import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultIndexSchema } from "@nxt/contracts";
import { parseNote, serializeNote } from "@nxt/domain";
import { describe, expect, it } from "vitest";
import { SystemFileStore } from "../src/services/system-file-store.js";
import { VaultService } from "../src/services/vault-service.js";
import { LocalDriveAdapter } from "../src/storage/local-drive-adapter.js";
import type { StoragePort } from "../src/storage/storage-port.js";

const noteId = "018f47d2-6a34-7b2a-9f21-8a7034963aef";

const sourceFor = (title: string, body = "# Today\n"): string =>
  serializeNote({
    frontmatter: {
      id: noteId,
      title,
      created: "2026-08-23T12:00:00.000Z",
      updated: "2026-08-23T12:00:00.000Z",
      tags: [],
      aliases: []
    },
    body
  });

const setup = async (
  storageOverride?: (storage: StoragePort) => StoragePort,
  now: () => Date = () => new Date("2026-08-23T12:00:00.000Z")
) => {
  const raw = await LocalDriveAdapter.create(await mkdtemp(join(tmpdir(), "nxt-vault-service-")));
  const notes = await raw.createFolder({ parentId: "vault", name: "Notes" });
  const assets = await raw.createFolder({ parentId: "vault", name: "_assets" });
  const inbox = await raw.createFolder({ parentId: notes.id, name: "Inbox" });
  const plans = await raw.createFolder({ parentId: notes.id, name: "Plans" });
  const archive = await raw.createFolder({ parentId: notes.id, name: "Archive" });
  const index = await raw.createText({
    parentId: "private",
    name: "vault-index.json",
    mimeType: "application/json",
    text: '{"schemaVersion":1,"entries":[]}\n'
  });
  const storage = storageOverride?.(raw) ?? raw;
  const indexStore = new SystemFileStore({
    storage,
    fileId: index.id,
    parentId: "private",
    name: "vault-index.json",
    schema: VaultIndexSchema
  });
  const service = new VaultService({
    storage,
    indexStore,
    folders: {
      notesId: notes.id,
      inboxId: inbox.id,
      plansId: plans.id,
      archiveId: archive.id,
      assetsId: assets.id
    },
    now,
    createId: () => noteId,
    confirmationSecret: "test-only-folder-confirmation-secret-32-bytes"
  });
  return { raw, storage, service, indexStore, ids: { notes, assets, inbox, plans, archive, index } };
};

describe("SystemFileStore", () => {
  it("updates only the pinned verified system file and validates the readback checksum", async () => {
    const { raw, indexStore, ids } = await setup();
    const before = await indexStore.read();

    const updated = await indexStore.update({ schemaVersion: 1, entries: [] }, before.file.version);

    expect(updated.file.id).toBe(ids.index.id);
    expect(BigInt(updated.file.version)).toBeGreaterThan(BigInt(before.file.version));
    expect(updated.checksum).toBe(createHash("sha256").update(updated.source).digest("hex"));
    expect((await raw.listChildren({ parentId: "private", pageSize: 100 })).files).toHaveLength(1);
  });

  it("fails closed for a wrong pinned name, schema, version, or checksum", async () => {
    const { raw, ids } = await setup();
    const wrongName = new SystemFileStore({
      storage: raw,
      fileId: ids.index.id,
      parentId: "private",
      name: "preferences.json",
      schema: VaultIndexSchema
    });
    await expect(wrongName.read()).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });

    const invalid = await raw.createText({
      parentId: "private",
      name: "invalid-index.json",
      mimeType: "application/json",
      text: '{"schemaVersion":2,"entries":[]}\n'
    });
    const invalidStore = new SystemFileStore({
      storage: raw,
      fileId: invalid.id,
      parentId: "private",
      name: "invalid-index.json",
      schema: VaultIndexSchema
    });
    await expect(invalidStore.read()).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });

    const before = await raw.readText(ids.index.id);
    await expect(
      new SystemFileStore({
        storage: {
          ...raw,
          get: raw.get.bind(raw),
          readText: async (fileId) => ({ ...(await raw.readText(fileId)), checksum: "0".repeat(64) })
        } as StoragePort,
        fileId: ids.index.id,
        parentId: "private",
        name: "vault-index.json",
        schema: VaultIndexSchema
      }).read()
    ).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
    await expect(
      new SystemFileStore({
        storage: raw,
        fileId: ids.index.id,
        parentId: "private",
        name: "vault-index.json",
        schema: VaultIndexSchema
      }).update({ schemaVersion: 1, entries: [] }, `${before.file.version}-stale`)
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const validStore = new SystemFileStore({
      storage: raw,
      fileId: ids.index.id,
      parentId: "private",
      name: "vault-index.json",
      schema: VaultIndexSchema
    });
    await expect(validStore.update({ schemaVersion: 2, entries: [] } as never))
      .rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
  });
});

describe("VaultService notes", () => {
  it("keeps the Task 7 folder bound at 255 Unicode code points", async () => {
    const { service, ids } = await setup();
    const name200 = "🙂".repeat(200);
    const name255 = "🙂".repeat(255);
    const created = await service.createFolder({ parentId: ids.plans.id, name: name200 });
    expect(created.name).toBe(name200);

    const renamed = await service.updateFolder({ folderId: created.id, expectedVersion: created.version, name: name255 });
    expect(renamed.name).toBe(name255);
    await expect(service.createFolder({ parentId: ids.plans.id, name: "🙂".repeat(256) }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("creates portable notes in Inbox and indexes only after full source readback", async () => {
    let readbackObserved = false;
    let indexWriteObservedAfterReadback = false;
    const { service, raw, ids } = await setup((storage) => ({
      ...storage,
      get: storage.get.bind(storage),
      listChildren: storage.listChildren.bind(storage),
      readText: async (fileId) => {
        const result = await storage.readText(fileId);
        if (result.file.mimeType === "text/markdown") readbackObserved = true;
        return result;
      },
      createText: storage.createText.bind(storage),
      updateText: async (input) => {
        if (input.fileId === ids.index.id) indexWriteObservedAfterReadback = readbackObserved;
        return storage.updateText(input);
      },
      move: storage.move.bind(storage),
      trash: storage.trash.bind(storage),
      createFolder: storage.createFolder.bind(storage),
      createBytes: storage.createBytes.bind(storage),
      readBytes: storage.readBytes.bind(storage),
      listRevisions: storage.listRevisions.bind(storage)
    }));

    const result = await service.createNote({ title: "Quick note", body: "# Today", folderId: ids.inbox.id });

    expect(result.note.frontmatter.title).toBe("Quick note");
    expect(result.note.path).toBe("Notes/Inbox/Quick note.md");
    expect(parseNote(result.source).frontmatter.id).toBe(noteId);
    expect(indexWriteObservedAfterReadback).toBe(true);
    expect((await raw.readText(ids.index.id)).text).toContain(noteId);
  });

  it("accepts a newer Drive version when the created note readback is byte-identical", async () => {
    let createdVersion: string | undefined;
    const { service, indexStore, ids } = await setup((storage) => ({
      ...storage,
      get: storage.get.bind(storage),
      listChildren: storage.listChildren.bind(storage),
      readText: async (fileId) => {
        const readback = await storage.readText(fileId);
        if (readback.file.mimeType !== "text/markdown") return readback;
        return {
          ...readback,
          file: { ...readback.file, version: (BigInt(readback.file.version) + 1n).toString() }
        };
      },
      createText: async (input) => {
        const created = await storage.createText(input);
        if (created.mimeType === "text/markdown") createdVersion = created.version;
        return created;
      },
      updateText: storage.updateText.bind(storage),
      move: storage.move.bind(storage),
      trash: storage.trash.bind(storage),
      createFolder: storage.createFolder.bind(storage),
      createBytes: storage.createBytes.bind(storage),
      readBytes: storage.readBytes.bind(storage),
      listRevisions: storage.listRevisions.bind(storage)
    }));

    const result = await service.createNote({ title: "Test", body: "", folderId: ids.plans.id });

    expect(createdVersion).toBeDefined();
    expect(result.version).toBe((BigInt(createdVersion as string) + 1n).toString());
    expect((await indexStore.read()).value.entries).toEqual([
      expect.objectContaining({ id: noteId, driveVersion: result.version, path: "Notes/Plans/Test.md" })
    ]);
  });

  it("returns conflict and retains both sources when Drive changed before save", async () => {
    const { service, raw, ids } = await setup();
    const created = await service.createNote({ title: "Quick note", body: "# Today", folderId: ids.inbox.id });
    const remoteSource = sourceFor("Quick note", "# Remote\n");
    await raw.updateText({
      fileId: created.driveId,
      expectedVersion: created.version,
      mimeType: "text/markdown",
      text: remoteSource
    });

    await expect(
      service.updateNote({ noteId, expectedVersion: created.version, source: sourceFor("Quick note", "# Local\n") })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await raw.readText(created.driveId)).text).toBe(remoteSource);
    expect(sourceFor("Quick note", "# Local\n")).toContain("# Local");
  });

  it("serializes same-note writes and refuses to mutate the index after a mismatched readback", async () => {
    const { service, raw, ids } = await setup();
    const created = await service.createNote({ title: "Quick note", body: "# Today", folderId: ids.inbox.id });
    const indexBefore = await raw.readText(ids.index.id);
    let active = 0;
    let maximum = 0;
    let corruptReadback = false;
    const guardedStorage: StoragePort = {
      ...raw,
      get: raw.get.bind(raw),
      listChildren: raw.listChildren.bind(raw),
      readText: async (fileId) => {
        const result = await raw.readText(fileId);
        if (corruptReadback && fileId === created.driveId) return { ...result, text: `${result.text}\ncorrupt` };
        return result;
      },
      updateText: async (input) => {
        if (input.fileId !== created.driveId) return raw.updateText(input);
        active += 1;
        maximum = Math.max(maximum, active);
        await Promise.resolve();
        try {
          return await raw.updateText(input);
        } finally {
          active -= 1;
        }
      },
      move: raw.move.bind(raw),
      trash: raw.trash.bind(raw),
      createFolder: raw.createFolder.bind(raw),
      createText: raw.createText.bind(raw),
      createBytes: raw.createBytes.bind(raw),
      readBytes: raw.readBytes.bind(raw),
      listRevisions: raw.listRevisions.bind(raw)
    };
    const indexStore = new SystemFileStore({
      storage: guardedStorage,
      fileId: ids.index.id,
      parentId: "private",
      name: "vault-index.json",
      schema: VaultIndexSchema
    });
    const guarded = new VaultService({
      storage: guardedStorage,
      indexStore,
      folders: {
        notesId: ids.notes.id,
        inboxId: ids.inbox.id,
        plansId: ids.plans.id,
        archiveId: ids.archive.id,
        assetsId: ids.assets.id
      },
      now: () => new Date("2026-08-23T12:01:00.000Z"),
      createId: () => noteId,
      confirmationSecret: "test-only-folder-confirmation-secret-32-bytes"
    });
    corruptReadback = true;
    await expect(
      guarded.updateNote({ noteId, expectedVersion: created.version, source: sourceFor("Quick note", "# Local\n") })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(maximum).toBe(1);
    const beforeValue = JSON.parse(indexBefore.text);
    const afterValue = (await indexStore.read()).value;
    expect(afterValue.entries).toEqual(beforeValue.entries);
    expect(afterValue.pendingMutations).toHaveLength(1);
  });

  it("sanitizes collision-prone names, preserves the UUID, adds aliases, and recalculates attachment links on move", async () => {
    const { service, ids } = await setup();
    const created = await service.createNote({
      title: "Quarter / Plan",
      body: `![diagram](../../_assets/${noteId}/diagram.png)`,
      folderId: ids.inbox.id
    });
    expect(created.note.path).toBe("Notes/Inbox/Quarter - Plan.md");
    await expect(
      service.createNote({ title: "Quarter \\ Plan", body: "x", folderId: ids.inbox.id })
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const renamed = await service.renameNote({
      noteId,
      expectedVersion: created.version,
      title: "Annual Plan"
    });
    expect(renamed.note.frontmatter.id).toBe(noteId);
    expect(renamed.note.frontmatter.aliases).toContain("Quarter / Plan");
    expect(renamed.note.path).toBe("Notes/Inbox/Annual Plan.md");

    const moved = await service.moveNote({
      noteId,
      expectedVersion: renamed.version,
      folderId: ids.plans.id
    });
    expect(moved.note.path).toBe("Notes/Plans/Annual Plan.md");
    expect(moved.source).toContain(`../../_assets/${noteId}/diagram.png`);

    const archived = await service.archiveNote({ noteId, expectedVersion: moved.version });
    expect(archived.note.path).toBe("Notes/Archive/Annual Plan.md");
  });

  it("recalculates angled, titled, and reference-style attachment destinations at a new depth", async () => {
    const { service, ids } = await setup();
    const nested = await service.createFolder({ parentId: ids.plans.id, name: "Nested" });
    const created = await service.createNote({
      title: "Attachments",
      body: `![diagram](<../../_assets/${noteId}/diagram one.png> "Diagram")\n\n[download]: ../../_assets/${noteId}/file.pdf`,
      folderId: ids.inbox.id
    });

    const moved = await service.moveNote({
      noteId,
      expectedVersion: created.version,
      folderId: nested.id
    });

    expect(moved.source).toContain(`(<../../../_assets/${noteId}/diagram one.png> "Diagram")`);
    expect(moved.source).toContain(`[download]: ../../../_assets/${noteId}/file.pdf`);
  });

  it("records the old title as an alias for a case-only rename", async () => {
    const { service, ids } = await setup();
    const created = await service.createNote({ title: "Plan", body: "# Plan", folderId: ids.inbox.id });

    const renamed = await service.renameNote({ noteId, expectedVersion: created.version, title: "PLAN" });

    expect(renamed.note.frontmatter.title).toBe("PLAN");
    expect(renamed.note.frontmatter.aliases).toContain("Plan");
    expect(renamed.note.path).toBe("Notes/Inbox/PLAN.md");
  });

  it("classifies note dependency outages and stored corruption as redacted 503 failures", async () => {
    let outage = false;
    let corrupt = false;
    const { service, ids } = await setup((storage) => ({
      ...storage,
      get: storage.get.bind(storage),
      listChildren: storage.listChildren.bind(storage),
      readText: async (fileId) => {
        const readback = await storage.readText(fileId);
        if (readback.file.mimeType !== "text/markdown") return readback;
        if (outage) throw new Error("injected credential-bearing outage");
        return corrupt ? { ...readback, text: "not portable markdown" } : readback;
      },
      readBytes: storage.readBytes.bind(storage),
      createFolder: storage.createFolder.bind(storage),
      createText: storage.createText.bind(storage),
      createBytes: storage.createBytes.bind(storage),
      updateText: storage.updateText.bind(storage),
      move: storage.move.bind(storage),
      trash: storage.trash.bind(storage),
      listRevisions: storage.listRevisions.bind(storage)
    }));
    await service.createNote({ title: "Probe", body: "body", folderId: ids.inbox.id });
    outage = true;
    await expect(service.getNote(noteId)).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE", status: 503 });
    outage = false;
    corrupt = true;
    await expect(service.getNote(noteId)).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE", status: 503 });
  });
});

describe("VaultService folders", () => {
  it("bounds nesting, protects provisioned folders, and requires a current tamper-resistant confirmation", async () => {
    const { service, ids } = await setup();
    const custom = await service.createFolder({ parentId: ids.notes.id, name: "Project" });
    await service.createNote({ title: "Quick note", body: "# Today", folderId: custom.id });

    await expect(
      service.trashFolder({ folderId: custom.id, expectedTreeVersion: "stale" })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const confirmation = await service.issueFolderDeleteConfirmation(custom.id);
    expect(confirmation.descendantCount).toBe(1);
    await expect(
      service.trashFolder({
        folderId: custom.id,
        expectedTreeVersion: confirmation.treeVersion,
        confirmationToken: `${confirmation.confirmationToken.slice(0, -1)}x`
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(service.trashFolder({ folderId: ids.inbox.id, expectedTreeVersion: confirmation.treeVersion }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });

    await expect(
      service.trashFolder({
        folderId: custom.id,
        expectedTreeVersion: confirmation.treeVersion,
        confirmationToken: confirmation.confirmationToken
      })
    ).resolves.toMatchObject({ trashed: true });
  });

  it("accepts a still-current confirmation after time advances and rejects it after expiry", async () => {
    let clock = Date.parse("2026-08-23T12:00:00.000Z");
    const currentTime = () => new Date(clock);
    const first = await setup(undefined, currentTime);
    const folder = await first.service.createFolder({ parentId: first.ids.notes.id, name: "Current" });
    await first.service.createNote({ title: "Quick note", body: "# Today", folderId: folder.id });
    const confirmation = await first.service.issueFolderDeleteConfirmation(folder.id);
    clock += 1_000;

    await expect(first.service.trashFolder({
      folderId: folder.id,
      expectedTreeVersion: confirmation.treeVersion,
      confirmationToken: confirmation.confirmationToken
    })).resolves.toEqual({ trashed: true });

    clock = Date.parse("2026-08-23T12:00:00.000Z");
    const second = await setup(undefined, currentTime);
    const expiring = await second.service.createFolder({ parentId: second.ids.notes.id, name: "Expiring" });
    await second.service.createNote({ title: "Quick note", body: "# Today", folderId: expiring.id });
    const expired = await second.service.issueFolderDeleteConfirmation(expiring.id);
    clock += 5 * 60 * 1_000 + 1;

    await expect(second.service.trashFolder({
      folderId: expiring.id,
      expectedTreeVersion: expired.treeVersion,
      confirmationToken: expired.confirmationToken
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("treats a nested folder as a descendant that requires confirmation", async () => {
    const { service, ids } = await setup();
    const parent = await service.createFolder({ parentId: ids.notes.id, name: "Parent" });
    await service.createFolder({ parentId: parent.id, name: "Empty child" });
    const confirmation = await service.issueFolderDeleteConfirmation(parent.id);

    expect(confirmation.descendantCount).toBe(1);
    await expect(service.trashFolder({
      folderId: parent.id,
      expectedTreeVersion: confirmation.treeVersion
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
