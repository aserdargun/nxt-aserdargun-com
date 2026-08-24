import { access, mkdir, mkdtemp, readFile, readdir, rename, symlink, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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

  it("matches StoragePort MIME-change and same-parent no-op behavior", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    const storage = await LocalDriveAdapter.create(root);
    const file = await storage.createText({
      parentId: "vault",
      name: "note.txt",
      mimeType: "text/plain",
      text: "one"
    });
    const updated = await storage.updateText({
      fileId: file.id,
      expectedVersion: file.version,
      mimeType: "text/markdown",
      text: "two"
    });

    expect(updated.mimeType).toBe("text/markdown");
    await expect(storage.readText(file.id)).resolves.toMatchObject({
      text: "two",
      file: { mimeType: "text/markdown" }
    });
    await expect(
      storage.move({
        fileId: file.id,
        fromParentId: "vault",
        toParentId: "vault",
        expectedVersion: updated.version
      })
    ).rejects.toThrow("same-parent move requires a rename");
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

    await expect(storage.move({ fileId: parent.id, fromParentId: "vault", toParentId: child.id, expectedVersion: parent.version })).rejects.toThrow("cycle");
    const moved = await storage.move({ fileId: file.id, fromParentId: parent.id, toParentId: child.id, expectedVersion: file.version, newName: "moved.md" });
    expect(moved.parentIds).toEqual([child.id]);
    expect(moved.name).toBe("moved.md");
    await expect(storage.readText(file.id)).resolves.toMatchObject({ text: "text" });
  });

  it("atomically rejects a move when the observed version changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    const storage = await LocalDriveAdapter.create(root);
    const first = await storage.createFolder({ parentId: "vault", name: "first" });
    const second = await storage.createFolder({ parentId: "vault", name: "second" });
    const file = await storage.createText({ parentId: first.id, name: "note.md", mimeType: "text/markdown", text: "text" });
    const externallyRenamed = await storage.move({
      fileId: file.id,
      fromParentId: first.id,
      toParentId: first.id,
      expectedVersion: file.version,
      newName: "external.md"
    });

    await expect(storage.move({
      fileId: file.id,
      fromParentId: first.id,
      toParentId: second.id,
      newName: "intended.md",
      expectedVersion: file.version
    } as never)).rejects.toThrow("version conflict");
    await expect(storage.get(file.id)).resolves.toMatchObject({
      version: externallyRenamed.version,
      name: "external.md",
      parentIds: [first.id]
    });
  });

  it("rejects an omitted move version before changing local metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    const storage = await LocalDriveAdapter.create(root);
    const first = await storage.createFolder({ parentId: "vault", name: "first" });
    const second = await storage.createFolder({ parentId: "vault", name: "second" });
    const file = await storage.createText({ parentId: first.id, name: "note.md", mimeType: "text/markdown", text: "text" });

    await expect(storage.move({
      fileId: file.id,
      fromParentId: first.id,
      toParentId: second.id,
      expectedVersion: undefined
    } as never)).rejects.toThrow("invalid storage version");

    await expect(storage.get(file.id)).resolves.toMatchObject({
      version: file.version,
      name: "note.md",
      parentIds: [first.id]
    });
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

  it("serializes mutations across adapters before either adapter loads metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    const first = await LocalDriveAdapter.create(root);
    let markSecondReady!: () => void;
    let releaseSecond!: () => void;
    const secondReady = new Promise<void>((resolve) => {
      markSecondReady = resolve;
    });
    const secondRelease = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const second = await LocalDriveAdapter.create(root, {
      beforeMutationLoad: async () => {
        markSecondReady();
        await secondRelease;
      },
      beforeMetadataWrite: () => {
        throw new Error("second adapter intentionally fails");
      }
    });

    const secondMutation = second.createText({ parentId: "vault", name: "second.md", mimeType: "text/markdown", text: "second" });
    void secondMutation.catch(() => undefined);
    const reachedLock = await Promise.race([
      secondReady.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100))
    ]);
    expect(reachedLock).toBe(true);

    let firstSettled = false;
    const firstMutation = first.createText({ parentId: "vault", name: "first.md", mimeType: "text/markdown", text: "first" });
    void firstMutation.then(
      () => {
        firstSettled = true;
      },
      () => {
        firstSettled = true;
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(firstSettled).toBe(false);

    releaseSecond();
    await expect(secondMutation).rejects.toThrow("second adapter intentionally fails");
    const committed = await firstMutation;
    expect(committed.id).toBe("file_1");
    await expect(first.readText(committed.id)).resolves.toMatchObject({ text: "first" });
    expect(await readFile(join(root, ".revisions", committed.id, "1"), "utf8")).toBe("first");
  });

  it("recovers an interrupted Trash rollback on the next adapter load", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    let rollbackAttempted = false;
    const storage = await LocalDriveAdapter.create(root, {
      beforeMetadataRollbackWrite: () => {
        rollbackAttempted = true;
        throw new Error("injected rollback metadata failure");
      }
    });
    const file = await storage.createText({ parentId: "vault", name: "note.md", mimeType: "text/markdown", text: "one" });
    await mkdir(join(root, ".trash", file.id));

    await expect(storage.trash(file.id)).rejects.toThrow("injected rollback metadata failure");
    expect(rollbackAttempted).toBe(true);

    const recovered = await LocalDriveAdapter.create(root);
    expect((await recovered.get(file.id)).trashed).toBe(false);
    await expect(recovered.readText(file.id)).resolves.toMatchObject({ text: "one" });
    await expect(access(join(root, ".content", file.id))).resolves.toBeUndefined();
  });

  it("never steals an actively held old lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    const first = await LocalDriveAdapter.create(root);
    const committed = await first.createText({ parentId: "vault", name: "first.md", mimeType: "text/markdown", text: "first" });
    const lockPath = join(root, ".mutation.lock");
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({ token: "active-owner" }));
    await utimes(lockPath, new Date(0), new Date(0));

    await expect(LocalDriveAdapter.create(root, { lockTimeoutMs: 50 })).rejects.toThrow("timed out waiting for storage mutation lock");
    expect(await readFile(join(root, ".revisions", committed.id, "1"), "utf8")).toBe("first");
  });

  it("archives an owner lock before permitting a successor", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    let releaseProbeEnabled = false;
    let successor: Promise<LocalDriveAdapter> | undefined;
    const owner = await LocalDriveAdapter.create(root, {
      beforeLockRelease: () => {
        if (releaseProbeEnabled) {
          successor = LocalDriveAdapter.create(root, { lockTimeoutMs: 250 });
        }
      }
    });

    releaseProbeEnabled = true;
    await owner.createFolder({ parentId: "vault", name: "folder" });
    expect(successor).toBeDefined();
    await expect(successor).resolves.toBeInstanceOf(LocalDriveAdapter);
    expect((await readdir(join(root, ".lock-history"))).length).toBeGreaterThanOrEqual(2);
  });

  it("does not finalize a Trash journal against a bogus regular file and archives the untrusted artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    const storage = await LocalDriveAdapter.create(root);
    const file = await storage.createText({ parentId: "vault", name: "note.md", mimeType: "text/markdown", text: "one" });
    const originalMetadata = JSON.parse(await readFile(join(root, ".metadata.json"), "utf8"));
    const stagedMetadata = structuredClone(originalMetadata);
    stagedMetadata.files[file.id].trashed = true;
    await writeFile(join(root, ".metadata.json"), `${JSON.stringify(stagedMetadata)}\n`);
    await writeFile(join(root, ".trash", file.id), "bogus");
    await writeFile(
      join(root, ".trash-rollback.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        fileId: file.id,
        originalMetadata,
        expectedContent: { size: 3, checksum: createHash("sha256").update("one").digest("hex") }
      })}\n`
    );

    const recovered = await LocalDriveAdapter.create(root);
    expect((await recovered.get(file.id)).trashed).toBe(false);
    await expect(recovered.readText(file.id)).resolves.toMatchObject({ text: "one" });
    await expect(access(join(root, ".trash", file.id))).rejects.toThrow();
    const [historyEntry] = await readdir(join(root, ".transaction-history"));
    expect(await readFile(join(root, ".transaction-history", historyEntry as string, "artifact"), "utf8")).toBe("bogus");
  });

  it("writes Trash from the immutable revision rather than a mutable active cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    const storage = await LocalDriveAdapter.create(root);
    const file = await storage.createText({ parentId: "vault", name: "note.md", mimeType: "text/markdown", text: "authoritative" });
    await writeFile(join(root, ".content", file.id), "tampered cache");

    await storage.trash(file.id);

    expect(await readFile(join(root, ".trash", file.id), "utf8")).toBe("authoritative");
    expect(await readFile(join(root, ".revisions", file.id, "1"), "utf8")).toBe("authoritative");
  });

  it("retries lock acquisition when an existing lock disappears during handoff", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    await LocalDriveAdapter.create(root);
    const lockPath = join(root, ".mutation.lock");
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({ token: "handoff-owner" }));
    let handoffObserved = false;

    await expect(
      LocalDriveAdapter.create(root, {
        lockTimeoutMs: 50,
        onLockExists: async () => {
          handoffObserved = true;
          await rename(lockPath, join(root, ".manual-handoff-lock"));
        }
      })
    ).resolves.toBeInstanceOf(LocalDriveAdapter);
    expect(handoffObserved).toBe(true);
  });

  it("rejects malformed metadata during adapter creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    await LocalDriveAdapter.create(root);
    await writeFile(join(root, ".metadata.json"), '{"schemaVersion":1,"sequence":0,"generation":0,"files":[],"revisions":[]}\n');

    await expect(LocalDriveAdapter.create(root)).rejects.toThrow("invalid local metadata");
  });

  it("rejects persisted parent cycles during adapter creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    const storage = await LocalDriveAdapter.create(root);
    const first = await storage.createFolder({ parentId: "vault", name: "first" });
    const second = await storage.createFolder({ parentId: first.id, name: "second" });
    const metadata = JSON.parse(await readFile(join(root, ".metadata.json"), "utf8"));
    metadata.files[first.id].parentIds = [second.id];
    await writeFile(join(root, ".metadata.json"), `${JSON.stringify(metadata)}\n`);

    await expect(LocalDriveAdapter.create(root)).rejects.toThrow("invalid local metadata");
  });

  it("rejects a version one file whose active content revision is two", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    const storage = await LocalDriveAdapter.create(root);
    const file = await storage.createText({ parentId: "vault", name: "note.md", mimeType: "text/markdown", text: "one" });
    const metadata = JSON.parse(await readFile(join(root, ".metadata.json"), "utf8"));
    metadata.files[file.id].contentRevision = "2";
    metadata.revisions[file.id].push({ id: "2", modifiedTime: file.modifiedTime });
    await writeFile(join(root, ".revisions", file.id, "2"), "future revision", { flag: "wx" });
    await writeFile(join(root, ".metadata.json"), `${JSON.stringify(metadata)}\n`);

    await expect(LocalDriveAdapter.create(root)).rejects.toThrow("invalid local metadata");
  });

  it("recovers a staged legacy unbound file journal without losing its journal or artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    const storage = await LocalDriveAdapter.create(root);
    const file = await storage.createText({ parentId: "vault", name: "note.md", mimeType: "text/markdown", text: "one" });
    const originalMetadata = JSON.parse(await readFile(join(root, ".metadata.json"), "utf8"));
    const stagedMetadata = structuredClone(originalMetadata);
    stagedMetadata.sequence = 2;
    stagedMetadata.generation = 2;
    stagedMetadata.files[file.id].trashed = true;
    stagedMetadata.files[file.id].version = "2";
    stagedMetadata.files[file.id].modifiedTime = "1970-01-01T00:00:00.002Z";
    await writeFile(join(root, ".metadata.json"), `${JSON.stringify(stagedMetadata)}\n`);
    await writeFile(join(root, ".trash", file.id), "unbound staged artifact", { flag: "wx" });
    await writeFile(
      join(root, ".trash-rollback.json"),
      `${JSON.stringify({ schemaVersion: 1, fileId: file.id, originalMetadata })}\n`,
      { flag: "wx" }
    );

    const recovered = await LocalDriveAdapter.create(root);
    expect((await recovered.get(file.id)).trashed).toBe(false);
    await expect(recovered.readText(file.id)).resolves.toMatchObject({ text: "one" });
    await expect(access(join(root, ".trash", file.id))).rejects.toThrow();

    const historyEntries = await readdir(join(root, ".transaction-history"));
    expect(historyEntries).toHaveLength(1);
    expect(await readFile(join(root, ".transaction-history", historyEntries[0] as string, "artifact"), "utf8")).toBe("unbound staged artifact");
    expect(JSON.parse(await readFile(join(root, ".transaction-history", historyEntries[0] as string, "journal.json"), "utf8"))).toMatchObject({
      schemaVersion: 1,
      fileId: file.id
    });

    const restarted = await LocalDriveAdapter.create(root);
    await expect(restarted.readText(file.id)).resolves.toMatchObject({ text: "one" });
    expect(await readdir(join(root, ".transaction-history"))).toEqual(historyEntries);
  });

  it("trashes a file from its immutable revision when the mutable cache is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    const storage = await LocalDriveAdapter.create(root);
    const file = await storage.createText({ parentId: "vault", name: "note.md", mimeType: "text/markdown", text: "authoritative" });
    await rename(join(root, ".content", file.id), join(root, "withheld-cache"));

    await storage.trash(file.id);

    expect(await readFile(join(root, ".trash", file.id), "utf8")).toBe("authoritative");
    expect(await readFile(join(root, ".revisions", file.id, "1"), "utf8")).toBe("authoritative");
  });

  it("trashes verified revision bytes even when the mutable cache is corrupt", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    const storage = await LocalDriveAdapter.create(root);
    const file = await storage.createText({ parentId: "vault", name: "note.md", mimeType: "text/markdown", text: "authoritative" });
    await rename(join(root, ".content", file.id), join(root, "original-cache"));
    await mkdir(join(root, ".content", file.id));

    await storage.trash(file.id);

    expect(await readFile(join(root, ".trash", file.id), "utf8")).toBe("authoritative");
    expect(await readFile(join(root, ".revisions", file.id, "1"), "utf8")).toBe("authoritative");
  });

  it("persists the explicit file Trash state sequence", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    const storage = await LocalDriveAdapter.create(root);
    const file = await storage.createText({ parentId: "vault", name: "note.md", mimeType: "text/markdown", text: "one" });

    await storage.trash(file.id);

    const stateEntries = await readdir(join(root, ".transaction-state-history"));
    const preservedStates = await Promise.all(
      stateEntries.sort().map(async (entry) =>
        JSON.parse(await readFile(join(root, ".transaction-state-history", entry, "journal.json"), "utf8")).state as string
      )
    );
    expect(preservedStates).toEqual(["prepared", "metadata-staged", "artifact-verified"]);
    const [historyEntry] = await readdir(join(root, ".transaction-history"));
    expect(JSON.parse(await readFile(join(root, ".transaction-history", historyEntry as string, "journal.json"), "utf8"))).toMatchObject({
      schemaVersion: 2,
      state: "finalized"
    });
  });

  it("resumes a metadata-staged file Trash through verification and finalization after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    const storage = await LocalDriveAdapter.create(root);
    const file = await storage.createText({ parentId: "vault", name: "note.md", mimeType: "text/markdown", text: "one" });
    const originalMetadata = JSON.parse(await readFile(join(root, ".metadata.json"), "utf8"));
    const stagedMetadata = structuredClone(originalMetadata);
    stagedMetadata.sequence = 2;
    stagedMetadata.generation = 2;
    stagedMetadata.files[file.id].trashed = true;
    stagedMetadata.files[file.id].version = "2";
    stagedMetadata.files[file.id].modifiedTime = "1970-01-01T00:00:00.002Z";
    const descriptor = { size: 3, checksum: createHash("sha256").update("one").digest("hex") };
    await writeFile(join(root, ".metadata.json"), `${JSON.stringify(stagedMetadata)}\n`);
    await writeFile(join(root, ".trash", file.id), "one", { flag: "wx" });
    await writeFile(
      join(root, ".trash-rollback.json"),
      `${JSON.stringify({
        schemaVersion: 2,
        operation: "trash",
        itemKind: "file",
        state: "metadata-staged",
        fileId: file.id,
        originalMetadata,
        content: descriptor
      })}\n`,
      { flag: "wx" }
    );
    const recovered = await LocalDriveAdapter.create(root);

    expect((await recovered.get(file.id)).trashed).toBe(true);
    expect(await readFile(join(root, ".trash", file.id), "utf8")).toBe("one");
    const stateEntries = await readdir(join(root, ".transaction-state-history"));
    const preservedStates = await Promise.all(
      stateEntries.sort().map(async (entry) =>
        JSON.parse(await readFile(join(root, ".transaction-state-history", entry, "journal.json"), "utf8")).state as string
      )
    );
    expect(preservedStates).toEqual(["metadata-staged", "artifact-verified"]);
    const [historyEntry] = await readdir(join(root, ".transaction-history"));
    expect(JSON.parse(await readFile(join(root, ".transaction-history", historyEntry as string, "journal.json"), "utf8"))).toMatchObject({
      schemaVersion: 2,
      state: "finalized",
      itemKind: "file"
    });
  });

  it("rolls back a metadata-staged file Trash with no verifiable artifact after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    const storage = await LocalDriveAdapter.create(root);
    const file = await storage.createText({ parentId: "vault", name: "note.md", mimeType: "text/markdown", text: "one" });
    const originalMetadata = JSON.parse(await readFile(join(root, ".metadata.json"), "utf8"));
    const stagedMetadata = structuredClone(originalMetadata);
    stagedMetadata.sequence = 2;
    stagedMetadata.generation = 2;
    stagedMetadata.files[file.id].trashed = true;
    stagedMetadata.files[file.id].version = "2";
    stagedMetadata.files[file.id].modifiedTime = "1970-01-01T00:00:00.002Z";
    await writeFile(join(root, ".metadata.json"), `${JSON.stringify(stagedMetadata)}\n`);
    await writeFile(
      join(root, ".trash-rollback.json"),
      `${JSON.stringify({
        schemaVersion: 2,
        operation: "trash",
        itemKind: "file",
        state: "metadata-staged",
        fileId: file.id,
        originalMetadata,
        content: { size: 3, checksum: createHash("sha256").update("one").digest("hex") }
      })}\n`,
      { flag: "wx" }
    );
    const recovered = await LocalDriveAdapter.create(root);

    expect((await recovered.get(file.id)).trashed).toBe(false);
    await expect(recovered.readText(file.id)).resolves.toMatchObject({ text: "one" });
    const [stateEntry] = await readdir(join(root, ".transaction-state-history"));
    expect(JSON.parse(await readFile(join(root, ".transaction-state-history", stateEntry as string, "journal.json"), "utf8"))).toMatchObject({
      schemaVersion: 2,
      state: "metadata-staged"
    });
    const [historyEntry] = await readdir(join(root, ".transaction-history"));
    expect(JSON.parse(await readFile(join(root, ".transaction-history", historyEntry as string, "journal.json"), "utf8"))).toMatchObject({
      schemaVersion: 2,
      state: "rolled-back",
      itemKind: "file"
    });
  });

  it("rolls back when current trashed metadata selects a revision not bound by the journal", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    const storage = await LocalDriveAdapter.create(root);
    const file = await storage.createText({ parentId: "vault", name: "note.md", mimeType: "text/markdown", text: "one" });
    const originalMetadata = JSON.parse(await readFile(join(root, ".metadata.json"), "utf8"));
    const currentMetadata = structuredClone(originalMetadata);
    currentMetadata.sequence = 2;
    currentMetadata.generation = 2;
    currentMetadata.files[file.id].trashed = true;
    currentMetadata.files[file.id].version = "2";
    currentMetadata.files[file.id].modifiedTime = "1970-01-01T00:00:00.002Z";
    currentMetadata.files[file.id].contentRevision = "2";
    currentMetadata.revisions[file.id].push({ id: "2", modifiedTime: "1970-01-01T00:00:00.002Z" });
    await writeFile(join(root, ".revisions", file.id, "2"), "two", { flag: "wx" });
    await writeFile(join(root, ".metadata.json"), `${JSON.stringify(currentMetadata)}\n`);
    await writeFile(join(root, ".trash", file.id), "one", { flag: "wx" });
    await writeFile(
      join(root, ".trash-rollback.json"),
      `${JSON.stringify({
        schemaVersion: 2,
        operation: "trash",
        itemKind: "file",
        state: "artifact-verified",
        fileId: file.id,
        originalMetadata,
        content: { size: 3, checksum: createHash("sha256").update("one").digest("hex") }
      })}\n`,
      { flag: "wx" }
    );

    const recovered = await LocalDriveAdapter.create(root);

    expect((await recovered.get(file.id)).trashed).toBe(false);
    await expect(recovered.readText(file.id)).resolves.toMatchObject({ text: "one" });
    await expect(access(join(root, ".trash", file.id))).rejects.toThrow();
    const [historyEntry] = await readdir(join(root, ".transaction-history"));
    expect(await readFile(join(root, ".transaction-history", historyEntry as string, "artifact"), "utf8")).toBe("one");
    expect(JSON.parse(await readFile(join(root, ".transaction-history", historyEntry as string, "journal.json"), "utf8"))).toMatchObject({
      schemaVersion: 2,
      state: "rolled-back"
    });

    const restarted = await LocalDriveAdapter.create(root);
    await expect(restarted.readText(file.id)).resolves.toMatchObject({ text: "one" });
    expect(await readdir(join(root, ".transaction-history"))).toEqual([historyEntry]);
  });

  it("rolls back instead of throwing when the journal descriptor mismatches the active immutable revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    const storage = await LocalDriveAdapter.create(root);
    const file = await storage.createText({ parentId: "vault", name: "note.md", mimeType: "text/markdown", text: "one" });
    const originalMetadata = JSON.parse(await readFile(join(root, ".metadata.json"), "utf8"));
    const currentMetadata = structuredClone(originalMetadata);
    currentMetadata.sequence = 2;
    currentMetadata.generation = 2;
    currentMetadata.files[file.id].trashed = true;
    currentMetadata.files[file.id].version = "2";
    currentMetadata.files[file.id].modifiedTime = "1970-01-01T00:00:00.002Z";
    await writeFile(join(root, ".metadata.json"), `${JSON.stringify(currentMetadata)}\n`);
    await writeFile(join(root, ".trash", file.id), "two", { flag: "wx" });
    await writeFile(
      join(root, ".trash-rollback.json"),
      `${JSON.stringify({
        schemaVersion: 2,
        operation: "trash",
        itemKind: "file",
        state: "artifact-verified",
        fileId: file.id,
        originalMetadata,
        content: { size: 3, checksum: createHash("sha256").update("two").digest("hex") }
      })}\n`,
      { flag: "wx" }
    );

    const recovered = await LocalDriveAdapter.create(root);

    expect((await recovered.get(file.id)).trashed).toBe(false);
    await expect(recovered.readText(file.id)).resolves.toMatchObject({ text: "one" });
    await expect(access(join(root, ".trash", file.id))).rejects.toThrow();
    const [historyEntry] = await readdir(join(root, ".transaction-history"));
    expect(await readFile(join(root, ".transaction-history", historyEntry as string, "artifact"), "utf8")).toBe("two");
    expect(JSON.parse(await readFile(join(root, ".transaction-history", historyEntry as string, "journal.json"), "utf8"))).toMatchObject({
      schemaVersion: 2,
      state: "rolled-back"
    });
  });

  it("refuses a journal swapped to a symlink before the no-follow read", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    const storage = await LocalDriveAdapter.create(root);
    const file = await storage.createText({ parentId: "vault", name: "note.md", mimeType: "text/markdown", text: "one" });
    const originalMetadata = JSON.parse(await readFile(join(root, ".metadata.json"), "utf8"));
    const journalPath = join(root, ".trash-rollback.json");
    const outsidePath = join(root, "outside-journal.json");
    await writeFile(outsidePath, JSON.stringify({ schemaVersion: 1, fileId: file.id, originalMetadata }));
    await writeFile(journalPath, JSON.stringify({ schemaVersion: 1, fileId: file.id, originalMetadata }));
    let swapped = false;

    await expect(
      LocalDriveAdapter.create(root, {
        beforeJournalOpen: async () => {
          swapped = true;
          await rename(journalPath, join(root, "journal-before-swap.json"));
          await symlink(outsidePath, journalPath);
        }
      })
    ).rejects.toThrow("unsafe Trash rollback journal");
    expect(swapped).toBe(true);
  });

  it("does not archive a successor lock when the previous owner path is swapped after ownership proof", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    let swapEnabled = false;
    let swapped = false;
    const owner = await LocalDriveAdapter.create(root, {
      afterLockOwnershipCheck: async () => {
        if (swapEnabled) {
          const lockPath = join(root, ".mutation.lock");
          await rename(lockPath, join(root, "previous-owner-lock"));
          await mkdir(lockPath);
          await writeFile(join(lockPath, "owner.json"), JSON.stringify({ token: "successor" }));
          swapped = true;
        }
      }
    });

    swapEnabled = true;
    await owner.createFolder({ parentId: "vault", name: "folder" });
    expect(swapped).toBe(true);
    expect(JSON.parse(await readFile(join(root, ".mutation.lock", "owner.json"), "utf8"))).toMatchObject({ token: "successor" });
  });

  it("rejects invalid lock timeout values before touching storage", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    for (const lockTimeoutMs of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1.5, 60_001]) {
      await expect(LocalDriveAdapter.create(root, { lockTimeoutMs })).rejects.toThrow("invalid lock timeout");
    }
  });

  it("rejects deeply malformed root metadata during creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    await LocalDriveAdapter.create(root);
    const metadata = JSON.parse(await readFile(join(root, ".metadata.json"), "utf8"));
    metadata.files.vault = null;
    await writeFile(join(root, ".metadata.json"), `${JSON.stringify(metadata)}\n`);

    await expect(LocalDriveAdapter.create(root)).rejects.toThrow("invalid local metadata");
  });

  it("rejects an unbound file Trash journal before initializing an empty root", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    await writeFile(
      join(root, ".trash-rollback.json"),
      JSON.stringify({ schemaVersion: 1, fileId: "file_1", originalMetadata: { schemaVersion: 1, sequence: 0, generation: 0, files: {}, revisions: {} } })
    );

    await expect(LocalDriveAdapter.create(root)).rejects.toThrow("pending Trash journal without metadata");
    await expect(access(join(root, ".metadata.json"))).rejects.toThrow();
  });

  it("revalidates a replaced canonical root before creating a mutation lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
    const storage = await LocalDriveAdapter.create(root);
    const movedRoot = `${root}-moved`;
    await rename(root, movedRoot);
    await symlink(movedRoot, root);

    await expect(storage.createFolder({ parentId: "vault", name: "folder" })).rejects.toThrow("unsafe storage directory");
    await expect(access(join(movedRoot, ".mutation.lock"))).rejects.toThrow();
  });
});
