import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

test("root contract pins the supported toolchain and lifecycle", async () => {
  const pkg = await readJson("package.json");
  assert.equal(pkg.private, true);
  assert.equal(pkg.packageManager, "pnpm@11.22.0");
  assert.deepEqual(pkg.engines, { node: ">=22.0.0 <23" });
  for (const script of [
    "build",
    "lint",
    "typecheck",
    "test",
    "e2e",
    "dev:codex",
    "stop:codex",
    "validate:codex",
    "validate:ci",
    "validate:macos",
    "deployment:verify",
    "azure:release",
    "drive:backup"
  ]) {
    assert.equal(typeof pkg.scripts[script], "string", `${script} must exist`);
  }
  const web = await readJson("web/package.json");
  assert.equal(web.scripts.test, "vitest run --maxWorkers=1");
});

test("secret and generated paths are ignored by Git", async () => {
  await readFile(".gitignore", "utf8");
  for (const path of [
    ".env.local",
    "google-oauth-client.local.json",
    ".nxt-local/state.json",
    "web/dist/index.html",
    "api-dist/index.mjs",
    "playwright-report/index.html"
  ]) {
    await assert.doesNotReject(
      run("git", ["check-ignore", "--no-index", "--quiet", path])
    );
  }
});
