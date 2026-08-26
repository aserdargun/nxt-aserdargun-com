import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  inspectRuntimeProcess,
  verifyLocalRuntimeOwnership,
  type RuntimeProcessObservation
} from "../src/services/local-runtime-ownership.js";

const liveChildren = new Set<ReturnType<typeof spawn>>();
afterEach(async () => {
  for (const child of liveChildren) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await new Promise((resolve) => child.exitCode !== null || child.signalCode !== null ? resolve(undefined) : child.once("exit", resolve));
  }
  liveChildren.clear();
});

const identity = (pid: number, parentPid: number, cwd: string): RuntimeProcessObservation => ({
  pid, parentPid, pgid: 200, startTime: `start-${pid}`, cwd,
  executable: "/fixture/node", command: `node fixture-${pid}`
});

const writeControl = async (checkout: string, fixtureRoot: string, nonce: string, service: RuntimeProcessObservation, overrides: Record<string, unknown> = {}) => {
  const localDirectory = join(checkout, ".nxt-local");
  const controlPath = join(localDirectory, "control.json");
  const attestationPath = join(localDirectory, "functions.attestation.json");
  const functions = {
    pid: service.pid, pgid: service.pgid, startTime: service.startTime, cwd: service.cwd,
    executable: service.executable, command: service.command, port: 7071,
    logPath: join(localDirectory, "functions.log")
  };
  const record = {
    version: 2, state: "ready", checkoutRealpath: checkout, fixtureRoot, nonce, runtimeAttestationPath: attestationPath,
    createdAt: "2026-08-26T12:00:00.000Z", updatedAt: "2026-08-26T12:00:01.000Z",
    services: [{
      name: "functions", status: "ready", port: 7071, nonce,
      ...functions
    }],
    ...overrides
  };
  await writeFile(controlPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await writeFile(attestationPath, `${JSON.stringify({
    version: 1, checkoutRealpath: checkout, fixtureRoot, nonce, functions
  })}\n`, { mode: 0o600 });
  return { controlPath, attestationPath, record };
};

const makeFixture = async () => {
  const checkout = await realpath(await mkdtemp(join(tmpdir(), "nxt-runtime-owner-")));
  const fixtureRoot = join(checkout, ".nxt-local", "fixtures", "playwright");
  await mkdir(fixtureRoot, { recursive: true });
  const nonce = randomUUID();
  const api = join(checkout, "api");
  await mkdir(api);
  const service = identity(200, 100, api);
  await writeControl(checkout, fixtureRoot, nonce, service);
  return { checkout, fixtureRoot, nonce, api, service };
};

describe("local runtime lifecycle ownership", () => {
  it("admits only the exact attested Functions process or its direct Core Tools worker child", async () => {
    const fixture = await makeFixture();
    const observations = new Map<number, RuntimeProcessObservation>([
      [300, identity(300, 200, fixture.api)],
      [200, fixture.service]
    ]);
    try {
      await expect(verifyLocalRuntimeOwnership({
        checkoutPath: fixture.checkout, fixtureRoot: fixture.fixtureRoot, nonce: fixture.nonce,
        currentParentPid: 200, inspectProcess: async (pid) => observations.get(pid) ?? null,
        assertProcessAlive: () => undefined
      })).resolves.toMatchObject({ nonce: fixture.nonce, functions: { pid: 200 } });
      await expect(verifyLocalRuntimeOwnership({
        checkoutPath: fixture.checkout, fixtureRoot: fixture.fixtureRoot, nonce: fixture.nonce,
        currentParentPid: 100, inspectProcess: async (pid) => observations.get(pid) ?? null,
        assertProcessAlive: () => undefined
      })).rejects.toThrow(/identity|ownership/u);

      observations.set(200, { ...fixture.service, startTime: "stale" });
      await expect(verifyLocalRuntimeOwnership({
        checkoutPath: fixture.checkout, fixtureRoot: fixture.fixtureRoot, nonce: fixture.nonce,
        currentParentPid: 200, inspectProcess: async (pid) => observations.get(pid) ?? null,
        assertProcessAlive: () => undefined
      })).rejects.toThrow(/identity|ownership/u);
    } finally {
      await rm(fixture.checkout, { recursive: true, force: true });
    }
  });

  it("refuses missing, corrupt, foreign, starting, wrong-nonce, and symlink control records", async () => {
    const fixture = await makeFixture();
    const controlPath = join(fixture.checkout, ".nxt-local", "control.json");
    const observer = async (pid: number) => pid === 200 ? fixture.service : pid === 300 ? identity(300, 200, fixture.api) : null;
    const verify = () => verifyLocalRuntimeOwnership({
      checkoutPath: fixture.checkout, fixtureRoot: fixture.fixtureRoot, nonce: fixture.nonce,
      currentParentPid: 200, inspectProcess: observer, assertProcessAlive: () => undefined
    });
    try {
      const original = await readFile(controlPath, "utf8");
      await rm(controlPath);
      await expect(verify()).rejects.toThrow(/control|ownership/u);
      await writeFile(controlPath, "{broken", { mode: 0o600 });
      await expect(verify()).rejects.toThrow(/control|ownership/u);
      await writeControl(fixture.checkout, fixture.fixtureRoot, fixture.nonce, fixture.service, { checkoutRealpath: `${fixture.checkout}-foreign` });
      await expect(verify()).rejects.toThrow(/control|ownership/u);
      await writeControl(fixture.checkout, fixture.fixtureRoot, fixture.nonce, fixture.service, { state: "starting" });
      await expect(verify()).rejects.toThrow(/control|ownership/u);
      await writeFile(controlPath, original, { mode: 0o600 });
      await expect(verifyLocalRuntimeOwnership({
        checkoutPath: fixture.checkout, fixtureRoot: fixture.fixtureRoot, nonce: randomUUID(),
        currentParentPid: 200, inspectProcess: observer, assertProcessAlive: () => undefined
      })).rejects.toThrow(/control|ownership/u);
      const target = join(fixture.checkout, ".nxt-local", "control-target.json");
      await rm(controlPath);
      await writeFile(target, original, { mode: 0o600 });
      await symlink(target, controlPath);
      await expect(verify()).rejects.toThrow(/control|ownership/u);
    } finally {
      await rm(fixture.checkout, { recursive: true, force: true });
    }
  });

  it("refuses missing, corrupt, wrong-nonce, symlinked, and control-mismatched Functions attestations", async () => {
    const fixture = await makeFixture();
    const localDirectory = join(fixture.checkout, ".nxt-local");
    const attestationPath = join(localDirectory, "functions.attestation.json");
    const verify = () => verifyLocalRuntimeOwnership({
      checkoutPath: fixture.checkout, fixtureRoot: fixture.fixtureRoot, nonce: fixture.nonce,
      currentParentPid: 200,
      inspectProcess: async (pid) => pid === 200 ? fixture.service : pid === 300 ? identity(300, 200, fixture.api) : null,
      assertProcessAlive: () => undefined
    });
    try {
      const original = await readFile(attestationPath, "utf8");
      await expect(verify()).resolves.toMatchObject({ nonce: fixture.nonce, functions: { pid: 200 } });
      await rm(attestationPath);
      await expect(verify()).rejects.toThrow(/attestation|ownership/u);
      await writeFile(attestationPath, "{broken", { mode: 0o600 });
      await expect(verify()).rejects.toThrow(/attestation|ownership/u);
      const parsed = JSON.parse(original) as Record<string, unknown>;
      await writeFile(attestationPath, `${JSON.stringify({ ...parsed, nonce: randomUUID() })}\n`, { mode: 0o600 });
      await expect(verify()).rejects.toThrow(/attestation|ownership/u);
      await writeFile(attestationPath, `${JSON.stringify({
        ...parsed, functions: { ...(parsed.functions as Record<string, unknown>), command: "foreign command" }
      })}\n`, { mode: 0o600 });
      await expect(verify()).rejects.toThrow(/attestation|identity|ownership/u);
      const target = join(localDirectory, "attestation-target.json");
      await rm(attestationPath);
      await writeFile(target, original, { mode: 0o600 });
      await symlink(target, attestationPath);
      await expect(verify()).rejects.toThrow(/attestation|ownership/u);
    } finally {
      await rm(fixture.checkout, { recursive: true, force: true });
    }
  });

  it("rejects a direct non-descendant invocation while the harmless recorded process survives", async () => {
    const fixture = await makeFixture();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: fixture.api, stdio: "ignore" });
    liveChildren.add(child);
    try {
      const observed = await inspectRuntimeProcess(child.pid as number);
      expect(observed).not.toBeNull();
      await writeControl(fixture.checkout, fixture.fixtureRoot, fixture.nonce, observed as RuntimeProcessObservation);
      await expect(verifyLocalRuntimeOwnership({
        checkoutPath: fixture.checkout, fixtureRoot: fixture.fixtureRoot, nonce: fixture.nonce,
        currentParentPid: process.ppid
      })).rejects.toThrow(/descendant|ownership/u);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
      liveChildren.delete(child);
      await rm(fixture.checkout, { recursive: true, force: true });
    }
  });
});
