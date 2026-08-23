import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalDriveAdapter } from "../src/storage/index.js";

describe("LocalDriveAdapter", () => {
  it("versions writes and never permanently deletes", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    const storage = await LocalDriveAdapter.create(root);
    const file = await storage.createText({
      parentId: "vault",
      name: "note.md",
      mimeType: "text/markdown",
      text: "one"
    });
    const updated = await storage.updateText({
      fileId: file.id,
      expectedVersion: file.version,
      text: "two",
      mimeType: "text/markdown"
    });

    expect(BigInt(updated.version)).toBeGreaterThan(BigInt(file.version));
    expect((await storage.readText(file.id)).text).toBe("two");
    expect((await storage.listRevisions(file.id)).map((revision) => revision.id)).toEqual(["1", "2"]);

    await storage.trash(file.id);
    expect((await storage.get(file.id)).trashed).toBe(true);
    await expect(storage.readText(file.id)).rejects.toThrow("trashed");
    expect(await readFile(join(root, ".trash", file.id), "utf8")).toBe("two");
    expect(await readFile(join(root, ".metadata.json"), "utf8")).not.toContain("refresh_token");
  });

  it("uses opaque IDs, bounded names, and optimistic versions", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    const storage = await LocalDriveAdapter.create(root);
    const file = await storage.createText({
      parentId: "vault",
      name: "safe.md",
      mimeType: "text/markdown",
      text: "one"
    });

    await expect(storage.get("../.metadata.json")).rejects.toThrow("invalid file ID");
    await expect(storage.get("x".repeat(513))).rejects.toThrow("invalid file ID");
    await expect(
      storage.createText({ parentId: "vault", name: "../escape.md", mimeType: "text/markdown", text: "x" })
    ).rejects.toThrow("invalid name");
    await expect(
      storage.updateText({ fileId: file.id, expectedVersion: "0", mimeType: "text/markdown", text: "two" })
    ).rejects.toThrow("version conflict");
  });

  it("assigns deterministic opaque IDs without deriving them from caller paths", async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    const first = await LocalDriveAdapter.create(firstRoot);
    const second = await LocalDriveAdapter.create(secondRoot);

    const firstFile = await first.createText({ parentId: "vault", name: "note.md", mimeType: "text/markdown", text: "one" });
    const secondFile = await second.createText({ parentId: "vault", name: "note.md", mimeType: "text/markdown", text: "one" });

    expect(firstFile.id).toBe("file_1");
    expect(secondFile.id).toBe(firstFile.id);
  });

  it("paginates in a stable order and rejects stale page tokens", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    const storage = await LocalDriveAdapter.create(root);
    await storage.createText({ parentId: "vault", name: "c.md", mimeType: "text/markdown", text: "c" });
    await storage.createText({ parentId: "vault", name: "a.md", mimeType: "text/markdown", text: "a" });
    await storage.createText({ parentId: "vault", name: "b.md", mimeType: "text/markdown", text: "b" });

    const first = await storage.listChildren({ parentId: "vault", pageSize: 2 });
    expect(first.files.map((file) => file.name)).toEqual(["a.md", "b.md"]);
    expect(first.nextPageToken).toBeTypeOf("string");
    await storage.createText({ parentId: "vault", name: "d.md", mimeType: "text/markdown", text: "d" });
    await expect(
      storage.listChildren({ parentId: "vault", pageSize: 2, pageToken: first.nextPageToken })
    ).rejects.toThrow("stale page token");
  });

  it("prevents folder cycles and keeps moved content inside internal directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    const storage = await LocalDriveAdapter.create(root);
    const parent = await storage.createFolder({ parentId: "vault", name: "parent" });
    const child = await storage.createFolder({ parentId: parent.id, name: "child" });
    const file = await storage.createText({ parentId: parent.id, name: "note.md", mimeType: "text/markdown", text: "text" });

    await expect(storage.move({ fileId: parent.id, fromParentId: "vault", toParentId: child.id })).rejects.toThrow("cycle");
    const moved = await storage.move({ fileId: file.id, fromParentId: parent.id, toParentId: child.id, newName: "moved.md" });
    expect(moved.parentIds).toEqual([child.id]);
    expect(moved.name).toBe("moved.md");
    await expect(storage.readText(file.id)).resolves.toMatchObject({ text: "text" });
  });
});
