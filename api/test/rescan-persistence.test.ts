import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultIndexSchema } from "@nxt/contracts";
import { parseNote, serializeNote } from "@nxt/domain";
import { describe, expect, it } from "vitest";
import { AttachmentService } from "../src/services/attachment-service.js";
import { RescanService } from "../src/services/rescan-service.js";
import { SystemFileStore } from "../src/services/system-file-store.js";
import { GoogleDriveAdapter } from "../src/storage/google-drive-adapter.js";
import type { GoogleDriveClient, GoogleDriveUpdateInput } from "../src/storage/google-drive-client.js";
import { LocalDriveAdapter } from "../src/storage/local-drive-adapter.js";
import { RootBoundaryStorage } from "../src/storage/root-boundary.js";
import {
  StorageMutationOutcomeUnknownError,
  StorageVersionConflictError,
  type StorageOperationContext,
  type StoragePort,
  type StoredFile
} from "../src/storage/storage-port.js";

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

type MemoryFile = StoredFile & { bytes?: Uint8Array };

class DeterministicAttachmentDrive implements StoragePort {
  private readonly files = new Map<string, MemoryFile>();
  private sequence = 0;
  private operationCount = 0;
  private ambiguousAttachmentCreates = true;

  public constructor() {
    this.files.set("vault", this.folder("vault", "vault", []));
    this.files.set("private", this.folder("private", "private", []));
  }

  public calls(): number { return this.operationCount; }
  public resetCalls(): void { this.operationCount = 0; }
  public allowAttachmentCreates(): void { this.ambiguousAttachmentCreates = false; }

  public async get(fileId: string, context?: StorageOperationContext): Promise<StoredFile> {
    this.consume(context);
    return this.metadata(this.active(fileId, context));
  }

  public async listChildren(input: { parentId: string; pageToken?: string; pageSize: number }, context?: StorageOperationContext): Promise<{ files: StoredFile[]; nextPageToken?: string }> {
    this.consume(context);
    this.activeFolder(input.parentId, context);
    const offset = input.pageToken === undefined ? 0 : Number(input.pageToken);
    const children = [...this.files.values()]
      .filter((file) => !file.trashed && file.parentIds.length === 1 && file.parentIds[0] === input.parentId)
      .sort((left, right) => left.name.localeCompare(right.name, "en-US") || left.id.localeCompare(right.id, "en-US"));
    const page = children.slice(offset, offset + input.pageSize).map((file) => this.metadata(file));
    const next = offset + page.length;
    return next < children.length ? { files: page, nextPageToken: String(next) } : { files: page };
  }

  public async readText(fileId: string, context?: StorageOperationContext): Promise<{ file: StoredFile; text: string; checksum: string }> {
    const readback = await this.readBytes(fileId, context);
    return { file: readback.file, text: new TextDecoder("utf-8", { fatal: true }).decode(readback.bytes), checksum: readback.checksum };
  }

  public async readBytes(fileId: string, context?: StorageOperationContext): Promise<{ file: StoredFile; bytes: Uint8Array; checksum: string }> {
    this.consume(context);
    const file = this.active(fileId, context);
    if (file.mimeType === "application/vnd.google-apps.folder" || file.bytes === undefined) throw new Error("not a content file");
    const bytes = Uint8Array.from(file.bytes);
    return { file: this.metadata(file), bytes, checksum: createHash("sha256").update(bytes).digest("hex") };
  }

  public async createFolder(input: { parentId: string; name: string }, context?: StorageOperationContext): Promise<StoredFile> {
    this.consume(context);
    this.activeFolder(input.parentId, context);
    const id = this.nextId();
    const file = this.folder(id, input.name, [input.parentId]);
    this.files.set(id, file);
    return this.metadata(file);
  }

  public async createText(input: { parentId: string; name: string; mimeType: string; text: string }, context?: StorageOperationContext): Promise<StoredFile> {
    return this.createContent({ ...input, bytes: new TextEncoder().encode(input.text) }, context);
  }

  public async createBytes(input: { parentId: string; name: string; mimeType: string; bytes: Uint8Array; appProperties?: Record<string, string> }, context?: StorageOperationContext): Promise<StoredFile> {
    this.consume(context);
    if (this.ambiguousAttachmentCreates && input.mimeType.startsWith("image/")) throw new StorageMutationOutcomeUnknownError();
    return this.createContent(input);
  }

  public async updateText(input: { fileId: string; expectedVersion: string; mimeType: string; text: string }, context?: StorageOperationContext): Promise<StoredFile> {
    this.consume(context);
    const file = this.active(input.fileId, context);
    if (file.version !== input.expectedVersion) throw new StorageVersionConflictError();
    file.version = String(Number(file.version) + 1);
    file.mimeType = input.mimeType;
    file.bytes = new TextEncoder().encode(input.text);
    file.size = file.bytes.byteLength;
    file.modifiedTime = this.modified(file.version);
    return this.metadata(file);
  }

  public async move(input: { fileId: string; fromParentId: string; toParentId: string; expectedVersion: string; newName?: string }, context?: StorageOperationContext): Promise<StoredFile> {
    this.consume(context);
    const file = this.active(input.fileId, context);
    this.activeFolder(input.toParentId, context);
    if (file.version !== input.expectedVersion || file.parentIds[0] !== input.fromParentId) throw new StorageVersionConflictError();
    file.parentIds = [input.toParentId];
    if (input.newName !== undefined) file.name = input.newName;
    file.version = String(Number(file.version) + 1);
    file.modifiedTime = this.modified(file.version);
    return this.metadata(file);
  }

  public async trash(input: { fileId: string; expectedVersion: string }, context?: StorageOperationContext): Promise<StoredFile> {
    this.consume(context);
    const file = this.active(input.fileId, context);
    if (file.version !== input.expectedVersion) throw new StorageVersionConflictError();
    file.trashed = true;
    file.version = String(Number(file.version) + 1);
    file.modifiedTime = this.modified(file.version);
    return this.metadata(file);
  }

  public async listRevisions(_fileId: string, context?: StorageOperationContext): Promise<Array<{ id: string; modifiedTime: string }>> {
    this.consume(context);
    return [];
  }

  private createContent(input: { parentId: string; name: string; mimeType: string; bytes: Uint8Array; appProperties?: Record<string, string> }, context?: StorageOperationContext): StoredFile {
    this.activeFolder(input.parentId, context);
    const id = this.nextId();
    const bytes = Uint8Array.from(input.bytes);
    const file: MemoryFile = {
      id,
      name: input.name,
      mimeType: input.mimeType,
      parentIds: [input.parentId],
      version: "1",
      modifiedTime: this.modified("1"),
      size: bytes.byteLength,
      trashed: false,
      bytes,
      ...(input.appProperties === undefined ? {} : { appProperties: { ...input.appProperties } })
    };
    this.files.set(id, file);
    return this.metadata(file);
  }

  private folder(id: string, name: string, parentIds: string[]): MemoryFile {
    return { id, name, mimeType: "application/vnd.google-apps.folder", parentIds, version: "1", modifiedTime: this.modified("1"), size: 0, trashed: false };
  }

  private active(fileId: string, context?: StorageOperationContext): MemoryFile {
    const file = this.files.get(fileId);
    if (file === undefined || (file.trashed && context?.allowTrashed !== true)) throw new Error("missing fake Drive file");
    return file;
  }

  private activeFolder(fileId: string, context?: StorageOperationContext): MemoryFile {
    const file = this.active(fileId, context);
    if (file.mimeType !== "application/vnd.google-apps.folder") throw new Error("not a fake Drive folder");
    return file;
  }

  private metadata(file: MemoryFile): StoredFile {
    return {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      parentIds: [...file.parentIds],
      version: file.version,
      modifiedTime: file.modifiedTime,
      size: file.size,
      trashed: file.trashed,
      ...(file.appProperties === undefined ? {} : { appProperties: { ...file.appProperties } })
    };
  }

  private nextId(): string { this.sequence += 1; return `fake-${String(this.sequence).padStart(5, "0")}`; }
  private modified(version: string): string { return `2026-08-24T00:00:${String(Number(version) % 60).padStart(2, "0")}.000Z`; }
  private consume(context?: StorageOperationContext): void { this.operationCount += 1; context?.operationBudget?.consume(); }
}

type TestCursorPayload = {
  scanId: string;
  generation: number;
  position: number;
  nonce: string;
  expiresAt: string;
};

const decodeCursor = (cursor: string): TestCursorPayload => {
  const encoded = cursor.split(".")[1];
  if (encoded === undefined) throw new Error("test cursor is malformed");
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as TestCursorPayload;
};

const signCursor = (payload: TestCursorPayload, secret: string): string => {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `s1.${encoded}.${signature}`;
};

const seedEmptyFolders = async (fixture: Awaited<ReturnType<typeof setup>>, count: number): Promise<void> => {
  for (let index = 0; index < count; index += 1) {
    await fixture.storage.createFolder({
      parentId: fixture.notes.id,
      name: `Receipt-${String(index).padStart(3, "0")}`
    });
  }
};

const createOutcomeUnknownStore = (fixture: Awaited<ReturnType<typeof setup>>) => {
  let armed = false;
  let failedReadbacks = 0;
  let traversalCalls = 0;
  const storage = delegate(fixture.storage, {
    listChildren: async (input, context) => {
      traversalCalls += 1;
      return fixture.storage.listChildren(input, context);
    },
    readText: async (fileId, context) => {
      const result = await fixture.storage.readText(fileId, context);
      if (fileId === fixture.indexFile.id && failedReadbacks > 0) {
        failedReadbacks -= 1;
        throw new Error("injected accepted-write readback loss");
      }
      if (fileId !== fixture.indexFile.id) traversalCalls += 1;
      return result;
    },
    updateText: async (input, context) => {
      const result = await fixture.storage.updateText(input, context);
      if (input.fileId === fixture.indexFile.id && armed) {
        armed = false;
        failedReadbacks = 1;
      }
      return result;
    }
  });
  const indexStore = new SystemFileStore({
    storage,
    fileId: fixture.indexFile.id,
    parentId: "private",
    name: "vault-index.json",
    schema: VaultIndexSchema
  });
  return {
    storage,
    indexStore,
    armAcceptedWriteReadbackLoss: () => { armed = true; },
    resetTraversalCalls: () => { traversalCalls = 0; },
    traversalCalls: () => traversalCalls
  };
};

describe("persisted rescan staging", () => {
  it("recovers an accepted progress transition after the prior cursor expires and continues on a fresh instance", async () => {
    const fixture = await setup();
    await seedEmptyFolders(fixture, 80);
    const probe = createOutcomeUnknownStore(fixture);
    const secret = "progress-receipt-recovery-secret-32-bytes";
    let clock = Date.parse("2026-08-24T08:00:00.000Z");
    const service = () => new RescanService({
      storage: probe.storage,
      indexStore: probe.indexStore,
      notesFolderId: fixture.notes.id,
      cursorSecret: secret,
      now: () => new Date(clock)
    });

    const started = await service().scanPage({ cursor: null, limit: 100 });
    const priorCursor = started.cursor as string;
    const prior = decodeCursor(priorCursor);
    clock = Date.parse(prior.expiresAt) - 1_000;
    probe.armAcceptedWriteReadbackLoss();
    probe.resetTraversalCalls();
    await expect(service().scanPage({ cursor: priorCursor, limit: 100 })).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
    expect(probe.traversalCalls()).toBeGreaterThan(0);

    const persisted = (await fixture.indexStore.read()).value.rescanState;
    const transition = persisted?.lastTransition;
    expect(persisted).not.toBeNull();
    expect(transition).not.toBeNull();
    expect(transition?.recoveryExpiresAt).toBe(persisted?.expiresAt);
    expect(Date.parse(persisted?.expiresAt ?? "")).toBeGreaterThan(Date.parse(prior.expiresAt));

    clock = Date.parse(prior.expiresAt) + 1_000;
    probe.resetTraversalCalls();
    const recovered = await service().scanPage({ cursor: priorCursor, limit: 100 });
    expect(probe.traversalCalls()).toBe(0);
    expect(recovered).toEqual({
      cursor: signCursor({
        scanId: persisted?.scanId ?? "",
        generation: persisted?.baseGeneration ?? -1,
        position: persisted?.position ?? -1,
        nonce: persisted?.nonce ?? "",
        expiresAt: persisted?.expiresAt ?? ""
      }, secret),
      processed: transition?.processed,
      complete: false,
      records: transition?.records,
      recoveries: transition?.recoveries
    });

    let page = await service().scanPage({ cursor: recovered.cursor, limit: 100 });
    while (!page.complete) page = await service().scanPage({ cursor: page.cursor, limit: 100 });
    expect((await fixture.indexStore.read()).value.rescanState).toBeNull();
  });

  it("rolls back an accepted final swap whose readback fails and leaves the old index resumable", async () => {
    const fixture = await setup();
    const noteId = randomUUID();
    const source = serializeNote({
      frontmatter: {
        id: noteId,
        title: "Actual Drive title",
        created: "2026-08-24T09:00:00.000Z",
        updated: "2026-08-24T09:00:00.000Z",
        tags: [],
        aliases: []
      },
      body: "# Actual\n"
    });
    await fixture.storage.createText({ parentId: fixture.notes.id, name: "Actual.md", mimeType: "text/markdown", text: source });
    const probe = createOutcomeUnknownStore(fixture);
    const secret = "completion-receipt-recovery-secret-32-bytes";
    let clock = Date.parse("2026-08-24T09:00:00.000Z");
    const service = () => new RescanService({
      storage: probe.storage,
      indexStore: probe.indexStore,
      notesFolderId: fixture.notes.id,
      cursorSecret: secret,
      now: () => new Date(clock)
    });

    const started = await service().scanPage({ cursor: null, limit: 100 });
    const priorCursor = started.cursor as string;
    probe.armAcceptedWriteReadbackLoss();
    await expect(service().scanPage({ cursor: priorCursor, limit: 100 })).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });

    const rolledBack = (await fixture.indexStore.read()).value;
    expect(rolledBack.entries).toEqual([]);
    expect(rolledBack.rescanState).not.toBeNull();
    expect(rolledBack.lastCompletedRescan).toBeNull();

    clock += 1_000;
    await expect(service().scanPage({ cursor: priorCursor, limit: 100 })).resolves.toMatchObject({ complete: true, cursor: null });
    const completed = (await fixture.indexStore.read()).value;
    expect(completed.entries).toHaveLength(1);
    expect(completed.entries[0]).toMatchObject({ id: noteId, title: "Actual Drive title" });
    expect(completed.rescanState).toBeNull();
  });

  it("rejects the exact prior cursor once its progress receipt recovery expiry passes", async () => {
    const fixture = await setup();
    await seedEmptyFolders(fixture, 50);
    const probe = createOutcomeUnknownStore(fixture);
    const secret = "expired-progress-receipt-secret-32-bytes";
    let clock = Date.parse("2026-08-24T10:00:00.000Z");
    const service = () => new RescanService({
      storage: probe.storage,
      indexStore: probe.indexStore,
      notesFolderId: fixture.notes.id,
      cursorSecret: secret,
      now: () => new Date(clock)
    });

    const started = await service().scanPage({ cursor: null, limit: 100 });
    const priorCursor = started.cursor as string;
    clock = Date.parse(decodeCursor(priorCursor).expiresAt) - 1_000;
    await service().scanPage({ cursor: priorCursor, limit: 100 });
    const receipt = (await fixture.indexStore.read()).value.rescanState?.lastTransition;
    const recoveryExpiresAt = receipt?.recoveryExpiresAt;
    expect(recoveryExpiresAt).toBeTypeOf("string");
    if (recoveryExpiresAt === undefined || recoveryExpiresAt === null) throw new Error("progress receipt expiry is missing");

    clock = Date.parse(recoveryExpiresAt);
    probe.resetTraversalCalls();
    await expect(service().scanPage({ cursor: priorCursor, limit: 100 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(probe.traversalCalls()).toBe(0);
  });

  it("rejects an older cursor after its successor advances", async () => {
    const fixture = await setup();
    await seedEmptyFolders(fixture, 100);
    const secret = "advanced-successor-receipt-secret-32-bytes";
    const service = () => new RescanService({
      storage: fixture.storage,
      indexStore: fixture.indexStore,
      notesFolderId: fixture.notes.id,
      cursorSecret: secret,
      now: () => new Date("2026-08-24T11:00:00.000Z")
    });

    const started = await service().scanPage({ cursor: null, limit: 100 });
    const successor = await service().scanPage({ cursor: started.cursor, limit: 100 });
    expect(successor.complete).toBe(false);
    const advanced = await service().scanPage({ cursor: successor.cursor, limit: 100 });
    expect(advanced.cursor).not.toBe(successor.cursor);
    await expect(service().scanPage({ cursor: started.cursor, limit: 100 })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects tampered, cross-scan, generation, position, nonce, and equivalent re-encoded prior cursors", async () => {
    const fixture = await setup();
    await seedEmptyFolders(fixture, 50);
    const secret = "exact-prior-cursor-binding-secret-32-bytes";
    const service = () => new RescanService({
      storage: fixture.storage,
      indexStore: fixture.indexStore,
      notesFolderId: fixture.notes.id,
      cursorSecret: secret,
      now: () => new Date("2026-08-24T12:00:00.000Z")
    });

    const started = await service().scanPage({ cursor: null, limit: 100 });
    const priorCursor = started.cursor as string;
    await service().scanPage({ cursor: priorCursor, limit: 100 });
    const payload = decodeCursor(priorCursor);
    const equivalentReEncoding = signCursor({
      expiresAt: payload.expiresAt,
      nonce: payload.nonce,
      position: payload.position,
      generation: payload.generation,
      scanId: payload.scanId
    }, secret);
    expect(equivalentReEncoding).not.toBe(priorCursor);

    const tampered = `${priorCursor.slice(0, -1)}${priorCursor.endsWith("A") ? "B" : "A"}`;
    await expect(service().scanPage({ cursor: tampered, limit: 100 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    for (const invalid of [
      equivalentReEncoding,
      signCursor({ ...payload, scanId: randomUUID() }, secret),
      signCursor({ ...payload, generation: payload.generation + 1 }, secret),
      signCursor({ ...payload, position: payload.position + 1 }, secret),
      signCursor({ ...payload, nonce: payload.nonce === "A".repeat(22) ? "B".repeat(22) : "A".repeat(22) }, secret)
    ]) {
      await expect(service().scanPage({ cursor: invalid, limit: 100 })).rejects.toMatchObject({ code: "CONFLICT" });
    }
  });

  it("rejects a persisted receipt whose response and successor cursor state were altered", async () => {
    const fixture = await setup();
    await seedEmptyFolders(fixture, 50);
    const secret = "tampered-persisted-receipt-secret-32-bytes";
    const service = () => new RescanService({
      storage: fixture.storage,
      indexStore: fixture.indexStore,
      notesFolderId: fixture.notes.id,
      cursorSecret: secret,
      now: () => new Date("2026-08-24T12:30:00.000Z")
    });

    const started = await service().scanPage({ cursor: null, limit: 100 });
    const priorCursor = started.cursor as string;
    await service().scanPage({ cursor: priorCursor, limit: 100 });
    const snapshot = await fixture.indexStore.read();
    const state = snapshot.value.rescanState;
    if (state === null || state.lastTransition === null) throw new Error("progress receipt is missing");
    const tamperedState = structuredClone(state);
    tamperedState.nonce = tamperedState.nonce === "A".repeat(22) ? "B".repeat(22) : "A".repeat(22);
    tamperedState.lastTransition.processed += 1;
    await fixture.indexStore.update({ ...snapshot.value, rescanState: tamperedState }, snapshot.file.version);

    await expect(service().scanPage({ cursor: priorCursor, limit: 100 })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("replays progress without traversal or renewal of the receipt recovery expiry", async () => {
    const fixture = await setup();
    await seedEmptyFolders(fixture, 50);
    const probe = createOutcomeUnknownStore(fixture);
    const secret = "read-only-progress-replay-secret-32-bytes";
    let clock = Date.parse("2026-08-24T13:00:00.000Z");
    const service = () => new RescanService({
      storage: probe.storage,
      indexStore: probe.indexStore,
      notesFolderId: fixture.notes.id,
      cursorSecret: secret,
      now: () => new Date(clock)
    });

    const started = await service().scanPage({ cursor: null, limit: 100 });
    const priorCursor = started.cursor as string;
    const accepted = await service().scanPage({ cursor: priorCursor, limit: 100 });
    const before = (await fixture.indexStore.read()).value.rescanState;
    const recoveryExpiresAt = before?.lastTransition?.recoveryExpiresAt;
    expect(recoveryExpiresAt).toBe(before?.expiresAt);

    clock += 60_000;
    probe.resetTraversalCalls();
    await expect(service().scanPage({ cursor: priorCursor, limit: 100 })).resolves.toEqual(accepted);
    clock += 60_000;
    await expect(service().scanPage({ cursor: priorCursor, limit: 100 })).resolves.toEqual(accepted);
    expect(probe.traversalCalls()).toBe(0);
    expect((await fixture.indexStore.read()).value.rescanState).toEqual(before);
  });

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
    await expect(firstService.scanPage({ cursor: first.cursor, limit: 100 })).resolves.toEqual(second);

    let page = second;
    let service = firstService;
    if (!page.complete) {
      service = service === firstService ? secondService : firstService;
      page = await service.scanPage({ cursor: page.cursor, limit: 100 });
      await expect(firstService.scanPage({ cursor: first.cursor, limit: 100 })).rejects.toMatchObject({ code: "CONFLICT" });
    }
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

  it("recovers an accepted Google-backed progress write from the old cursor within the 100-call budget", async () => {
    const drive = createRescanGoogleDrive();
    const google = new GoogleDriveAdapter(drive.client, {
      rootId: "root",
      sleep: async () => undefined,
      random: () => 0
    });
    const bounded = new RootBoundaryStorage(google, "root");
    const indexStore = new SystemFileStore({
      storage: bounded,
      fileId: "index",
      parentId: "private",
      name: "vault-index.json",
      schema: VaultIndexSchema
    });
    const service = () => new RescanService({
      storage: bounded,
      indexStore,
      notesFolderId: "notes",
      cursorSecret: "google-rescan-recovery-secret-more-than-32-bytes"
    });

    drive.resetCalls();
    const started = await service().scanPage({ cursor: null, limit: 100 });
    expect(started.complete).toBe(false);
    expect(started.cursor).not.toBeNull();
    expect(drive.calls()).toBeLessThanOrEqual(100);

    drive.enableAmbiguousProgressProbe();
    drive.resetCalls();
    await expect(service().scanPage({ cursor: started.cursor, limit: 100 })).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
    expect(drive.calls()).toBeLessThanOrEqual(100);
    expect(drive.acceptedProbeWrites()).toBe(1);
    expect(drive.injectedCasConflicts()).toBe(1);
    expect(drive.injectedRetryableReads()).toBeGreaterThan(0);

    drive.resetCalls();
    let page = await service().scanPage({ cursor: started.cursor, limit: 100 });
    expect(drive.calls()).toBeLessThanOrEqual(100);
    expect(page.cursor === null || page.cursor !== started.cursor).toBe(true);
    expect(page.records.length + page.recoveries.length).toBeLessThanOrEqual(100);
    let pages = 0;
    while (!page.complete) {
      drive.resetCalls();
      page = await service().scanPage({ cursor: page.cursor, limit: 100 });
      expect(drive.calls()).toBeLessThanOrEqual(100);
      expect(page.records.length + page.recoveries.length).toBeLessThanOrEqual(100);
      pages += 1;
      expect(pages).toBeLessThan(100);
    }

    expect(VaultIndexSchema.parse((await indexStore.read()).value).rescanState).toBeNull();
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

    let page = await service.scanPage({ cursor: null, limit: 100 });
    let state = (await fixture.indexStore.read()).value.rescanState;
    while (!page.complete && state?.recoveries[0] === undefined) {
      page = await service.scanPage({ cursor: page.cursor, limit: 100 });
      state = (await fixture.indexStore.read()).value.rescanState;
    }

    expect(page.complete).toBe(false);
    expect(state?.recoveries[0]).toMatchObject({ path: "Notes/000-Broken.md", rawSource });
  });

  it("reclaims exactly 256 simultaneous terminal attachment conflicts and restores reservation capacity", async () => {
    const storage = new DeterministicAttachmentDrive();
    const notes = await storage.createFolder({ parentId: "vault", name: "Notes" });
    const assets = await storage.createFolder({ parentId: "vault", name: "_assets" });
    const indexFile = await storage.createText({
      parentId: "private",
      name: "vault-index.json",
      mimeType: "application/json",
      text: '{"schemaVersion":1,"entries":[]}\n'
    });
    const indexStore = new SystemFileStore({ storage, fileId: indexFile.id, parentId: "private", name: "vault-index.json", schema: VaultIndexSchema });
    const noteCount = 257;
    const noteIds = Array.from({ length: noteCount }, () => randomUUID());
    const noteFiles: Array<{ id: string; name: string }> = [];
    const created = "2026-08-24T08:00:00.000Z";
    const sourceFor = (index: number, title = `Lifecycle ${index}`): string => serializeNote({
      frontmatter: { id: noteIds[index] as string, title, created, updated: created, tags: [], aliases: [] },
      body: `# Lifecycle ${index}\n`
    });
    const entries = [];
    for (let index = 0; index < noteCount; index += 1) {
      const name = `Lifecycle-${String(index).padStart(3, "0")}.md`;
      const file = await storage.createText({ parentId: notes.id, name, mimeType: "text/markdown", text: sourceFor(index) });
      noteFiles.push({ id: file.id, name });
      entries.push({
        id: noteIds[index] as string,
        title: `Lifecycle ${index}`,
        aliases: [],
        driveId: file.id,
        path: `Notes/${name}`,
        created,
        updated: created,
        driveVersion: file.version,
        tags: [],
        searchText: `lifecycle ${index}`,
        excerpt: "",
        outboundNoteIds: [],
        unresolvedWikiTargets: [],
        attachmentReferences: [],
        attachments: [],
        backlinks: []
      });
    }
    const initial = await indexStore.read();
    await indexStore.update({ ...initial.value, entries }, initial.file.version);
    const vault = {
      getNote: async (noteId: string) => {
        const index = noteIds.indexOf(noteId);
        const file = noteFiles[index];
        if (index < 0 || file === undefined) throw new Error("missing lifecycle note");
        const current = await storage.readText(file.id);
        const path = `Notes/${file.name}`;
        return {
          note: { ...parseNote(current.text), path },
          source: current.text,
          driveId: file.id,
          version: current.file.version,
          path,
          checksum: current.checksum
        };
      }
    };
    const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=", "base64"));
    let clock = Date.parse("2026-08-24T12:00:00.000Z");
    const attachmentService = () => new AttachmentService({
      storage,
      indexStore,
      vault,
      assetsRootId: assets.id,
      now: () => new Date(clock)
    });

    for (let index = 0; index < 256; index += 1) {
      storage.resetCalls();
      await expect(attachmentService().upload({
        noteId: noteIds[index] as string,
        name: `terminal-${index}.png`,
        declaredMime: "image/png",
        bytes: png
      })).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
      expect(storage.calls()).toBeLessThan(100);
      // Later uploads run before every earlier immediate reconcile horizon, so
      // all 256 reservations coexist before recovery begins.
      clock -= 1;
    }
    expect((await indexStore.read()).value.pendingMutations).toHaveLength(256);

    const runHorizon = async (attempt: 1 | 2 | 3): Promise<void> => {
      clock += 15 * 60 * 1_000 + 512;
      for (;;) {
        const before = (await indexStore.read()).value.pendingMutations;
        const due = before.filter((mutation) => mutation.phase !== "conflicted" && Date.parse(mutation.reconcileAfter ?? mutation.expiresAt) <= clock).length;
        if (due === 0) break;
        await expect(attachmentService().read("missing-lifecycle-asset")).rejects.toMatchObject({ code: "NOT_FOUND" });
      }
      const after = (await indexStore.read()).value.pendingMutations;
      expect(after).toHaveLength(256);
      expect(after.every((mutation) => mutation.recoveryAttempts === attempt)).toBe(true);
      expect(after.every((mutation) => mutation.phase === (attempt === 3 ? "conflicted" : "outcome-unknown"))).toBe(true);
      if (attempt < 3) expect(after.every((mutation) => mutation.phase !== "conflicted")).toBe(true);
    };
    await runHorizon(1);
    await runHorizon(2);
    await runHorizon(3);

    await expect(attachmentService().upload({
      noteId: noteIds[256] as string,
      name: "capacity-257.png",
      declaredMime: "image/png",
      bytes: png
    })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await indexStore.read()).value.pendingMutations).toHaveLength(256);

    const stale = await storage.get(noteFiles[0]!.id);
    await storage.updateText({ fileId: stale.id, expectedVersion: stale.version, mimeType: "text/markdown", text: sourceFor(0, "Actual Drive Title") });
    const terminal = (await indexStore.read()).value.pendingMutations;
    const rawSecrets = terminal.flatMap((mutation) => [
      mutation.id,
      mutation.ownerId,
      mutation.recoveryClaimId,
      mutation.parentId,
      mutation.driveId,
      mutation.attachmentMarker
    ]).filter((value): value is string => value !== undefined);
    const secret = "terminal-attachment-rescan-secret-32-bytes";
    let cursor: string | null = null;
    let complete = false;
    const pages = [];
    while (!complete) {
      storage.resetCalls();
      const page = await new RescanService({
        storage,
        indexStore,
        notesFolderId: notes.id,
        cursorSecret: secret,
        now: () => new Date(clock)
      }).scanPage({ cursor, limit: 100 });
      expect(storage.calls()).toBeLessThanOrEqual(100);
      expect(page.records.length + page.recoveries.length).toBeLessThanOrEqual(100);
      pages.push(page);
      cursor = page.cursor;
      complete = page.complete;
      expect(pages.length).toBeLessThan(100);
    }
    const recoveries = pages.flatMap((page) => page.recoveries);
    expect(recoveries).toHaveLength(256);
    expect(recoveries.every((recovery) => recovery.path === "Notes" && recovery.rawSource === "" && recovery.error === "External change detected. Rescan is reconciling the index.")).toBe(true);
    expect(recoveries.every((recovery) => Object.keys(recovery).sort().join(",") === "error,path,rawSource")).toBe(true);
    const serialized = JSON.stringify(pages);
    for (const secretValue of rawSecrets) expect(serialized).not.toContain(secretValue);
    const rebuilt = (await indexStore.read()).value;
    expect(rebuilt.pendingMutations).toEqual([]);
    expect(rebuilt.entries).toHaveLength(noteCount);
    expect(rebuilt.entries.find((entry) => entry.id === noteIds[0])?.title).toBe("Actual Drive Title");

    storage.allowAttachmentCreates();
    await expect(attachmentService().upload({
      noteId: noteIds[0] as string,
      name: "after-terminal-recovery.png",
      declaredMime: "image/png",
      bytes: png
    })).resolves.toMatchObject({ name: "after-terminal-recovery.png", disposition: "inline" });
    expect((await indexStore.read()).value.pendingMutations).toEqual([]);
  }, 180_000);
});

const createRescanGoogleDrive = () => {
  const folderMime = "application/vnd.google-apps.folder";
  type DriveFile = {
    id: string;
    name: string;
    mimeType: string;
    parents: string[];
    version: number;
    trashed: boolean;
    content?: string;
  };
  const files = new Map<string, DriveFile>();
  const add = (file: DriveFile): void => { files.set(file.id, file); };
  add({ id: "root", name: "root", mimeType: folderMime, parents: [], version: 1, trashed: false });
  add({ id: "notes", name: "Notes", mimeType: folderMime, parents: ["root"], version: 1, trashed: false });
  add({ id: "private", name: "NXT-PRIVATE-COM", mimeType: folderMime, parents: ["root"], version: 1, trashed: false });
  add({
    id: "index",
    name: "vault-index.json",
    mimeType: "application/json",
    parents: ["private"],
    version: 1,
    trashed: false,
    content: '{"schemaVersion":1,"entries":[]}\n'
  });
  for (let index = 0; index < 35; index += 1) {
    add({
      id: `empty-${String(index).padStart(3, "0")}`,
      name: `Empty-${String(index).padStart(3, "0")}`,
      mimeType: folderMime,
      parents: ["notes"],
      version: 1,
      trashed: false
    });
  }
  let rawCalls = 0;
  let probeEnabled = false;
  let injectCasConflict = false;
  let acceptedProbeWriteCount = 0;
  let injectedCasConflictCount = 0;
  let retryPairs = 0;
  let retryPending = false;
  let retryableReadCount = 0;
  let failAcceptedReadback = 0;
  const statusError = (status: number): Error => Object.assign(new Error(`injected ${status}`), { response: { status } });
  const file = (fileId: string): DriveFile => {
    const value = files.get(fileId);
    if (value === undefined) throw new Error("missing fake Drive file");
    return value;
  };
  const metadata = (value: DriveFile): Record<string, unknown> => ({
    id: value.id,
    name: value.name,
    mimeType: value.mimeType,
    parents: [...value.parents],
    version: String(value.version),
    modifiedTime: `2026-08-24T08:00:00.${String(value.version).padStart(3, "0")}Z`,
    ...(value.mimeType === folderMime ? {} : {
      size: String(new TextEncoder().encode(value.content ?? "").byteLength),
      md5Checksum: createHash("md5").update(value.content ?? "").digest("hex")
    }),
    trashed: value.trashed
  });
  const client: GoogleDriveClient = {
    files: {
      get: async (input) => {
        rawCalls += 1;
        if (input.fileId === "index" && input.alt !== "media" && failAcceptedReadback > 0) {
          failAcceptedReadback -= 1;
          retryableReadCount += 1;
          throw statusError(503);
        }
        if (probeEnabled && retryPairs > 0) {
          if (!retryPending) {
            retryPending = true;
            retryPairs -= 1;
            retryableReadCount += 1;
            throw statusError(503);
          }
          retryPending = false;
        }
        const value = file(input.fileId);
        return input.alt === "media"
          ? { data: value.content ?? "" }
          : { data: metadata(value), headers: { etag: `"version-${value.version}"` } };
      },
      list: async (input) => {
        rawCalls += 1;
        const match = /^'([^']+)' in parents/u.exec(input.q);
        if (match === null) throw new Error("invalid fake Drive query");
        const parentId = match[1] as string;
        const offset = input.pageToken === undefined ? 0 : Number(input.pageToken);
        const children = [...files.values()]
          .filter((candidate) => !candidate.trashed && candidate.parents.length === 1 && candidate.parents[0] === parentId)
          .sort((first, second) => first.name.localeCompare(second.name, "en-US"));
        const page = children.slice(offset, offset + input.pageSize);
        const next = offset + page.length;
        return {
          data: {
            files: page.map(metadata),
            ...(next < children.length ? { nextPageToken: String(next) } : {})
          }
        };
      },
      create: async () => { throw new Error("unsupported fake Drive create"); },
      update: async (input: GoogleDriveUpdateInput, options) => {
        rawCalls += 1;
        const current = file(input.fileId);
        if (options?.headers["If-Match"] !== `"version-${current.version}"`) throw statusError(412);
        if (probeEnabled && injectCasConflict) {
          injectCasConflict = false;
          injectedCasConflictCount += 1;
          throw statusError(412);
        }
        if (typeof input.media?.body !== "string") throw new Error("fake Drive update requires text media");
        current.content = input.media.body;
        current.mimeType = input.media.mimeType;
        current.version += 1;
        if (probeEnabled) {
          acceptedProbeWriteCount += 1;
          probeEnabled = false;
          failAcceptedReadback = 3;
        }
        return { data: { id: current.id } };
      }
    },
    revisions: { list: async () => ({ data: { revisions: [] } }) }
  };
  return {
    client,
    calls: () => rawCalls,
    resetCalls: () => { rawCalls = 0; },
    enableAmbiguousProgressProbe: () => {
      probeEnabled = true;
      injectCasConflict = true;
      retryPairs = 3;
      retryPending = false;
    },
    acceptedProbeWrites: () => acceptedProbeWriteCount,
    injectedCasConflicts: () => injectedCasConflictCount,
    injectedRetryableReads: () => retryableReadCount
  };
};
