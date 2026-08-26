import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CONTROL_VERSION,
  inspectProcess,
  stopControlledStack,
  writeControlRecord
} from "../scripts/stop-local-core.mjs";
import {
  assertPortsAvailable,
  FUNCTIONS_HOST_LOCAL_SANDBOX_PROFILE,
  startLocalStack
} from "../scripts/local-dev.mjs";

const waitFor = async (predicate, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for fixture state.");
};

const fixture = async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "nxt-lifecycle-")));
  const childScript = join(directory, "fixture.mjs");
  await writeFile(childScript, [
    'import { createServer } from "node:net";',
    'import { spawn } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    'const server = createServer(() => {});',
    'server.listen(Number(process.argv[2]), "127.0.0.1");',
    'if (process.argv[3] === "ignore") process.on("SIGTERM", () => {});',
    'else process.on("SIGTERM", () => server.close(() => process.exit(0)));',
    'if (process.argv[3] === "tree") {',
    '  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: process.cwd(), stdio: "ignore" });',
    '  writeFileSync(process.argv[4], String(child.pid));',
    '}'
  ].join("\n"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return { directory, childScript };
};

const reservePort = async () => {
  const server = createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
};

const startChild = async (script, port, cwd, mode, extra) => {
  const child = spawn(process.execPath, [script, String(port), ...(mode === undefined ? [] : [mode]), ...(extra === undefined ? [] : [extra])], { cwd, stdio: "ignore" });
  await waitFor(async () => {
    const observed = await inspectProcess(child.pid);
    return observed?.listeningPorts.includes(port) === true;
  });
  return child;
};

const makeRecord = async ({ checkoutPath, controlPath, child, port, nonce = crypto.randomUUID() }) => {
  const observed = await inspectProcess(child.pid);
  assert(observed);
  const record = {
    version: CONTROL_VERSION,
    checkoutRealpath: await realpath(checkoutPath),
    nonce,
    createdAt: new Date().toISOString(),
    services: [{
      name: "fixture",
      pid: child.pid,
      startTime: observed.startTime,
      cwd: observed.cwd,
      executable: observed.executable,
      command: observed.command,
      port,
      logPath: join(checkoutPath, ".nxt-local", "fixture.log"),
      nonce
    }]
  };
  await writeControlRecord(controlPath, record);
  return record;
};

test("controlled stop validates identity, closes the listener, and is idempotent", async (t) => {
  const { directory, childScript } = await fixture(t);
  const controlDirectory = join(directory, ".nxt-local");
  const controlPath = join(controlDirectory, "control.json");
  await mkdir(controlDirectory, { recursive: true });
  const port = await reservePort();
  const child = await startChild(childScript, port, directory);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await makeRecord({ checkoutPath: directory, controlPath, child, port, command: childScript });

  const result = await stopControlledStack({ checkoutPath: directory, controlPath, termTimeoutMs: 2_000, killTimeoutMs: 1_000 });
  assert.equal(result.status, "stopped");
  assert.equal(await inspectProcess(child.pid), null);
  await assert.rejects(readFile(controlPath), /ENOENT/u);
  assert.deepEqual(await stopControlledStack({ checkoutPath: directory, controlPath }), { status: "idle" });
});

test("controlled stop escalates only the still-matching stubborn identity", async (t) => {
  const { directory, childScript } = await fixture(t);
  const controlPath = join(directory, ".nxt-local", "control.json");
  await mkdir(join(directory, ".nxt-local"), { recursive: true });
  const port = await reservePort();
  const child = await startChild(childScript, port, directory, "ignore");
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await makeRecord({ checkoutPath: directory, controlPath, child, port });
  assert.deepEqual(
    await stopControlledStack({ checkoutPath: directory, controlPath, termTimeoutMs: 100, killTimeoutMs: 1_000 }),
    { status: "stopped" }
  );
  assert.equal(await inspectProcess(child.pid), null);
});

test("controlled stop discovers and removes the checkout-owned process tree", async (t) => {
  const { directory, childScript } = await fixture(t);
  const controlPath = join(directory, ".nxt-local", "control.json");
  const childPidPath = join(directory, "descendant.pid");
  await mkdir(join(directory, ".nxt-local"), { recursive: true });
  const port = await reservePort();
  const child = await startChild(childScript, port, directory, "tree", childPidPath);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await waitFor(async () => readFile(childPidPath, "utf8").then(() => true, () => false));
  const descendantPid = Number(await readFile(childPidPath, "utf8"));
  await makeRecord({ checkoutPath: directory, controlPath, child, port });
  await stopControlledStack({ checkoutPath: directory, controlPath, termTimeoutMs: 1_000, killTimeoutMs: 1_000 });
  assert.equal(await inspectProcess(descendantPid), null);
});

for (const [label, mutate] of [
  ["foreign checkout", (record) => ({ ...record, checkoutRealpath: "/tmp/foreign-checkout" })],
  ["PID start time", (record) => ({ ...record, services: record.services.map((service) => ({ ...service, startTime: "stale" })) })],
  ["cwd", (record) => ({ ...record, services: record.services.map((service) => ({ ...service, cwd: "/tmp" })) })],
  ["command", (record) => ({ ...record, services: record.services.map((service) => ({ ...service, command: "foreign-command" })) })],
  ["nonce", (record) => ({ ...record, services: record.services.map((service) => ({ ...service, nonce: crypto.randomUUID() })) })]
]) {
  test(`controlled stop refuses a mismatched ${label} without signaling`, async (t) => {
    const { directory, childScript } = await fixture(t);
    const controlPath = join(directory, ".nxt-local", "control.json");
    await mkdir(join(directory, ".nxt-local"), { recursive: true });
    const port = await reservePort();
    const child = await startChild(childScript, port, directory);
    t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    const record = await makeRecord({ checkoutPath: directory, controlPath, child, port, command: childScript });
    await writeFile(controlPath, `${JSON.stringify(mutate(record), null, 2)}\n`, { mode: 0o600 });
    await assert.rejects(stopControlledStack({ checkoutPath: directory, controlPath }), /refus/i);
    assert.equal((await inspectProcess(child.pid))?.listeningPorts.includes(port), true);
  });
}

test("controlled stop refuses corrupt records without affecting a harmless process", async (t) => {
  const { directory, childScript } = await fixture(t);
  const controlPath = join(directory, ".nxt-local", "control.json");
  await mkdir(join(directory, ".nxt-local"), { recursive: true });
  const port = await reservePort();
  const child = await startChild(childScript, port, directory);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await writeFile(controlPath, "{not-json", { mode: 0o600 });
  await assert.rejects(stopControlledStack({ checkoutPath: directory, controlPath }), /refus/i);
  assert.equal((await inspectProcess(child.pid))?.listeningPorts.includes(port), true);
});

test("the Functions sandbox profile admits only peers macOS classifies as host-local", () => {
  assert.equal(
    FUNCTIONS_HOST_LOCAL_SANDBOX_PROFILE,
    '(version 1) (allow default) (deny network-inbound (require-all (remote ip "*:*") (require-not (remote ip "localhost:*"))))'
  );
});

test("occupied foreign ports are refused and the foreign listener survives", async (t) => {
  const server = createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === "object");
  await assert.rejects(assertPortsAvailable([address.port]), /occupied/u);
  assert.equal(server.listening, true);
});

test("Run refuses Drive configuration and an existing corrupt control record", async (t) => {
  process.env.GOOGLE_CLIENT_ID = "must-not-be-used";
  try {
    await assert.rejects(startLocalStack(), /GOOGLE_CLIENT_ID/u);
  } finally {
    delete process.env.GOOGLE_CLIENT_ID;
  }

  const directory = await realpath(await mkdtemp(join(tmpdir(), "nxt-start-refusal-")));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, ".nxt-local"), { recursive: true });
  await writeFile(join(directory, ".nxt-local", "control.json"), "{corrupt", { mode: 0o600 });
  await assert.rejects(startLocalStack({ checkout: directory }), /existing local control/u);
  assert.equal(await readFile(join(directory, ".nxt-local", "control.json"), "utf8"), "{corrupt");
});

test("partial startup rolls back and the real stack supports crash-safe Stop", { timeout: 120_000 }, async (t) => {
  await assert.rejects(
    startLocalStack({ testHooks: { afterService: (name) => { if (name === "vite") throw new Error("injected partial startup failure"); } } }),
    /injected partial/u
  );
  await assert.doesNotReject(assertPortsAvailable([4280, 5173, 7071]));

  const stack = await startLocalStack();
  t.after(async () => { await stopControlledStack({ checkoutPath: process.cwd() }).catch(() => {}); });
  assert.deepEqual(stack.services.map(({ name, port }) => ({ name, port })), [
    { name: "vite", port: 5173 },
    { name: "functions", port: 7071 },
    { name: "swa", port: 4280 }
  ]);
  assert.equal((await fetch("http://127.0.0.1:4280/login")).status, 200);
  const session = await fetch("http://127.0.0.1:7071/api/private/session");
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), { user: { userDetails: "aserdargun" } });
  await assert.rejects(startLocalStack(), /occupied|existing/u);

  const swa = stack.services.find(({ name }) => name === "swa");
  assert(swa);
  process.kill(swa.pid, "SIGKILL");
  await waitFor(async () => await inspectProcess(swa.pid) === null);
  assert.deepEqual(await stopControlledStack({ checkoutPath: process.cwd() }), { status: "stopped" });
  assert.deepEqual(await stopControlledStack({ checkoutPath: process.cwd() }), { status: "idle" });
  await assert.doesNotReject(assertPortsAvailable([4280, 5173, 7071]));
});
