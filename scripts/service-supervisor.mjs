import { spawn } from "node:child_process";
import { chmod, lstat, open, readFile } from "node:fs/promises";

import { inspectProcess } from "./stop-local-core.mjs";

const required = (name) => {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing supervisor setting ${name}.`);
  return value;
};

const nonce = required("NXT_SERVICE_GATE_NONCE");
const registrationPath = required("NXT_SERVICE_GATE_REGISTRATION");
const releasePath = required("NXT_SERVICE_GATE_RELEASE");
const cancelPath = required("NXT_SERVICE_GATE_CANCEL");
const executable = required("NXT_SERVICE_EXECUTABLE");
const args = JSON.parse(required("NXT_SERVICE_ARGS"));
const cwd = required("NXT_SERVICE_CWD");

if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) throw new Error("Invalid supervised service arguments.");

const readGate = async (path) => {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Unsafe service gate file.");
    const value = JSON.parse(await readFile(path, "utf8"));
    return value?.version === 1 && value?.nonce === nonce;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};

const identity = await inspectProcess(process.pid);
if (identity === null) throw new Error("Supervisor identity could not be observed.");
const cancelledBeforeRegistration = await readGate(cancelPath);
const registration = `${JSON.stringify({ version: 1, nonce, identity }, null, 2)}\n`;
const registrationHandle = await open(registrationPath, "wx", 0o600);
try {
  await registrationHandle.writeFile(registration, "utf8");
  await registrationHandle.sync();
} finally {
  await registrationHandle.close();
}
await chmod(registrationPath, 0o600);
if (cancelledBeforeRegistration || await readGate(cancelPath)) process.exit(0);

let released = false;
while (!released) {
  if (await readGate(cancelPath)) process.exit(0);
  released = await readGate(releasePath);
  if (released && await readGate(cancelPath)) process.exit(0);
  if (!released) await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
}
if (await readGate(cancelPath)) process.exit(0);

const childEnvironment = { ...process.env };
for (const name of Object.keys(childEnvironment)) if (name.startsWith("NXT_SERVICE_")) delete childEnvironment[name];
const child = spawn(executable, args, { cwd, env: childEnvironment, detached: false, stdio: "inherit" });

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill(signal); } catch (error) { if (error?.code !== "ESRCH") throw error; }
    }
  });
}

const result = await new Promise((resolvePromise, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolvePromise({ code, signal }));
});
process.exitCode = result.code ?? (result.signal === null ? 1 : 128);
