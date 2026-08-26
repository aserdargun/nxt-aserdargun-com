import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, open, realpath, readdir, rm, rmdir } from "node:fs/promises";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { CONTROL_VERSION, inspectProcess, writeControlRecord } from "./stop-local-core.mjs";

const run = promisify(execFile);
const checkoutPath = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ports = [4280, 5173, 7071];
const driveKeys = [
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "NXT_VAULT_DRIVE_FOLDER_ID", "NXT_PRIVATE_DRIVE_FOLDER_ID",
  "NXT_NOTES_DRIVE_FOLDER_ID", "NXT_INBOX_DRIVE_FOLDER_ID", "NXT_PLANS_DRIVE_FOLDER_ID", "NXT_ARCHIVE_DRIVE_FOLDER_ID",
  "NXT_ASSETS_DRIVE_FOLDER_ID", "NXT_PUBLISHED_DRIVE_FOLDER_ID", "NXT_VAULT_INDEX_DRIVE_FILE_ID",
  "NXT_PREFERENCES_DRIVE_FILE_ID", "NXT_PUBLICATION_MANIFEST_DRIVE_FILE_ID"
];
export const FUNCTIONS_HOST_LOCAL_SANDBOX_PROFILE = '(version 1) (allow default) (deny network-inbound (require-all (remote ip "*:*") (require-not (remote ip "localhost:*"))))';

const findExecutable = async (name) => {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
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

const waitForListener = async (child, port, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Local child exited before port ${port} became ready.`);
    const candidates = [child.pid, ...await descendants(child.pid)];
    for (const pid of candidates) {
      const observed = await inspectProcess(pid);
      if (observed?.listeningPorts.includes(port)) return observed;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for local port ${port}.`);
};

const terminateLaunched = async (children) => {
  for (const child of children.toReversed()) {
    const observed = await inspectProcess(child.pid);
    if (observed !== null && observed.startTime === child.identity?.startTime) {
      try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
    }
  }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && children.some((child) => child.exitCode === null)) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  for (const child of children.toReversed()) {
    if (child.exitCode === null) {
      const observed = await inspectProcess(child.pid);
      if (observed !== null && observed.startTime === child.identity?.startTime) {
        try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
      }
    }
  }
};

const ensureLocalDirectory = async (checkout, localDirectory, controlPath) => {
  let metadata;
  try { metadata = await lstat(localDirectory); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (metadata?.isSymbolicLink() || (metadata !== undefined && !metadata.isDirectory())) throw new Error("Refusing unsafe .nxt-local path.");
  if (metadata !== undefined && await realpath(localDirectory) !== localDirectory) throw new Error("Refusing foreign .nxt-local path.");
  try {
    await lstat(controlPath);
    throw new Error("Refusing an existing local control record. Run Stop after verifying its ownership.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(localDirectory, { recursive: true, mode: 0o700 });
  await chmod(localDirectory, 0o700);
  for (const entry of await readdir(localDirectory)) {
    if (!/^(?:vite|functions|swa)\.log$/u.test(entry)) throw new Error("Refusing unexpected local lifecycle artifact.");
    await rm(join(localDirectory, entry), { force: true });
  }
  if (!localDirectory.startsWith(`${checkout}${sep}`)) throw new Error("Refusing foreign local lifecycle directory.");
};

const resolvePackageBin = async (packageName, relativeBin, from) => {
  const packagePath = createRequire(join(from, "package.json")).resolve(`${packageName}/package.json`);
  return join(dirname(packagePath), relativeBin);
};

const spawnLogged = async ({ name, executable, args, cwd, env, localDirectory }) => {
  const logPath = join(localDirectory, `${name}.log`);
  const log = await open(logPath, "a", 0o600);
  const child = spawn(executable, args, { cwd, env, detached: true, stdio: ["ignore", log.fd, log.fd] });
  child.unref();
  await log.close();
  child.identity = await inspectProcess(child.pid);
  if (child.identity === null) throw new Error(`${name} failed before identity observation.`);
  return { child, logPath };
};

const removeKnownLocalArtifacts = async (localDirectory) => {
  for (const name of ["control.json", "vite.log", "functions.log", "swa.log"]) await rm(join(localDirectory, name), { force: true });
  await rmdir(localDirectory).catch((error) => {
    if (error?.code !== "ENOTEMPTY" && error?.code !== "ENOENT") throw error;
  });
};

export const startLocalStack = async ({ checkout = checkoutPath, testHooks } = {}) => {
  const checkoutRealpath = await realpath(checkout);
  const localDirectory = join(checkoutRealpath, ".nxt-local");
  const controlPath = join(localDirectory, "control.json");
  for (const key of driveKeys) {
    if (typeof process.env[key] === "string" && process.env[key].trim().length > 0) throw new Error(`Refusing live Drive environment key ${key}.`);
  }
  const tools = await preflightTools();
  await assertPortsAvailable();
  await ensureLocalDirectory(checkoutRealpath, localDirectory, controlPath);
  let viteBin;
  let swaBin;
  try {
    await run(tools.pnpmPath, ["build"], { cwd: checkoutRealpath, env: process.env, maxBuffer: 20 * 1024 * 1024 });
    await run(tools.pnpmPath, ["api:build"], { cwd: checkoutRealpath, env: process.env, maxBuffer: 20 * 1024 * 1024 });
    await run(tools.pnpmPath, ["artifact:verify"], { cwd: checkoutRealpath, env: process.env, maxBuffer: 20 * 1024 * 1024 });
    const vitePackage = createRequire(join(checkoutRealpath, "web", "package.json")).resolve("vite/package.json");
    viteBin = join(dirname(vitePackage), "bin/vite.js");
    swaBin = await resolvePackageBin("@azure/static-web-apps-cli", "dist/cli/bin.js", checkoutRealpath);
  } catch (error) {
    await removeKnownLocalArtifacts(localDirectory);
    throw error;
  }
  const nonce = randomUUID();
  const launched = [];
  const services = [];
  let interrupted = false;
  const addService = async ({ name, executable, args, cwd, env, port }) => {
    const { child, logPath } = await spawnLogged({ name, executable, args, cwd, env, localDirectory });
    launched.push(child);
    const listener = await waitForListener(child, port);
    child.identity = await inspectProcess(child.pid);
    if (child.identity === null) throw new Error(`${name} launcher identity changed before readiness.`);
    const launcher = listener.pid === child.pid ? undefined : child.identity;
    services.push({
      name,
      pid: listener.pid,
      startTime: listener.startTime,
      cwd: listener.cwd,
      executable: listener.executable,
      command: listener.command,
      port,
      logPath,
      nonce,
      ...(launcher === undefined ? {} : { launcher })
    });
    await testHooks?.afterService?.(name);
    if (interrupted) throw new Error("Local startup was interrupted.");
  };
  const cleanup = async () => {
    await terminateLaunched(launched);
    await removeKnownLocalArtifacts(localDirectory);
  };
  const onSignal = () => { interrupted = true; };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await addService({
      name: "vite", executable: process.execPath, args: [viteBin, "--host", "127.0.0.1", "--port", "5173", "--strictPort"],
      cwd: join(checkoutRealpath, "web"), env: process.env, port: 5173
    });
    await addService({
      name: "functions", executable: "/usr/bin/sandbox-exec",
      args: ["-p", FUNCTIONS_HOST_LOCAL_SANDBOX_PROFILE, tools.funcHostPath, "start", "--port", "7071", "--cors", "http://127.0.0.1:4280"],
      cwd: join(checkoutRealpath, "api"),
      env: {
        ...process.env,
        NODE_ENV: "development",
        AZURE_FUNCTIONS_ENVIRONMENT: "Development",
        FUNCTIONS_WORKER_RUNTIME: "node",
        NXT_LOCAL_AUTH_BYPASS: "1",
        NXT_ALLOWED_GITHUB_USER: process.env.NXT_ALLOWED_GITHUB_USER?.trim() || "aserdargun"
      },
      port: 7071
    });
    await addService({
      name: "swa", executable: process.execPath,
      args: [swaBin, "start", "http://127.0.0.1:5173", "--api-devserver-url", "http://127.0.0.1:7071", "--swa-config-location", join(checkoutRealpath, "web", "public"), "--host", "127.0.0.1", "--port", "4280"],
      cwd: checkoutRealpath, env: process.env, port: 4280
    });
    if (interrupted) throw new Error("Local startup was interrupted.");
    const record = {
      version: CONTROL_VERSION,
      checkoutRealpath,
      nonce,
      createdAt: new Date().toISOString(),
      services
    };
    await writeControlRecord(controlPath, record);
    for (const service of services) {
      const observed = await inspectProcess(service.pid);
      if (observed === null || observed.startTime !== service.startTime || observed.command !== service.command || !observed.listeningPorts.includes(service.port)) {
        throw new Error(`${service.name} identity changed while recording startup.`);
      }
    }
    return { url: "http://127.0.0.1:4280", localDirectory, tools, services };
  } catch (error) {
    await cleanup();
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
  const result = await startLocalStack();
  process.stdout.write(`NXT is ready at ${result.url}. Logs: ${result.localDirectory}.\n`);
}
