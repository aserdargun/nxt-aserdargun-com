import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
export const CONTROL_VERSION = 1;

const refuse = (reason) => new Error(`Refusing local lifecycle operation: ${reason}.`);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const isNonce = (value) => typeof value === "string" && /^[0-9a-f-]{36}$/iu.test(value);

const runObserved = async (file, args) => {
  try {
    return (await run(file, args, { encoding: "utf8", maxBuffer: 1024 * 1024 })).stdout.trim();
  } catch (error) {
    if (error?.code === 1 || error?.code === "ENOENT") return "";
    throw error;
  }
};

const observeCwd = async (pid) => {
  if (process.platform === "linux") return realpath(`/proc/${pid}/cwd`).catch(() => "");
  const output = await runObserved("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  const line = output.split("\n").find((value) => value.startsWith("n"));
  return line?.slice(1) ?? "";
};

const observeListeners = async (pid) => {
  const output = await runObserved("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"]);
  return [...new Set(output.split("\n").flatMap((line) => {
    if (!line.startsWith("n")) return [];
    const match = /:([0-9]+)(?:\s|$)/u.exec(line);
    return match === null ? [] : [Number(match[1])];
  }))].sort((a, b) => a - b);
};

export const inspectProcess = async (pid) => {
  if (!positiveInteger(pid)) return null;
  const [startTime, executable, command, cwd, listeningPorts] = await Promise.all([
    runObserved("/bin/ps", ["-p", String(pid), "-o", "lstart="]),
    runObserved("/bin/ps", ["-p", String(pid), "-o", "comm="]),
    runObserved("/bin/ps", ["-p", String(pid), "-o", "command="]),
    observeCwd(pid),
    observeListeners(pid)
  ]);
  if (startTime.length === 0 || executable.length === 0 || command.length === 0 || cwd.length === 0) return null;
  return { pid, startTime, cwd, executable, command, listeningPorts };
};

const validateServiceSchema = (service, recordNonce, checkout, localDirectory) => {
  if (!isObject(service) || typeof service.name !== "string" || service.name.length === 0 || !positiveInteger(service.pid) ||
    typeof service.startTime !== "string" || service.startTime.length === 0 || typeof service.cwd !== "string" ||
    typeof service.executable !== "string" || service.executable.length === 0 || typeof service.command !== "string" ||
    service.command.length === 0 || !positiveInteger(service.port) || service.port > 65_535 || typeof service.logPath !== "string" ||
    service.nonce !== recordNonce) throw refuse("invalid service identity");
  const resolvedCwd = resolve(service.cwd);
  if (resolvedCwd !== checkout && !resolvedCwd.startsWith(`${checkout}${sep}`)) throw refuse("foreign service cwd");
  const resolvedLog = resolve(service.logPath);
  if (dirname(resolvedLog) !== localDirectory) throw refuse("foreign service log");
  if (service.launcher !== undefined) {
    const launcher = service.launcher;
    if (!isObject(launcher) || !positiveInteger(launcher.pid) || typeof launcher.startTime !== "string" || typeof launcher.cwd !== "string" ||
      typeof launcher.executable !== "string" || typeof launcher.command !== "string") throw refuse("invalid launcher identity");
    const launcherCwd = resolve(launcher.cwd);
    if (launcherCwd !== checkout && !launcherCwd.startsWith(`${checkout}${sep}`)) throw refuse("foreign launcher cwd");
  }
};

const parseControlRecord = (text, checkout, localDirectory) => {
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    throw refuse("corrupt control record");
  }
  if (!isObject(record) || record.version !== CONTROL_VERSION || record.checkoutRealpath !== checkout || !isNonce(record.nonce) ||
    typeof record.createdAt !== "string" || Number.isNaN(Date.parse(record.createdAt)) || !Array.isArray(record.services) ||
    record.services.length === 0) throw refuse("invalid or foreign control record");
  for (const service of record.services) validateServiceSchema(service, record.nonce, checkout, localDirectory);
  if (new Set(record.services.map(({ name }) => name)).size !== record.services.length ||
    new Set(record.services.map(({ port }) => port)).size !== record.services.length ||
    new Set(record.services.map(({ pid }) => pid)).size !== record.services.length) throw refuse("duplicate service identity");
  return record;
};

const assertLocalDirectory = async (checkout, controlPath) => {
  const expectedDirectory = join(checkout, ".nxt-local");
  const expectedControl = join(expectedDirectory, "control.json");
  let resolvedControl = resolve(controlPath);
  try {
    resolvedControl = join(await realpath(dirname(resolvedControl)), basename(resolvedControl));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (resolvedControl !== expectedControl) throw refuse("foreign control path");
  let metadata;
  try {
    metadata = await lstat(expectedDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") return expectedDirectory;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || await realpath(expectedDirectory) !== expectedDirectory) {
    throw refuse("unsafe control directory");
  }
  return expectedDirectory;
};

export const writeControlRecord = async (controlPath, record) => {
  const checkout = await realpath(record.checkoutRealpath);
  const localDirectory = await assertLocalDirectory(checkout, controlPath);
  parseControlRecord(JSON.stringify(record), checkout, localDirectory);
  await mkdir(localDirectory, { recursive: true, mode: 0o700 });
  await chmod(localDirectory, 0o700);
  const temporary = join(localDirectory, `.control-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, controlPath);
    await chmod(controlPath, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};

const identityMatches = (expected, observed) => observed !== null && expected.pid === observed.pid &&
  expected.startTime === observed.startTime && expected.cwd === observed.cwd && expected.executable === observed.executable &&
  expected.command === observed.command;

const observeVerifiedService = async (service) => {
  const root = await inspectProcess(service.pid);
  if (root !== null && (!identityMatches(service, root) || !root.listeningPorts.includes(service.port))) {
    throw refuse(`${service.name} listener identity changed`);
  }
  if (root === null && !await listenerIsClosed(service.port)) throw refuse(`${service.name} listener was replaced`);
  const launcher = service.launcher === undefined ? root : await inspectProcess(service.launcher.pid);
  if (launcher !== null && !identityMatches(service.launcher ?? service, launcher)) throw refuse(`${service.name} launcher identity changed`);
  return { root, launcher };
};

const childPids = async (pid) => {
  try {
    const output = await runObserved("/usr/bin/pgrep", ["-P", String(pid)]);
    return output.split(/\s+/u).filter(Boolean).map(Number).filter(positiveInteger);
  } catch {
    return [];
  }
};

const descendantIdentities = async (roots, checkout) => {
  const queue = roots.map(({ pid }) => pid);
  const seen = new Set(queue);
  const found = [];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const pid of await childPids(parent)) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      const identity = await inspectProcess(pid);
      if (identity === null) continue;
      if (identity.cwd !== checkout && !identity.cwd.startsWith(`${checkout}${sep}`)) throw refuse("foreign descendant cwd");
      found.push(identity);
      queue.push(pid);
    }
  }
  return found;
};

const waitUntilDead = async (identities, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const states = await Promise.all(identities.map(({ pid }) => inspectProcess(pid)));
    for (const [index, observed] of states.entries()) {
      if (observed !== null && !identityMatches(identities[index], observed)) throw refuse(`PID ${identities[index].pid} was reused while stopping`);
    }
    if (states.every((observed) => observed === null)) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  return false;
};

const signalIdentity = async (identity, signal) => {
  const observed = await inspectProcess(identity.pid);
  if (observed === null) return;
  if (!identityMatches(identity, observed)) throw refuse(`PID ${identity.pid} was reused before ${signal}`);
  try {
    process.kill(identity.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
};

const listenerIsClosed = async (port) => new Promise((resolvePromise) => {
  const socket = connect({ host: "127.0.0.1", port });
  const done = (closed) => {
    socket.destroy();
    resolvePromise(closed);
  };
  socket.setTimeout(250, () => done(true));
  socket.once("connect", () => done(false));
  socket.once("error", () => done(true));
});

export const stopControlledStack = async ({
  checkoutPath,
  controlPath = join(checkoutPath, ".nxt-local", "control.json"),
  termTimeoutMs = 4_000,
  killTimeoutMs = 2_000
}) => {
  const checkout = await realpath(resolve(checkoutPath));
  const localDirectory = await assertLocalDirectory(checkout, controlPath);
  let text;
  try {
    text = await readFile(controlPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "idle" };
    throw error;
  }
  const metadata = await lstat(controlPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw refuse("unsafe control file");
  const record = parseControlRecord(text, checkout, localDirectory);
  const verified = await Promise.all(record.services.map(observeVerifiedService));
  const roots = verified.flatMap(({ root, launcher }) => [root, launcher]).filter((identity) => identity !== null);
  const descendants = await descendantIdentities(roots, checkout);
  const identities = [...new Map([...roots, ...descendants].map((identity) => [identity.pid, identity])).values()];
  for (const identity of identities.toReversed()) await signalIdentity(identity, "SIGTERM");
  if (!await waitUntilDead(identities, termTimeoutMs)) {
    for (const identity of identities.toReversed()) await signalIdentity(identity, "SIGKILL");
    if (!await waitUntilDead(identities, killTimeoutMs)) throw refuse("owned processes did not exit");
  }
  for (const service of record.services) {
    if (!await listenerIsClosed(service.port)) throw refuse(`${service.name} listener is still open`);
  }
  if (await readFile(controlPath, "utf8") !== text) throw refuse("control record changed during stop");
  await rm(controlPath);
  for (const service of record.services) await rm(service.logPath, { force: true });
  await rmdir(localDirectory).catch((error) => { if (error?.code !== "ENOTEMPTY" && error?.code !== "ENOENT") throw error; });
  return { status: "stopped" };
};
