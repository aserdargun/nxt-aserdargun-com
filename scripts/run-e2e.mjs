import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { promisify } from "node:util";

import { assertPortsAvailable } from "./local-dev.mjs";

const run = promisify(execFile);
const checkout = new URL("..", import.meta.url).pathname.replace(/\/$/u, "");
const driveKeys = [
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "NXT_VAULT_DRIVE_FOLDER_ID", "NXT_PRIVATE_DRIVE_FOLDER_ID",
  "NXT_NOTES_DRIVE_FOLDER_ID", "NXT_INBOX_DRIVE_FOLDER_ID", "NXT_PLANS_DRIVE_FOLDER_ID", "NXT_ARCHIVE_DRIVE_FOLDER_ID",
  "NXT_ASSETS_DRIVE_FOLDER_ID", "NXT_PUBLISHED_DRIVE_FOLDER_ID", "NXT_VAULT_INDEX_DRIVE_FILE_ID",
  "NXT_PREFERENCES_DRIVE_FILE_ID", "NXT_PUBLICATION_MANIFEST_DRIVE_FILE_ID", "NXT_LOCAL_STORAGE_MODE",
  "NXT_LOCAL_FIXTURE_ROOT", "NXT_LOCAL_CHECKOUT_ROOT", "NXT_LOCAL_AUTH_BYPASS"
];
const environment = { ...process.env };
for (const key of driveKeys) delete environment[key];

const assertTeardown = async () => {
  await assertPortsAvailable([4280, 5173, 7071]);
  try {
    await lstat(`${checkout}/.nxt-local`);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("E2E teardown left .nxt-local behind.");
};

let interrupted = false;
const interrupt = () => { interrupted = true; };
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

let testError;
try {
  await run("pnpm", ["dev:codex", "--", "--e2e"], { cwd: checkout, env: environment, maxBuffer: 32 * 1024 * 1024 });
  if (interrupted) throw new Error("E2E run was interrupted before Chromium started.");
  const args = ["exec", "playwright", "test", ...process.argv.slice(2)];
  const result = await run("pnpm", args, { cwd: checkout, env: environment, maxBuffer: 64 * 1024 * 1024 });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (interrupted) throw new Error("E2E run was interrupted during Chromium acceptance.");
} catch (error) {
  testError = error;
  if (typeof error?.stdout === "string") process.stdout.write(error.stdout);
  if (typeof error?.stderr === "string") process.stderr.write(error.stderr);
} finally {
  try {
    const stopped = await run("pnpm", ["stop:codex"], { cwd: checkout, env: environment, maxBuffer: 8 * 1024 * 1024 });
    process.stdout.write(stopped.stdout);
    process.stderr.write(stopped.stderr);
    await assertTeardown();
  } catch (stopError) {
    testError = testError === undefined ? stopError : new AggregateError([testError, stopError], "E2E failed and teardown was not proven.");
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}

if (testError !== undefined) throw testError;
