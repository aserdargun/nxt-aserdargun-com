import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const secretOne = "never-print-client-secret";
const secretTwo = "never-print-refresh-token";
const subscriptionId = "11111111-2222-4333-8444-555555555555";
const tenantId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const resourceId = `/subscriptions/${subscriptionId}/resourceGroups/rg-nxt-aserdargun-com/providers/Microsoft.Web/staticSites/swa-nxt-aserdargun-com`;
const validAccount = { id: subscriptionId, name: "display-name-is-not-identity", state: "Enabled", tenantId, user: { name: "operator@example.invalid", type: "user" } };
const validApp = { id: resourceId, name: "swa-nxt-aserdargun-com", resourceGroup: "rg-nxt-aserdargun-com", provisioningState: "Succeeded", sku: { name: "Free" }, location: "West Europe", defaultHostname: "calm-field.azurestaticapps.net" };
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

const successRunner = (calls, { account = validAccount, app = validApp, onRest } = {}) => async (file, args) => {
  assert.equal(file, "az");
  calls.push(args);
  const key = args.join(" ");
  if (key === "account show --only-show-errors --output json") return { code: 0, stdout: JSON.stringify(account), stderr: "" };
  if (key.startsWith("staticwebapp show ")) return { code: 0, stdout: JSON.stringify(app), stderr: "" };
  if (key.startsWith("staticwebapp hostname list ")) return { code: 0, stdout: "[]", stderr: "" };
  if (args[0] === "rest") {
    await onRest?.(args);
    return { code: 0, stdout: "", stderr: "" };
  }
  return { code: 2, stdout: "", stderr: "unexpected fake command" };
};

test("manual Azure apply validates exact target and exposes only sorted key names", async (context) => {
  const { applyAzureSettings } = await loadRelease();
  const directory = await realpath(await mkdtemp(join(tmpdir(), "nxt-azure-release-")));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const envFile = join(directory, ".env.local");
  await writeFile(envFile, source(), { mode: 0o600 });
  const temporaryParent = join(directory, "temporary");
  await mkdir(temporaryParent, { mode: 0o700 });
  const calls = [];
  let payloadPath;
  let payload;
  let output = "";
  const result = await applyAzureSettings({
    envFile,
    identity: { repository: "nxt-aserdargun-com" },
    temporaryParent,
    runAz: successRunner(calls, {
      onRest: async (args) => {
        const bodyArgument = args[args.indexOf("--body") + 1];
        assert.match(bodyArgument, /^@\//u);
        payloadPath = bodyArgument.slice(1);
        assert.equal(await realpath(payloadPath), payloadPath);
        assert.equal((await lstat(payloadPath)).mode & 0o777, 0o600);
        assert.equal((await lstat(dirname(payloadPath))).mode & 0o777, 0o700);
        payload = JSON.parse(await readFile(payloadPath, "utf8"));
      }
    }),
    log: (line) => { output += `${line}\n`; }
  });
  assert.equal(result.keyCount, 15);
  assert.deepEqual(result.keys, Object.keys(settings).sort());
  assert.doesNotMatch(output, new RegExp(`${secretOne}|${secretTwo}`, "u"));
  assert.match(output, /Azure settings applied: GOOGLE_CLIENT_ID,/u);
  assert.doesNotMatch(JSON.stringify(calls), new RegExp(`${secretOne}|${secretTwo}`, "u"));
  const mutation = calls.find((args) => args[0] === "rest");
  assert.deepEqual(mutation.slice(0, 7), ["rest", "--method", "put", "--url", `${resourceId}/config/appsettings?api-version=2025-05-01`, "--body", `@${payloadPath}`]);
  assert.deepEqual(mutation.slice(7), ["--only-show-errors", "--output", "none"]);
  assert.deepEqual(payload, { properties: settings });
  await assert.rejects(lstat(payloadPath), { code: "ENOENT" });
  assert.deepEqual(await readdir(temporaryParent), []);
});

test("Azure apply redacts sentinel values from child diagnostics and thrown errors", async (context) => {
  const { applyAzureSettings } = await loadRelease();
  const directory = await realpath(await mkdtemp(join(tmpdir(), "nxt-azure-redaction-")));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const envFile = join(directory, ".env.local");
  await writeFile(envFile, source(), { mode: 0o600 });
  const temporaryParent = join(directory, "temporary");
  await mkdir(temporaryParent, { mode: 0o700 });
  const calls = [];
  const runner = successRunner(calls);
  let payloadPath;
  await assert.rejects(
    applyAzureSettings({
      envFile,
      identity: { repository: "nxt-aserdargun-com" },
      temporaryParent,
      runAz: async (file, args) => {
        if (args[0] === "rest") {
          calls.push(args);
          payloadPath = args[args.indexOf("--body") + 1].slice(1);
          return { code: 1, stdout: `bad ${secretOne}`, stderr: `worse ${secretTwo}` };
        }
        return runner(file, args);
      },
      log: () => undefined
    }),
    (error) => {
      assert.doesNotMatch(String(error?.stack), new RegExp(`${secretOne}|${secretTwo}`, "u"));
      assert.match(String(error?.message), /Azure settings mutation failed/u);
      return true;
    }
  );
  assert.doesNotMatch(JSON.stringify(calls), new RegExp(`${secretOne}|${secretTwo}`, "u"));
  await assert.rejects(lstat(payloadPath), { code: "ENOENT" });
  assert.deepEqual(await readdir(temporaryParent), []);
});

test("Azure env admission refuses symlinks, wrong modes, unknown/local keys, duplicates, controls, and missing values", async (context) => {
  const { readReleaseEnvironment } = await loadRelease();
  const directory = await realpath(await mkdtemp(join(tmpdir(), "nxt-azure-env-")));
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
  const canonicalParent = join(directory, "canonical-parent");
  await mkdir(canonicalParent);
  const canonicalEnv = join(canonicalParent, ".env.local");
  await writeFile(canonicalEnv, source(), { mode: 0o600 });
  const linkedParent = join(directory, "linked-parent");
  await symlink(canonicalParent, linkedParent);
  await assert.rejects(readReleaseEnvironment(join(linkedParent, ".env.local")), /canonical/u);
  const replacement = join(directory, "replacement.env");
  await writeFile(replacement, source(), { mode: 0o600 });
  await assert.rejects(readReleaseEnvironment(envFile, {
    openFile: async (path, flags) => {
      await rm(path);
      await symlink(replacement, path);
      return open(path, flags);
    }
  }), /changed|opened|symbolic link|symlink|ELOOP/u);
  await rm(envFile);
  await writeFile(envFile, source(), { mode: 0o600 });
  const regularReplacement = join(directory, "regular-replacement.env");
  const regularSwapSecret = "regular-rename-swap-secret";
  await writeFile(regularReplacement, source({ ...settings, GOOGLE_CLIENT_SECRET: regularSwapSecret }), { mode: 0o600 });
  await assert.rejects(readReleaseEnvironment(envFile, {
    openFile: async (path, flags) => {
      await rename(regularReplacement, path);
      return open(path, flags);
    }
  }), (error) => {
    assert.match(String(error?.message), /changed/u);
    assert.doesNotMatch(String(error?.stack), new RegExp(regularSwapSecret, "u"));
    return true;
  });
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

test("Azure apply binds the REST target to a valid account and exact resource identity", async (context) => {
  const { applyAzureSettings } = await loadRelease();
  const directory = await realpath(await mkdtemp(join(tmpdir(), "nxt-azure-identity-")));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const envFile = join(directory, ".env.local");
  await writeFile(envFile, source(), { mode: 0o600 });
  for (const account of [
    { ...validAccount, id: undefined, name: "aserdargun subscription" },
    { ...validAccount, id: "not-a-uuid", name: "aserdargun subscription" },
    { ...validAccount, tenantId: "not-a-uuid", name: "aserdargun subscription" },
    { ...validAccount, user: { name: "operator@example.invalid", type: "servicePrincipal" }, name: "aserdargun subscription" }
  ]) {
    const calls = [];
    await assert.rejects(applyAzureSettings({
      envFile,
      identity: { repository: "nxt-aserdargun-com" },
      runAz: successRunner(calls, { account }),
      log: () => undefined
    }), /subscription identity/u);
    assert.equal(calls.some((args) => args[0] === "rest"), false);
  }
  const calls = [];
  await assert.rejects(applyAzureSettings({
    envFile,
    identity: { repository: "nxt-aserdargun-com" },
    runAz: successRunner(calls, { app: { ...validApp, id: `${resourceId}-foreign` } }),
    log: () => undefined
  }), /exact Ready Free Static Web App/u);
  assert.equal(calls.some((args) => args[0] === "rest"), false);
});
