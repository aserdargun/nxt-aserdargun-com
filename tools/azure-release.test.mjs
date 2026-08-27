import assert from "node:assert/strict";
import { chmod, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const secretOne = "never-print-client-secret";
const secretTwo = "never-print-refresh-token";
const settings = {
  NXT_ALLOWED_GITHUB_USER: "aserdargun",
  GOOGLE_CLIENT_ID: "desktop-client-id",
  GOOGLE_CLIENT_SECRET: secretOne,
  GOOGLE_REFRESH_TOKEN: secretTwo,
  NXT_VAULT_DRIVE_FOLDER_ID: "vault-root-id",
  NXT_PRIVATE_DRIVE_FOLDER_ID: "private-root-id",
  NXT_NOTES_DRIVE_FOLDER_ID: "notes-id",
  NXT_INBOX_DRIVE_FOLDER_ID: "inbox-id",
  NXT_PLANS_DRIVE_FOLDER_ID: "plans-id",
  NXT_ARCHIVE_DRIVE_FOLDER_ID: "archive-id",
  NXT_ASSETS_DRIVE_FOLDER_ID: "assets-id",
  NXT_PUBLISHED_DRIVE_FOLDER_ID: "published-id",
  NXT_VAULT_INDEX_DRIVE_FILE_ID: "index-id",
  NXT_PREFERENCES_DRIVE_FILE_ID: "preferences-id",
  NXT_PUBLICATION_MANIFEST_DRIVE_FILE_ID: "manifest-id"
};
const source = (input = settings) => `${Object.entries(input).map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
const loadRelease = () => import("../scripts/azure-static-web-app-release.mjs");

const successRunner = (calls) => async (file, args) => {
  assert.equal(file, "az");
  calls.push(args);
  const key = args.join(" ");
  if (key === "account show --only-show-errors --output json") return { code: 0, stdout: JSON.stringify({ name: "aserdargun subscription", state: "Enabled", user: { name: "aserdargun" } }), stderr: "" };
  if (key.startsWith("staticwebapp show ")) return { code: 0, stdout: JSON.stringify({ name: "swa-nxt-aserdargun-com", resourceGroup: "rg-nxt-aserdargun-com", provisioningState: "Succeeded", sku: { name: "Free" }, location: "West Europe", defaultHostname: "calm-field.azurestaticapps.net" }), stderr: "" };
  if (key.startsWith("staticwebapp hostname list ")) return { code: 0, stdout: "[]", stderr: "" };
  if (key.startsWith("staticwebapp appsettings set ")) return { code: 0, stdout: "", stderr: "" };
  return { code: 2, stdout: "", stderr: "unexpected fake command" };
};

test("manual Azure apply validates exact target and exposes only sorted key names", async (context) => {
  const { applyAzureSettings } = await loadRelease();
  const directory = await mkdtemp(join(tmpdir(), "nxt-azure-release-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const envFile = join(directory, ".env.local");
  await writeFile(envFile, source(), { mode: 0o600 });
  const calls = [];
  let output = "";
  const result = await applyAzureSettings({
    envFile,
    identity: { repository: "nxt-aserdargun-com" },
    runAz: successRunner(calls),
    log: (line) => { output += `${line}\n`; }
  });
  assert.equal(result.keyCount, 15);
  assert.deepEqual(result.keys, Object.keys(settings).sort());
  assert.doesNotMatch(output, new RegExp(`${secretOne}|${secretTwo}`, "u"));
  assert.match(output, /Azure settings applied: GOOGLE_CLIENT_ID,/u);
  const mutation = calls.find((args) => args[0] === "staticwebapp" && args[1] === "appsettings" && args[2] === "set");
  assert.deepEqual(mutation.slice(0, 9), ["staticwebapp", "appsettings", "set", "--name", "swa-nxt-aserdargun-com", "--resource-group", "rg-nxt-aserdargun-com", "--only-show-errors", "--output"]);
  assert.equal(mutation[9], "none");
  assert.equal(mutation[10], "--setting-names");
});

test("Azure apply redacts sentinel values from child diagnostics and thrown errors", async (context) => {
  const { applyAzureSettings } = await loadRelease();
  const directory = await mkdtemp(join(tmpdir(), "nxt-azure-redaction-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const envFile = join(directory, ".env.local");
  await writeFile(envFile, source(), { mode: 0o600 });
  const calls = [];
  const runner = successRunner(calls);
  await assert.rejects(
    applyAzureSettings({
      envFile,
      identity: { repository: "nxt-aserdargun-com" },
      runAz: async (file, args) => args[0] === "staticwebapp" && args[1] === "appsettings"
        ? { code: 1, stdout: `bad ${secretOne}`, stderr: `worse ${secretTwo}` }
        : runner(file, args),
      log: () => undefined
    }),
    (error) => {
      assert.doesNotMatch(String(error?.stack), new RegExp(`${secretOne}|${secretTwo}`, "u"));
      assert.match(String(error?.message), /Azure settings mutation failed/u);
      return true;
    }
  );
});

test("Azure env admission refuses symlinks, wrong modes, unknown/local keys, duplicates, controls, and missing values", async (context) => {
  const { readReleaseEnvironment } = await loadRelease();
  const directory = await mkdtemp(join(tmpdir(), "nxt-azure-env-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const envFile = join(directory, ".env.local");
  await writeFile(envFile, source(), { mode: 0o600 });
  assert.deepEqual(await readReleaseEnvironment(envFile), settings);
  await chmod(envFile, 0o644);
  await assert.rejects(readReleaseEnvironment(envFile), /mode 0600/u);
  await chmod(envFile, 0o600);
  const link = join(directory, "linked.env");
  await symlink(envFile, link);
  await assert.rejects(readReleaseEnvironment(link), /regular non-symlink/u);
  const replacement = join(directory, "replacement.env");
  await writeFile(replacement, source(), { mode: 0o600 });
  await assert.rejects(readReleaseEnvironment(envFile, {
    openFile: async (path, flags) => {
      await rm(path);
      await symlink(replacement, path);
      return open(path, flags);
    }
  }), /symbolic link|symlink|ELOOP/u);
  await rm(envFile);
  await writeFile(envFile, source(), { mode: 0o600 });
  for (const badSource of [
    `${source()}NXT_LOCAL_AUTH_BYPASS=1\n`,
    `${source()}GOOGLE_CLIENT_ID=duplicate\n`,
    source({ ...settings, GOOGLE_CLIENT_SECRET: "" }),
    source({ ...settings, GOOGLE_CLIENT_SECRET: "line\rbreak" }),
    source(Object.fromEntries(Object.entries(settings).filter(([key]) => key !== "GOOGLE_REFRESH_TOKEN")))
  ]) {
    await writeFile(envFile, badSource, { mode: 0o600 });
    await assert.rejects(readReleaseEnvironment(envFile));
  }
});
