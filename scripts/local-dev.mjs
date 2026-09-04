import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, link, lstat, mkdir, open, readFile, realpath, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  CONTROL_VERSION,
  acquireStartupLease,
  inspectProcess,
  releaseOwnedStartupLease,
  stopControlledStack,
  writeOwnedControlRecord
} from "./stop-local-core.mjs";
import { createE2eEnvironment, createViteServiceEnvironment } from "./e2e-environment.mjs";
import { seedLocalFixtures } from "./local-fixtures.mjs";

const run = promisify(execFile);
const checkoutPath = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const supervisorPath = join(checkoutPath, "scripts", "service-supervisor.mjs");
const ports = [4280, 5173, 7071];
const driveKeys = [
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "NXT_VAULT_DRIVE_FOLDER_ID", "NXT_PRIVATE_DRIVE_FOLDER_ID",
  "NXT_NOTES_DRIVE_FOLDER_ID", "NXT_INBOX_DRIVE_FOLDER_ID", "NXT_PLANS_DRIVE_FOLDER_ID", "NXT_ARCHIVE_DRIVE_FOLDER_ID",
  "NXT_ASSETS_DRIVE_FOLDER_ID", "NXT_PUBLISHED_DRIVE_FOLDER_ID", "NXT_VAULT_INDEX_DRIVE_FILE_ID",
  "NXT_PREFERENCES_DRIVE_FILE_ID", "NXT_PUBLICATION_MANIFEST_DRIVE_FILE_ID"
];
const localRuntimeKeys = ["NXT_LOCAL_STORAGE_MODE", "NXT_LOCAL_FIXTURE_ROOT", "NXT_LOCAL_CHECKOUT_ROOT", "NXT_LOCAL_CONTROL_NONCE"];
export const FUNCTIONS_HOST_LOCAL_SANDBOX_PROFILE = '(version 1) (allow default) (deny network-inbound (require-all (remote ip "*:*") (require-not (remote ip "localhost:*"))))';

const findExecutable = async (name) => {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = join(directory, name);
    try { await access(candidate, constants.X_OK); return candidate; } catch { continue; }
  }
  throw new Error(`Required executable ${name} was not found.`);
};

const versionTuple = (value) => value.split(".").map(Number);
const versionAtLeast = (actual, minimum) => {
  const left = versionTuple(actual);
  const right = versionTuple(minimum);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) > (right[index] ?? 0);
  }
  return true;
};

export const preflightTools = async () => {
  if (process.versions.node.split(".")[0] !== "22") throw new Error("Local NXT lifecycle requires Node 22.");
  const func = await findExecutable("func");
  const pnpm = await findExecutable("pnpm");
  if (process.platform !== "darwin") throw new Error("The fail-closed Functions host-local sandbox currently requires macOS.");
  await access("/usr/bin/sandbox-exec", constants.X_OK).catch(() => {
    throw new Error("The macOS sandbox required for host-local Functions is unavailable.");
  });
  const funcMain = await realpath(func);
  const funcHostPath = join(dirname(dirname(funcMain)), "bin", "func");
  await access(funcHostPath, constants.X_OK).catch(() => { throw new Error("The real Functions Core Tools host binary is unavailable."); });
  const funcVersion = (await run(funcHostPath, ["--version"], { encoding: "utf8" })).stdout.trim();
  if (!/^4\.[0-9]+\.[0-9]+$/u.test(funcVersion) || !versionAtLeast(funcVersion, "4.0.5382")) {
    throw new Error("Azure Functions Core Tools v4 >= 4.0.5382 is required.");
  }
  const enforcementScript = [
    'const server = require("node:net").createServer();',
    'server.once("error", (error) => process.exit(error.code === "EPERM" ? 0 : 2));',
    'server.listen(0, "127.0.0.1", () => process.exit(3));'
  ].join("");
  try {
    await run("/usr/bin/sandbox-exec", ["-p", "(version 1) (allow default) (deny network-inbound)", process.execPath, "-e", enforcementScript], {
      timeout: 3_000,
      maxBuffer: 1024 * 1024
    });
  } catch (error) {
    throw new Error(`The macOS inbound-network sandbox enforcement check failed (${error?.code ?? "unknown"}).`, { cause: error });
  }
  return { node: process.versions.node, func: funcVersion, funcHostPath, pnpmPath: pnpm };
};

const probePort = async (port) => new Promise((resolvePromise, reject) => {
  const server = createServer();
  server.unref();
  server.once("error", (error) => reject(new Error(`Refusing occupied local port ${port}: ${error.code ?? "unavailable"}.`)));
  server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(resolvePromise));
});

export const assertPortsAvailable = async (expectedPorts = ports) => {
  for (const port of expectedPorts) await probePort(port);
};

const childPids = async (pid) => {
  try {
    const { stdout } = await run("/usr/bin/pgrep", ["-P", String(pid)], { encoding: "utf8" });
    return stdout.trim().split(/\s+/u).filter(Boolean).map(Number).filter(Number.isSafeInteger);
  } catch (error) {
    if (error?.code === 1) return [];
    throw error;
  }
};

const descendants = async (pid) => {
  const found = [];
  const queue = [pid];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const child of await childPids(parent)) {
      if (seen.has(child)) continue;
      seen.add(child);
      found.push(child);
      queue.push(child);
    }
  }
  return found;
};

const waitForListener = async (child, port, onLauncherIdentity, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Local child exited before port ${port} became ready.`);
    const launcher = await inspectProcess(child.pid);
    if (launcher === null) throw new Error(`Local child identity disappeared before port ${port} became ready.`);
    await onLauncherIdentity(launcher);
    if (launcher.listeningPorts.includes(port)) return launcher;
    for (const pid of await descendants(child.pid)) {
      const observed = await inspectProcess(pid);
      if (observed?.listeningPorts.includes(port)) return observed;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for local port ${port}.`);
};

const ensureLocalDirectory = async (checkout, localDirectory) => {
  let metadata;
  try { metadata = await lstat(localDirectory); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (metadata?.isSymbolicLink() || (metadata !== undefined && !metadata.isDirectory())) throw new Error("Refusing unsafe .nxt-local path.");
  if (metadata !== undefined && await realpath(localDirectory) !== localDirectory) throw new Error("Refusing foreign .nxt-local path.");
  await mkdir(localDirectory, { recursive: true, mode: 0o700 });
  await chmod(localDirectory, 0o700);
  if (!localDirectory.startsWith(`${checkout}${sep}`)) throw new Error("Refusing foreign local lifecycle directory.");
};

const clearOwnedStaleLogs = async (localDirectory) => {
  for (const entry of await readdir(localDirectory)) {
    if (/^(?:vite|functions|swa)\.log$/u.test(entry)) await rm(join(localDirectory, entry), { force: true });
    else if (entry !== "control.json" && entry !== "startup.lock") throw new Error("Refusing unexpected local lifecycle artifact.");
  }
};

const resolvePackageBin = async (packageName, relativeBin, from) => {
  const packagePath = createRequire(join(from, "package.json")).resolve(`${packageName}/package.json`);
  return join(dirname(packagePath), relativeBin);
};

const spawnGated = async ({ name, executable, args, cwd, env, localDirectory, gate }) => {
  const logPath = join(localDirectory, `${name}.log`);
  const log = await open(logPath, "a", 0o600);
  const child = spawn(process.execPath, [supervisorPath], {
    cwd,
    env: {
      ...env,
      NXT_SERVICE_GATE_NONCE: gate.nonce,
      NXT_SERVICE_GATE_REGISTRATION: gate.registrationPath,
      NXT_SERVICE_GATE_RELEASE: gate.releasePath,
      NXT_SERVICE_GATE_CANCEL: gate.cancelPath,
      NXT_SERVICE_EXECUTABLE: executable,
      NXT_SERVICE_ARGS: JSON.stringify(args),
      NXT_SERVICE_CWD: cwd
    },
    detached: true,
    stdio: ["ignore", log.fd, log.fd]
  });
  child.unref();
  await log.close();
  return { child, logPath };
};

const writeGate = async (path, nonce) => {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ version: 1, nonce })}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
};

export const parseCompleteSupervisorRegistration = (text) =>
  text.endsWith("\n") ? JSON.parse(text) : undefined;

const writeFunctionsAttestation = async ({ path, localDirectory, checkoutRealpath, fixtureRoot, nonce, service }) => {
  if (path !== join(localDirectory, "functions.attestation.json") || service.name !== "functions" || service.status !== "ready" ||
    service.port !== 7071 || service.cwd !== join(checkoutRealpath, "api") || service.logPath !== join(localDirectory, "functions.log")) {
    throw new Error("Refusing invalid Functions runtime attestation.");
  }
  const functions = Object.fromEntries(["pid", "pgid", "startTime", "cwd", "executable", "command", "port", "logPath"]
    .map((key) => [key, service[key]]));
  const temporary = join(localDirectory, `.functions-attestation-${process.pid}-${randomUUID()}.tmp`);
  const text = `${JSON.stringify({ version: 1, checkoutRealpath, fixtureRoot, nonce, functions }, null, 2)}\n`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    throw new Error("Functions runtime attestation could not be committed atomically.", { cause: error });
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
};

const waitForSupervisorRegistration = async (child, gate, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Service supervisor exited before registration.");
    try {
      const metadata = await lstat(gate.registrationPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Unsafe service supervisor registration.");
      const registration = parseCompleteSupervisorRegistration(await readFile(gate.registrationPath, "utf8"));
      if (registration === undefined) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
        continue;
      }
      if (registration?.version !== 1 || registration?.nonce !== gate.nonce || registration?.identity?.pid !== child.pid) {
        throw new Error("Invalid service supervisor registration.");
      }
      const observed = await inspectProcess(child.pid);
      if (observed === null || !sameIdentity(registration.identity, observed)) throw new Error("Service supervisor identity changed during registration.");
      return observed;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("Timed out waiting for service supervisor registration.");
};

const sameIdentity = (left, right) => left.pid === right.pid && left.pgid === right.pgid && left.startTime === right.startTime &&
  left.cwd === right.cwd && left.executable === right.executable && left.command === right.command;

const sameProcessInstance = (left, right) => left.pid === right.pid && left.pgid === right.pgid && left.startTime === right.startTime &&
  left.cwd === right.cwd;

const sanitizedBaseEnvironment = () => {
  const environment = { ...process.env };
  delete environment.NXT_LOCAL_AUTH_BYPASS;
  for (const key of localRuntimeKeys) delete environment[key];
  return createE2eEnvironment(environment);
};

export const startLocalStack = async ({ checkout = checkoutPath, localFixtures = false, testHooks } = {}) => {
  const checkoutRealpath = await realpath(checkout);
  const localDirectory = join(checkoutRealpath, ".nxt-local");
  const controlPath = join(localDirectory, "control.json");
  for (const key of driveKeys) {
    if (typeof process.env[key] === "string" && process.env[key].trim().length > 0) throw new Error(`Refusing live Drive environment key ${key}.`);
  }
  const tools = await preflightTools();
  await access(supervisorPath, constants.R_OK);
  await ensureLocalDirectory(checkoutRealpath, localDirectory);
  const nonce = randomUUID();
  const lease = await acquireStartupLease({ checkoutPath: checkoutRealpath, controlPath, nonce });
  const services = [];
  const baseEnvironment = sanitizedBaseEnvironment();
  const fixtureRoot = localFixtures ? join(localDirectory, "fixtures", "playwright") : undefined;
  const runtimeAttestationPath = fixtureRoot === undefined ? undefined : join(localDirectory, "functions.attestation.json");
  let interrupted = false;
  let record = {
    version: CONTROL_VERSION,
    state: "starting",
    checkoutRealpath,
    nonce,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    coordinator: lease.record.owner,
    ...(fixtureRoot === undefined ? {} : { fixtureRoot, runtimeAttestationPath }),
    services
  };
  const persist = async (state = "starting") => {
    record = { ...record, state, updatedAt: new Date().toISOString(), services: [...services] };
    await writeOwnedControlRecord(controlPath, record, lease);
  };
  const cleanup = async () => stopControlledStack({ checkoutPath: checkoutRealpath, controlPath, ownerNonce: nonce });
  const onSignal = () => { interrupted = true; };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await persist();
    await clearOwnedStaleLogs(localDirectory);
    await assertPortsAvailable();
    await testHooks?.afterLease?.();
    if (interrupted) throw new Error("Local startup was interrupted.");

    await run(tools.pnpmPath, ["build"], { cwd: checkoutRealpath, env: baseEnvironment, maxBuffer: 20 * 1024 * 1024 });
    if (interrupted) throw new Error("Local startup was interrupted.");
    await run(tools.pnpmPath, ["api:build"], { cwd: checkoutRealpath, env: baseEnvironment, maxBuffer: 20 * 1024 * 1024 });
    if (interrupted) throw new Error("Local startup was interrupted.");
    await run(tools.pnpmPath, ["artifact:verify"], { cwd: checkoutRealpath, env: baseEnvironment, maxBuffer: 20 * 1024 * 1024 });
    if (interrupted) throw new Error("Local startup was interrupted.");
    if (fixtureRoot !== undefined) {
      await seedLocalFixtures({ checkoutPath: checkoutRealpath, fixtureRoot, environment: baseEnvironment });
      if (interrupted) throw new Error("Local startup was interrupted.");
    }
    const vitePackage = createRequire(join(checkoutRealpath, "web", "package.json")).resolve("vite/package.json");
    const viteBin = join(dirname(vitePackage), "bin/vite.js");
    const swaBin = await resolvePackageBin("@azure/static-web-apps-cli", "dist/cli/bin.js", checkoutRealpath);

    const addService = async ({ name, executable, args, cwd, env, port }) => {
      const index = services.length;
      const gateNonce = randomUUID();
      const gatePrefix = join(localDirectory, `.gate-${name}-${gateNonce}`);
      const gate = {
        nonce: gateNonce,
        registrationPath: `${gatePrefix}.registration.json`,
        releasePath: `${gatePrefix}.release.json`,
        cancelPath: `${gatePrefix}.cancel.json`
      };
      const logPath = join(localDirectory, `${name}.log`);
      services.push({ name, status: "planned", gate, port, logPath, nonce });
      await persist();
      await testHooks?.afterServicePlanned?.(name, services[index]);
      if (interrupted) throw new Error("Local startup was interrupted.");
      const { child } = await spawnGated({ name, executable, args, cwd, env, localDirectory, gate });
      await testHooks?.afterSupervisorSpawn?.(name, { pid: child.pid });
      if (interrupted) throw new Error("Local startup was interrupted.");
      services[index] = { name, status: "planned", candidatePid: child.pid, gate, port, logPath, nonce };
      await persist();
      let launcherIdentity = await waitForSupervisorRegistration(child, gate);
      services[index] = { name, status: "gated", launcher: launcherIdentity, gate, port, logPath, nonce };
      await persist();
      await testHooks?.beforeServiceRelease?.(name, launcherIdentity);
      if (interrupted) throw new Error("Local startup was interrupted.");
      await writeGate(gate.releasePath, gate.nonce);
      const listener = await waitForListener(child, port, async (observed) => {
        if (sameIdentity(launcherIdentity, observed)) return;
        if (!sameProcessInstance(launcherIdentity, observed)) throw new Error(`${name} launcher process instance changed before readiness.`);
        launcherIdentity = observed;
        services[index] = { name, status: "gated", launcher: launcherIdentity, gate, port, logPath, nonce };
        await persist();
      });
      const finalLauncher = await inspectProcess(child.pid);
      if (finalLauncher === null || !sameIdentity(launcherIdentity, finalLauncher)) throw new Error(`${name} launcher identity changed before readiness.`);
      services[index] = {
        name,
        status: "ready",
        pid: listener.pid,
        pgid: listener.pgid,
        startTime: listener.startTime,
        cwd: listener.cwd,
        executable: listener.executable,
        command: listener.command,
        port,
        logPath,
        gate,
        nonce,
        ...(listener.pid === child.pid ? {} : { launcher: launcherIdentity })
      };
      await persist();
      await testHooks?.afterService?.(name);
      if (interrupted) throw new Error("Local startup was interrupted.");
    };

    await addService({
      name: "vite", executable: process.execPath, args: [viteBin, "--host", "127.0.0.1", "--port", "5173", "--strictPort"],
      cwd: join(checkoutRealpath, "web"), env: createViteServiceEnvironment(baseEnvironment, localFixtures), port: 5173
    });
    await addService({
      name: "functions", executable: "/usr/bin/sandbox-exec",
      args: ["-p", FUNCTIONS_HOST_LOCAL_SANDBOX_PROFILE, tools.funcHostPath, "start", "--port", "7071", "--cors", "http://127.0.0.1:4280"],
      cwd: join(checkoutRealpath, "api"),
      env: {
        ...baseEnvironment,
        NODE_ENV: "development",
        AZURE_FUNCTIONS_ENVIRONMENT: "Development",
        FUNCTIONS_WORKER_RUNTIME: "node",
        NXT_LOCAL_AUTH_BYPASS: "1",
        NXT_ALLOWED_GITHUB_USER: process.env.NXT_ALLOWED_GITHUB_USER?.trim() || "aserdargun",
        ...(fixtureRoot === undefined ? {} : {
          NXT_LOCAL_STORAGE_MODE: "filesystem",
          NXT_LOCAL_FIXTURE_ROOT: fixtureRoot,
          NXT_LOCAL_CHECKOUT_ROOT: checkoutRealpath,
          NXT_LOCAL_CONTROL_NONCE: nonce
        })
      },
      port: 7071
    });
    if (fixtureRoot !== undefined && runtimeAttestationPath !== undefined) {
      const functions = services.find(({ name }) => name === "functions");
      if (functions === undefined) throw new Error("Functions identity is unavailable for runtime attestation.");
      await writeFunctionsAttestation({
        path: runtimeAttestationPath, localDirectory, checkoutRealpath, fixtureRoot, nonce, service: functions
      });
    }
    await addService({
      name: "swa", executable: process.execPath,
      args: [swaBin, "start", "http://127.0.0.1:5173", "--api-devserver-url", "http://127.0.0.1:7071", "--swa-config-location", join(checkoutRealpath, "web", "public"), "--host", "127.0.0.1", "--port", "4280"],
      cwd: checkoutRealpath, env: baseEnvironment, port: 4280
    });
    await persist("ready");
    for (const service of services) {
      const observed = await inspectProcess(service.pid);
      if (observed === null || !sameIdentity(service, observed) || !observed.listeningPorts.includes(service.port)) {
        throw new Error(`${service.name} identity changed while recording startup.`);
      }
    }
    await releaseOwnedStartupLease(lease);
    return { url: "http://127.0.0.1:4280", localDirectory, tools, services };
  } catch (error) {
    try { await cleanup(); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Local startup failed and owned cleanup could not be proven.", { cause: cleanupError });
    }
    throw error;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
};

if (process.argv.includes("--check")) {
  const tools = await preflightTools();
  process.stdout.write(`Node ${tools.node}; Functions Core Tools ${tools.func}.\n`);
} else if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const result = await startLocalStack({ localFixtures: process.argv.includes("--e2e") });
  process.stdout.write(`NXT is ready at ${result.url}. Logs: ${result.localDirectory}.\n`);
}
