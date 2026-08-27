import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { basename, delimiter, isAbsolute, join, resolve, sep } from "node:path";

import {
  defaultEnumerateChildPids,
  defaultEnumerateGroupPids,
  inspectProcess
} from "./stop-local-core.mjs";

const pause = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
const isInside = (candidate, checkout) => candidate === checkout || candidate.startsWith(`${checkout}${sep}`);
const sameIdentity = (expected, observed) => observed !== null && expected.pid === observed.pid && expected.pgid === observed.pgid &&
  expected.startTime === observed.startTime && expected.cwd === observed.cwd && expected.executable === observed.executable &&
  expected.command === observed.command;
const changedIdentityFields = (expected, observed) => ["pid", "pgid", "startTime", "cwd", "executable", "command"]
  .filter((field) => expected[field] !== observed?.[field]).join(",");

const resolveExecutable = async (file, environment) => {
  const candidates = file.includes(sep) || isAbsolute(file)
    ? [resolve(file)]
    : (environment.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, file));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; }
    catch (error) { if (error?.code !== "ENOENT" && error?.code !== "EACCES") throw error; }
  }
  throw new Error(`Unable to resolve active command ${file}.`);
};

const normalizeCommand = async (file, args, environment) => {
  const executable = await resolveExecutable(file, environment);
  const prefix = (await readFile(executable, "utf8")).slice(0, 128);
  if (/^#!\/usr\/bin\/env node(?:\s|$)/u.test(prefix) || prefix.startsWith(`#!${process.execPath}\n`)) {
    return { file: process.execPath, args: [executable, ...args], identityToken: basename(executable) };
  }
  return { file: executable, args, identityToken: basename(executable) };
};

const inspectStableProcess = async (pid, inspect) => {
  let previous;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = await inspect(pid);
    if (observed === null) return null;
    if (previous !== undefined && sameIdentity(previous, observed)) return observed;
    previous = observed;
    await pause(5);
  }
  throw new Error(`Refusing unstable active-command PID ${pid}.`);
};

const observeSpawnedRoot = async (child, { cwd, identityToken, inspect }) => {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const identity = await inspectStableProcess(child.pid, inspect);
    if (identity !== null) {
      if (identity.pid !== identity.pgid) throw new Error("Refusing active command without an isolated process group.");
      if (resolve(identity.cwd) !== cwd) throw new Error("Refusing active command with a foreign working directory.");
      if (!identity.command.includes(identityToken)) throw new Error("Refusing active command with an unexpected command identity.");
      return identity;
    }
    if (child.exitCode !== null || child.signalCode !== null) return undefined;
    await pause(10);
  }
  throw new Error("Refusing active command whose full process identity could not be observed.");
};

const createOutputCollector = (stream, maximumBytes) => {
  const chunks = [];
  let bytes = 0;
  let overflow;
  stream.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes <= maximumBytes) chunks.push(chunk);
    else overflow ??= new Error(`Active command output exceeded ${maximumBytes} bytes.`);
  });
  return {
    value: () => Buffer.concat(chunks).toString("utf8"),
    error: () => overflow
  };
};

const createExitPromise = (child) => new Promise((resolvePromise, reject) => {
  child.once("error", reject);
  child.once("close", (code, signal) => resolvePromise({ code, signal }));
});

const discoverOwnedMembers = async ({ root, checkout, known, inspect, enumerateChildPids, enumerateGroupPids }) => {
  const current = new Map();
  const parents = new Map();
  for (const identity of known.values()) {
    const observed = await inspect(identity.pid);
    if (observed === null) continue;
    if (!sameIdentity(identity, observed)) throw new Error(`Refusing changed active-command PID ${identity.pid} fields ${changedIdentityFields(identity, observed)}.`);
    current.set(identity.pid, observed);
  }

  const queue = [...current.keys()];
  const visited = new Set();
  while (queue.length > 0) {
    const parentPid = queue.shift();
    if (visited.has(parentPid)) continue;
    visited.add(parentPid);
    for (const pid of await enumerateChildPids(parentPid)) {
      const prior = known.get(pid);
      const observed = prior === undefined ? await inspectStableProcess(pid, inspect) : await inspect(pid);
      if (observed === null) continue;
      if (!isInside(resolve(observed.cwd), checkout)) throw new Error("Refusing foreign active-command descendant.");
      if (prior !== undefined && !sameIdentity(prior, observed)) throw new Error(`Refusing reused active-command PID ${pid}.`);
      known.set(pid, observed);
      current.set(pid, observed);
      parents.set(pid, parentPid);
      queue.push(pid);
    }
  }

  for (const pid of await enumerateGroupPids(root.pgid)) {
    const prior = known.get(pid);
    const observed = prior === undefined ? await inspectStableProcess(pid, inspect) : await inspect(pid);
    if (observed === null) continue;
    if (observed.pgid !== root.pgid || !isInside(resolve(observed.cwd), checkout)) {
      throw new Error("Refusing foreign active-command process-group member.");
    }
    if (prior !== undefined && !sameIdentity(prior, observed)) throw new Error(`Refusing reused active-command group PID ${pid}.`);
    known.set(pid, observed);
    current.set(pid, observed);
  }
  return { current: [...current.values()], parents };
};

const leafFirst = (members, parents, rootPid) => {
  const depth = (pid) => {
    let value = pid === rootPid ? 0 : 1;
    const seen = new Set([pid]);
    let cursor = pid;
    while (parents.has(cursor) && !seen.has(parents.get(cursor))) {
      cursor = parents.get(cursor);
      seen.add(cursor);
      value += 1;
    }
    return value;
  };
  return members.toSorted((left, right) => depth(right.pid) - depth(left.pid) || right.pid - left.pid);
};

const signalIdentity = async (identity, signal, inspect) => {
  const observed = await inspect(identity.pid);
  if (observed === null) return;
  if (!sameIdentity(identity, observed)) throw new Error(`Refusing changed active-command PID ${identity.pid} before ${signal}.`);
  try { process.kill(identity.pid, signal); }
  catch (error) { if (error?.code !== "ESRCH") throw error; }
};

const terminateOwnedCommand = async ({ root, checkout, inspect, enumerateChildPids, enumerateGroupPids }) => {
  const known = new Map([[root.pid, root]]);
  const discover = () => discoverOwnedMembers({ root, checkout, known, inspect, enumerateChildPids, enumerateGroupPids });
  const phase = async (signal, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    let emptyPasses = 0;
    while (Date.now() < deadline) {
      const { current, parents } = await discover();
      if (current.length === 0) {
        emptyPasses += 1;
        if (emptyPasses === 2) return true;
      } else {
        emptyPasses = 0;
        for (const identity of leafFirst(current, parents, root.pid)) await signalIdentity(identity, signal, inspect);
      }
      await pause(25);
    }
    return false;
  };
  if (await phase("SIGTERM", 400)) return;
  if (!await phase("SIGKILL", 2_000)) throw new Error("Owned active-command processes did not exit.");
};

const proveOwnedCommandEmpty = async ({ root, checkout, inspect, enumerateChildPids, enumerateGroupPids }) => {
  const known = new Map([[root.pid, root]]);
  let emptyPasses = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { current } = await discoverOwnedMembers({ root, checkout, known, inspect, enumerateChildPids, enumerateGroupPids });
    if (current.length === 0) {
      emptyPasses += 1;
      if (emptyPasses === 2) return;
    } else emptyPasses = 0;
    await pause(25);
  }
  throw new Error("Active command exited while owned process-group members remained.");
};

const commandFailure = (message, result, stdout, stderr, cause) => Object.assign(new Error(message, { cause }), {
  code: result?.code,
  signal: result?.signal,
  stdout,
  stderr
});

export const runOwnedCommand = async (file, args, {
  cwd,
  env,
  maxBuffer = 16 * 1024 * 1024,
  signal,
  timeoutMs,
  inspect = inspectProcess,
  enumerateChildPids = defaultEnumerateChildPids,
  enumerateGroupPids = defaultEnumerateGroupPids
}) => {
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
    throw new Error("Active command timeout must be a positive integer.");
  }
  const timeoutSignal = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
  const activeSignal = signal === undefined ? timeoutSignal : timeoutSignal === undefined ? signal : AbortSignal.any([signal, timeoutSignal]);
  const checkout = await realpath(resolve(cwd));
  const command = await normalizeCommand(file, args, env);
  const child = spawn(command.file, command.args, {
    cwd: checkout,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout = createOutputCollector(child.stdout, maxBuffer);
  const stderr = createOutputCollector(child.stderr, maxBuffer);
  const exit = createExitPromise(child);
  await new Promise((resolvePromise, reject) => {
    child.once("spawn", resolvePromise);
    child.once("error", reject);
  });
  const root = await observeSpawnedRoot(child, { cwd: checkout, identityToken: command.identityToken, inspect });
  if (root === undefined) {
    const result = await exit;
    const overflow = stdout.error() ?? stderr.error();
    if (overflow !== undefined || result.code !== 0) throw commandFailure("Active command failed.", result, stdout.value(), stderr.value(), overflow);
    return { ...result, stdout: stdout.value(), stderr: stderr.value() };
  }

  let interrupted = activeSignal?.aborted === true;
  let wakeInterruption;
  const interruption = new Promise((resolvePromise) => { wakeInterruption = resolvePromise; });
  const onAbort = () => { interrupted = true; wakeInterruption(); };
  activeSignal?.addEventListener("abort", onAbort, { once: true });
  if (interrupted) wakeInterruption();
  try {
    const first = await Promise.race([
      exit.then((result) => ({ type: "exit", result })),
      interruption.then(() => ({ type: "interrupt" }))
    ]);
    if (first.type === "interrupt" || interrupted) {
      let terminationError;
      try { await terminateOwnedCommand({ root, checkout, inspect, enumerateChildPids, enumerateGroupPids }); }
      catch (error) { terminationError = error; }
      const result = await Promise.race([exit, pause(2_500).then(() => undefined)]);
      if (terminationError !== undefined || result === undefined) {
        throw commandFailure("Interrupted active command cleanup could not be proven.", result, stdout.value(), stderr.value(), terminationError);
      }
      throw commandFailure("Active command was interrupted.", result, stdout.value(), stderr.value());
    }

    const result = first.result;
    let survivorError;
    try { await proveOwnedCommandEmpty({ root, checkout, inspect, enumerateChildPids, enumerateGroupPids }); }
    catch (error) {
      survivorError = error;
      await terminateOwnedCommand({ root, checkout, inspect, enumerateChildPids, enumerateGroupPids });
    }
    const overflow = stdout.error() ?? stderr.error();
    if (survivorError !== undefined || overflow !== undefined || result.code !== 0) {
      throw commandFailure("Active command failed or left owned descendants.", result, stdout.value(), stderr.value(), survivorError ?? overflow);
    }
    return { ...result, stdout: stdout.value(), stderr: stderr.value() };
  } finally {
    activeSignal?.removeEventListener("abort", onAbort);
  }
};
