import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDENTITY_KEYS = ["command", "cwd", "executable", "logPath", "pgid", "pid", "port", "startTime"] as const;

export interface RuntimeProcessObservation {
  readonly pid: number;
  readonly parentPid: number;
  readonly pgid: number;
  readonly startTime: string;
  readonly cwd: string;
  readonly executable: string;
  readonly command: string;
}

interface RecordedIdentity {
  readonly pid: number;
  readonly pgid: number;
  readonly startTime: string;
  readonly cwd: string;
  readonly executable: string;
  readonly command: string;
}

const refusal = (): Error => new Error("Local runtime ownership could not be verified.");
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const isInside = (path: string, checkout: string): boolean => path === checkout || path.startsWith(`${checkout}${sep}`);
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());

const runObserved = async (file: string, args: readonly string[]): Promise<string> => {
  try {
    return (await run(file, [...args], { encoding: "utf8", timeout: 2_000, maxBuffer: 1024 * 1024 })).stdout.trim();
  } catch (error) {
    if ((error as { readonly code?: string | number }).code === 1) return "";
    throw error;
  }
};

const observeCwd = async (pid: number): Promise<string> => {
  if (process.platform === "linux") return realpath(`/proc/${pid}/cwd`).catch(() => "");
  const output = await runObserved("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  return output.split("\n").find((line) => line.startsWith("n"))?.slice(1) ?? "";
};

export const inspectRuntimeProcess = async (pid: number): Promise<RuntimeProcessObservation | null> => {
  if (!positiveInteger(pid)) return null;
  const [parentText, pgidText, startTime, executable, command, cwd] = await Promise.all([
    runObserved("/bin/ps", ["-p", String(pid), "-o", "ppid="]),
    runObserved("/bin/ps", ["-p", String(pid), "-o", "pgid="]),
    runObserved("/bin/ps", ["-p", String(pid), "-o", "lstart="]),
    runObserved("/bin/ps", ["-p", String(pid), "-o", "comm="]),
    runObserved("/bin/ps", ["-p", String(pid), "-o", "command="]),
    observeCwd(pid)
  ]);
  const parentPid = Number(parentText);
  const pgid = Number(pgidText);
  if (!positiveInteger(parentPid) || !positiveInteger(pgid) || startTime.length === 0 || executable.length === 0 ||
    command.length === 0 || cwd.length === 0) return null;
  return { pid, parentPid, pgid, startTime, cwd, executable, command };
};

const sameIdentity = (expected: RecordedIdentity, observed: RuntimeProcessObservation | null): boolean =>
  observed !== null && expected.pid === observed.pid && expected.pgid === observed.pgid &&
  expected.startTime === observed.startTime && expected.cwd === observed.cwd &&
  expected.executable === observed.executable && expected.command === observed.command;

const parseIdentity = (value: unknown, checkout: string): RecordedIdentity => {
  if (!isObject(value) || !positiveInteger(value.pid) || !positiveInteger(value.pgid) ||
    typeof value.startTime !== "string" || value.startTime.length === 0 || typeof value.cwd !== "string" ||
    typeof value.executable !== "string" || value.executable.length === 0 || typeof value.command !== "string" ||
    value.command.length === 0 || !isInside(resolve(value.cwd), checkout)) throw refusal();
  return {
    pid: value.pid, pgid: value.pgid, startTime: value.startTime, cwd: value.cwd,
    executable: value.executable, command: value.command
  };
};

const readExactFile = async (path: string): Promise<string> => {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw refusal();
    return await handle.readFile("utf8");
  } catch {
    throw refusal();
  } finally {
    await handle?.close();
  }
};

const readExactControl = async (checkout: string): Promise<string> => {
  const localDirectory = join(checkout, ".nxt-local");
  const localMetadata = await lstat(localDirectory).catch(() => { throw refusal(); });
  if (!localMetadata.isDirectory() || localMetadata.isSymbolicLink() || await realpath(localDirectory) !== localDirectory) throw refusal();
  return readExactFile(join(localDirectory, "control.json"));
};

const parseControl = (text: string, checkout: string, fixtureRoot: string, nonce: string): {
  readonly functions: RecordedIdentity & { readonly port: number; readonly logPath: string };
  readonly attestationPath: string;
} => {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw refusal(); }
  const attestationPath = join(checkout, ".nxt-local", "functions.attestation.json");
  if (!isObject(value) || value.version !== 2 || value.state !== "ready" || value.checkoutRealpath !== checkout ||
    value.fixtureRoot !== fixtureRoot || value.nonce !== nonce || value.runtimeAttestationPath !== attestationPath ||
    !UUID.test(nonce) || !Array.isArray(value.services)) throw refusal();
  const services: unknown[] = value.services;
  const functions = services.filter((service): service is Record<string, unknown> => isObject(service) && service.name === "functions");
  if (functions.length !== 1) throw refusal();
  const service = functions[0];
  if (service?.status !== "ready" || service.port !== 7071 || service.nonce !== nonce ||
    service.logPath !== join(checkout, ".nxt-local", "functions.log")) throw refusal();
  const identity = parseIdentity(service, checkout);
  if (identity.cwd !== join(checkout, "api")) throw refusal();
  return { functions: { ...identity, port: 7071, logPath: join(checkout, ".nxt-local", "functions.log") }, attestationPath };
};

const parseAttestation = (
  text: string,
  checkout: string,
  fixtureRoot: string,
  nonce: string,
  expected: RecordedIdentity & { readonly port: number; readonly logPath: string }
): void => {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw refusal(); }
  if (!isObject(value) || !hasExactKeys(value, ["version", "checkoutRealpath", "fixtureRoot", "nonce", "functions"]) ||
    value.version !== 1 || value.checkoutRealpath !== checkout || value.fixtureRoot !== fixtureRoot || value.nonce !== nonce ||
    !isObject(value.functions) || !hasExactKeys(value.functions, IDENTITY_KEYS)) throw refusal();
  const actual = parseIdentity(value.functions, checkout);
  if (!sameIdentity(expected, { ...actual, parentPid: 1 }) || value.functions.port !== expected.port ||
    value.functions.logPath !== expected.logPath) throw refusal();
};

export const verifyLocalRuntimeOwnership = async ({
  checkoutPath,
  fixtureRoot,
  nonce,
  currentParentPid = process.ppid,
  inspectProcess,
  assertProcessAlive = (pid: number): void => { process.kill(pid, 0); }
}: {
  readonly checkoutPath: string;
  readonly fixtureRoot: string;
  readonly nonce: string;
  readonly currentParentPid?: number;
  readonly inspectProcess?: (pid: number) => Promise<RuntimeProcessObservation | null>;
  readonly assertProcessAlive?: (pid: number) => void;
}): Promise<{ readonly nonce: string; readonly functions: RecordedIdentity }> => {
  let checkout: string;
  try {
    checkout = await realpath(resolve(checkoutPath));
  } catch {
    throw refusal();
  }
  if (checkout !== checkoutPath || fixtureRoot !== join(checkout, ".nxt-local", "fixtures", "playwright")) throw refusal();
  const control = parseControl(await readExactControl(checkout), checkout, fixtureRoot, nonce);
  parseAttestation(await readExactFile(control.attestationPath), checkout, fixtureRoot, nonce, control.functions);
  if (currentParentPid !== control.functions.pid) throw refusal();
  try { assertProcessAlive(control.functions.pid); } catch { throw refusal(); }
  if (inspectProcess !== undefined && !sameIdentity(control.functions, await inspectProcess(control.functions.pid))) throw refusal();
  return { nonce, functions: control.functions };
};
