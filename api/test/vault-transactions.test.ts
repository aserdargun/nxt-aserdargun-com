import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreferencesSchema, VaultIndexSchema, type VaultIndex, type VaultIndexEntry, type VaultPendingMutation } from "@nxt/contracts";
import { parseNote, serializeNote } from "@nxt/domain";
import { describe, expect, it } from "vitest";
import { SystemFileStore } from "../src/services/system-file-store.js";
import { VaultService } from "../src/services/vault-service.js";
import { LocalDriveAdapter } from "../src/storage/local-drive-adapter.js";
import { StorageMutationNotAppliedError, type StoragePort } from "../src/storage/storage-port.js";

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
  const preferencesFile = await storage.createText({
    parentId: "private",
    name: "preferences.json",
    mimeType: "application/json",
    text: '{"schemaVersion":1,"favorites":[],"recent":[],"theme":"system"}\n'
  });
  const folders = { notesId: notes.id, inboxId: inbox.id, plansId: plans.id, archiveId: archive.id, assetsId: assets.id };
  const storeFor = (port: StoragePort = storage) => new SystemFileStore({
    storage: port,
    fileId: indexFile.id,
    parentId: "private",
    name: "vault-index.json",
    schema: VaultIndexSchema
  });
  const preferencesStoreFor = (port: StoragePort = storage) => new SystemFileStore({
    storage: port,
    fileId: preferencesFile.id,
    parentId: "private",
    name: "preferences.json",
    schema: PreferencesSchema
  });
  let currentTime = new Date("2026-08-24T08:00:00.000Z");
  const serviceFor = (
    id: string,
    port: StoragePort = storage,
    indexStore: SystemFileStore<VaultIndex> = storeFor(port)
  ) => new VaultService({
    storage: port,
    indexStore,
    folders,
    createId: () => id,
    now: () => currentTime,
    confirmationSecret: "transaction-test-confirmation-secret-32-bytes",
    preferencesStore: preferencesStoreFor(port)
  });
  return {
    storage, folders, indexFile, preferencesFile, storeFor, preferencesStoreFor, serviceFor,
    setTime: (value: string) => { currentTime = new Date(value); }
  };
};

const gateFirstReservation = (base: SystemFileStore<VaultIndex>) => {
  let release!: () => void;
  let entered!: () => void;
  let first = true;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const didEnter = new Promise<void>((resolve) => { entered = resolve; });
  const observed: VaultPendingMutation[] = [];
  const store = {
    read: base.read.bind(base),
    update: base.update.bind(base),
    compareAndSet: async (
      transform: (current: VaultIndex) => VaultIndex,
      options?: { attempts?: number }
    ) => {
      if (first) {
        first = false;
        entered();
        await released;
      }
      return base.compareAndSet((current) => {
        const before = new Set(current.pendingMutations.map((mutation) => mutation.id));
        const next = transform(current);
        observed.push(...next.pendingMutations.filter((mutation) => !before.has(mutation.id)));
        return next;
      }, options);
    }
  } as unknown as SystemFileStore<VaultIndex>;
  return { store, didEnter, release, observed };
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

  it("measures every storage call and serialized index byte for a large-index update", async () => {
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
    const seededIndexBytes = new TextEncoder().encode((await fixture.storeFor().read()).source).byteLength;
    let storageReads = 0;
    let vaultLists = 0;
    let indexWrites = 0;
    let serializedIndexBytes = 0;
    const counted = delegate(fixture.storage, {
      readText: async (fileId) => {
        storageReads += 1;
        return fixture.storage.readText(fileId);
      },
      listChildren: async (input) => {
        vaultLists += 1;
        return fixture.storage.listChildren(input);
      },
      updateText: async (input) => {
        if (input.fileId === fixture.indexFile.id) {
          indexWrites += 1;
          serializedIndexBytes += new TextEncoder().encode(input.text).byteLength;
        }
        return fixture.storage.updateText(input);
      }
    });
    const next = parseNote(created.source);
    next.body = "new";

    await fixture.serviceFor(randomUUID(), counted).updateNote({
      noteId: created.note.frontmatter.id,
      expectedVersion: created.version,
      source: serializeNote(next)
    });

    expect(storageReads).toBeLessThanOrEqual(20);
    expect(vaultLists).toBeLessThanOrEqual(1);
    expect(indexWrites).toBe(4);
    expect(serializedIndexBytes).toBeGreaterThan(seededIndexBytes * 3);
    expect(serializedIndexBytes).toBeLessThan(seededIndexBytes * 5 + 500_000);
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
        if (input.fileId === created.driveId) throw new StorageMutationNotAppliedError();
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
          if (indexWrites === 4) throw new Error("injected function crash before finalize");
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

  it("does not orphan a create when Drive accepts it but the adapter readback rejects", async () => {
    const fixture = await setup();
    const orphanId = randomUUID();
    const ambiguous = delegate(fixture.storage, {
      createText: async (input) => {
        if (input.name === "Orphan.md") {
          await fixture.storage.createText(input);
          throw new Error("injected post-create readback outage");
        }
        return fixture.storage.createText(input);
      }
    });

    await expect(fixture.serviceFor(orphanId, ambiguous).createNote({
      title: "Orphan",
      body: "survives ambiguous acknowledgement",
      folderId: fixture.folders.inboxId
    })).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });

    const afterFailure = (await fixture.storeFor().read()).value;
    expect(
      afterFailure.entries.some((entry) => entry.id === orphanId) ||
      afterFailure.pendingMutations.some((mutation) => mutation.noteId === orphanId)
    ).toBe(true);

    await fixture.serviceFor(randomUUID()).createNote({ title: "Trigger", body: "next", folderId: fixture.folders.inboxId });
    const recovered = (await fixture.storeFor().read()).value;
    expect(recovered.entries.find((entry) => entry.id === orphanId)?.title).toBe("Orphan");
    expect(recovered.pendingMutations.some((mutation) => mutation.noteId === orphanId)).toBe(false);
  });

  it("does not reconcile a delayed live write merely because the short lease elapsed", async () => {
    const fixture = await setup();
    let release!: () => void;
    let entered!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const didEnter = new Promise<void>((resolve) => { entered = resolve; });
    const gated = delegate(fixture.storage, {
      createText: async (input) => {
        if (input.name === "Delayed.md") { entered(); await released; }
        return fixture.storage.createText(input);
      }
    });
    const first = fixture.serviceFor(randomUUID(), gated).createNote({
      title: "Delayed", body: "first", folderId: fixture.folders.inboxId
    });
    await didEnter;
    fixture.setTime("2026-08-24T08:00:31.000Z");

    const second = await fixture.serviceFor(randomUUID()).createNote({
      title: "Delayed", body: "second", folderId: fixture.folders.inboxId
    }).then(() => "fulfilled", (error: unknown) => (error as { code?: string }).code);
    release();
    await first;

    expect(second).toBe("CONFLICT");
    const files = await fixture.storage.listChildren({ parentId: fixture.folders.inboxId, pageSize: 100 });
    expect(files.files.filter((file) => file.name === "Delayed.md")).toHaveLength(1);
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

  it("serializes a folder subtree mutation against a descendant note mutation across instances", async () => {
    const fixture = await setup();
    const service = fixture.serviceFor(randomUUID());
    const parent = await service.createFolder({ parentId: fixture.folders.plansId, name: "Parent" });
    const child = await service.createFolder({ parentId: parent.id, name: "Child" });
    const note = await service.createNote({ title: "Nested", body: "old", folderId: child.id });
    let release!: () => void;
    let entered!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const didEnter = new Promise<void>((resolve) => { entered = resolve; });
    const gated = delegate(fixture.storage, {
      move: async (input) => {
        if (input.fileId === parent.id) { entered(); await released; }
        return fixture.storage.move(input);
      }
    });
    const rename = fixture.serviceFor(randomUUID(), gated).renameFolder({
      folderId: parent.id, expectedVersion: parent.version, name: "Renamed"
    });
    await didEnter;
    const changed = parseNote(note.source);
    changed.body = "concurrent";
    const descendantOutcome = await fixture.serviceFor(randomUUID()).updateNote({
      noteId: note.note.frontmatter.id,
      expectedVersion: note.version,
      source: serializeNote(changed)
    }).then(() => "fulfilled", (error: unknown) => (error as { code?: string }).code);
    release();
    await rename;

    expect(descendantOutcome).toBe("CONFLICT");
  });

  it("rejects moving a folder into its descendant before any Drive mutation", async () => {
    const fixture = await setup();
    const service = fixture.serviceFor(randomUUID());
    const parent = await service.createFolder({ parentId: fixture.folders.plansId, name: "Parent" });
    const child = await service.createFolder({ parentId: parent.id, name: "Child" });
    let moves = 0;
    const counted = delegate(fixture.storage, {
      move: async (input) => { moves += 1; return fixture.storage.move(input); }
    });

    await expect(fixture.serviceFor(randomUUID(), counted).moveFolder({
      folderId: parent.id,
      expectedVersion: parent.version,
      parentId: child.id
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(moves).toBe(0);
  });

  it("recovers a combined folder rename-and-move after an acknowledged move loses readback", async () => {
    const fixture = await setup();
    const service = fixture.serviceFor(randomUUID());
    const parent = await service.createFolder({ parentId: fixture.folders.plansId, name: "Parent" });
    const child = await service.createFolder({ parentId: parent.id, name: "Child" });
    const note = await service.createNote({ title: "Nested", body: "body", folderId: child.id });
    const ambiguous = delegate(fixture.storage, {
      move: async (input) => {
        if (input.fileId === parent.id) {
          await fixture.storage.move(input);
          throw new Error("injected post-move readback outage");
        }
        return fixture.storage.move(input);
      }
    });

    await expect(fixture.serviceFor(randomUUID(), ambiguous).updateFolder({
      folderId: parent.id,
      expectedVersion: parent.version,
      name: "Renamed",
      parentId: fixture.folders.inboxId
    })).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
    expect((await fixture.storeFor().read()).value.pendingMutations.some((mutation) => mutation.folderId === parent.id)).toBe(true);

    await fixture.serviceFor(randomUUID()).createFolder({ parentId: fixture.folders.plansId, name: "Trigger" });
    const recovered = (await fixture.storeFor().read()).value;
    expect(recovered.entries.find((entry) => entry.id === note.note.frontmatter.id)?.path)
      .toBe("Notes/Inbox/Renamed/Child/Nested.md");
    expect(recovered.pendingMutations.some((mutation) => mutation.folderId === parent.id)).toBe(false);
  });

  it("keeps folder Trash recoverable when preference pruning fails and completes after restart", async () => {
    const fixture = await setup();
    const service = fixture.serviceFor(randomUUID());
    const parent = await service.createFolder({ parentId: fixture.folders.plansId, name: "Disposable" });
    const note = await service.createNote({ title: "Nested", body: "body", folderId: parent.id });
    const preferences = await fixture.preferencesStoreFor().read();
    await fixture.preferencesStoreFor().update({
      ...preferences.value,
      favorites: [note.note.frontmatter.id],
      recent: [note.note.frontmatter.id]
    }, preferences.file.version);
    const tree = await service.vaultTree();
    const folder = tree.folders.find((candidate) => candidate.id === parent.id)!;
    let failPrune = true;
    const failingPreferences = delegate(fixture.storage, {
      updateText: async (input) => {
        if (input.fileId === fixture.preferencesFile.id && failPrune) {
          failPrune = false;
          throw new StorageMutationNotAppliedError();
        }
        return fixture.storage.updateText(input);
      }
    });

    await expect(fixture.serviceFor(randomUUID(), failingPreferences).trashFolder({
      folderId: parent.id,
      expectedTreeVersion: tree.treeVersion,
      confirmationToken: folder.deleteConfirmation!.confirmationToken
    })).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
    expect((await fixture.storeFor().read()).value.pendingMutations).toContainEqual(expect.objectContaining({
      folderId: parent.id,
      phase: "index-applied"
    }));

    await fixture.serviceFor(randomUUID()).createFolder({ parentId: fixture.folders.plansId, name: "Trigger" });
    expect((await fixture.storeFor().read()).value.pendingMutations).toEqual([]);
    expect((await fixture.preferencesStoreFor().read()).value).toMatchObject({ favorites: [], recent: [] });
  });

  it.each([
    ["external rename", async (fixture: Awaited<ReturnType<typeof setup>>, folderId: string, version: string) => {
      await fixture.storage.move({
        fileId: folderId,
        fromParentId: fixture.folders.plansId,
        toParentId: fixture.folders.plansId,
        newName: "External",
        expectedVersion: version
      } as never);
    }, "External", "Plans"],
    ["external parent move", async (fixture: Awaited<ReturnType<typeof setup>>, folderId: string, version: string) => {
      await fixture.storage.move({
        fileId: folderId,
        fromParentId: fixture.folders.plansId,
        toParentId: fixture.folders.archiveId,
        expectedVersion: version
      } as never);
    }, "Parent", "Archive"]
  ])("does not overwrite an %s while recovering an ambiguous folder move", async (_label, externalChange, expectedName, expectedParent) => {
    const fixture = await setup();
    const parent = await fixture.serviceFor(randomUUID()).createFolder({ parentId: fixture.folders.plansId, name: "Parent" });
    const ambiguous = delegate(fixture.storage, {
      move: async (input) => {
        if (input.fileId === parent.id) throw new Error("injected ambiguous move");
        return fixture.storage.move(input);
      }
    });
    await expect(fixture.serviceFor(randomUUID(), ambiguous).updateFolder({
      folderId: parent.id,
      expectedVersion: parent.version,
      name: "Intended",
      parentId: fixture.folders.inboxId
    })).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
    await externalChange(fixture, parent.id, parent.version);
    fixture.setTime("2026-08-24T08:16:00.000Z");

    await expect(fixture.serviceFor(randomUUID()).createFolder({
      parentId: fixture.folders.plansId,
      name: "Unrelated"
    })).resolves.toMatchObject({ name: "Unrelated" });

    const actual = await fixture.storage.get(parent.id);
    const actualParent = await fixture.storage.get(actual.parentIds[0]!);
    expect(actual).toMatchObject({ name: expectedName });
    expect(actualParent.name).toBe(expectedParent);
    expect((await fixture.storeFor().read()).value.pendingMutations).toContainEqual(expect.objectContaining({
      folderId: parent.id,
      phase: "conflicted"
    }));
  });

  it("does not block unrelated work or overwrite external note content during ambiguous move recovery", async () => {
    const fixture = await setup();
    const created = await fixture.serviceFor(randomUUID()).createNote({
      title: "Target", body: "original", folderId: fixture.folders.plansId
    });
    const ambiguous = delegate(fixture.storage, {
      move: async (input) => {
        if (input.fileId === created.driveId) throw new Error("injected ambiguous move");
        return fixture.storage.move(input);
      }
    });
    await expect(fixture.serviceFor(randomUUID(), ambiguous).moveNote({
      noteId: created.note.frontmatter.id,
      expectedVersion: created.version,
      folderId: fixture.folders.inboxId
    })).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
    const external = parseNote(created.source);
    external.body = "external content";
    const externalFile = await fixture.storage.updateText({
      fileId: created.driveId,
      expectedVersion: created.version,
      mimeType: "text/markdown",
      text: serializeNote(external)
    });
    fixture.setTime("2026-08-24T08:16:00.000Z");

    await expect(fixture.serviceFor(randomUUID()).createFolder({
      parentId: fixture.folders.plansId,
      name: "Unrelated"
    })).resolves.toMatchObject({ name: "Unrelated" });
    await expect(fixture.storage.readText(created.driveId)).resolves.toMatchObject({
      file: { version: externalFile.version, parentIds: [fixture.folders.plansId] },
      text: expect.stringContaining("external content")
    });
    expect((await fixture.storeFor().read()).value.pendingMutations).toContainEqual(expect.objectContaining({
      noteId: created.note.frontmatter.id,
      phase: "conflicted"
    }));
  });

  it("conditionally replays an exact unchanged note move after the ambiguity horizon", async () => {
    const fixture = await setup();
    const created = await fixture.serviceFor(randomUUID()).createNote({
      title: "Target", body: "original", folderId: fixture.folders.plansId
    });
    let noteMoveCalls = 0;
    const guarded = delegate(fixture.storage, {
      move: async (input) => {
        if (input.fileId === created.driveId) {
          noteMoveCalls += 1;
          if (noteMoveCalls === 1) throw new Error("injected ambiguous move");
          if ((input as typeof input & { expectedVersion?: string }).expectedVersion !== created.version) {
            throw new Error("missing exact move precondition");
          }
        }
        return fixture.storage.move(input);
      }
    });
    await expect(fixture.serviceFor(randomUUID(), guarded).moveNote({
      noteId: created.note.frontmatter.id,
      expectedVersion: created.version,
      folderId: fixture.folders.inboxId
    })).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
    fixture.setTime("2026-08-24T08:16:00.000Z");

    await fixture.serviceFor(randomUUID(), guarded).createFolder({ parentId: fixture.folders.plansId, name: "Trigger" });

    expect(noteMoveCalls).toBe(2);
    expect((await fixture.storeFor().read()).value.entries.find((entry) => entry.id === created.note.frontmatter.id)?.path)
      .toBe("Notes/Inbox/Target.md");
  });

  it.each(["update", "move"] as const)("retries note %s from fresh paths when an ancestor finishes between preflight and reservation", async (operation) => {
    const fixture = await setup();
    const parent = await fixture.serviceFor(randomUUID()).createFolder({ parentId: fixture.folders.plansId, name: "Parent" });
    const created = await fixture.serviceFor(randomUUID()).createNote({ title: "Nested", body: "original", folderId: parent.id });
    const gate = gateFirstReservation(fixture.storeFor());
    const service = fixture.serviceFor(randomUUID(), fixture.storage, gate.store);
    const changed = parseNote(created.source);
    changed.body = "changed";
    const pending = operation === "update"
      ? service.updateNote({ noteId: created.note.frontmatter.id, expectedVersion: created.version, source: serializeNote(changed) })
      : service.moveNote({ noteId: created.note.frontmatter.id, expectedVersion: created.version, folderId: fixture.folders.inboxId });
    await gate.didEnter;
    await fixture.serviceFor(randomUUID()).renameFolder({ folderId: parent.id, expectedVersion: parent.version, name: "Renamed" });
    gate.release();
    await pending;

    expect(gate.observed.at(-1)?.oldPath).toBe("Notes/Plans/Renamed/Nested.md");
  });

  it("retries a nested folder update from its fresh path when its ancestor changes before reservation", async () => {
    const fixture = await setup();
    const parent = await fixture.serviceFor(randomUUID()).createFolder({ parentId: fixture.folders.plansId, name: "Parent" });
    const child = await fixture.serviceFor(randomUUID()).createFolder({ parentId: parent.id, name: "Child" });
    const gate = gateFirstReservation(fixture.storeFor());
    const pending = fixture.serviceFor(randomUUID(), fixture.storage, gate.store).renameFolder({
      folderId: child.id,
      expectedVersion: child.version,
      name: "Child-Renamed"
    });
    await gate.didEnter;
    await fixture.serviceFor(randomUUID()).renameFolder({ folderId: parent.id, expectedVersion: parent.version, name: "Parent-Renamed" });
    gate.release();
    await pending;

    expect(gate.observed.at(-1)?.oldPath).toBe("Notes/Plans/Parent - Renamed/Child");
  });
});
