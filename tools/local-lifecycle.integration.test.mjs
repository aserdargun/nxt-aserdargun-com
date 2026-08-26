import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

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

const run = promisify(execFile);
const checkout = process.cwd();
const lifecycleModuleUrl = pathToFileURL(join(checkout, "scripts", "local-dev.mjs")).href;

const waitFor = async (predicate, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for fixture state.");
};

const pathExists = async (path) => access(path).then(() => true, () => false);

const terminateRunner = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!child.kill("SIGKILL")) return;
  await new Promise((resolvePromise) => child.once("exit", resolvePromise));
};

const forceCleanupCheckoutStack = async () => {
  await stopControlledStack({ checkoutPath: checkout, termTimeoutMs: 500, killTimeoutMs: 500 }).catch(() => {});
  const groupIds = new Set();
  for (const port of [4280, 5173, 7071]) {
    let stdout = "";
    try {
      stdout = (await run("/usr/sbin/lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" })).stdout;
    } catch (error) {
      if (error?.code !== 1) throw error;
    }
    for (const value of stdout.trim().split(/\s+/u).filter(Boolean)) {
      const pid = Number(value);
      const observed = await inspectProcess(pid);
      if (observed === null) continue;
      if (observed.cwd !== checkout && !observed.cwd.startsWith(`${checkout}${sep}`)) {
        throw new Error(`Refusing test cleanup of foreign listener PID ${pid}.`);
      }
      const { stdout: pgidText } = await run("/bin/ps", ["-p", String(pid), "-o", "pgid="], { encoding: "utf8" });
      groupIds.add(Number(pgidText.trim()));
    }
  }
  if (groupIds.size > 0) {
    const { stdout } = await run("/bin/ps", ["-axo", "pid=,pgid="], { encoding: "utf8" });
    const identities = [];
    for (const line of stdout.split("\n")) {
      const match = /^\s*([0-9]+)\s+([0-9]+)\s*$/u.exec(line);
      if (match === null || !groupIds.has(Number(match[2]))) continue;
      const observed = await inspectProcess(Number(match[1]));
      if (observed === null) continue;
      if (observed.cwd !== checkout && !observed.cwd.startsWith(`${checkout}${sep}`)) {
        throw new Error(`Refusing test cleanup of foreign group member PID ${observed.pid}.`);
      }
      identities.push(observed);
    }
    for (const identity of identities.toReversed()) {
      const observed = await inspectProcess(identity.pid);
      if (observed !== null && observed.startTime === identity.startTime && observed.cwd === identity.cwd &&
        observed.executable === identity.executable && observed.command === identity.command) process.kill(identity.pid, "SIGKILL");
    }
  }
  await waitFor(async () => assertPortsAvailable([4280, 5173, 7071]).then(() => true, () => false), 5_000).catch(() => {});
  if (await assertPortsAvailable([4280, 5173, 7071]).then(() => true, () => false)) {
    await rm(join(checkout, ".nxt-local"), { recursive: true, force: true });
  }
};

const createLauncherHarness = async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "nxt-launcher-")));
  const script = join(directory, "launcher.mjs");
  await writeFile(script, [
    'import { access, writeFile } from "node:fs/promises";',
    `import { startLocalStack } from ${JSON.stringify(lifecycleModuleUrl)};`,
    'const [id, directory, mode, target = ""] = process.argv.slice(2);',
    'const marker = `${directory}/${mode}-${target || id}-${id}.marker`;',
    'const result = `${directory}/result-${id}.json`;',
    'const waitForRelease = async () => {',
    '  const deadline = Date.now() + 30_000;',
    '  while (Date.now() < deadline) {',
    '    try { await access(`${directory}/release-${id}`); return; } catch {}',
    '    await new Promise((resolve) => setTimeout(resolve, 25));',
    '  }',
    '  throw new Error("launcher barrier timeout");',
    '};',
    'try {',
    '  const stack = await startLocalStack({ testHooks: {',
    '    afterLease: async () => { if (mode === "lease") { await writeFile(marker, "leased"); await waitForRelease(); } },',
    '    afterService: async (name) => { if (mode === "crash" && name === target) { await writeFile(marker, name); await new Promise(() => {}); } },',
    '    beforeServiceRelease: async (name, supervisor) => { if (mode === "pre-release" && name === target) { await writeFile(marker, JSON.stringify({ name, pid: supervisor.pid })); await new Promise(() => {}); } }',
    '  } });',
    '  await writeFile(result, JSON.stringify({ ok: true, services: stack.services.map(({ name, pid }) => ({ name, pid })) }));',
    '} catch (error) {',
    '  await writeFile(result, JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error), details: error instanceof AggregateError ? error.errors.map((item) => item instanceof Error ? item.message : String(item)) : [] }));',
    '  process.exitCode = 1;',
    '}'
  ].join("\n"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return { directory, script };
};

const spawnLauncher = ({ script, directory, id, mode, target = "", env = process.env }) =>
  spawn(process.execPath, [script, id, directory, mode, target], { cwd: checkout, env, stdio: "ignore" });

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
    'else if (process.argv[3] !== "late-fork") process.on("SIGTERM", () => server.close(() => process.exit(0)));',
    'if (process.argv[3] === "tree") {',
    '  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: process.cwd(), stdio: "ignore" });',
    '  writeFileSync(process.argv[4], String(child.pid));',
    '}',
    'if (process.argv[3] === "late-fork") {',
    '  process.once("SIGTERM", () => {',
    '    const child = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { cwd: process.cwd(), stdio: "ignore" });',
    '    writeFileSync(process.argv[4], String(child.pid));',
    '    server.close(() => process.exit(0));',
    '  });',
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
  const child = spawn(process.execPath, [script, String(port), ...(mode === undefined ? [] : [mode]), ...(extra === undefined ? [] : [extra])], { cwd, detached: true, stdio: "ignore" });
  await waitFor(async () => {
    const observed = await inspectProcess(child.pid);
    return observed?.listeningPorts.includes(port) === true;
  });
  return child;
};

const makeRecord = async ({ checkoutPath, controlPath, child, port, nonce = crypto.randomUUID() }) => {
  const observed = await inspectProcess(child.pid);
  assert(observed);
  const { stdout: pgidText } = await run("/bin/ps", ["-p", String(child.pid), "-o", "pgid="], { encoding: "utf8" });
  const pgid = Number(pgidText.trim());
  assert(Number.isSafeInteger(pgid) && pgid > 0);
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
      pgid,
      port,
      logPath: join(checkoutPath, ".nxt-local", "fixture.log"),
      nonce
    }]
  };
  await writeControlRecord(controlPath, record);
  return record;
};

test("process inspection includes the process-group identity", async (t) => {
  const { directory, childScript } = await fixture(t);
  const port = await reservePort();
  const child = await startChild(childScript, port, directory);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const observed = await inspectProcess(child.pid);
  assert(observed);
  assert(Number.isSafeInteger(observed.pgid) && observed.pgid > 0);
});

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
  ["executable", (record) => ({ ...record, services: record.services.map((service) => ({ ...service, executable: "/tmp/foreign-executable" })) })],
  ["process group", (record) => ({ ...record, services: record.services.map((service) => ({ ...service, pgid: service.pgid + 1 })) })],
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

test("controlled stop refuses descendant-enumeration errors and retains ownership state", async (t) => {
  const { directory, childScript } = await fixture(t);
  const controlPath = join(directory, ".nxt-local", "control.json");
  await mkdir(join(directory, ".nxt-local"), { recursive: true });
  const port = await reservePort();
  const child = await startChild(childScript, port, directory);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await makeRecord({ checkoutPath: directory, controlPath, child, port });

  await assert.rejects(
    stopControlledStack({
      checkoutPath: directory,
      controlPath,
      enumerateChildPids: async () => { throw new Error("injected descendant enumeration failure"); }
    }),
    /injected descendant enumeration failure/u
  );
  assert.equal((await inspectProcess(child.pid))?.listeningPorts.includes(port), true);
  assert.match(await readFile(controlPath, "utf8"), /fixture/u);
});

test("concurrent Stops have exactly one exclusive identity-bound owner", async (t) => {
  const { directory, childScript } = await fixture(t);
  const controlPath = join(directory, ".nxt-local", "control.json");
  await mkdir(join(directory, ".nxt-local"), { recursive: true });
  const port = await reservePort();
  const child = await startChild(childScript, port, directory);
  let claimObserved = false;
  let releaseClaim;
  const claimBarrier = new Promise((resolvePromise) => { releaseClaim = resolvePromise; });
  await makeRecord({ checkoutPath: directory, controlPath, child, port });
  const firstStop = stopControlledStack({
    checkoutPath: directory,
    controlPath,
    afterStopClaim: async () => { claimObserved = true; await claimBarrier; }
  });
  t.after(async () => {
    releaseClaim();
    await firstStop.catch(() => {});
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  await waitFor(() => claimObserved);
  assert.equal(await pathExists(join(directory, ".nxt-local", "stop.lock")), true);
  await assert.rejects(
    stopControlledStack({ checkoutPath: directory, controlPath }),
    /Stop|stop.*owned|claim/u
  );
  assert.equal((await inspectProcess(child.pid))?.listeningPorts.includes(port), true);
  assert.match(await readFile(controlPath, "utf8"), /fixture/u);
  releaseClaim();
  assert.deepEqual(await firstStop, { status: "stopped" });
});

test("controlled stop repeatedly discovers and terminates a late fork", async (t) => {
  const { directory, childScript } = await fixture(t);
  const controlPath = join(directory, ".nxt-local", "control.json");
  const childPidPath = join(directory, "late-descendant.pid");
  await mkdir(join(directory, ".nxt-local"), { recursive: true });
  const port = await reservePort();
  const child = await startChild(childScript, port, directory, "late-fork", childPidPath);
  let descendantPid;
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGKILL");
    if (Number.isSafeInteger(descendantPid) && await inspectProcess(descendantPid) !== null) process.kill(descendantPid, "SIGKILL");
  });
  await makeRecord({ checkoutPath: directory, controlPath, child, port });

  assert.deepEqual(
    await stopControlledStack({ checkoutPath: directory, controlPath, termTimeoutMs: 1_000, killTimeoutMs: 1_000 }),
    { status: "stopped" }
  );
  await waitFor(async () => readFile(childPidPath, "utf8").then(() => true, () => false));
  descendantPid = Number(await readFile(childPidPath, "utf8"));
  assert.equal(await inspectProcess(descendantPid), null);
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

test("simultaneous launchers have exactly one lease owner and the loser cannot erase its stack", { timeout: 120_000 }, async (t) => {
  const { directory, script } = await createLauncherHarness(t);
  const runners = [
    spawnLauncher({ script, directory, id: "a", mode: "lease" }),
    spawnLauncher({ script, directory, id: "b", mode: "lease" })
  ];
  t.after(async () => {
    await Promise.all(runners.map(terminateRunner));
    await forceCleanupCheckoutStack();
  });

  await waitFor(async () => {
    const entries = await readdir(directory);
    return entries.filter((name) => name.startsWith("lease-") && name.endsWith(".marker")).length === 1 &&
      entries.filter((name) => name.startsWith("result-") && name.endsWith(".json")).length === 1;
  }, 15_000);
  const entries = await readdir(directory);
  const leaseMarker = entries.find((name) => name.startsWith("lease-") && name.endsWith(".marker"));
  assert(leaseMarker);
  const winnerId = leaseMarker.endsWith("-a.marker") ? "a" : "b";
  const loserId = winnerId === "a" ? "b" : "a";
  const loser = JSON.parse(await readFile(join(directory, `result-${loserId}.json`), "utf8"));
  assert.equal(loser.ok, false);
  assert.match(loser.message, /lease|control|startup/u);
  assert.equal(await pathExists(join(checkout, ".nxt-local", "startup.lock")), true);
  const starting = JSON.parse(await readFile(join(checkout, ".nxt-local", "control.json"), "utf8"));
  assert.equal(starting.state, "starting");
  assert.equal(starting.services.length, 0);

  await writeFile(join(directory, `release-${winnerId}`), "release");
  await waitFor(() => pathExists(join(directory, `result-${winnerId}.json`)), 90_000);
  const winner = JSON.parse(await readFile(join(directory, `result-${winnerId}.json`), "utf8"));
  assert.equal(winner.ok, true, [winner.message, ...(winner.details ?? [])].filter(Boolean).join(" | ") || "winning launcher failed");
  assert.deepEqual(winner.services.map(({ name }) => name), ["vite", "functions", "swa"]);
  const ready = JSON.parse(await readFile(join(checkout, ".nxt-local", "control.json"), "utf8"));
  assert.equal(ready.state, "ready");
  for (const name of ["vite", "functions", "swa"]) assert.equal(await pathExists(join(checkout, ".nxt-local", `${name}.log`)), true);
  assert.deepEqual(await stopControlledStack({ checkoutPath: checkout }), { status: "stopped" });
  await assert.doesNotReject(assertPortsAvailable([4280, 5173, 7071]));
});

test("launcher SIGKILL before Vite release leaves only a recorded gated supervisor for Stop", { timeout: 120_000 }, async (t) => {
  const { directory, script } = await createLauncherHarness(t);
  const runner = spawnLauncher({ script, directory, id: "prerelease", mode: "pre-release", target: "vite" });
  const markerPath = join(directory, "pre-release-vite-prerelease.marker");
  const resultPath = join(directory, "result-prerelease.json");
  t.after(async () => {
    await terminateRunner(runner);
    await forceCleanupCheckoutStack();
  });

  await waitFor(async () => await pathExists(markerPath) || await pathExists(resultPath), 90_000);
  assert.equal(await pathExists(markerPath), true, await pathExists(resultPath) ? (JSON.parse(await readFile(resultPath, "utf8")).message ?? "service was released before its gate") : "missing pre-release marker");
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  const provisional = JSON.parse(await readFile(join(checkout, ".nxt-local", "control.json"), "utf8"));
  assert.equal(provisional.state, "starting");
  assert.equal(provisional.services.length, 1);
  assert.equal(provisional.services[0].status, "gated");
  assert.equal(provisional.services[0].launcher.pid, marker.pid);
  await assert.doesNotReject(assertPortsAvailable([5173]));
  await terminateRunner(runner);

  assert.deepEqual(await stopControlledStack({ checkoutPath: checkout }), { status: "stopped" });
  assert.equal(await inspectProcess(marker.pid), null);
  await assert.doesNotReject(assertPortsAvailable([4280, 5173, 7071]));
  assert.equal(await pathExists(join(checkout, ".nxt-local")), false);
});

for (const [serviceName, expectedCount] of [["vite", 1], ["functions", 2]]) {
  test(`Stop recovers a launcher SIGKILL after ${serviceName} is durably recorded`, { timeout: 120_000 }, async (t) => {
    const { directory, script } = await createLauncherHarness(t);
    const runner = spawnLauncher({ script, directory, id: serviceName, mode: "crash", target: serviceName });
    t.after(async () => {
      await terminateRunner(runner);
      await forceCleanupCheckoutStack();
    });

    const markerPath = join(directory, `crash-${serviceName}-${serviceName}.marker`);
    const resultPath = join(directory, `result-${serviceName}.json`);
    await waitFor(async () => await pathExists(markerPath) || await pathExists(resultPath), 90_000);
    assert.equal(
      await pathExists(markerPath),
      true,
      await pathExists(resultPath) ? (JSON.parse(await readFile(resultPath, "utf8")).message ?? "launcher failed before crash barrier") : "missing crash barrier"
    );
    const provisional = JSON.parse(await readFile(join(checkout, ".nxt-local", "control.json"), "utf8"));
    assert.equal(provisional.state, "starting");
    assert.equal(provisional.services.length, expectedCount);
    assert.equal(provisional.services.every(({ status }) => status === "ready"), true);
    await terminateRunner(runner);

    assert.deepEqual(await stopControlledStack({ checkoutPath: checkout }), { status: "stopped" });
    await assert.doesNotReject(assertPortsAvailable([4280, 5173, 7071]));
    assert.equal(await pathExists(join(checkout, ".nxt-local")), false);
  });
}

test("caller-exported local auth bypass is removed from Vite and SWA and child-scoped to Functions", { timeout: 120_000 }, async (t) => {
  const { directory, script } = await createLauncherHarness(t);
  const marker = `caller-${crypto.randomUUID()}`;
  const wrapper = join(directory, "pnpm");
  const buildEnvironmentLog = join(directory, "build-environment.log");
  const { stdout: realPnpm } = await run("/usr/bin/which", ["pnpm"], { encoding: "utf8" });
  await writeFile(wrapper, [
    "#!/usr/bin/env node",
    'const { spawnSync } = require("node:child_process");',
    'const { appendFileSync } = require("node:fs");',
    'appendFileSync(process.env.NXT_TEST_BUILD_ENV_LOG, `${process.env.NXT_LOCAL_AUTH_BYPASS === undefined ? "absent" : "present"}\\n`);',
    'const result = spawnSync(process.env.NXT_TEST_REAL_PNPM, process.argv.slice(2), { env: process.env, stdio: "inherit" });',
    'process.exit(result.status ?? 1);'
  ].join("\n"));
  await chmod(wrapper, 0o700);
  const runner = spawnLauncher({
    script,
    directory,
    id: "env",
    mode: "normal",
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      NXT_LOCAL_AUTH_BYPASS: marker,
      NXT_TEST_BUILD_ENV_LOG: buildEnvironmentLog,
      NXT_TEST_REAL_PNPM: realPnpm.trim()
    }
  });
  t.after(async () => {
    await terminateRunner(runner);
    await forceCleanupCheckoutStack();
  });

  await waitFor(() => pathExists(join(directory, "result-env.json")), 90_000);
  const result = JSON.parse(await readFile(join(directory, "result-env.json"), "utf8"));
  assert.equal(result.ok, true, [result.message, ...(result.details ?? [])].filter(Boolean).join(" | ") || "environment-scope launcher failed");
  const buildEnvironmentStates = (await readFile(buildEnvironmentLog, "utf8")).trim().split("\n");
  assert.equal(buildEnvironmentStates.length >= 3, true);
  assert.equal(buildEnvironmentStates.every((state) => state === "absent"), true);
  const record = JSON.parse(await readFile(join(checkout, ".nxt-local", "control.json"), "utf8"));
  for (const service of record.services) {
    const { stdout } = await run("/bin/ps", ["eww", "-p", String(service.pid), "-o", "command="], { encoding: "utf8" });
    if (service.name === "functions") {
      assert.equal(/NXT_LOCAL_AUTH_BYPASS=1(?:\s|$)/u.test(stdout), true, "Functions must receive the child-only bypass.");
      assert.equal(stdout.includes(marker), false, "Functions must not inherit the caller bypass value.");
    } else {
      assert.equal(stdout.includes("NXT_LOCAL_AUTH_BYPASS="), false, `${service.name} must not inherit the auth bypass.`);
    }
  }
  assert.deepEqual(await stopControlledStack({ checkoutPath: checkout }), { status: "stopped" });
});

test("ready Stop keeps Run excluded until process, control, and log cleanup finishes", { timeout: 180_000 }, async (t) => {
  const stack = await startLocalStack();
  let cleanupObserved = false;
  let releaseCleanup;
  const cleanupBarrier = new Promise((resolvePromise) => { releaseCleanup = resolvePromise; });
  const stopping = stopControlledStack({
    checkoutPath: checkout,
    beforeStopClaimRelease: async () => { cleanupObserved = true; await cleanupBarrier; }
  });
  t.after(async () => {
    releaseCleanup();
    await stopping.catch(() => {});
    await forceCleanupCheckoutStack();
  });

  await waitFor(() => cleanupObserved, 30_000);
  assert.equal(await pathExists(join(checkout, ".nxt-local", "stop.lock")), true);
  assert.equal(await pathExists(join(checkout, ".nxt-local", "control.json")), false);
  for (const service of stack.services) assert.equal(await pathExists(service.logPath), false);
  await assert.doesNotReject(assertPortsAvailable([4280, 5173, 7071]));
  await assert.rejects(startLocalStack(), /Stop|stop.*owned|claim/u);
  releaseCleanup();
  assert.deepEqual(await stopping, { status: "stopped" });

  const restarted = await startLocalStack();
  assert.equal(restarted.services.length, 3);
  assert.deepEqual(await stopControlledStack({ checkoutPath: checkout }), { status: "stopped" });
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
