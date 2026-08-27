import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { promisify } from "node:util";

import { assertPortsAvailable } from "./local-dev.mjs";
import { createE2eEnvironment } from "./e2e-environment.mjs";
import { runOwnedCommand } from "./owned-command.mjs";

const run = promisify(execFile);
const checkout = new URL("..", import.meta.url).pathname.replace(/\/$/u, "");
const environment = createE2eEnvironment();

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
let activeController;
const interrupt = () => {
  interrupted = true;
  activeController?.abort();
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

const runActive = async (file, args, options) => {
  const controller = new AbortController();
  activeController = controller;
  if (interrupted) controller.abort();
  try {
    return await runOwnedCommand(file, args, { ...options, signal: controller.signal });
  } finally {
    if (activeController === controller) activeController = undefined;
  }
};

let testError;
try {
  const forwarded = process.argv.slice(2);
  if (forwarded[0] === "--") forwarded.shift();
  const args = ["exec", "playwright", "test", ...forwarded];
  const result = await runActive("pnpm", args, { cwd: checkout, env: environment, maxBuffer: 64 * 1024 * 1024 });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (interrupted) throw new Error("E2E run was interrupted during Chromium acceptance.");
} catch (error) {
  testError = error;
  if (typeof error?.stdout === "string") process.stdout.write(error.stdout);
  if (typeof error?.stderr === "string") process.stderr.write(error.stderr);
} finally {
  try {
    const stopped = await run("pnpm", ["stop:codex"], {
      cwd: checkout, env: environment, maxBuffer: 8 * 1024 * 1024, timeout: 60_000
    });
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
