import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, realpath, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { verifyReleaseIdentity } from "./verify-deployment-contract.mjs";

const exec = promisify(execFile);
const MAX_ENV_BYTES = 64 * 1024;
const MAX_VALUE_BYTES = 4 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const API_VERSION = "2025-05-01";
const settingKeys = Object.freeze([
  "NXT_ALLOWED_GITHUB_USER",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
  "NXT_VAULT_DRIVE_FOLDER_ID",
  "NXT_PRIVATE_DRIVE_FOLDER_ID",
  "NXT_NOTES_DRIVE_FOLDER_ID",
  "NXT_INBOX_DRIVE_FOLDER_ID",
  "NXT_PLANS_DRIVE_FOLDER_ID",
  "NXT_ARCHIVE_DRIVE_FOLDER_ID",
  "NXT_ASSETS_DRIVE_FOLDER_ID",
  "NXT_PUBLISHED_DRIVE_FOLDER_ID",
  "NXT_VAULT_INDEX_DRIVE_FILE_ID",
  "NXT_PREFERENCES_DRIVE_FILE_ID",
  "NXT_PUBLICATION_MANIFEST_DRIVE_FILE_ID"
]);
const settingKeySet = new Set(settingKeys);

const refuse = (message) => new Error(`Refusing Azure release: ${message}.`);
const safeString = (value) => typeof value === "string" ? value : "";
const containsControls = (value) => [...value].some((character) => {
  const code = character.codePointAt(0);
  return code !== undefined && (code <= 31 || code === 127);
});

export const readReleaseEnvironment = async (envFile, { openFile = open } = {}) => {
  const path = resolve(envFile);
  const metadata = await lstat(path).catch(() => { throw refuse("environment file is unavailable"); });
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw refuse("environment file must be a regular non-symlink");
  if ((metadata.mode & 0o777) !== 0o600) throw refuse("environment file must use mode 0600");
  if (metadata.size <= 0 || metadata.size > MAX_ENV_BYTES) throw refuse("environment file size is invalid");
  const canonical = await realpath(path).catch(() => { throw refuse("environment file is unavailable"); });
  if (canonical !== path) throw refuse("environment file path must be canonical");
  let handle;
  try { handle = await openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw refuse("environment file changed or could not be opened"); }
  let source;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.isSymbolicLink() || (opened.mode & 0o777) !== 0o600 || opened.size <= 0 || opened.size > MAX_ENV_BYTES ||
        opened.dev !== metadata.dev || opened.ino !== metadata.ino || opened.size !== metadata.size) {
      throw refuse("environment file changed between validation and open");
    }
    source = await handle.readFile("utf8");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Refusing Azure release:")) throw error;
    throw refuse("environment file changed or could not be read");
  } finally {
    await handle.close().catch(() => undefined);
  }
  const values = {};
  for (const raw of source.split("\n")) {
    if (raw === "" || raw.startsWith("#")) continue;
    const separator = raw.indexOf("=");
    if (separator <= 0) throw refuse("environment line is invalid");
    const key = raw.slice(0, separator);
    const value = raw.slice(separator + 1);
    if (!settingKeySet.has(key)) throw refuse("environment key is unknown");
    if (Object.hasOwn(values, key)) throw refuse("environment key is duplicated");
    if (value.trim() === "" || Buffer.byteLength(value) > MAX_VALUE_BYTES || containsControls(value)) throw refuse("environment value is invalid");
    values[key] = value;
  }
  if (Object.keys(values).length !== settingKeys.length || settingKeys.some((key) => !Object.hasOwn(values, key))) throw refuse("environment keys are incomplete");
  if (values.NXT_ALLOWED_GITHUB_USER !== "aserdargun") throw refuse("exact GitHub owner is required");
  return values;
};

export const defaultAzureRunner = async (file, args) => {
  try {
    const result = await exec(file, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: Number.isInteger(error?.code) ? error.code : 1, stdout: safeString(error?.stdout), stderr: safeString(error?.stderr) };
  }
};

const runChecked = async (runAz, args, label) => {
  let result;
  try { result = await runAz("az", args); }
  catch { throw new Error(`${label} failed.`); }
  if (result?.code !== 0) throw new Error(`${label} failed.`);
  return safeString(result.stdout);
};
const parseJson = (source, label) => {
  try { return JSON.parse(source); }
  catch { throw new Error(`${label} returned invalid JSON.`); }
};
const exactIdentity = (identity) => identity?.repository === "nxt-aserdargun-com";
const safePrincipal = (value) => typeof value === "string" && value.length > 0 && value.length <= 320 && !containsControls(value);

const createSecureSettingsPayload = async ({ values, temporaryParent = tmpdir() }) => {
  let directory;
  let payloadPath;
  try {
    const parent = await realpath(resolve(temporaryParent));
    directory = await mkdtemp(join(parent, "nxt-azure-settings-"));
    await chmod(directory, 0o700);
    const directoryMetadata = await lstat(directory);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink() || (directoryMetadata.mode & 0o777) !== 0o700) throw refuse("secure settings payload directory is invalid");
    payloadPath = join(directory, "appsettings.json");
    const properties = Object.fromEntries([...settingKeys].sort().map((key) => [key, values[key]]));
    const bytes = Buffer.from(`${JSON.stringify({ properties })}\n`, "utf8");
    const handle = await open(payloadPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      const metadata = await handle.stat();
      if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600 || metadata.size !== bytes.byteLength) throw refuse("secure settings payload file is invalid");
    } finally {
      await handle.close().catch(() => undefined);
    }
    if (await realpath(payloadPath) !== payloadPath) throw refuse("secure settings payload path is invalid");
    return {
      path: payloadPath,
      async cleanup() {
        try { await unlink(payloadPath); }
        catch (error) { if (error?.code !== "ENOENT") throw refuse("secure settings payload cleanup failed"); }
        try { await rmdir(directory); }
        catch { throw refuse("secure settings payload cleanup failed"); }
      }
    };
  } catch (error) {
    if (payloadPath !== undefined) await unlink(payloadPath).catch(() => undefined);
    if (directory !== undefined) await rmdir(directory).catch(() => undefined);
    if (error instanceof Error && error.message.startsWith("Refusing Azure release:")) throw error;
    throw refuse("secure settings payload could not be prepared");
  }
};

export const applyAzureSettings = async ({ envFile, identity, runAz = defaultAzureRunner, log = console.log, temporaryParent = tmpdir() }) => {
  if (!exactIdentity(identity)) throw refuse("release identity was not verified");
  const values = await readReleaseEnvironment(envFile);
  const account = parseJson(await runChecked(runAz, ["account", "show", "--only-show-errors", "--output", "json"], "Azure account verification"), "Azure account verification");
  if (!UUID.test(safeString(account?.id)) || account?.state !== "Enabled" || !UUID.test(safeString(account?.tenantId)) ||
      account?.user?.type !== "user" || !safePrincipal(account?.user?.name)) throw refuse("valid enabled Azure subscription identity is required");
  const expectedResourceId = `/subscriptions/${account.id}/resourceGroups/rg-nxt-aserdargun-com/providers/Microsoft.Web/staticSites/swa-nxt-aserdargun-com`;
  const targetArgs = ["--name", "swa-nxt-aserdargun-com", "--resource-group", "rg-nxt-aserdargun-com", "--only-show-errors", "--output", "json"];
  const app = parseJson(await runChecked(runAz, ["staticwebapp", "show", ...targetArgs], "Azure Static Web App verification"), "Azure Static Web App verification");
  if (safeString(app?.id).toLowerCase() !== expectedResourceId.toLowerCase() || app?.name !== "swa-nxt-aserdargun-com" || app?.resourceGroup !== "rg-nxt-aserdargun-com" || app?.provisioningState !== "Succeeded" ||
      app?.sku?.name !== "Free" || safeString(app?.location).replace(/\s+/gu, "").toLowerCase() !== "westeurope" ||
      typeof app?.defaultHostname !== "string" || !app.defaultHostname.endsWith(".azurestaticapps.net")) {
    throw refuse("exact Ready Free Static Web App is required");
  }
  const hostnames = parseJson(await runChecked(runAz, ["staticwebapp", "hostname", "list", ...targetArgs.slice(0, 4), "--only-show-errors", "--output", "json"], "Azure hostname verification"), "Azure hostname verification");
  if (!Array.isArray(hostnames) || hostnames.length !== 0) throw refuse("custom hostnames must be empty");
  const sortedKeys = [...settingKeys].sort();
  const payload = await createSecureSettingsPayload({ values, temporaryParent });
  let mutationFailure;
  try {
    await runChecked(runAz, [
      "rest", "--method", "put",
      "--url", `${expectedResourceId}/config/appsettings?api-version=${API_VERSION}`,
      "--body", `@${payload.path}`,
      "--only-show-errors", "--output", "none"
    ], "Azure settings mutation");
  } catch (error) {
    mutationFailure = error;
  }
  await payload.cleanup();
  if (mutationFailure !== undefined) throw mutationFailure;
  log(`Azure settings applied: ${sortedKeys.join(", ")}.`);
  return { keyCount: sortedKeys.length, keys: sortedKeys };
};

export const runAzureReleaseCli = async ({ cwd = process.cwd(), argv = process.argv.slice(2), runAz = defaultAzureRunner, log = console.log }) => {
  if (argv.length !== 3 || argv[0] !== "apply" || argv[1] !== "--env-file") throw new Error("Usage: azure-static-web-app-release.mjs apply --env-file .env.local");
  const identity = await verifyReleaseIdentity({ checkoutPath: cwd });
  return applyAzureSettings({ envFile: resolve(cwd, argv[2]), identity, runAz, log });
};

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runAzureReleaseCli({}).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Azure release failed."}\n`);
    process.exitCode = 1;
  });
}
