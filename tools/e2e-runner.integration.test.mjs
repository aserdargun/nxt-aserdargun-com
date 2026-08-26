import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const checkout = process.cwd();
const runnerPath = join(checkout, "scripts", "run-e2e.mjs");
const exists = (path) => access(path).then(() => true, () => false);

const waitFor = async (predicate, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for fake pnpm state.");
};

const collect = (stream) => {
  let value = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { value += chunk; });
  return () => value;
};

test("SIGTERM aborts the active command immediately, preserves output, fails, and still runs Stop", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "nxt-e2e-runner-"));
  const fakePnpm = join(directory, "pnpm");
  const started = join(directory, "started");
  const stopped = join(directory, "stopped");
  await writeFile(fakePnpm, [
    "#!/usr/bin/env node",
    'const { writeFileSync } = require("node:fs");',
    'const command = process.argv[2];',
    'if (command === "dev:codex") {',
    '  writeFileSync(process.env.NXT_TEST_STARTED, String(process.pid));',
    '  process.stdout.write("fake-long-child-stdout\\n");',
    '  process.stderr.write("fake-long-child-stderr\\n");',
    '  process.on("SIGTERM", () => process.exit(143));',
    '  setInterval(() => {}, 1_000);',
    '} else if (command === "stop:codex") {',
    '  writeFileSync(process.env.NXT_TEST_STOPPED, "stopped");',
    '} else process.exit(2);'
  ].join("\n"), { mode: 0o700 });
  await chmod(fakePnpm, 0o700);

  const child = spawn(process.execPath, [runnerPath], {
    cwd: checkout,
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, NXT_TEST_STARTED: started, NXT_TEST_STOPPED: stopped },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  let fakePid;
  context.after(async () => {
    if (fakePid !== undefined) {
      try { process.kill(fakePid, "SIGTERM"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
    }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  });

  await waitFor(() => exists(started));
  fakePid = Number(await readFile(started, "utf8"));
  const exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const startedAt = Date.now();
  child.kill("SIGTERM");
  let result = await Promise.race([exit, new Promise((resolve) => setTimeout(() => resolve("timeout"), 1_000))]);
  if (result === "timeout") {
    process.kill(fakePid, "SIGTERM");
    result = await exit;
  }
  assert.notEqual(result, "timeout", "runner did not abort its active command within one second");
  assert.ok(Date.now() - startedAt < 1_000, "runner interruption was not immediate");
  assert.notEqual(result.code, 0);
  assert.equal(await exists(stopped), true, "Stop was not invoked after interruption");
  assert.match(stdout(), /fake-long-child-stdout/u);
  assert.match(stderr(), /fake-long-child-stderr/u);
});

test("forwards a selective Playwright path without pnpm's leading separator", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "nxt-e2e-filter-"));
  const fakePnpm = join(directory, "pnpm");
  const calls = join(directory, "calls.jsonl");
  await writeFile(fakePnpm, [
    "#!/usr/bin/env node",
    'const { appendFileSync } = require("node:fs");',
    'appendFileSync(process.env.NXT_TEST_CALLS, `${JSON.stringify(process.argv.slice(2))}\\n`);'
  ].join("\n"), { mode: 0o700 });
  await chmod(fakePnpm, 0o700);
  context.after(() => rm(directory, { recursive: true, force: true }));

  const child = spawn(process.execPath, [runnerPath, "--", "e2e/publication.spec.ts"], {
    cwd: checkout,
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, NXT_TEST_CALLS: calls },
    stdio: "ignore"
  });
  const result = await new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  assert.deepEqual(result, { code: 0, signal: null });
  const invoked = (await readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(invoked, [
    ["dev:codex", "--", "--e2e"],
    ["exec", "playwright", "test", "e2e/publication.spec.ts"],
    ["stop:codex"]
  ]);
});
