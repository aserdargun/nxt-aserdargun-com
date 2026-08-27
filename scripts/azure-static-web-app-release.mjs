import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { verifyReleaseIdentity } from "./verify-deployment-contract.mjs";

const exec = promisify(execFile);
const MAX_ENV_BYTES = 64 * 1024;
const MAX_VALUE_BYTES = 4 * 1024;
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
  await realpath(path);
  const handle = await openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let source;
  try { source = await handle.readFile("utf8"); }
  finally { await handle.close(); }
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

export const applyAzureSettings = async ({ envFile, identity, runAz = defaultAzureRunner, log = console.log }) => {
  if (!exactIdentity(identity)) throw refuse("release identity was not verified");
  const values = await readReleaseEnvironment(envFile);
  const account = parseJson(await runChecked(runAz, ["account", "show", "--only-show-errors", "--output", "json"], "Azure account verification"), "Azure account verification");
  if (account?.name !== "aserdargun subscription" || account?.state !== "Enabled") throw refuse("exact enabled Azure subscription is required");
  const targetArgs = ["--name", "swa-nxt-aserdargun-com", "--resource-group", "rg-nxt-aserdargun-com", "--only-show-errors", "--output", "json"];
  const app = parseJson(await runChecked(runAz, ["staticwebapp", "show", ...targetArgs], "Azure Static Web App verification"), "Azure Static Web App verification");
  if (app?.name !== "swa-nxt-aserdargun-com" || app?.resourceGroup !== "rg-nxt-aserdargun-com" || app?.provisioningState !== "Succeeded" ||
      app?.sku?.name !== "Free" || safeString(app?.location).replace(/\s+/gu, "").toLowerCase() !== "westeurope" ||
      typeof app?.defaultHostname !== "string" || !app.defaultHostname.endsWith(".azurestaticapps.net")) {
    throw refuse("exact Ready Free Static Web App is required");
  }
  const hostnames = parseJson(await runChecked(runAz, ["staticwebapp", "hostname", "list", ...targetArgs.slice(0, 4), "--only-show-errors", "--output", "json"], "Azure hostname verification"), "Azure hostname verification");
  if (!Array.isArray(hostnames) || hostnames.length !== 0) throw refuse("custom hostnames must be empty");
  const sortedKeys = [...settingKeys].sort();
  const settingArguments = sortedKeys.map((key) => `${key}=${values[key]}`);
  await runChecked(runAz, [
    "staticwebapp", "appsettings", "set",
    "--name", "swa-nxt-aserdargun-com",
    "--resource-group", "rg-nxt-aserdargun-com",
    "--only-show-errors", "--output", "none",
    "--setting-names", ...settingArguments
  ], "Azure settings mutation");
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
