import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultIndexSchema } from "@nxt/contracts";
import { describe, expect, it } from "vitest";
import { RescanService } from "../src/services/rescan-service.js";
import { SystemFileStore } from "../src/services/system-file-store.js";
import { LocalDriveAdapter } from "../src/storage/local-drive-adapter.js";
import { RootBoundaryStorage } from "../src/storage/root-boundary.js";
import { StorageVersionConflictError, type StoragePort, type StoredFile } from "../src/storage/storage-port.js";

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

  it("enforces the budget below RootBoundary ancestry reads and resumes after an index CAS retry", async () => {
    const folderMime = "application/vnd.google-apps.folder";
    const files = new Map<string, StoredFile>();
    const texts = new Map<string, string>();
    const add = (id: string, name: string, mimeType: string, parentIds: string[], text?: string): void => {
      files.set(id, {
        id, name, mimeType, parentIds, version: "1", modifiedTime: "2026-08-24T08:00:00.000Z",
        size: text === undefined ? 0 : new TextEncoder().encode(text).byteLength, trashed: false
      });
      if (text !== undefined) texts.set(id, text);
    };
    add("root", "root", folderMime, []);
    add("level-one", "level-one", folderMime, ["root"]);
    add("level-two", "level-two", folderMime, ["level-one"]);
    add("notes", "Notes", folderMime, ["level-two"]);
    add("private", "private", folderMime, ["root"]);
    add("index", "vault-index.json", "application/json", ["private"], '{"schemaVersion":1,"entries":[]}\n');
    const timestamp = "2026-08-24T08:00:00.000Z";
    for (let index = 0; index < 100; index += 1) {
      const suffix = String(index).padStart(3, "0");
      if (index % 5 === 0) {
        add(`empty-${suffix}`, `Empty-${suffix}`, folderMime, ["notes"]);
      } else {
        const noteId = `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
        add(
          `note-${suffix}`,
          `Note-${suffix}.md`,
          "text/markdown",
          ["notes"],
          `---\nid: ${noteId}\ntitle: Note ${index}\ncreated: ${timestamp}\nupdated: ${timestamp}\ntags: []\naliases: []\n---\n\nbody`
        );
      }
    }
    let calls = 0;
    let injectConflict = true;
    const charge = (context: unknown): void => {
      const budget = (context as { operationBudget?: { consume(): void } } | undefined)?.operationBudget;
      budget?.consume();
      calls += 1;
    };
    const metadata = (fileId: string): StoredFile => {
      const file = files.get(fileId);
      if (file === undefined) throw new Error("missing file");
      return structuredClone(file);
    };
    const unsupported = async (): Promise<never> => { throw new Error("unsupported"); };
    const lowLevel = {
      get: async (fileId: string, context?: unknown) => { charge(context); return metadata(fileId); },
      listChildren: async (input: { parentId: string; pageToken?: string; pageSize: number }, context?: unknown) => {
        charge(context);
        const offset = input.pageToken === undefined ? 0 : Number(input.pageToken);
        const candidates = [...files.values()].filter((file) => !file.trashed && file.parentIds[0] === input.parentId);
        const page = candidates.slice(offset, offset + input.pageSize).map((file) => structuredClone(file));
        const next = offset + page.length;
        return { files: page, ...(next < candidates.length ? { nextPageToken: String(next) } : {}) };
      },
      readText: async (fileId: string, context?: unknown) => {
        charge(context);
        const text = texts.get(fileId);
        if (text === undefined) throw new Error("not text");
        return { file: metadata(fileId), text, checksum: createHash("sha256").update(text).digest("hex") };
      },
      readBytes: unsupported,
      createFolder: unsupported,
      createText: unsupported,
      createBytes: unsupported,
      updateText: async (input: { fileId: string; expectedVersion: string; mimeType: string; text: string }, context?: unknown) => {
        charge(context);
        const file = files.get(input.fileId);
        if (file === undefined || file.version !== input.expectedVersion) throw new StorageVersionConflictError();
        if (input.fileId === "index" && injectConflict) {
          injectConflict = false;
          file.version = String(Number(file.version) + 1);
          throw new StorageVersionConflictError();
        }
        file.version = String(Number(file.version) + 1);
        file.mimeType = input.mimeType;
        file.size = new TextEncoder().encode(input.text).byteLength;
        texts.set(input.fileId, input.text);
        return metadata(input.fileId);
      },
      move: unsupported,
      trash: unsupported,
      listRevisions: unsupported
    } as StoragePort;
    const bounded = new RootBoundaryStorage(lowLevel, "root");
    const indexStore = new SystemFileStore({
      storage: bounded, fileId: "index", parentId: "private", name: "vault-index.json", schema: VaultIndexSchema
    });
    let cursor: string | null = null;
    let complete = false;
    let pages = 0;
    while (!complete) {
      calls = 0;
      const page = await new RescanService({
        storage: bounded,
        indexStore,
        notesFolderId: "notes",
        cursorSecret: "persisted-rescan-cursor-secret-32-bytes"
      }).scanPage({ cursor, limit: 100 });
      expect(calls).toBeLessThanOrEqual(100);
      expect(page.records.length + page.recoveries.length).toBeLessThanOrEqual(100);
      cursor = page.cursor;
      complete = page.complete;
      pages += 1;
      expect(pages).toBeLessThan(250);
    }
    expect(injectConflict).toBe(false);
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
