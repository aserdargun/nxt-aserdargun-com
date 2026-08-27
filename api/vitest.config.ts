import { defineConfig } from "vitest/config";

const configuredMaxWorkers = process.env.NXT_VITEST_MAX_WORKERS;
const maxWorkers = configuredMaxWorkers === undefined ? undefined : Number(configuredMaxWorkers);
const configuredTestTimeout = process.env.NXT_VITEST_TEST_TIMEOUT_MS;
const testTimeout = configuredTestTimeout === undefined ? undefined : Number(configuredTestTimeout);

if (maxWorkers !== undefined && (!Number.isInteger(maxWorkers) || maxWorkers < 1)) {
  throw new Error("NXT_VITEST_MAX_WORKERS must be a positive integer.");
}
if (testTimeout !== undefined && (!Number.isInteger(testTimeout) || testTimeout < 1)) {
  throw new Error("NXT_VITEST_TEST_TIMEOUT_MS must be a positive integer.");
}

export default defineConfig({
  test: {
    maxWorkers,
    testTimeout
  }
});
