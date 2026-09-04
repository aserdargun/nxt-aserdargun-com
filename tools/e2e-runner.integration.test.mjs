import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as e2eEnvironment from "../scripts/e2e-environment.mjs";
import { inspectProcess } from "../scripts/stop-local-core.mjs";

const checkout = process.cwd();
const runnerPath = join(checkout, "scripts", "run-e2e.mjs");
const exists = (path) => access(path).then(() => true, () => false);

test("the E2E Vite environment scrubs inherited HMR flags before exact opt-in", () => {
  assert.equal(typeof e2eEnvironment.createViteServiceEnvironment, "function");
  const createViteServiceEnvironment = e2eEnvironment.createViteServiceEnvironment;
  if (typeof createViteServiceEnvironment !== "function") return;
  const inherited = { KEEP_ME: "yes", NXT_E2E_DISABLE_VITE_HMR: "caller-value" };

  assert.deepEqual(createViteServiceEnvironment(inherited, false), { KEEP_ME: "yes" });
  assert.deepEqual(createViteServiceEnvironment(inherited, true), {
    KEEP_ME: "yes",
    NXT_E2E_DISABLE_VITE_HMR: "1"
  });
  assert.deepEqual(e2eEnvironment.createE2eEnvironment(inherited), { KEEP_ME: "yes" });
});

const waitFor = async (predicate, timeoutMs = 5_000) => {
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

const stopExactFixture = async (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0 || await inspectProcess(pid) === null) return;
  try { process.kill(pid, "SIGKILL"); }
  catch (error) { if (error?.code !== "ESRCH") throw error; }
  await waitFor(async () => await inspectProcess(pid) === null);
};

test("SIGTERM reaps the exact active command group including a TERM-resistant grandchild without touching a foreign peer", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "nxt-e2e-runner-"));
  const fakePnpm = join(directory, "pnpm");
  const started = join(directory, "started");
  const grandchildStarted = join(directory, "grandchild-started");
  const foreignStarted = join(directory, "foreign-started");
  const stopped = join(directory, "stopped");
  await writeFile(fakePnpm, [
    "#!/usr/bin/env node",
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    'const command = process.argv[2];',
    'if (command === "--grandchild") {',
    '  writeFileSync(process.env.NXT_TEST_GRANDCHILD_STARTED, String(process.pid));',
    '  process.on("SIGTERM", () => {});',
    '  setInterval(() => {}, 1_000);',
    '} else if (command === "--foreign") {',
    '  writeFileSync(process.env.NXT_TEST_FOREIGN_STARTED, String(process.pid));',
    '  process.on("SIGTERM", () => {});',
    '  setInterval(() => {}, 1_000);',
    '} else if (command === "exec") {',
    '  writeFileSync(process.env.NXT_TEST_STARTED, String(process.pid));',
    '  spawn(process.execPath, [process.argv[1], "--grandchild"], { cwd: process.cwd(), env: process.env, stdio: "ignore" });',
    '  process.stdout.write("fake-long-child-stdout\\n");',
    '  process.stderr.write("fake-long-child-stderr\\n");',
    '  setInterval(() => {}, 1_000);',
    '} else if (command === "stop:codex") {',
    '  writeFileSync(process.env.NXT_TEST_STOPPED, "stopped");',
    '} else process.exit(2);'
  ].join("\n"), { mode: 0o700 });
  await chmod(fakePnpm, 0o700);

  const fixtureEnvironment = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    NXT_TEST_STARTED: started,
    NXT_TEST_GRANDCHILD_STARTED: grandchildStarted,
    NXT_TEST_FOREIGN_STARTED: foreignStarted,
    NXT_TEST_STOPPED: stopped
  };
  const foreign = spawn(fakePnpm, ["--foreign"], {
    cwd: checkout,
    env: fixtureEnvironment,
    detached: true,
    stdio: "ignore"
  });
  const child = spawn(process.execPath, [runnerPath], {
    cwd: checkout,
    env: fixtureEnvironment,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  let fakePid;
  let grandchildPid;
  let foreignPid;
  context.after(async () => {
    await stopExactFixture(grandchildPid);
    await stopExactFixture(fakePid);
    if (await inspectProcess(foreignPid) !== null) {
      const closed = once(foreign, "close");
      foreign.kill("SIGKILL");
      await closed;
    }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  });

  await waitFor(async () => await exists(started) && await exists(grandchildStarted) && await exists(foreignStarted));
  fakePid = Number(await readFile(started, "utf8"));
  grandchildPid = Number(await readFile(grandchildStarted, "utf8"));
  foreignPid = Number(await readFile(foreignStarted, "utf8"));
  const [directIdentity, grandchildIdentity, foreignIdentity] = await Promise.all([
    inspectProcess(fakePid), inspectProcess(grandchildPid), inspectProcess(foreignPid)
  ]);
  assert.equal(grandchildIdentity?.pgid, directIdentity?.pgid, "grandchild fixture did not join the active command group");
  assert.notEqual(foreignIdentity?.pgid, directIdentity?.pgid, "foreign fixture did not own a distinct process group");
  const exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const startedAt = Date.now();
  child.kill("SIGTERM");
  const result = await Promise.race([exit, new Promise((resolve) => setTimeout(() => resolve("timeout"), 5_000))]);
  assert.notEqual(result, "timeout", "runner did not complete bounded identity-verified interruption cleanup");
  assert.ok(Date.now() - startedAt < 5_000, "runner interruption cleanup was not bounded");
  assert.notEqual(result.code, 0);
  assert.equal(await exists(stopped), true, "Stop was not invoked after interruption");
  assert.match(stdout(), /fake-long-child-stdout/u);
  assert.match(stderr(), /fake-long-child-stderr/u);
  assert.equal(await inspectProcess(fakePid), null, `direct active command survived runner teardown\n${stderr()}`);
  assert.equal(await inspectProcess(grandchildPid), null, `TERM-resistant active-command grandchild survived runner teardown\n${stderr()}`);
  assert.notEqual(await inspectProcess(foreignPid), null, "foreign same-name process in another group was signaled");
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
    ["exec", "playwright", "test", "e2e/publication.spec.ts"],
    ["stop:codex"]
  ]);
});
