import { defineConfig } from "vitest/config";

const configuredMaxWorkers = process.env.NXT_VITEST_MAX_WORKERS;
const maxWorkers = configuredMaxWorkers === undefined ? undefined : Number(configuredMaxWorkers);

if (maxWorkers !== undefined && (!Number.isInteger(maxWorkers) || maxWorkers < 1)) {
  throw new Error("NXT_VITEST_MAX_WORKERS must be a positive integer.");
}

export default defineConfig({
  test: {
    maxWorkers
  }
});
