import { describe, expect, it } from "vitest";
import { RootBoundaryStorage } from "../src/storage/index.js";

describe("RootBoundaryStorage", () => {
  it("rejects cross-root and ambiguous ancestry", async () => {
    const storage = RootBoundaryStorage.forTest({
      allowedRootId: "vault",
      graph: { vault: [], note: ["other"], other: [] }
    });
    await expect(storage.assertInside("note")).rejects.toThrow("outside configured root");
  });

  it("accepts the configured root and its single-parent descendants", async () => {
    const storage = RootBoundaryStorage.forTest({
      allowedRootId: "vault",
      graph: { vault: [], notes: ["vault"], note: ["notes"] }
    });
    await expect(storage.assertInside("vault")).resolves.toBeUndefined();
    await expect(storage.assertInside("note")).resolves.toBeUndefined();
  });

  it("validates the configured root before accepting it", async () => {
    await expect(
      RootBoundaryStorage.forTest({ allowedRootId: "vault", graph: {} }).assertInside("vault")
    ).rejects.toThrow("missing parent");
    await expect(
      RootBoundaryStorage.forTest({ allowedRootId: "vault", graph: { vault: [] }, trashed: ["vault"] }).assertInside("vault")
    ).rejects.toThrow("trashed");
    await expect(
      RootBoundaryStorage.forTest({ allowedRootId: "vault", graph: { vault: [] }, shortcuts: ["vault"] }).assertInside("vault")
    ).rejects.toThrow("shortcut");
  });

  it("rejects multiple parents, cycles, shortcuts, trash, missing parents, and long IDs", async () => {
    await expect(
      RootBoundaryStorage.forTest({ allowedRootId: "vault", graph: { vault: [], shared: ["vault", "other"] } }).assertInside("shared")
    ).rejects.toThrow("ambiguous ancestry");
    await expect(
      RootBoundaryStorage.forTest({ allowedRootId: "vault", graph: { vault: [], a: ["b"], b: ["a"] } }).assertInside("a")
    ).rejects.toThrow("cycle");
    await expect(
      RootBoundaryStorage.forTest({ allowedRootId: "vault", graph: { vault: [], link: ["vault"] }, shortcuts: ["link"] }).assertInside("link")
    ).rejects.toThrow("shortcut");
    await expect(
      RootBoundaryStorage.forTest({ allowedRootId: "vault", graph: { vault: [], deleted: ["vault"] }, trashed: ["deleted"] }).assertInside("deleted")
    ).rejects.toThrow("trashed");
    await expect(
      RootBoundaryStorage.forTest({ allowedRootId: "vault", graph: { vault: [], orphan: ["missing"] } }).assertInside("orphan")
    ).rejects.toThrow("missing parent");
    await expect(
      RootBoundaryStorage.forTest({ allowedRootId: "vault", graph: { vault: [] } }).assertInside("x".repeat(513))
    ).rejects.toThrow("invalid file ID");
  });

  it("caps ancestry traversal at one hundred nodes", async () => {
    const graph: Record<string, string[]> = { vault: [] };
    for (let index = 0; index <= 100; index += 1) {
      graph[`node-${index}`] = [index === 100 ? "vault" : `node-${index + 1}`];
    }
    const storage = RootBoundaryStorage.forTest({ allowedRootId: "vault", graph });
    await expect(storage.assertInside("node-0")).rejects.toThrow("ancestry limit");
  });
});
