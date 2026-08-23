import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
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

  it("does not expose an update when metadata persistence rejects it and retries preserve its revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    let rejectNextMetadataSave = false;
    const storage = await LocalDriveAdapter.create(root, {
      beforeMetadataWrite: () => {
        if (rejectNextMetadataSave) {
          rejectNextMetadataSave = false;
          throw new Error("injected metadata failure");
        }
      }
    });
    const file = await storage.createText({ parentId: "vault", name: "note.md", mimeType: "text/markdown", text: "one" });

    rejectNextMetadataSave = true;
    await expect(
      storage.updateText({ fileId: file.id, expectedVersion: file.version, mimeType: "text/markdown", text: "two" })
    ).rejects.toThrow("injected metadata failure");
    expect(await storage.get(file.id)).toMatchObject({ version: file.version });
    await expect(storage.readText(file.id)).resolves.toMatchObject({ text: "one" });
    expect(await storage.listRevisions(file.id)).toEqual([{ id: "1", modifiedTime: file.modifiedTime }]);

    const retried = await storage.updateText({ fileId: file.id, expectedVersion: file.version, mimeType: "text/markdown", text: "two" });
    expect(retried.version).toBe("2");
    await expect(storage.readText(file.id)).resolves.toMatchObject({ text: "two" });
    expect(await readFile(join(root, ".revisions", file.id, "2"), "utf8")).toBe("two");
  });

  it("reconciles a failed pre-commit create before reusing its deterministic ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    let rejectNextMetadataSave = false;
    const storage = await LocalDriveAdapter.create(root, {
      beforeMetadataWrite: () => {
        if (rejectNextMetadataSave) {
          rejectNextMetadataSave = false;
          throw new Error("injected metadata failure");
        }
      }
    });

    rejectNextMetadataSave = true;
    await expect(
      storage.createText({ parentId: "vault", name: "failed.md", mimeType: "text/markdown", text: "failed content" })
    ).rejects.toThrow("injected metadata failure");
    expect((await storage.listChildren({ parentId: "vault", pageSize: 10 })).files).toEqual([]);

    const created = await storage.createText({ parentId: "vault", name: "recovered.md", mimeType: "text/markdown", text: "recovered content" });
    expect(created.id).toBe("file_1");
    expect(created.name).toBe("recovered.md");
    await expect(storage.readText(created.id)).resolves.toMatchObject({ text: "recovered content" });
    expect(await readFile(join(root, ".revisions", created.id, "1"), "utf8")).toBe("recovered content");
  });

  it("never overwrites an existing immutable revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    const storage = await LocalDriveAdapter.create(root);
    const file = await storage.createText({ parentId: "vault", name: "note.md", mimeType: "text/markdown", text: "one" });
    await writeFile(join(root, ".revisions", file.id, "2"), "immutable other content", { flag: "wx" });

    await expect(
      storage.updateText({ fileId: file.id, expectedVersion: file.version, mimeType: "text/markdown", text: "two" })
    ).rejects.toThrow("immutable revision");
    expect((await storage.get(file.id)).version).toBe(file.version);
    await expect(storage.readText(file.id)).resolves.toMatchObject({ text: "one" });
    expect(await readFile(join(root, ".revisions", file.id, "2"), "utf8")).toBe("immutable other content");
  });

  it("rejects an intermediate symlink without creating metadata outside the requested root", async () => {
    const base = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    const container = join(base, "container");
    const outside = join(base, "outside");
    await mkdir(container);
    await mkdir(outside);
    await symlink(outside, join(container, "link"));

    await expect(LocalDriveAdapter.create(join(container, "link", "nested"))).rejects.toThrow("unsafe storage directory");
    await expect(access(join(outside, "nested", ".metadata.json"))).rejects.toThrow();
  });

  it("returns only the StoragePort file fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    const storage = await LocalDriveAdapter.create(root);
    const file = await storage.createFolder({ parentId: "vault", name: "folder" });

    expect(file).not.toHaveProperty("kind");
  });

  it("rolls back metadata when moving active content to Trash fails after commit staging", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    const storage = await LocalDriveAdapter.create(root);
    const file = await storage.createText({ parentId: "vault", name: "note.md", mimeType: "text/markdown", text: "one" });
    await mkdir(join(root, ".trash", file.id));

    await expect(storage.trash(file.id)).rejects.toThrow("trash destination already exists");
    expect((await storage.get(file.id)).trashed).toBe(false);
    await expect(storage.readText(file.id)).resolves.toMatchObject({ text: "one" });
    await expect(access(join(root, ".content", file.id))).resolves.toBeUndefined();
  });
});
