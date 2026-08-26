import { randomUUID } from "node:crypto";
import { mkdir, realpath, rename, rm, rmdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/local-runtime-ownership.js", () => ({
  verifyLocalRuntimeOwnership: vi.fn().mockResolvedValue({ nonce: "composition-test", functions: {} })
}));

const localKeys = [
  "NXT_LOCAL_STORAGE_MODE", "NXT_LOCAL_FIXTURE_ROOT", "NXT_LOCAL_CHECKOUT_ROOT",
  "NXT_LOCAL_CONTROL_NONCE", "NODE_ENV", "AZURE_FUNCTIONS_ENVIRONMENT", "NXT_LOCAL_AUTH_BYPASS"
] as const;
const googleKeys = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"] as const;
const original = new Map([...localKeys, ...googleKeys].map((key) => [key, process.env[key]]));

const setLocalEnvironment = (checkout: string, fixtureRoot: string, nonce: string): void => {
  process.env.NXT_LOCAL_STORAGE_MODE = "filesystem";
  process.env.NXT_LOCAL_FIXTURE_ROOT = fixtureRoot;
  process.env.NXT_LOCAL_CHECKOUT_ROOT = checkout;
  process.env.NXT_LOCAL_CONTROL_NONCE = nonce;
  process.env.NODE_ENV = "development";
  process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Development";
  process.env.NXT_LOCAL_AUTH_BYPASS = "1";
  for (const key of googleKeys) delete process.env[key];
};

afterEach(() => {
  for (const [key, value] of original) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
});

describe("runtime service composition", () => {
  it("keeps Google as the default and rejects caller local paths without the trusted mode", async () => {
    delete process.env.NXT_LOCAL_STORAGE_MODE;
    process.env.NXT_LOCAL_FIXTURE_ROOT = "/tmp/caller-controlled";
    const runtime = await import("../src/services/runtime-services.js");
    await expect(runtime.resolveTask7Services()).rejects.toThrow("Task 7 service configuration is incomplete");
  });

  it("rejects local mode unless every development/auth/canonical-root guard holds", async () => {
    const checkout = await realpath(join(import.meta.dirname, "..", ".."));
    const fixtureRoot = join(checkout, ".nxt-local", "fixtures", "runtime-guard-test");
    await mkdir(fixtureRoot, { recursive: true });
    try {
      process.env.NXT_LOCAL_STORAGE_MODE = "filesystem";
      process.env.NXT_LOCAL_FIXTURE_ROOT = fixtureRoot;
      process.env.NXT_LOCAL_CHECKOUT_ROOT = checkout;
      process.env.NODE_ENV = "production";
      process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Development";
      process.env.NXT_LOCAL_AUTH_BYPASS = "1";
      const runtime = await import("../src/services/runtime-services.js");
      await expect(Promise.resolve(runtime.resolveTask7Services())).rejects.toThrow("Local runtime is not permitted");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("shares one canonical local vault between Task 7 and Task 9", async () => {
    const checkout = await realpath(join(import.meta.dirname, "..", ".."));
    const fixtureRoot = join(checkout, ".nxt-local", "fixtures", "playwright");
    // @ts-expect-error The local fixture controller is intentionally a Node-only module outside the API build.
    const fixtures = await import("../../scripts/local-fixtures.mjs") as {
      seedLocalFixtures(input: { checkoutPath: string; fixtureRoot: string; environment: Record<string, string> }): Promise<unknown>;
      removeLocalFixtures(input: { checkoutPath: string; fixtureRoot: string }): Promise<void>;
    };
    await fixtures.seedLocalFixtures({ checkoutPath: checkout, fixtureRoot, environment: {} });
    try {
      setLocalEnvironment(checkout, fixtureRoot, randomUUID());
      const runtime = await import("../src/services/runtime-services.js");
      const task7 = await runtime.resolveTask7Services();
      const task9 = await runtime.resolveTask9Services();
      const note = await task7.vault.getNote("018f47d2-6a34-7b2a-9f21-8a7034963aef");
      const published = await task9.publications.publish({ noteId: note.note.frontmatter.id, expectedVersion: note.version });
      await expect(task9.reader.getNote(published.publicId)).resolves.toMatchObject({ title: "Welcome to NXT" });
    } finally {
      await fixtures.removeLocalFixtures({ checkoutPath: checkout, fixtureRoot });
      await rmdir(join(checkout, ".nxt-local", "fixtures")).catch(() => undefined);
      await rmdir(join(checkout, ".nxt-local")).catch(() => undefined);
    }
  }, 30_000);

  it("rejects a symlinked local fixture descriptor even under a valid owned control", async () => {
    const checkout = await realpath(join(import.meta.dirname, "..", ".."));
    const fixtureRoot = join(checkout, ".nxt-local", "fixtures", "playwright");
    // @ts-expect-error The local fixture controller is intentionally a Node-only module outside the API build.
    const fixtures = await import("../../scripts/local-fixtures.mjs") as {
      seedLocalFixtures(input: { checkoutPath: string; fixtureRoot: string; environment: Record<string, string> }): Promise<unknown>;
    };
    await fixtures.seedLocalFixtures({ checkoutPath: checkout, fixtureRoot, environment: {} });
    const descriptor = join(fixtureRoot, ".fixture.json");
    const target = join(fixtureRoot, ".fixture-target.json");
    try {
      setLocalEnvironment(checkout, fixtureRoot, randomUUID());
      await rename(descriptor, target);
      await symlink(target, descriptor);
      const runtime = await import("../src/services/runtime-services.js");
      await expect(runtime.resolveTask7Services()).rejects.toThrow("Local runtime is not permitted");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
      await rmdir(join(checkout, ".nxt-local", "fixtures")).catch(() => undefined);
      await rmdir(join(checkout, ".nxt-local")).catch(() => undefined);
    }
  });
});
