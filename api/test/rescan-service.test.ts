import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { VaultIndexSchema, type VaultPendingMutation } from "@nxt/contracts";
import { deriveIndex, parseNote, serializeNote } from "@nxt/domain";
import { describe, expect, it } from "vitest";
import { AttachmentService } from "../src/services/attachment-service.js";
import { RescanService } from "../src/services/rescan-service.js";
import { SystemFileStore } from "../src/services/system-file-store.js";
import { LocalDriveAdapter } from "../src/storage/local-drive-adapter.js";
import type { StoragePort } from "../src/storage/storage-port.js";

const validSource = serializeNote({
  frontmatter: {
    id: "018f47d2-6a34-7b2a-9f21-8a7034963aef",
    title: "External",
    created: "2026-08-23T12:00:00.000Z",
    updated: "2026-08-23T12:00:00.000Z",
    tags: [],
    aliases: []
  },
  body: "[[Other]]"
});
const noteId = "018f47d2-6a34-7b2a-9f21-8a7034963aef";
const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=", "base64"));

const setup = async (wrap?: (storage: StoragePort) => StoragePort) => {
  const raw = await LocalDriveAdapter.create(await mkdtemp(join(tmpdir(), "nxt-rescan-")));
  const notes = await raw.createFolder({ parentId: "vault", name: "Notes" });
  const plans = await raw.createFolder({ parentId: notes.id, name: "Plans" });
  const assets = await raw.createFolder({ parentId: "vault", name: "_assets" });
  const privateFile = await raw.createText({
    parentId: "private",
    name: "vault-index.json",
    mimeType: "application/json",
    text: '{"schemaVersion":1,"entries":[]}\n'
  });
  const storage = wrap?.(raw) ?? raw;
  const indexStore = new SystemFileStore({
    storage,
    fileId: privateFile.id,
    parentId: "private",
    name: "vault-index.json",
    schema: VaultIndexSchema
  });
  const rescan = new RescanService({
    storage,
    indexStore,
    notesFolderId: notes.id,
    cursorSecret: "test-only-rescan-cursor-secret-32-bytes",
    now: () => new Date("2026-08-23T12:00:00.000Z")
  });
  return { raw, storage, rescan, indexStore, ids: { notes, plans, assets, privateFile } };
};

const delegateStorage = (storage: StoragePort, overrides: Partial<StoragePort>): StoragePort => ({
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

const seedStaleIndexedNote = async (fixture: Awaited<ReturnType<typeof setup>>) => {
  const file = await fixture.raw.createText({
    parentId: fixture.ids.plans.id,
    name: "External.md",
    mimeType: "text/markdown",
    text: validSource
  });
  const entry = deriveIndex([{ source: validSource, driveId: file.id, path: "Notes/Plans/External.md", driveVersion: file.version, attachments: [] }]).entries[0];
  if (entry === undefined) throw new Error("failed to derive the indexed note fixture");
  const snapshot = await fixture.indexStore.read();
  await fixture.indexStore.update({ ...snapshot.value, entries: [{ ...entry, title: "Prior committed title" }] }, snapshot.file.version);
  return file;
};

const finishScan = async (service: RescanService, cursor: string | null): Promise<void> => {
  let current = cursor;
  let complete = false;
  while (!complete) {
    const page = await service.scanPage({ cursor: current, limit: 100 });
    current = page.cursor;
    complete = page.complete;
  }
};

const pendingMutation = (changes: Partial<VaultPendingMutation> = {}): VaultPendingMutation => ({
  id: randomUUID(),
  operation: "move-folder",
  folderId: "folder-live",
  oldPath: "Notes/Plans/Old",
  newPath: "Notes/Plans/New",
  ownerId: randomUUID(),
  fence: 1,
  phase: "reserved",
  createdAt: "2026-08-23T12:00:00.000Z",
  expiresAt: "2026-08-23T12:15:00.000Z",
  ...changes
});

describe("RescanService", () => {
  it("discovers only Markdown below Notes and preserves invalid raw source for recovery", async () => {
    const { raw, rescan, ids } = await setup();
    await raw.createText({ parentId: ids.plans.id, name: "External.md", mimeType: "text/markdown", text: validSource });
    const invalidRaw = "---\ntitle: broken\n---\n\nraw recovery body";
    await raw.createText({ parentId: ids.plans.id, name: "Broken.md", mimeType: "text/markdown", text: invalidRaw });
    await raw.createText({ parentId: ids.plans.id, name: "Ignore.txt", mimeType: "text/plain", text: "ignore" });
    await raw.createText({ parentId: ids.assets.id, name: "Asset.md", mimeType: "text/markdown", text: validSource });
    await raw.createText({ parentId: "private", name: "Private.md", mimeType: "text/markdown", text: validSource });

    let page = await rescan.scanPage({ cursor: null, limit: 2 });
    const cursors = new Set<string>();
    const records = [...page.records];
    const recoveries = [...page.recoveries];
    while (!page.complete) {
      expect(page.cursor).not.toBeNull();
      expect(page.cursor?.length).toBeLessThanOrEqual(512);
      expect(cursors.has(page.cursor!)).toBe(false);
      cursors.add(page.cursor!);
      page = await rescan.scanPage({ cursor: page.cursor, limit: 2 });
      records.push(...page.records);
      recoveries.push(...page.recoveries);
    }

    expect(records.map((item) => item.path)).toEqual(["Notes/Plans/External.md"]);
    expect(recoveries).toEqual([
      expect.objectContaining({ path: "Notes/Plans/Broken.md", rawSource: invalidRaw })
    ]);
    const index = (await rescan.readIndex()).value;
    expect(index.entries.map((item) => item.path)).toEqual(["Notes/Plans/External.md"]);
  });

  it("never asks Drive for or processes more than 100 entries in one request", async () => {
    let listed = 0;
    const { raw, ids } = await setup();
    for (let index = 0; index < 140; index += 1) {
      await raw.createText({ parentId: ids.plans.id, name: `Ignore-${index}.txt`, mimeType: "text/plain", text: "x" });
    }
    const storage: StoragePort = {
      ...raw,
      get: raw.get.bind(raw),
      listChildren: async (input) => {
        expect(input.pageSize).toBeLessThanOrEqual(100 - listed);
        const result = await raw.listChildren(input);
        listed += result.files.length;
        return result;
      },
      readText: raw.readText.bind(raw),
      readBytes: raw.readBytes.bind(raw),
      createFolder: raw.createFolder.bind(raw),
      createText: raw.createText.bind(raw),
      createBytes: raw.createBytes.bind(raw),
      updateText: raw.updateText.bind(raw),
      move: raw.move.bind(raw),
      trash: raw.trash.bind(raw),
      listRevisions: raw.listRevisions.bind(raw)
    };
    const store = new SystemFileStore({
      storage,
      fileId: ids.privateFile.id,
      parentId: "private",
      name: "vault-index.json",
      schema: VaultIndexSchema
    });
    const rescan = new RescanService({
      storage,
      indexStore: store,
      notesFolderId: ids.notes.id,
      cursorSecret: "test-only-rescan-cursor-secret-32-bytes"
    });

    const page = await rescan.scanPage({ cursor: null, limit: 100 });

    expect(page.processed).toBeLessThanOrEqual(100);
    expect(listed).toBeLessThanOrEqual(100);
  });

  it("rejects tampered cursors and preserves the prior valid index when final update fails", async () => {
    const { raw, ids } = await setup();
    await raw.createText({ parentId: ids.plans.id, name: "External.md", mimeType: "text/markdown", text: validSource });
    let failFinalIndexWrite = true;
    const storage: StoragePort = {
      ...raw,
      get: raw.get.bind(raw),
      listChildren: raw.listChildren.bind(raw),
      readText: raw.readText.bind(raw),
      readBytes: raw.readBytes.bind(raw),
      createFolder: raw.createFolder.bind(raw),
      createText: raw.createText.bind(raw),
      createBytes: raw.createBytes.bind(raw),
      updateText: async (input) => {
        if (
          failFinalIndexWrite &&
          input.fileId === ids.privateFile.id &&
          JSON.parse(input.text).rescanState === null &&
          JSON.parse(input.text).entries.length > 0
        ) throw new Error("injected partial write failure");
        return raw.updateText(input);
      },
      move: raw.move.bind(raw),
      trash: raw.trash.bind(raw),
      listRevisions: raw.listRevisions.bind(raw)
    };
    const indexStore = new SystemFileStore({
      storage,
      fileId: ids.privateFile.id,
      parentId: "private",
      name: "vault-index.json",
      schema: VaultIndexSchema
    });
    const rescan = new RescanService({
      storage,
      indexStore,
      notesFolderId: ids.notes.id,
      cursorSecret: "test-only-rescan-cursor-secret-32-bytes"
    });

    const first = await rescan.scanPage({ cursor: null, limit: 1 });
    expect(first.cursor).not.toBeNull();
    await expect(
      rescan.scanPage({ cursor: `${first.cursor!.slice(0, -1)}x`, limit: 100 })
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    let page = first;
    await expect(async () => {
      while (!page.complete) page = await rescan.scanPage({ cursor: page.cursor, limit: 100 });
    }).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
    expect((await indexStore.read()).value.entries).toEqual([]);
    expect((await indexStore.read()).value.rescanState).not.toBeNull();

    failFinalIndexWrite = false;
    while (!page.complete) page = await rescan.scanPage({ cursor: page.cursor, limit: 100 });
    expect((await rescan.readIndex()).value.entries).toHaveLength(1);
  });

  it("fails closed over a live attachment intent, keeps the old index and intent, then requires a fresh scan", async () => {
    const fixture = await setup();
    const noteFile = await seedStaleIndexedNote(fixture);
    const started = await fixture.rescan.scanPage({ cursor: null, limit: 100 });
    let release!: () => void;
    let signal!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { signal = resolve; });
    const attachmentStorage = delegateStorage(fixture.raw, {
      createBytes: async (input, context) => {
        signal();
        await gate;
        return fixture.raw.createBytes(input, context);
      }
    });
    const vault = {
      getNote: async () => {
        const current = await fixture.raw.readText(noteFile.id);
        return {
          note: { ...parseNote(current.text), path: "Notes/Plans/External.md" },
          source: current.text,
          driveId: noteFile.id,
          version: current.file.version,
          path: "Notes/Plans/External.md",
          checksum: current.checksum
        };
      }
    };
    const attachments = new AttachmentService({
      storage: attachmentStorage,
      indexStore: fixture.indexStore,
      vault,
      assetsRootId: fixture.ids.assets.id,
      now: () => new Date("2026-08-23T12:00:00.000Z")
    });
    const upload = attachments.upload({ noteId, name: "during-scan.png", declaredMime: "image/png", bytes: png });
    await entered;
    const liveIntent = structuredClone((await fixture.indexStore.read()).value.pendingMutations[0]);

    await expect(finishScan(fixture.rescan, started.cursor)).rejects.toMatchObject({ code: "CONFLICT" });
    let after = (await fixture.indexStore.read()).value;
    expect(after.entries[0]?.title).toBe("Prior committed title");
    expect(after.pendingMutations).toEqual([liveIntent]);
    expect(after.rescanState).not.toBeNull();

    release();
    await expect(upload).resolves.toMatchObject({ name: "during-scan.png" });
    await expect(finishScan(fixture.rescan, started.cursor)).rejects.toMatchObject({ code: "CONFLICT" });
    const restarted = await fixture.rescan.scanPage({ cursor: null, limit: 100 });
    await finishScan(fixture.rescan, restarted.cursor);
    after = (await fixture.indexStore.read()).value;
    expect(after.entries[0]).toMatchObject({ title: "External", attachments: [expect.objectContaining({ name: "during-scan.png" })] });
    expect(after.pendingMutations).toEqual([]);
  });

  it("fails closed over a live Task 7 folder intent and requires a fresh scan after it resolves", async () => {
    const fixture = await setup();
    await seedStaleIndexedNote(fixture);
    const started = await fixture.rescan.scanPage({ cursor: null, limit: 100 });
    const liveIntent = pendingMutation();
    await fixture.indexStore.compareAndSet((index) => ({
      ...index,
      generation: index.generation + 1,
      pendingMutations: [...index.pendingMutations, liveIntent]
    }));

    await expect(finishScan(fixture.rescan, started.cursor)).rejects.toMatchObject({ code: "CONFLICT" });
    let after = (await fixture.indexStore.read()).value;
    expect(after.entries[0]?.title).toBe("Prior committed title");
    expect(after.pendingMutations).toEqual([liveIntent]);

    await fixture.indexStore.compareAndSet((index) => ({
      ...index,
      generation: index.generation + 1,
      pendingMutations: index.pendingMutations.filter((mutation) => mutation.id !== liveIntent.id)
    }));
    await expect(finishScan(fixture.rescan, started.cursor)).rejects.toMatchObject({ code: "CONFLICT" });
    const restarted = await fixture.rescan.scanPage({ cursor: null, limit: 100 });
    await finishScan(fixture.rescan, restarted.cursor);
    after = (await fixture.indexStore.read()).value;
    expect(after.entries[0]?.title).toBe("External");
    expect(after.pendingMutations).toEqual([]);
  });

  it("rejects a terminal conflict introduced after scan start without clearing either conflict", async () => {
    const fixture = await setup();
    await seedStaleIndexedNote(fixture);
    const captured = pendingMutation({ phase: "conflicted" });
    await fixture.indexStore.compareAndSet((index) => ({ ...index, pendingMutations: [captured], generation: index.generation + 1 }));
    const started = await fixture.rescan.scanPage({ cursor: null, limit: 100 });
    const later = pendingMutation({ phase: "conflicted" });
    await fixture.indexStore.compareAndSet((index) => ({ ...index, pendingMutations: [...index.pendingMutations, later], generation: index.generation + 1 }));

    await expect(finishScan(fixture.rescan, started.cursor)).rejects.toMatchObject({ code: "CONFLICT" });
    const after = (await fixture.indexStore.read()).value;
    expect(after.entries[0]?.title).toBe("Prior committed title");
    expect(after.pendingMutations).toEqual([captured, later]);
    expect(after.rescanState).not.toBeNull();
  });

  it.each(["changed fingerprint", "reused id"] as const)("rejects a captured terminal conflict with a %s", async (mode) => {
    const fixture = await setup();
    await seedStaleIndexedNote(fixture);
    const captured = pendingMutation({ phase: "conflicted" });
    await fixture.indexStore.compareAndSet((index) => ({ ...index, pendingMutations: [captured], generation: index.generation + 1 }));
    const started = await fixture.rescan.scanPage({ cursor: null, limit: 100 });
    const changed = mode === "changed fingerprint"
      ? { ...captured, fence: captured.fence + 1 }
      : pendingMutation({ id: captured.id, operation: "update-note", noteId, driveId: "different-drive-id", phase: "conflicted" });
    const snapshot = await fixture.indexStore.read();
    await fixture.indexStore.update({ ...snapshot.value, pendingMutations: [changed] }, snapshot.file.version);

    await expect(finishScan(fixture.rescan, started.cursor)).rejects.toMatchObject({ code: "CONFLICT" });
    const after = (await fixture.indexStore.read()).value;
    expect(after.entries[0]?.title).toBe("Prior committed title");
    expect(after.pendingMutations).toEqual([changed]);
    expect(after.rescanState).not.toBeNull();
  });
});
