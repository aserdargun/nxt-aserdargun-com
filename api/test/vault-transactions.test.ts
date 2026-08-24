import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultIndexSchema, type VaultIndexEntry } from "@nxt/contracts";
import { parseNote, serializeNote } from "@nxt/domain";
import { describe, expect, it } from "vitest";
import { SystemFileStore } from "../src/services/system-file-store.js";
import { VaultService } from "../src/services/vault-service.js";
import { LocalDriveAdapter } from "../src/storage/local-drive-adapter.js";
import type { StoragePort } from "../src/storage/storage-port.js";

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

const delegate = (storage: StoragePort, overrides: Partial<StoragePort> = {}): StoragePort => ({
  get: overrides.get ?? storage.get.bind(storage),
  listChildren: overrides.listChildren ?? storage.listChildren.bind(storage),
  readText: overrides.readText ?? storage.readText.bind(storage),
  readBytes: overrides.readBytes ?? storage.readBytes.bind(storage),
  createFolder: overrides.createFolder ?? storage.createFolder.bind(storage),
  createText: overrides.createText ?? storage.createText.bind(storage),
  createBytes: overrides.createBytes ?? storage.createBytes.bind(storage),
  updateText: overrides.updateText ?? storage.updateText.bind(storage),
  move: overrides.move ?? storage.move.bind(storage),
  trash: overrides.trash ?? storage.trash.bind(storage),
  listRevisions: overrides.listRevisions ?? storage.listRevisions.bind(storage)
});

const setup = async () => {
  const storage = await LocalDriveAdapter.create(await mkdtemp(join(tmpdir(), "nxt-vault-transactions-")));
  const notes = await storage.createFolder({ parentId: "vault", name: "Notes" });
  const inbox = await storage.createFolder({ parentId: notes.id, name: "Inbox" });
  const plans = await storage.createFolder({ parentId: notes.id, name: "Plans" });
  const archive = await storage.createFolder({ parentId: notes.id, name: "Archive" });
  const assets = await storage.createFolder({ parentId: "vault", name: "_assets" });
  const indexFile = await storage.createText({
    parentId: "private",
    name: "vault-index.json",
    mimeType: "application/json",
    text: '{"schemaVersion":1,"entries":[]}\n'
  });
  const folders = { notesId: notes.id, inboxId: inbox.id, plansId: plans.id, archiveId: archive.id, assetsId: assets.id };
  const storeFor = (port: StoragePort = storage) => new SystemFileStore({
    storage: port,
    fileId: indexFile.id,
    parentId: "private",
    name: "vault-index.json",
    schema: VaultIndexSchema
  });
  const serviceFor = (id: string, port: StoragePort = storage) => new VaultService({
    storage: port,
    indexStore: storeFor(port),
    folders,
    createId: () => id,
    now: () => new Date("2026-08-24T08:00:00.000Z"),
    confirmationSecret: "transaction-test-confirmation-secret-32-bytes"
  });
  return { storage, folders, indexFile, storeFor, serviceFor };
};

describe("persisted vault mutation coordination", () => {
  it("commits concurrent unique creates from two service instances without losing either", async () => {
    const fixture = await setup();
    const firstId = randomUUID();
    const secondId = randomUUID();
    const [first, second] = await Promise.all([
      fixture.serviceFor(firstId).createNote({ title: "First", body: "one", folderId: fixture.folders.inboxId }),
      fixture.serviceFor(secondId).createNote({ title: "Second", body: "two", folderId: fixture.folders.inboxId })
    ]);

    expect(new Set([first.note.frontmatter.id, second.note.frontmatter.id])).toEqual(new Set([firstId, secondId]));
    const index = (await fixture.storeFor().read()).value;
    expect(new Set(index.entries.map((entry) => entry.id))).toEqual(new Set([firstId, secondId]));
    expect(index.pendingMutations).toEqual([]);
  });

  it("allows only one concurrent same-path create and leaves no duplicate Drive file", async () => {
    const fixture = await setup();
    const outcomes = await Promise.allSettled([
      fixture.serviceFor(randomUUID()).createNote({ title: "Collision", body: "one", folderId: fixture.folders.inboxId }),
      fixture.serviceFor(randomUUID()).createNote({ title: "collision", body: "two", folderId: fixture.folders.inboxId })
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")[0]).toMatchObject({ reason: { code: "CONFLICT" } });
    const files = await fixture.storage.listChildren({ parentId: fixture.folders.inboxId, pageSize: 100 });
    expect(files.files.filter((file) => file.mimeType !== FOLDER_MIME_TYPE)).toHaveLength(1);
    expect((await fixture.storeFor().read()).value.pendingMutations).toEqual([]);
  });

  it("updates incrementally with bounded storage calls independent of index size", async () => {
    const fixture = await setup();
    const service = fixture.serviceFor(randomUUID());
    const created = await service.createNote({ title: "Target", body: "old", folderId: fixture.folders.inboxId });
    const snapshot = await fixture.storeFor().read();
    const target = snapshot.value.entries[0] as VaultIndexEntry;
    const fillers = Array.from({ length: 500 }, (_, index): VaultIndexEntry => ({
      ...target,
      id: randomUUID(),
      title: `Filler ${index}`,
      path: `Notes/Plans/Filler ${index}.md`,
      driveId: `external-${index}`,
      outboundNoteIds: [],
      backlinks: []
    }));
    await fixture.storeFor().update({ ...snapshot.value, entries: [target, ...fillers] }, snapshot.file.version);
    let vaultReads = 0;
    let vaultLists = 0;
    const counted = delegate(fixture.storage, {
      readText: async (fileId) => {
        if (fileId !== fixture.indexFile.id) vaultReads += 1;
        return fixture.storage.readText(fileId);
      },
      listChildren: async (input) => {
        vaultLists += 1;
        return fixture.storage.listChildren(input);
      }
    });
    const next = parseNote(created.source);
    next.body = "new";

    await fixture.serviceFor(randomUUID(), counted).updateNote({
      noteId: created.note.frontmatter.id,
      expectedVersion: created.version,
      source: serializeNote(next)
    });

    expect(vaultReads).toBeLessThanOrEqual(3);
    expect(vaultLists).toBeLessThanOrEqual(1);
    expect((await fixture.storeFor().read()).value.entries).toHaveLength(501);
  });

  it("rejects a concurrent cross-instance update while the persisted note lease is active", async () => {
    const fixture = await setup();
    const created = await fixture.serviceFor(randomUUID()).createNote({ title: "Target", body: "old", folderId: fixture.folders.inboxId });
    let release!: () => void;
    let entered!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const didEnter = new Promise<void>((resolve) => { entered = resolve; });
    const gated = delegate(fixture.storage, {
      updateText: async (input) => {
        if (input.fileId === created.driveId) { entered(); await released; }
        return fixture.storage.updateText(input);
      }
    });
    const firstNote = parseNote(created.source);
    firstNote.body = "first";
    const secondNote = parseNote(created.source);
    secondNote.body = "second";
    const first = fixture.serviceFor(randomUUID(), gated).updateNote({ noteId: created.note.frontmatter.id, expectedVersion: created.version, source: serializeNote(firstNote) });
    await didEnter;
    await expect(fixture.serviceFor(randomUUID()).updateNote({
      noteId: created.note.frontmatter.id,
      expectedVersion: created.version,
      source: serializeNote(secondNote)
    })).rejects.toMatchObject({ code: "CONFLICT" });
    release();
    await expect(first).resolves.toMatchObject({ note: { body: expect.stringContaining("first") } });
  });

  it("rejects a concurrent cross-instance Trash while the persisted note lease is active", async () => {
    const fixture = await setup();
    const created = await fixture.serviceFor(randomUUID()).createNote({ title: "Target", body: "old", folderId: fixture.folders.inboxId });
    let release!: () => void;
    let entered!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const didEnter = new Promise<void>((resolve) => { entered = resolve; });
    const gated = delegate(fixture.storage, {
      trash: async (fileId) => {
        if (fileId === created.driveId) { entered(); await released; }
        return fixture.storage.trash(fileId);
      }
    });
    const first = fixture.serviceFor(randomUUID(), gated).trashNote({ noteId: created.note.frontmatter.id, expectedVersion: created.version });
    await didEnter;
    await expect(fixture.serviceFor(randomUUID()).trashNote({
      noteId: created.note.frontmatter.id,
      expectedVersion: created.version
    })).rejects.toMatchObject({ code: "CONFLICT" });
    release();
    await expect(first).resolves.toEqual({ trashed: true });
  });

  it("cancels a reservation on a confirmed Drive failure", async () => {
    const fixture = await setup();
    const created = await fixture.serviceFor(randomUUID()).createNote({ title: "Target", body: "old", folderId: fixture.folders.inboxId });
    const failed = delegate(fixture.storage, {
      updateText: async (input) => {
        if (input.fileId === created.driveId) throw new Error("injected Drive outage");
        return fixture.storage.updateText(input);
      }
    });
    const note = parseNote(created.source);
    note.body = "new";

    await expect(fixture.serviceFor(randomUUID(), failed).updateNote({
      noteId: created.note.frontmatter.id,
      expectedVersion: created.version,
      source: serializeNote(note)
    })).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
    expect((await fixture.storeFor().read()).value.pendingMutations).toEqual([]);
  });

  it("reconciles a create that crashed after Drive readback before index finalization", async () => {
    const fixture = await setup();
    let indexWrites = 0;
    const crashing = delegate(fixture.storage, {
      updateText: async (input) => {
        if (input.fileId === fixture.indexFile.id) {
          indexWrites += 1;
          if (indexWrites === 2) throw new Error("injected function crash before finalize");
        }
        return fixture.storage.updateText(input);
      }
    });
    const orphanId = randomUUID();
    await expect(fixture.serviceFor(orphanId, crashing).createNote({
      title: "Recovered",
      body: "survives",
      folderId: fixture.folders.inboxId
    })).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });

    await fixture.serviceFor(randomUUID()).createNote({ title: "Trigger", body: "next", folderId: fixture.folders.inboxId });

    const index = (await fixture.storeFor().read()).value;
    expect(new Set(index.entries.map((entry) => entry.title))).toEqual(new Set(["Recovered", "Trigger"]));
    expect(index.pendingMutations).toEqual([]);
  });

  it("adds the old title alias for a case-only generic source update", async () => {
    const fixture = await setup();
    const service = fixture.serviceFor(randomUUID());
    const created = await service.createNote({ title: "Plan", body: "old", folderId: fixture.folders.inboxId });
    const note = parseNote(created.source);
    note.frontmatter.title = "PLAN";

    const updated = await service.updateNote({
      noteId: created.note.frontmatter.id,
      expectedVersion: created.version,
      source: serializeNote(note)
    });

    expect(updated.note.frontmatter.aliases).toContain("Plan");
  });

  it("CAS-updates nested descendant paths for folder rename and move", async () => {
    const fixture = await setup();
    const service = fixture.serviceFor(randomUUID());
    const parent = await service.createFolder({ parentId: fixture.folders.plansId, name: "Parent" });
    const child = await service.createFolder({ parentId: parent.id, name: "Child" });
    const note = await service.createNote({ title: "Nested", body: "body", folderId: child.id });

    const renamed = await service.renameFolder({ folderId: parent.id, expectedVersion: parent.version, name: "Renamed" });
    expect((await fixture.storeFor().read()).value.entries.find((entry) => entry.id === note.note.frontmatter.id)?.path)
      .toBe("Notes/Plans/Renamed/Child/Nested.md");
    await service.moveFolder({ folderId: renamed.id, expectedVersion: renamed.version, parentId: fixture.folders.inboxId });
    expect((await fixture.storeFor().read()).value.entries.find((entry) => entry.id === note.note.frontmatter.id)?.path)
      .toBe("Notes/Inbox/Renamed/Child/Nested.md");
  });
});
