import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
export const CONTROL_VERSION = 2;
export const STARTUP_LEASE_VERSION = 1;
export const STARTUP_LEASE_NAME = "startup.lock";
export const STOP_CLAIM_VERSION = 1;
export const STOP_CLAIM_NAME = "stop.lock";
const stoppingLeaseName = "stopping.lock";

const refuse = (reason) => new Error(`Refusing local lifecycle operation: ${reason}.`);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const isNonce = (value) => typeof value === "string" && /^[0-9a-f-]{36}$/iu.test(value);
const isInsideCheckout = (path, checkout) => path === checkout || path.startsWith(`${checkout}${sep}`);

const runObserved = async (file, args, { emptyOnExitOne = false } = {}) => {
  try {
    return (await run(file, args, { encoding: "utf8", maxBuffer: 1024 * 1024 })).stdout.trim();
  } catch (error) {
    if (emptyOnExitOne && error?.code === 1) return "";
    throw error;
  }
};

const observeCwd = async (pid) => {
  if (process.platform === "linux") return realpath(`/proc/${pid}/cwd`).catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  const output = await runObserved("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { emptyOnExitOne: true });
  const line = output.split("\n").find((value) => value.startsWith("n"));
  return line?.slice(1) ?? "";
};

const observeListeners = async (pid) => {
  const output = await runObserved("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], { emptyOnExitOne: true });
  return [...new Set(output.split("\n").flatMap((line) => {
    if (!line.startsWith("n")) return [];
    const match = /:([0-9]+)(?:\s|$)/u.exec(line);
    return match === null ? [] : [Number(match[1])];
  }))].sort((a, b) => a - b);
};

export const inspectProcess = async (pid) => {
  if (!positiveInteger(pid)) return null;
  const [startTime, executable, command, pgidText, cwd, listeningPorts] = await Promise.all([
    runObserved("/bin/ps", ["-p", String(pid), "-o", "lstart="], { emptyOnExitOne: true }),
    runObserved("/bin/ps", ["-p", String(pid), "-o", "comm="], { emptyOnExitOne: true }),
    runObserved("/bin/ps", ["-p", String(pid), "-o", "command="], { emptyOnExitOne: true }),
    runObserved("/bin/ps", ["-p", String(pid), "-o", "pgid="], { emptyOnExitOne: true }),
    observeCwd(pid),
    observeListeners(pid)
  ]);
  const pgid = Number(pgidText);
  if (startTime.length === 0 || executable.length === 0 || command.length === 0 || cwd.length === 0 || !positiveInteger(pgid)) return null;
  return { pid, pgid, startTime, cwd, executable, command, listeningPorts };
};

const validateIdentitySchema = (identity, checkout, label) => {
  if (!isObject(identity) || !positiveInteger(identity.pid) || !positiveInteger(identity.pgid) ||
    typeof identity.startTime !== "string" || identity.startTime.length === 0 || typeof identity.cwd !== "string" ||
    typeof identity.executable !== "string" || identity.executable.length === 0 || typeof identity.command !== "string" ||
    identity.command.length === 0) throw refuse(`invalid ${label} identity`);
  if (!isInsideCheckout(resolve(identity.cwd), checkout)) throw refuse(`foreign ${label} cwd`);
};

const validateProcessIdentityShape = (identity, label) => {
  if (!isObject(identity) || !positiveInteger(identity.pid) || !positiveInteger(identity.pgid) ||
    typeof identity.startTime !== "string" || identity.startTime.length === 0 || typeof identity.cwd !== "string" ||
    identity.cwd.length === 0 || typeof identity.executable !== "string" || identity.executable.length === 0 ||
    typeof identity.command !== "string" || identity.command.length === 0) throw refuse(`invalid ${label} identity`);
};

const identityMatches = (expected, observed) => observed !== null && expected.pid === observed.pid && expected.pgid === observed.pgid &&
  expected.startTime === observed.startTime && expected.cwd === observed.cwd && expected.executable === observed.executable &&
  expected.command === observed.command;

const validateGateSchema = (gate, service, localDirectory) => {
  if (!isObject(gate) || !isNonce(gate.nonce)) throw refuse(`invalid ${service.name} gate`);
  const prefix = join(localDirectory, `.gate-${service.name}-${gate.nonce}`);
  const expected = {
    registrationPath: `${prefix}.registration.json`,
    releasePath: `${prefix}.release.json`,
    cancelPath: `${prefix}.cancel.json`
  };
  for (const [key, path] of Object.entries(expected)) {
    if (gate[key] !== path || dirname(resolve(gate[key] ?? "")) !== localDirectory) throw refuse(`foreign ${service.name} gate`);
  }
};

const validateServiceSchema = (service, recordNonce, checkout, localDirectory) => {
  if (!isObject(service) || typeof service.name !== "string" || !/^[a-z][a-z0-9-]*$/u.test(service.name) || !positiveInteger(service.port) ||
    service.port > 65_535 || typeof service.logPath !== "string" || service.nonce !== recordNonce) {
    throw refuse("invalid service identity");
  }
  if (dirname(resolve(service.logPath)) !== localDirectory) throw refuse("foreign service log");
  const status = service.status ?? "ready";
  if (status !== "planned" && status !== "gated" && status !== "spawned" && status !== "ready") throw refuse("invalid service state");
  if (status === "planned") {
    validateGateSchema(service.gate, service, localDirectory);
    if (service.candidatePid !== undefined && !positiveInteger(service.candidatePid)) throw refuse(`invalid ${service.name} supervisor candidate`);
  }
  else if (status === "gated") {
    validateGateSchema(service.gate, service, localDirectory);
    validateIdentitySchema(service.launcher, checkout, `${service.name} launcher`);
  } else if (status === "spawned") validateIdentitySchema(service.launcher, checkout, `${service.name} launcher`);
  else {
    validateIdentitySchema(service, checkout, `${service.name} listener`);
    if (service.launcher !== undefined) validateIdentitySchema(service.launcher, checkout, `${service.name} launcher`);
    if (service.gate !== undefined) validateGateSchema(service.gate, service, localDirectory);
  }
};

const parseControlRecord = (text, checkout, localDirectory) => {
  let record;
  try { record = JSON.parse(text); } catch { throw refuse("corrupt control record"); }
  const state = record?.state ?? "ready";
  if (!isObject(record) || record.version !== CONTROL_VERSION || record.checkoutRealpath !== checkout || !isNonce(record.nonce) ||
    typeof record.createdAt !== "string" || Number.isNaN(Date.parse(record.createdAt)) || !Array.isArray(record.services) ||
    (state !== "starting" && state !== "ready") || (state === "ready" && record.services.length === 0)) {
    throw refuse("invalid or foreign control record");
  }
  if (record.state !== undefined) {
    if (typeof record.updatedAt !== "string" || Number.isNaN(Date.parse(record.updatedAt))) throw refuse("invalid control update time");
    validateIdentitySchema(record.coordinator, checkout, "startup coordinator");
  }
  for (const service of record.services) validateServiceSchema(service, record.nonce, checkout, localDirectory);
  if (state === "ready" && record.services.some((service) => (service.status ?? "ready") !== "ready")) {
    throw refuse("incomplete ready control record");
  }
  const identities = record.services.flatMap((service) => {
    if (service.status === "planned") return [];
    if (service.status === "spawned" || service.status === "gated") return [service.launcher];
    return [service, service.launcher];
  })
    .filter((identity) => identity !== undefined);
  if (new Set(record.services.map(({ name }) => name)).size !== record.services.length ||
    new Set(record.services.map(({ port }) => port)).size !== record.services.length ||
    new Set(identities.map(({ pid }) => pid)).size !== identities.length) throw refuse("duplicate service identity");
  return { ...record, state };
};

const parseLeaseRecord = (text, checkout) => {
  let lease;
  try { lease = JSON.parse(text); } catch { throw refuse("corrupt startup lease"); }
  if (!isObject(lease) || lease.version !== STARTUP_LEASE_VERSION || lease.checkoutRealpath !== checkout || !isNonce(lease.nonce) ||
    typeof lease.createdAt !== "string" || Number.isNaN(Date.parse(lease.createdAt))) throw refuse("invalid or foreign startup lease");
  validateIdentitySchema(lease.owner, checkout, "startup lease owner");
  return lease;
};

const parseStopClaim = (text, checkout) => {
  let claim;
  try { claim = JSON.parse(text); } catch { throw refuse("corrupt Stop claim"); }
  if (!isObject(claim) || claim.version !== STOP_CLAIM_VERSION || claim.checkoutRealpath !== checkout ||
    !isNonce(claim.nonce) || !isNonce(claim.controlNonce) || typeof claim.createdAt !== "string" ||
    Number.isNaN(Date.parse(claim.createdAt))) throw refuse("invalid or foreign Stop claim");
  validateProcessIdentityShape(claim.owner, "Stop claim owner");
  return claim;
};

const assertLocalDirectory = async (checkout, controlPath) => {
  const expectedDirectory = join(checkout, ".nxt-local");
  const expectedControl = join(expectedDirectory, "control.json");
  let resolvedControl = resolve(controlPath);
  try { resolvedControl = join(await realpath(dirname(resolvedControl)), basename(resolvedControl)); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (resolvedControl !== expectedControl) throw refuse("foreign control path");
  let metadata;
  try { metadata = await lstat(expectedDirectory); }
  catch (error) { if (error?.code === "ENOENT") return expectedDirectory; throw error; }
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || await realpath(expectedDirectory) !== expectedDirectory) {
    throw refuse("unsafe control directory");
  }
  return expectedDirectory;
};

const assertRegularLifecycleFile = async (path, label) => {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw refuse(`unsafe ${label}`);
};

const atomicWrite = async (path, text, localDirectory) => {
  const temporary = join(localDirectory, `.control-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};

export const writeControlRecord = async (controlPath, record) => {
  const checkout = await realpath(record.checkoutRealpath);
  const localDirectory = await assertLocalDirectory(checkout, controlPath);
  parseControlRecord(JSON.stringify(record), checkout, localDirectory);
  await mkdir(localDirectory, { recursive: true, mode: 0o700 });
  await chmod(localDirectory, 0o700);
  await atomicWrite(controlPath, `${JSON.stringify(record, null, 2)}\n`, localDirectory);
};

const exists = (path) => lstat(path).then(() => true, (error) => error?.code === "ENOENT" ? false : Promise.reject(error));

export const acquireStartupLease = async ({ checkoutPath, controlPath, nonce }) => {
  const checkout = await realpath(resolve(checkoutPath));
  const localDirectory = await assertLocalDirectory(checkout, controlPath);
  await mkdir(localDirectory, { recursive: true, mode: 0o700 });
  await chmod(localDirectory, 0o700);
  const leasePath = join(localDirectory, STARTUP_LEASE_NAME);
  const stoppingPath = join(localDirectory, stoppingLeaseName);
  const stopClaimPath = join(localDirectory, STOP_CLAIM_NAME);
  if (await exists(controlPath) || await exists(stoppingPath) || await exists(stopClaimPath)) {
    throw refuse("existing local control, startup state, or Stop claim");
  }
  const owner = await inspectProcess(process.pid);
  if (owner === null || !isInsideCheckout(owner.cwd, checkout)) throw refuse("startup owner is outside the checkout");
  const record = { version: STARTUP_LEASE_VERSION, checkoutRealpath: checkout, nonce, createdAt: new Date().toISOString(), owner };
  const text = `${JSON.stringify(record, null, 2)}\n`;
  let handle;
  try {
    handle = await open(leasePath, "wx", 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } catch (error) {
    if (error?.code === "EEXIST") throw refuse("startup lease is already owned");
    throw error;
  } finally { await handle?.close(); }
  await chmod(leasePath, 0o600);
  try {
    if (await exists(controlPath) || await exists(stopClaimPath)) throw refuse("control or Stop state appeared while acquiring startup lease");
  } catch (error) {
    if (await readFile(leasePath, "utf8").catch(() => "") === text) await rm(leasePath);
    throw error;
  }
  return { record, text, path: leasePath };
};

const assertOwnedLease = async (lease) => {
  await assertRegularLifecycleFile(lease.path, "startup lease");
  if (await readFile(lease.path, "utf8") !== lease.text) throw refuse("startup lease changed");
  if (!identityMatches(lease.record.owner, await inspectProcess(process.pid))) throw refuse("startup lease owner identity changed");
};

export const writeOwnedControlRecord = async (controlPath, record, lease) => {
  const checkout = await realpath(record.checkoutRealpath);
  const localDirectory = await assertLocalDirectory(checkout, controlPath);
  if (record.nonce !== lease.record.nonce || !identityMatches(record.coordinator, lease.record.owner)) {
    throw refuse("control replacement is not owned by the startup lease");
  }
  await assertOwnedLease(lease);
  let existingText;
  try { existingText = await readFile(controlPath, "utf8"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (existingText !== undefined) {
    const existing = parseControlRecord(existingText, checkout, localDirectory);
    if (existing.nonce !== record.nonce || existing.coordinator === undefined || !identityMatches(existing.coordinator, record.coordinator)) {
      throw refuse("control record ownership changed");
    }
  }
  parseControlRecord(JSON.stringify(record), checkout, localDirectory);
  await atomicWrite(controlPath, `${JSON.stringify(record, null, 2)}\n`, localDirectory);
  await assertOwnedLease(lease);
};

export const releaseOwnedStartupLease = async (lease) => {
  await assertOwnedLease(lease);
  await rm(lease.path);
};

const listenerIsClosed = async (port) => new Promise((resolvePromise) => {
  const socket = connect({ host: "127.0.0.1", port });
  const done = (closed) => { socket.destroy(); resolvePromise(closed); };
  socket.setTimeout(250, () => done(true));
  socket.once("connect", () => done(false));
  socket.once("error", () => done(true));
});

const defaultEnumerateChildPids = async (pid) => {
  try {
    const { stdout } = await run("/usr/bin/pgrep", ["-P", String(pid)], { encoding: "utf8", maxBuffer: 1024 * 1024 });
    return stdout.trim().split(/\s+/u).filter(Boolean).map(Number).filter(positiveInteger);
  } catch (error) {
    if (error?.code === 1) return [];
    throw error;
  }
};

const defaultEnumerateGroupPids = async (pgid) => {
  const { stdout } = await run("/bin/ps", ["-axo", "pid=,pgid="], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*([0-9]+)\s+([0-9]+)\s*$/u.exec(line);
    return match !== null && Number(match[2]) === pgid ? [Number(match[1])] : [];
  });
};

const serviceIdentities = (service) => {
  const status = service.status ?? "ready";
  if (status === "planned") return [];
  if (status === "spawned" || status === "gated") return [service.launcher];
  return [service, service.launcher].filter((identity) => identity !== undefined);
};

const verifyRecordedServices = async (record, inspect) => {
  for (const service of record.services) {
    if ((service.status ?? "ready") === "ready") {
      const listener = await inspect(service.pid);
      if (listener !== null && (!identityMatches(service, listener) || !listener.listeningPorts.includes(service.port))) {
        throw refuse(`${service.name} listener identity changed`);
      }
      if (listener === null && !await listenerIsClosed(service.port)) throw refuse(`${service.name} listener was replaced`);
    }
    for (const identity of serviceIdentities(service)) {
      const observed = await inspect(identity.pid);
      if (observed !== null && !identityMatches(identity, observed)) throw refuse(`${service.name} process identity changed`);
    }
  }
};

const discoverOwnedProcesses = async ({ expected, known, trustedGroups, checkout, enumerateChildPids, enumerateGroupPids, inspect }) => {
  const current = new Map();
  for (const identity of expected.values()) {
    const observed = await inspect(identity.pid);
    if (observed === null) continue;
    if (!identityMatches(identity, observed)) throw refuse(`PID ${identity.pid} identity changed during discovery`);
    current.set(observed.pid, observed);
    trustedGroups.add(observed.pgid);
  }
  const allowedGroups = new Set([...expected.values()].map(({ pgid }) => pgid));
  const queue = [...current.values()].map(({ pid }) => pid);
  const visitedParents = new Set();
  while (queue.length > 0) {
    const parent = queue.shift();
    if (visitedParents.has(parent)) continue;
    visitedParents.add(parent);
    for (const pid of await enumerateChildPids(parent)) {
      const observed = await inspect(pid);
      if (observed === null) continue;
      if (!isInsideCheckout(observed.cwd, checkout)) throw refuse("foreign descendant cwd");
      if (!allowedGroups.has(observed.pgid)) throw refuse("foreign descendant process group");
      current.set(pid, observed);
      queue.push(pid);
    }
  }
  for (const pgid of allowedGroups) {
    for (const pid of await enumerateGroupPids(pgid)) {
      const observed = await inspect(pid);
      if (observed === null) continue;
      const previous = known.get(pid);
      if (previous !== undefined && !identityMatches(previous, observed)) throw refuse(`PID ${pid} was reused during group discovery`);
      if (!isInsideCheckout(observed.cwd, checkout)) throw refuse("foreign process-group member cwd");
      if (!trustedGroups.has(pgid) && !expected.has(pid)) throw refuse("unproven process-group member");
      current.set(pid, observed);
    }
  }
  for (const identity of current.values()) {
    const previous = known.get(identity.pid);
    if (previous !== undefined && !identityMatches(previous, identity)) throw refuse(`PID ${identity.pid} identity changed during shutdown`);
    known.set(identity.pid, identity);
  }
  return [...current.values()];
};

const signalIdentity = async (identity, signal, inspect) => {
  const observed = await inspect(identity.pid);
  if (observed === null) return;
  if (!identityMatches(identity, observed)) throw refuse(`PID ${identity.pid} was reused before ${signal}`);
  try { process.kill(identity.pid, signal); }
  catch (error) { if (error?.code !== "ESRCH") throw error; }
};

const stopCoordinator = async (identity, { termTimeoutMs, killTimeoutMs, inspect }) => {
  let observed = await inspect(identity.pid);
  if (observed === null) return;
  if (!identityMatches(identity, observed)) throw refuse("startup coordinator identity changed");
  if (identity.pid === process.pid) throw refuse("cannot externally stop the current startup coordinator");
  await signalIdentity(identity, "SIGTERM", inspect);
  const termDeadline = Date.now() + termTimeoutMs;
  while (Date.now() < termDeadline && (observed = await inspect(identity.pid)) !== null) {
    if (!identityMatches(identity, observed)) throw refuse("startup coordinator PID was reused");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  if (observed === null) return;
  await signalIdentity(identity, "SIGKILL", inspect);
  const killDeadline = Date.now() + killTimeoutMs;
  while (Date.now() < killDeadline && (observed = await inspect(identity.pid)) !== null) {
    if (!identityMatches(identity, observed)) throw refuse("startup coordinator PID was reused after SIGKILL");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  if (observed !== null) throw refuse("startup coordinator did not exit");
};

const stopServiceProcesses = async ({ record, checkout, termTimeoutMs, killTimeoutMs, enumerateChildPids, enumerateGroupPids, inspect }) => {
  const identities = record.services.flatMap(serviceIdentities);
  const expected = new Map(identities.map((identity) => [identity.pid, identity]));
  const known = new Map(expected);
  const trustedGroups = new Set();
  const discover = () => discoverOwnedProcesses({ expected, known, trustedGroups, checkout, enumerateChildPids, enumerateGroupPids, inspect });
  const phase = async (signal, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    let emptyPasses = 0;
    while (Date.now() < deadline) {
      const current = await discover();
      if (current.length === 0) {
        emptyPasses += 1;
        if (emptyPasses >= 2) return true;
      } else {
        emptyPasses = 0;
        for (const identity of current.toReversed()) await signalIdentity(identity, signal, inspect);
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    return false;
  };
  if (await phase("SIGTERM", termTimeoutMs)) return;
  if (!await phase("SIGKILL", killTimeoutMs)) throw refuse("owned processes did not exit");
};

const readOptionalFile = async (path) => {
  try { await assertRegularLifecycleFile(path, "lifecycle file"); return await readFile(path, "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
};

const acquireStopClaim = async ({ localDirectory, checkout, controlNonce, inspect }) => {
  const path = join(localDirectory, STOP_CLAIM_NAME);
  const owner = await inspect(process.pid);
  if (owner === null) throw refuse("Stop owner identity could not be observed");
  validateProcessIdentityShape(owner, "Stop owner");
  const record = {
    version: STOP_CLAIM_VERSION,
    checkoutRealpath: checkout,
    controlNonce,
    nonce: randomUUID(),
    createdAt: new Date().toISOString(),
    owner
  };
  const text = `${JSON.stringify(record, null, 2)}\n`;
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } catch (error) {
    if (error?.code === "EEXIST") {
      const existingText = await readOptionalFile(path);
      if (existingText !== undefined) parseStopClaim(existingText, checkout);
      throw refuse("Stop claim is already owned");
    }
    throw error;
  } finally {
    await handle?.close();
  }
  await chmod(path, 0o600);
  return { path, record, text };
};

const assertOwnedStopClaim = async (claim, inspect) => {
  await assertRegularLifecycleFile(claim.path, "Stop claim");
  if (await readFile(claim.path, "utf8") !== claim.text) throw refuse("Stop claim changed");
  if (!identityMatches(claim.record.owner, await inspect(process.pid))) throw refuse("Stop claim owner identity changed");
};

const releaseOwnedStopClaim = async (claim, inspect) => {
  await assertOwnedStopClaim(claim, inspect);
  await rm(claim.path);
};

const writeGateClaim = async (path, nonce) => {
  const text = `${JSON.stringify({ version: 1, nonce })}\n`;
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    await assertRegularLifecycleFile(path, "service gate claim");
    const existing = JSON.parse(await readFile(path, "utf8"));
    if (existing?.version !== 1 || existing?.nonce !== nonce) throw refuse("service gate claim changed");
  } finally {
    await handle?.close();
  }
  await chmod(path, 0o600);
};

const readSupervisorRegistration = async (service, checkout, inspect) => {
  const text = await readOptionalFile(service.gate.registrationPath);
  if (text === undefined) return undefined;
  let registration;
  try { registration = JSON.parse(text); } catch { throw refuse(`corrupt ${service.name} supervisor registration`); }
  if (registration?.version !== 1 || registration?.nonce !== service.gate.nonce) throw refuse(`invalid ${service.name} supervisor registration`);
  validateIdentitySchema(registration.identity, checkout, `${service.name} supervisor`);
  if (!identityMatches(registration.identity, await inspect(registration.identity.pid))) {
    if (await inspect(registration.identity.pid) !== null) throw refuse(`${service.name} supervisor identity changed`);
  }
  return registration.identity;
};

const prepareGatedServices = async (record, checkout, inspect, timeoutMs) => {
  const prepared = [];
  for (const service of record.services) {
    if (service.gate === undefined || (service.status !== "planned" && service.status !== "gated")) {
      prepared.push(service);
      continue;
    }
    await writeGateClaim(service.gate.cancelPath, service.gate.nonce);
    if (service.status === "gated") {
      prepared.push(service);
      continue;
    }
    const deadline = Date.now() + timeoutMs;
    let identity;
    while (Date.now() < deadline && identity === undefined) {
      identity = await readSupervisorRegistration(service, checkout, inspect);
      if (identity !== undefined) break;
      if (service.candidatePid !== undefined && await inspect(service.candidatePid) === null) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    if (identity !== undefined) prepared.push({ ...service, status: "gated", launcher: identity });
    else if (service.candidatePid !== undefined && await inspect(service.candidatePid) === null) prepared.push(service);
    else throw refuse(`${service.name} supervisor cleanup could not be proven`);
  }
  return { ...record, services: prepared };
};

const claimStartupLease = async (localDirectory, checkout) => {
  const startupPath = join(localDirectory, STARTUP_LEASE_NAME);
  const stoppingPath = join(localDirectory, stoppingLeaseName);
  const stoppingText = await readOptionalFile(stoppingPath);
  if (stoppingText !== undefined) {
    if (await readOptionalFile(startupPath) !== undefined) throw refuse("multiple startup lease states");
    return { path: stoppingPath, text: stoppingText, record: parseLeaseRecord(stoppingText, checkout) };
  }
  const startupText = await readOptionalFile(startupPath);
  if (startupText === undefined) return undefined;
  const lease = parseLeaseRecord(startupText, checkout);
  try { await rename(startupPath, stoppingPath); }
  catch (error) {
    if (error?.code === "ENOENT") throw refuse("startup lease changed while claiming stop ownership");
    throw error;
  }
  if (await readFile(stoppingPath, "utf8") !== startupText) throw refuse("startup lease changed while claiming stop ownership");
  return { path: stoppingPath, text: startupText, record: lease };
};

export const stopControlledStack = async ({
  checkoutPath,
  controlPath = join(checkoutPath, ".nxt-local", "control.json"),
  termTimeoutMs = 4_000,
  killTimeoutMs = 2_000,
  ownerNonce,
  enumerateChildPids = defaultEnumerateChildPids,
  enumerateGroupPids = defaultEnumerateGroupPids,
  inspect = inspectProcess,
  afterStopClaim,
  beforeStopClaimRelease
}) => {
  const checkout = await realpath(resolve(checkoutPath));
  const localDirectory = await assertLocalDirectory(checkout, controlPath);
  const initialControlText = await readOptionalFile(controlPath);
  const initialRecord = initialControlText === undefined ? undefined : parseControlRecord(initialControlText, checkout, localDirectory);
  const initialStartupText = await readOptionalFile(join(localDirectory, STARTUP_LEASE_NAME));
  const initialStoppingText = await readOptionalFile(join(localDirectory, stoppingLeaseName));
  if (initialStartupText !== undefined && initialStoppingText !== undefined) throw refuse("multiple startup lease states");
  const initialLeaseText = initialStartupText ?? initialStoppingText;
  const initialLease = initialLeaseText === undefined ? undefined : parseLeaseRecord(initialLeaseText, checkout);
  if (initialRecord === undefined && initialLease === undefined) {
    const existingStop = await readOptionalFile(join(localDirectory, STOP_CLAIM_NAME));
    if (existingStop !== undefined) {
      parseStopClaim(existingStop, checkout);
      throw refuse("Stop claim is already owned");
    }
    return { status: "idle" };
  }
  const controlNonce = initialRecord?.nonce ?? initialLease.nonce;
  if (initialRecord !== undefined && initialLease !== undefined && initialRecord.nonce !== initialLease.nonce) {
    throw refuse("startup lease and control record ownership differ");
  }
  const stopClaim = await acquireStopClaim({ localDirectory, checkout, controlNonce, inspect });
  let claimReleased = false;
  try {
    await afterStopClaim?.(stopClaim.record);
    await assertOwnedStopClaim(stopClaim, inspect);
  const needsLease = initialRecord === undefined || initialRecord.state === "starting" ||
    await readOptionalFile(join(localDirectory, STARTUP_LEASE_NAME)) !== undefined ||
    await readOptionalFile(join(localDirectory, stoppingLeaseName)) !== undefined;
  const claimedLease = needsLease ? await claimStartupLease(localDirectory, checkout) : undefined;
  if (initialRecord === undefined && claimedLease === undefined) throw refuse("startup state changed while Stop acquired ownership");
  if (initialRecord?.state === "starting" && claimedLease === undefined) throw refuse("starting control record has no startup lease");
  if (ownerNonce !== undefined) {
    if (claimedLease === undefined || claimedLease.record.nonce !== ownerNonce || claimedLease.record.owner.pid !== process.pid) {
      throw refuse("startup cleanup is not owned by the caller");
    }
    if (!identityMatches(claimedLease.record.owner, await inspect(process.pid))) throw refuse("startup cleanup owner identity changed");
  }
  const frozenControlText = await readOptionalFile(controlPath);
  let record = frozenControlText === undefined ? {
    version: CONTROL_VERSION,
    state: "starting",
    checkoutRealpath: checkout,
    nonce: claimedLease.record.nonce,
    createdAt: claimedLease.record.createdAt,
    updatedAt: claimedLease.record.createdAt,
    coordinator: claimedLease.record.owner,
    services: []
  } : parseControlRecord(frozenControlText, checkout, localDirectory);
  if (claimedLease !== undefined && (record.nonce !== claimedLease.record.nonce || !identityMatches(record.coordinator, claimedLease.record.owner))) {
    throw refuse("startup lease and control record ownership differ");
  }
  if (claimedLease !== undefined && ownerNonce === undefined) {
    await stopCoordinator(claimedLease.record.owner, { termTimeoutMs, killTimeoutMs, inspect });
  }
  record = await prepareGatedServices(record, checkout, inspect, termTimeoutMs);
  await verifyRecordedServices(record, inspect);
  await stopServiceProcesses({ record, checkout, termTimeoutMs, killTimeoutMs, enumerateChildPids, enumerateGroupPids, inspect });
  for (const service of record.services) if (!await listenerIsClosed(service.port)) throw refuse(`${service.name} listener is still open`);
  if (await readOptionalFile(controlPath) !== frozenControlText) throw refuse("control record changed during stop");
  if (claimedLease !== undefined && await readFile(claimedLease.path, "utf8") !== claimedLease.text) throw refuse("claimed startup lease changed during stop");
  if (frozenControlText !== undefined) await rm(controlPath);
  if (claimedLease !== undefined) await rm(claimedLease.path);
  for (const service of record.services) {
    if (service.gate !== undefined) {
      await rm(service.gate.registrationPath, { force: true });
      await rm(service.gate.releasePath, { force: true });
      await rm(service.gate.cancelPath, { force: true });
    }
    await rm(service.logPath, { force: true });
  }
  await beforeStopClaimRelease?.(stopClaim.record);
  await releaseOwnedStopClaim(stopClaim, inspect);
  claimReleased = true;
  await rmdir(localDirectory).catch((error) => { if (error?.code !== "ENOTEMPTY" && error?.code !== "ENOENT") throw error; });
  return { status: "stopped" };
  } catch (error) {
    if (!claimReleased) {
      try { await releaseOwnedStopClaim(stopClaim, inspect); }
      catch (claimError) {
        throw new AggregateError([error, claimError], "Stop failed and its ownership claim could not be released.", { cause: claimError });
      }
    }
    throw error;
  }
};
