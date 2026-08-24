import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultIndexSchema } from "@nxt/contracts";
import { describe, expect, it } from "vitest";
import { RescanService } from "../src/services/rescan-service.js";
import { SystemFileStore } from "../src/services/system-file-store.js";
import { LocalDriveAdapter } from "../src/storage/local-drive-adapter.js";
import type { StoragePort } from "../src/storage/storage-port.js";

const delegate = (storage: StoragePort, overrides: Partial<StoragePort>): StoragePort => ({
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
  const storage = await LocalDriveAdapter.create(await mkdtemp(join(tmpdir(), "nxt-rescan-persisted-")));
  const notes = await storage.createFolder({ parentId: "vault", name: "Notes" });
  const indexFile = await storage.createText({
    parentId: "private",
    name: "vault-index.json",
    mimeType: "application/json",
    text: '{"schemaVersion":1,"entries":[]}\n'
  });
  const indexStore = new SystemFileStore({ storage, fileId: indexFile.id, parentId: "private", name: "vault-index.json", schema: VaultIndexSchema });
  return { storage, notes, indexFile, indexStore };
};

describe("persisted rescan staging", () => {
  it("survives a fresh service instance, rejects replay/conflicting scans, and clears staging at completion", async () => {
    const fixture = await setup();
    for (let index = 0; index < 150; index += 1) {
      await fixture.storage.createFolder({ parentId: fixture.notes.id, name: `Folder-${String(index).padStart(3, "0")}` });
    }
    const secret = "persisted-rescan-cursor-secret-32-bytes";
    const firstService = new RescanService({ storage: fixture.storage, indexStore: fixture.indexStore, notesFolderId: fixture.notes.id, cursorSecret: secret });
    const first = await firstService.scanPage({ cursor: null, limit: 100 });

    expect(first.complete).toBe(false);
    expect((await fixture.indexStore.read()).value.rescanState).not.toBeNull();
    const secondService = new RescanService({ storage: fixture.storage, indexStore: fixture.indexStore, notesFolderId: fixture.notes.id, cursorSecret: secret });
    await expect(secondService.scanPage({ cursor: null, limit: 100 })).rejects.toMatchObject({ code: "CONFLICT" });
    const second = await secondService.scanPage({ cursor: first.cursor, limit: 100 });
    await expect(firstService.scanPage({ cursor: first.cursor, limit: 100 })).rejects.toMatchObject({ code: "CONFLICT" });

    let page = second;
    let service = firstService;
    while (!page.complete) {
      service = service === firstService ? secondService : firstService;
      page = await service.scanPage({ cursor: page.cursor, limit: 100 });
    }
    expect((await fixture.indexStore.read()).value.rescanState).toBeNull();
  });

  it("caps both returned Drive entries and list/read operations at 100 including empty folders", async () => {
    const fixture = await setup();
    for (let index = 0; index < 150; index += 1) {
      await fixture.storage.createFolder({ parentId: fixture.notes.id, name: `Empty-${String(index).padStart(3, "0")}` });
    }
    let operations = 0;
    let returnedEntries = 0;
    const counted = delegate(fixture.storage, {
      listChildren: async (input) => {
        operations += 1;
        const page = await fixture.storage.listChildren(input);
        returnedEntries += page.files.length;
        return page;
      },
      readText: async (fileId) => {
        operations += 1;
        return fixture.storage.readText(fileId);
      }
    });
    const countedStore = new SystemFileStore({
      storage: counted,
      fileId: fixture.indexFile.id,
      parentId: "private",
      name: "vault-index.json",
      schema: VaultIndexSchema
    });
    const service = new RescanService({
      storage: counted,
      indexStore: countedStore,
      notesFolderId: fixture.notes.id,
      cursorSecret: "persisted-rescan-cursor-secret-32-bytes"
    });

    let page = await service.scanPage({ cursor: null, limit: 100 });
    expect(operations).toBeLessThanOrEqual(100);
    expect(returnedEntries).toBeLessThanOrEqual(100);
    while (!page.complete) {
      operations = 0;
      returnedEntries = 0;
      page = await new RescanService({
        storage: counted,
        indexStore: countedStore,
        notesFolderId: fixture.notes.id,
        cursorSecret: "persisted-rescan-cursor-secret-32-bytes"
      }).scanPage({ cursor: page.cursor, limit: 100 });
      expect(operations).toBeLessThanOrEqual(100);
      expect(returnedEntries).toBeLessThanOrEqual(100);
    }
  });

  it("returns at most 100 records and recoveries jointly while counting private index reads", async () => {
    const fixture = await setup();
    const timestamp = "2026-08-24T08:00:00.000Z";
    for (let index = 0; index < 6; index += 1) {
      await fixture.storage.createText({
        parentId: fixture.notes.id,
        name: `000-Broken-${index}.md`,
        mimeType: "text/markdown",
        text: `---\ntitle: broken\n---\n\n${"x".repeat(90_000)}`
      });
    }
    for (let index = 0; index < 194; index += 1) {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      await fixture.storage.createText({
        parentId: fixture.notes.id,
        name: `100-Valid-${String(index).padStart(3, "0")}.md`,
        mimeType: "text/markdown",
        text: `---\nid: ${id}\ntitle: Valid ${index}\ncreated: ${timestamp}\nupdated: ${timestamp}\ntags: []\naliases: []\n---\n\nbody`
      });
    }
    let operations = 0;
    const counted = delegate(fixture.storage, {
      listChildren: async (input) => { operations += 1; return fixture.storage.listChildren(input); },
      readText: async (fileId) => { operations += 1; return fixture.storage.readText(fileId); }
    });
    const countedStore = new SystemFileStore({
      storage: counted,
      fileId: fixture.indexFile.id,
      parentId: "private",
      name: "vault-index.json",
      schema: VaultIndexSchema
    });
    let cursor: string | null = null;
    let complete = false;
    while (!complete) {
      operations = 0;
      const page = await new RescanService({
        storage: counted,
        indexStore: countedStore,
        notesFolderId: fixture.notes.id,
        cursorSecret: "persisted-rescan-cursor-secret-32-bytes"
      }).scanPage({ cursor, limit: 100 });
      expect(operations).toBeLessThanOrEqual(100);
      expect(page.records.length + page.recoveries.length).toBeLessThanOrEqual(100);
      cursor = page.cursor;
      complete = page.complete;
    }
  });

  it("keeps the all-read budget when the persisted scan CAS retries", async () => {
    const fixture = await setup();
    for (let index = 0; index < 40; index += 1) {
      await fixture.storage.createFolder({ parentId: fixture.notes.id, name: `Retry-${String(index).padStart(3, "0")}` });
    }
    let operations = 0;
    let injectedConflict = false;
    const counted = delegate(fixture.storage, {
      listChildren: async (input) => { operations += 1; return fixture.storage.listChildren(input); },
      readText: async (fileId) => { operations += 1; return fixture.storage.readText(fileId); },
      updateText: async (input) => {
        if (input.fileId === fixture.indexFile.id && !injectedConflict) {
          injectedConflict = true;
          operations += 1;
          const current = await fixture.storage.readText(input.fileId);
          await fixture.storage.updateText({ ...input, expectedVersion: current.file.version, text: current.text });
        }
        return fixture.storage.updateText(input);
      }
    });
    const countedStore = new SystemFileStore({
      storage: counted,
      fileId: fixture.indexFile.id,
      parentId: "private",
      name: "vault-index.json",
      schema: VaultIndexSchema
    });

    const page = await new RescanService({
      storage: counted,
      indexStore: countedStore,
      notesFolderId: fixture.notes.id,
      cursorSecret: "persisted-rescan-cursor-secret-32-bytes"
    }).scanPage({ cursor: null, limit: 100 });

    expect(injectedConflict).toBe(true);
    expect(operations).toBeLessThanOrEqual(100);
    expect(page.records.length + page.recoveries.length).toBeLessThanOrEqual(100);
  });

  it("persists bounded invalid-frontmatter recovery source instead of process-local state", async () => {
    const fixture = await setup();
    const rawSource = `---\ntitle: broken\n---\n\n${"recovery".repeat(1_000)}`;
    await fixture.storage.createText({ parentId: fixture.notes.id, name: "000-Broken.md", mimeType: "text/markdown", text: rawSource });
    for (let index = 0; index < 120; index += 1) {
      await fixture.storage.createFolder({ parentId: fixture.notes.id, name: `Folder-${String(index).padStart(3, "0")}` });
    }
    const service = new RescanService({
      storage: fixture.storage,
      indexStore: fixture.indexStore,
      notesFolderId: fixture.notes.id,
      cursorSecret: "persisted-rescan-cursor-secret-32-bytes"
    });

    const page = await service.scanPage({ cursor: null, limit: 100 });
    const state = (await fixture.indexStore.read()).value.rescanState;

    expect(page.complete).toBe(false);
    expect(state?.recoveries[0]).toMatchObject({ path: "Notes/000-Broken.md", rawSource });
  });
});
