import { describe, expect, it } from "vitest";
import { RootBoundaryStorage } from "../src/storage/index.js";
import type { StoragePort, StoredFile } from "../src/storage/index.js";

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

  it("post-validates update return identity and ancestry while allowing a Trash result", async () => {
    const file = (input: Partial<StoredFile> = {}): StoredFile => ({
      id: "note",
      name: "note.md",
      mimeType: "text/markdown",
      parentIds: ["vault"],
      version: "2",
      modifiedTime: "2026-08-23T00:00:00.000Z",
      size: 4,
      trashed: false,
      ...input
    });
    const unsupported = async (): Promise<never> =>
      Promise.reject(new Error("unsupported"));
    const makeStorage = (updated: StoredFile): StoragePort => ({
      get: async (fileId) =>
        fileId === "vault"
          ? file({
              id: "vault",
              name: "vault",
              mimeType: FOLDER_MIME_TYPE,
              parentIds: [],
              size: 0
            })
          : file(),
      listChildren: unsupported,
      readText: unsupported,
      readBytes: unsupported,
      createFolder: unsupported,
      createText: unsupported,
      createBytes: unsupported,
      updateText: async () => updated,
      move: unsupported,
      trash: async () => file({ trashed: true }),
      listRevisions: unsupported
    });

    for (const updated of [
      file({ id: "other" }),
      file({ parentIds: ["outside"] }),
      file({ parentIds: ["vault", "outside"] })
    ]) {
      const bounded = new RootBoundaryStorage(makeStorage(updated), "vault");
      await expect(
        bounded.updateText({
          fileId: "note",
          expectedVersion: "1",
          mimeType: "text/markdown",
          text: "next"
        })
      ).rejects.toThrow();
    }

    const bounded = new RootBoundaryStorage(makeStorage(file()), "vault");
    await expect(
      bounded.updateText({
        fileId: "note",
        expectedVersion: "1",
        mimeType: "text/markdown",
        text: "next"
      })
    ).resolves.toMatchObject({ id: "note", parentIds: ["vault"] });
    await expect(bounded.trash({ fileId: "note", expectedVersion: "2" })).resolves.toMatchObject({
      id: "note",
      trashed: true
    });
  });

  it("forwards a structurally required conditional Trash version to the inner storage", async () => {
    const file: StoredFile = {
      id: "note", name: "note.md", mimeType: "text/markdown", parentIds: ["vault"],
      version: "7", modifiedTime: "2026-08-23T00:00:00.000Z", size: 4, trashed: false
    };
    const seen: Array<{ fileId: string; expectedVersion: string }> = [];
    const inner: StoragePort = {
      get: async (id) => id === "vault" ? { ...file, id: "vault", name: "vault", mimeType: FOLDER_MIME_TYPE, parentIds: [], size: 0 } : file,
      listChildren: async () => ({ files: [] }), readText: async () => { throw new Error("unused"); }, readBytes: async () => { throw new Error("unused"); },
      createFolder: async () => { throw new Error("unused"); }, createText: async () => { throw new Error("unused"); }, createBytes: async () => { throw new Error("unused"); },
      updateText: async () => { throw new Error("unused"); }, move: async () => { throw new Error("unused"); },
      trash: async (input) => { seen.push(input); return { ...file, trashed: true, version: "8" }; }, listRevisions: async () => []
    };
    const bounded = new RootBoundaryStorage(inner, "vault");
    await expect(bounded.trash({ fileId: "note", expectedVersion: "7" })).resolves.toMatchObject({ trashed: true });
    expect(seen).toEqual([{ fileId: "note", expectedVersion: "7" }]);
  });
});

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
