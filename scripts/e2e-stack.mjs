import { lstat } from "node:fs/promises";

import { createE2eEnvironment } from "./e2e-environment.mjs";
import { assertPortsAvailable } from "./local-dev.mjs";
import { runOwnedCommand } from "./owned-command.mjs";

export const E2E_STACK_START_TIMEOUT_MS = 180_000;

export const assertE2eStackStopped = async (checkout) => {
  await assertPortsAvailable([4280, 5173, 7071]);
  try {
    await lstat(`${checkout}/.nxt-local`);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("E2E teardown left .nxt-local behind.");
};

export const startE2eStack = async ({ checkout, environment = createE2eEnvironment(), signal }) => {
  const result = await runOwnedCommand("pnpm", ["dev:codex", "--", "--e2e"], {
    cwd: checkout,
    env: environment,
    maxBuffer: 32 * 1024 * 1024,
    signal,
    timeoutMs: E2E_STACK_START_TIMEOUT_MS
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
};

export const stopE2eStack = async ({ checkout, environment = createE2eEnvironment() }) => {
  const result = await runOwnedCommand("pnpm", ["stop:codex"], {
    cwd: checkout,
    env: environment,
    maxBuffer: 8 * 1024 * 1024,
    timeoutMs: 60_000
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  await assertE2eStackStopped(checkout);
};

export const withE2eStack = async ({ checkout, environment = createE2eEnvironment(), use }) => {
  let useError;
  try {
    await startE2eStack({ checkout, environment });
    await use();
  } catch (error) {
    useError = error;
  } finally {
    try { await stopE2eStack({ checkout, environment }); }
    catch (stopError) {
      useError = useError === undefined ? stopError : new AggregateError([useError, stopError], "E2E test failed and its exact stack teardown was not proven.");
    }
  }
  if (useError !== undefined) throw useError;
};
