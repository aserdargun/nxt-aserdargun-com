import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpRequest } from "@azure/functions";
import { VaultIndexSchema, type VaultIndex, type VaultPendingMutation } from "@nxt/contracts";
import { parseNote, renderMarkdown, serializeNote } from "@nxt/domain";
import { describe, expect, it, vi } from "vitest";
import { createAttachmentHandlers } from "../src/functions/attachments.js";
import { task8Routes } from "../src/functions/index.js";
import { ApiResponseError } from "../src/http/api-response.js";
import { OpaqueIdCodec } from "../src/functions/private-api.js";
import { AttachmentService } from "../src/services/attachment-service.js";
import { SystemFileStore } from "../src/services/system-file-store.js";
import { LocalDriveAdapter } from "../src/storage/local-drive-adapter.js";
import {
  StorageMutationOutcomeUnknownError,
  type StoragePort
} from "../src/storage/storage-port.js";

const noteId = "018f47d2-6a34-7b2a-9f21-8a7034963aef";
const otherNoteId = "018f47d2-6a34-7b2a-9f21-8a7034963af0";
const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=", "base64"));
const webp = Uint8Array.from(Buffer.from("UklGRiYAAABXRUJQVlA4IBoAAABQAQCdASoBAAEAAgA0JZwABAAAAP75HbIQAA==", "base64"));

const request = (method: string, url: string, body?: unknown, params: Record<string, string> = {}, headers: Record<string, string> = {}): HttpRequest =>
  new HttpRequest({
    method,
    url,
    params,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: { string: JSON.stringify(body) } })
  });

const sourceFor = (id: string, title: string, body = "# Today\n"): string => serializeNote({
  frontmatter: {
    id,
    title,
    created: "2026-08-23T12:00:00.000Z",
    updated: "2026-08-23T12:00:00.000Z",
    tags: [],
    aliases: []
  },
  body
});

const setup = async (options: { source?: string; storageOverride?: (storage: StoragePort) => StoragePort } = {}) => {
  const raw = await LocalDriveAdapter.create(await mkdtemp(join(tmpdir(), "nxt-attachment-service-")));
  const notes = await raw.createFolder({ parentId: "vault", name: "Notes" });
  const inbox = await raw.createFolder({ parentId: notes.id, name: "Inbox" });
  const assets = await raw.createFolder({ parentId: "vault", name: "_assets" });
  const source = options.source ?? sourceFor(noteId, "Plan");
  const note = await raw.createText({ parentId: inbox.id, name: "Plan.md", mimeType: "text/markdown", text: source });
  const indexFile = await raw.createText({ parentId: "private", name: "vault-index.json", mimeType: "application/json", text: "{\"schemaVersion\":1,\"entries\":[]}\n" });
  const storage = options.storageOverride?.(raw) ?? raw;
  const indexStore = new SystemFileStore<VaultIndex>({ storage: raw, fileId: indexFile.id, parentId: "private", name: "vault-index.json", schema: VaultIndexSchema });
  await indexStore.update({
    schemaVersion: 1,
    entries: [{
      id: noteId,
      title: "Plan",
      aliases: [],
      driveId: note.id,
      path: "Notes/Inbox/Plan.md",
      created: "2026-08-23T12:00:00.000Z",
      updated: "2026-08-23T12:00:00.000Z",
      driveVersion: note.version,
      tags: [],
      searchText: "plan",
      excerpt: "",
      outboundNoteIds: [],
      unresolvedWikiTargets: [],
      attachments: [],
      backlinks: []
    }]
  });
  const vault = {
    getNote: vi.fn(async (requestedNoteId: string) => {
      if (requestedNoteId !== noteId) throw new Error("missing note");
      const current = await raw.readText(note.id);
      return {
        note: { ...parseNote(current.text), path: "Notes/Inbox/Plan.md" },
        source: current.text,
        driveId: note.id,
        version: current.file.version,
        path: "Notes/Inbox/Plan.md",
        checksum: current.checksum
      };
    })
  };
  const service = new AttachmentService({ storage, indexStore, vault, assetsRootId: assets.id });
  return { raw, storage, service, indexStore, vault, ids: { notes, assets, note, indexFile } };
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

type AttachmentRecoveryProbe = {
  claimRecovery(candidate: VaultPendingMutation): Promise<VaultPendingMutation | undefined>;
  reconcileUpload(mutation: VaultPendingMutation): Promise<void>;
  renewRecoveryLease(mutation: VaultPendingMutation): Promise<VaultPendingMutation>;
  clearOwnedMutation(mutation: VaultPendingMutation): Promise<void>;
};

const recoveryProbe = (service: AttachmentService): AttachmentRecoveryProbe => service as unknown as AttachmentRecoveryProbe;
const recoveryClaimId = (mutation: VaultPendingMutation | undefined): string | undefined =>
  (mutation as (VaultPendingMutation & { recoveryClaimId?: string }) | undefined)?.recoveryClaimId;

const createClaimBarrierStore = (fixture: Awaited<ReturnType<typeof setup>>) => {
  let armed = false;
  let arrivals = 0;
  let release!: () => void;
  let transformCalls = 0;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const storage = delegateStorage(fixture.raw, {
    updateText: async (input, context) => {
      if (armed && input.fileId === fixture.ids.indexFile.id && arrivals < 2) {
        arrivals += 1;
        if (arrivals === 2) release();
        await barrier;
      }
      return fixture.raw.updateText(input, context);
    }
  });
  const store = new SystemFileStore<VaultIndex>({
    storage,
    fileId: fixture.ids.indexFile.id,
    parentId: "private",
    name: "vault-index.json",
    schema: VaultIndexSchema
  });
  const compareAndSet = store.compareAndSet.bind(store);
  store.compareAndSet = ((transform, options) => compareAndSet((index) => {
    transformCalls += 1;
    return transform(index);
  }, options)) as typeof store.compareAndSet;
  return {
    store,
    arm: () => { armed = true; },
    transformCalls: () => transformCalls
  };
};

const createPausedClaimStore = (fixture: Awaited<ReturnType<typeof setup>>) => {
  let release!: () => void;
  let signal!: () => void;
  let paused = true;
  let transformCalls = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { signal = resolve; });
  // Pause only after SystemFileStore has read the claimant snapshot, run the
  // updater, and performed update()'s claimant read. The pending call is now
  // immediately before its real low-level conditional update.
  const storage = delegateStorage(fixture.raw, {
    updateText: async (input, context) => {
      if (paused && input.fileId === fixture.ids.indexFile.id) {
        paused = false;
        signal();
        await gate;
      }
      return fixture.raw.updateText(input, context);
    }
  });
  const store = new SystemFileStore<VaultIndex>({
    storage,
    fileId: fixture.ids.indexFile.id,
    parentId: "private",
    name: "vault-index.json",
    schema: VaultIndexSchema
  });
  const compareAndSet = store.compareAndSet.bind(store);
  store.compareAndSet = ((transform, options) => compareAndSet((index) => {
    transformCalls += 1;
    return transform(index);
  }, options)) as typeof store.compareAndSet;
  return { store, entered, release, transformCalls: () => transformCalls };
};

const seedAmbiguousUpload = async (fixture: Awaited<ReturnType<typeof setup>>, clock: { value: number }, apply: boolean) => {
  const storage = delegateStorage(fixture.raw, {
    createBytes: async (input, context) => {
      if (!apply) throw new StorageMutationOutcomeUnknownError();
      const created = await fixture.raw.createBytes(input, context);
      throw new StorageMutationOutcomeUnknownError(created.id);
    }
  });
  const service = new AttachmentService({
    storage,
    indexStore: fixture.indexStore,
    vault: fixture.vault,
    assetsRootId: fixture.ids.assets.id,
    now: () => new Date(clock.value)
  });
  await expect(service.upload({ noteId, name: "ambiguous.png", declaredMime: "image/png", bytes: png }))
    .rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
  const mutation = (await fixture.indexStore.read()).value.pendingMutations[0];
  if (mutation === undefined) throw new Error("ambiguous upload did not persist its mutation");
  return mutation;
};

describe("AttachmentService", () => {
  it("rejects files above 20 MiB before Drive upload", async () => {
    const { service, raw } = await setup();
    const createBytes = vi.spyOn(raw, "createBytes");

    await expect(service.upload({
      noteId,
      name: "large.bin",
      declaredMime: "application/octet-stream",
      bytes: new Uint8Array(20 * 1024 * 1024 + 1)
    })).rejects.toMatchObject({ code: "TOO_LARGE" });
    expect(createBytes).not.toHaveBeenCalled();
  });

  it("stores a readback-verified asset only beneath its resolved note folder and projects no raw ID", async () => {
    const { service, raw, indexStore, ids } = await setup();

    const uploaded = await service.upload({ noteId, name: "diagram.png", declaredMime: "image/png", bytes: png });
    const stored = await raw.readBytes(uploaded.driveId);
    const assetFolder = (await raw.listChildren({ parentId: ids.assets.id, pageSize: 10 })).files.find((file) => file.name === noteId)!;

    expect(stored.file.parentIds).toEqual([assetFolder.id]);
    expect(stored.file.size).toBe(png.byteLength);
    expect(stored.checksum).toBe(createHash("sha256").update(png).digest("hex"));
    expect((await indexStore.read()).value.entries[0]?.attachments).toMatchObject([{
      driveId: uploaded.driveId,
      name: "diagram.png",
      mimeType: "image/png",
      size: png.byteLength,
      disposition: "inline"
    }]);
    expect(stored.file.appProperties?.nxtAttachmentMutation).toMatch(/^am1\.[A-Za-z0-9_-]{22}$/u);
    expect((await indexStore.read()).value.entries[0]?.attachments[0]).toMatchObject({
      marker: stored.file.appProperties?.nxtAttachmentMutation,
      version: stored.file.version
    });
  });

  it("rejects a configured asset root unless it is the exact _assets folder", async () => {
    const { raw, indexStore, vault, ids } = await setup();
    const service = new AttachmentService({ storage: raw, indexStore, vault, assetsRootId: ids.notes.id });

    await expect(service.upload({ noteId, name: "diagram.png", declaredMime: "image/png", bytes: png }))
      .rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
  });

  it("keeps malformed content and MIME/extension mismatches download-only", async () => {
    const { service } = await setup();

    const uploaded = await service.upload({ noteId, name: "report.jpg", declaredMime: "image/jpeg", bytes: png });
    const delivered = await service.read(uploaded.driveId);

    expect(uploaded.disposition).toBe("download");
    expect(delivered.disposition).toBe("download");
    expect(delivered.mimeType).toBe("image/png");
  });

  it("keeps new and legacy WebP projections download-only during verified delivery", async () => {
    const { service, indexStore } = await setup();
    const uploaded = await service.upload({ noteId, name: "legacy.webp", declaredMime: "image/webp", bytes: webp });
    expect(uploaded.disposition).toBe("download");

    await indexStore.compareAndSet((index) => ({
      ...index,
      entries: index.entries.map((entry) => entry.id === noteId
        ? { ...entry, attachments: entry.attachments.map((attachment) => attachment.driveId === uploaded.driveId ? { ...attachment, disposition: "inline" as const } : attachment) }
        : entry)
    }));

    await expect(service.read(uploaded.driveId)).resolves.toMatchObject({
      name: "legacy.webp",
      mimeType: "image/webp",
      disposition: "download"
    });
  });

  it("downgrades a legacy inline WebP mutation while recovering an ambiguous upload", async () => {
    const { raw, indexStore, ids, vault } = await setup();
    const storage = delegateStorage(raw, {
      createBytes: async (input, context) => {
        const created = await raw.createBytes(input, context);
        throw new StorageMutationOutcomeUnknownError(created.id);
      }
    });
    const uncertain = new AttachmentService({ storage, indexStore, vault, assetsRootId: ids.assets.id });
    await expect(uncertain.upload({ noteId, name: "recover-legacy.webp", declaredMime: "image/webp", bytes: webp }))
      .rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
    const pending = (await indexStore.read()).value.pendingMutations[0];
    if (pending?.driveId === undefined) throw new Error("ambiguous legacy WebP upload did not retain its Drive ID");
    await indexStore.compareAndSet((index) => ({
      ...index,
      pendingMutations: index.pendingMutations.map((mutation) => mutation.id === pending.id
        ? { ...mutation, attachmentDisposition: "inline" as const }
        : mutation)
    }));

    const recovered = new AttachmentService({ storage: raw, indexStore, vault, assetsRootId: ids.assets.id });
    await expect(recovered.read(pending.driveId)).resolves.toMatchObject({
      name: "recover-legacy.webp",
      mimeType: "image/webp",
      disposition: "download"
    });
    expect((await indexStore.read()).value.entries[0]?.attachments[0]?.disposition).toBe("download");
  });

  it("resolves duplicate normalized filenames deterministically before writing", async () => {
    const { service } = await setup();
    const first = await service.upload({ noteId, name: "e\u0301.png", declaredMime: "image/png", bytes: png });
    const second = await service.upload({ noteId, name: "é.png", declaredMime: "image/png", bytes: png });

    expect(first.name).toBe("é.png");
    expect(second.name).toBe("é-2.png");
  });

  it("rejects declared Drive folder and shortcut MIME types before creating an asset", async () => {
    const { service, raw } = await setup();
    const createFolder = vi.spyOn(raw, "createFolder");
    const createBytes = vi.spyOn(raw, "createBytes");
    const updateText = vi.spyOn(raw, "updateText");
    const trash = vi.spyOn(raw, "trash");

    await expect(service.upload({ noteId, name: "diagram.png", declaredMime: "application/vnd.google-apps.folder", bytes: png }))
      .rejects.toMatchObject({ code: "UNSAFE_FILE" });
    await expect(service.upload({ noteId, name: "diagram.png", declaredMime: "application/vnd.google-apps.shortcut", bytes: png }))
      .rejects.toMatchObject({ code: "UNSAFE_FILE" });
    expect(createBytes).not.toHaveBeenCalled();
    expect(createFolder).not.toHaveBeenCalled();
    expect(updateText).not.toHaveBeenCalled();
    expect(trash).not.toHaveBeenCalled();
  });

  it("rejects an asset that is indexed under the wrong note folder", async () => {
    const { service, raw, ids } = await setup();
    const uploaded = await service.upload({ noteId, name: "diagram.png", declaredMime: "image/png", bytes: png });
    const ownerFolder = (await raw.listChildren({ parentId: ids.assets.id, pageSize: 10 })).files.find((file) => file.name === noteId)!;
    const wrongFolder = await raw.createFolder({ parentId: ids.assets.id, name: otherNoteId });
    const stored = await raw.get(uploaded.driveId);
    await raw.move({ fileId: uploaded.driveId, fromParentId: ownerFolder.id, toParentId: wrongFolder.id, expectedVersion: stored.version });

    await expect(service.read(uploaded.driveId)).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
  });

  it("refuses Trash while inline and reference-style Markdown links remain", async () => {
    const source = sourceFor(noteId, "Plan", `![diagram](<../../_assets/${noteId}/diagram.png> "Diagram")\n\n[download]: ../../_assets/${noteId}/diagram.png\n`);
    const { service } = await setup({ source });
    const uploaded = await service.upload({ noteId, name: "diagram.png", declaredMime: "image/png", bytes: png });

    await expect(service.trash({ assetId: uploaded.driveId })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("uses the index reference projection for other notes without rereading every source", async () => {
    const { service, indexStore } = await setup();
    const uploaded = await service.upload({ noteId, name: "shared.png", declaredMime: "image/png", bytes: png });
    const current = await indexStore.read();
    const owner = current.value.entries[0];
    if (owner === undefined) throw new Error("missing owner");
    await indexStore.update({
      ...current.value,
      entries: [...current.value.entries, {
        ...owner,
        id: otherNoteId,
        title: "Other",
        driveId: "other-drive-id",
        path: "Notes/Inbox/Other.md",
        attachmentReferences: [`_assets/${noteId}/shared.png`],
        attachments: []
      }]
    });

    await expect(service.trash({ assetId: uploaded.driveId })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("trashes only the verified unreferenced asset and updates its index projection", async () => {
    const { service, raw, indexStore } = await setup();
    const uploaded = await service.upload({ noteId, name: "remove.png", declaredMime: "image/png", bytes: png });

    await expect(service.trash({ assetId: uploaded.driveId })).resolves.toEqual({ trashed: true });
    expect((await raw.get(uploaded.driveId)).trashed).toBe(true);
    expect((await indexStore.read()).value.entries[0]?.attachments).toHaveLength(0);
  });

  it("keeps ambiguous Trash outcomes persisted and unavailable rather than exposing the asset", async () => {
    const { service, raw, indexStore, vault, ids } = await setup();
    const uploaded = await service.upload({ noteId, name: "uncertain-trash.png", declaredMime: "image/png", bytes: png });
    const storage: StoragePort = {
      get: raw.get.bind(raw), listChildren: raw.listChildren.bind(raw), readText: raw.readText.bind(raw), readBytes: raw.readBytes.bind(raw),
      createFolder: raw.createFolder.bind(raw), createText: raw.createText.bind(raw), createBytes: raw.createBytes.bind(raw), updateText: raw.updateText.bind(raw), move: raw.move.bind(raw),
      trash: async (input) => {
        const trashed = await raw.trash(input);
        throw new StorageMutationOutcomeUnknownError(trashed.id);
      },
      listRevisions: raw.listRevisions.bind(raw)
    };
    const uncertain = new AttachmentService({ storage, indexStore, vault, assetsRootId: ids.assets.id });

    await expect(uncertain.trash({ assetId: uploaded.driveId })).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
    expect((await indexStore.read()).value.pendingMutations[0]).toMatchObject({ operation: "trash-attachment", phase: "outcome-unknown" });
    await expect(new AttachmentService({ storage: raw, indexStore, vault, assetsRootId: ids.assets.id }).read(uploaded.driveId))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await indexStore.read()).value.pendingMutations).toHaveLength(0);
    expect((await indexStore.read()).value.entries[0]?.attachments).toHaveLength(0);
  });

  it("retains a recovery mutation and exposes nothing after an ambiguous upload", async () => {
    const { raw, indexStore, ids } = await setup();
    const storage: StoragePort = {
      get: raw.get.bind(raw), listChildren: raw.listChildren.bind(raw), readText: raw.readText.bind(raw), readBytes: raw.readBytes.bind(raw),
      createFolder: raw.createFolder.bind(raw), createText: raw.createText.bind(raw),
      createBytes: async (input) => {
        const created = await raw.createBytes(input);
        throw new StorageMutationOutcomeUnknownError(created.id);
      },
      updateText: raw.updateText.bind(raw), move: raw.move.bind(raw), trash: raw.trash.bind(raw), listRevisions: raw.listRevisions.bind(raw)
    };
    const service = new AttachmentService({ storage, indexStore, vault: { getNote: async () => ({
      note: { ...parseNote(await raw.readText(ids.note.id).then((value) => value.text)), path: "Notes/Inbox/Plan.md" },
      source: (await raw.readText(ids.note.id)).text, driveId: ids.note.id, version: "1", path: "Notes/Inbox/Plan.md", checksum: (await raw.readText(ids.note.id)).checksum
    }) }, assetsRootId: ids.assets.id });

    await expect(service.upload({ noteId, name: "uncertain.png", declaredMime: "image/png", bytes: png })).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
    const pending = (await indexStore.read()).value.pendingMutations;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ operation: "create-attachment", phase: "outcome-unknown" });
    expect((await indexStore.read()).value.entries[0]?.attachments).toHaveLength(0);
  });

  it("recovers an ambiguous upload only after exact local readback proves the stored bytes", async () => {
    const { raw, indexStore, ids } = await setup();
    const storage: StoragePort = {
      get: raw.get.bind(raw), listChildren: raw.listChildren.bind(raw), readText: raw.readText.bind(raw), readBytes: raw.readBytes.bind(raw),
      createFolder: raw.createFolder.bind(raw), createText: raw.createText.bind(raw),
      createBytes: async (input) => {
        const created = await raw.createBytes(input);
        throw new StorageMutationOutcomeUnknownError(created.id);
      },
      updateText: raw.updateText.bind(raw), move: raw.move.bind(raw), trash: raw.trash.bind(raw), listRevisions: raw.listRevisions.bind(raw)
    };
    const vault = { getNote: async () => {
      const current = await raw.readText(ids.note.id);
      return { note: { ...parseNote(current.text), path: "Notes/Inbox/Plan.md" }, source: current.text, driveId: ids.note.id, version: current.file.version, path: "Notes/Inbox/Plan.md", checksum: current.checksum };
    } };
    const uncertain = new AttachmentService({ storage, indexStore, vault, assetsRootId: ids.assets.id });

    await expect(uncertain.upload({ noteId, name: "recover.png", declaredMime: "image/png", bytes: png })).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
    const assetId = (await indexStore.read()).value.pendingMutations[0]?.driveId;
    if (assetId === undefined) throw new Error("ambiguous upload did not retain its Drive ID");
    const recovered = new AttachmentService({ storage: raw, indexStore, vault, assetsRootId: ids.assets.id });

    await expect(recovered.read(assetId)).resolves.toMatchObject({ name: "recover.png", mimeType: "image/png", disposition: "inline" });
  });

  it("never trashes an unmarked lookalike while reconciling an ambiguous upload", async () => {
    const { raw, indexStore, ids, vault } = await setup();
    const storage: StoragePort = {
      get: raw.get.bind(raw), listChildren: raw.listChildren.bind(raw), readText: raw.readText.bind(raw), readBytes: raw.readBytes.bind(raw),
      createFolder: raw.createFolder.bind(raw), createText: raw.createText.bind(raw),
      createBytes: async (input) => {
        const created = await raw.createBytes(input);
        throw new StorageMutationOutcomeUnknownError(created.id);
      },
      updateText: raw.updateText.bind(raw), move: raw.move.bind(raw), trash: raw.trash.bind(raw), listRevisions: raw.listRevisions.bind(raw)
    };
    const uncertain = new AttachmentService({ storage, indexStore, vault, assetsRootId: ids.assets.id });
    await expect(uncertain.upload({ noteId, name: "duplicate.png", declaredMime: "image/png", bytes: png })).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
    const mutation = (await indexStore.read()).value.pendingMutations[0];
    if (mutation?.parentId === undefined || mutation.driveId === undefined) throw new Error("missing ambiguous upload intent");
    const duplicate = await raw.createBytes({ parentId: mutation.parentId, name: "duplicate.png", mimeType: "image/png", bytes: png });
    const recovered = new AttachmentService({ storage: raw, indexStore, vault, assetsRootId: ids.assets.id });

    await expect(recovered.read(mutation.driveId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await raw.get(mutation.driveId)).trashed).toBe(false);
    expect((await raw.get(duplicate.id)).trashed).toBe(false);
    expect((await indexStore.read()).value.pendingMutations[0]).toMatchObject({ phase: "conflicted" });
  });

  it.each(["same-service", "cross-service"] as const)("grants exactly one %s concurrent recovery claim from one candidate", async (mode) => {
    const fixture = await setup();
    const clock = { value: Date.parse("2026-08-24T12:00:00.000Z") };
    const candidate = await seedAmbiguousUpload(fixture, clock, false);
    const barrier = createClaimBarrierStore(fixture);
    const first = new AttachmentService({ storage: fixture.raw, indexStore: barrier.store, vault: fixture.vault, assetsRootId: fixture.ids.assets.id, now: () => new Date(clock.value) });
    const second = mode === "same-service"
      ? first
      : new AttachmentService({ storage: fixture.raw, indexStore: barrier.store, vault: fixture.vault, assetsRootId: fixture.ids.assets.id, now: () => new Date(clock.value) });

    barrier.arm();
    const claims = await Promise.all([
      recoveryProbe(first).claimRecovery(candidate),
      recoveryProbe(second).claimRecovery(candidate)
    ]);
    const accepted = claims.filter((claim): claim is VaultPendingMutation => claim !== undefined);
    const committed = (await fixture.indexStore.read()).value.pendingMutations[0];

    expect(accepted).toHaveLength(1);
    expect(recoveryClaimId(accepted[0])).toMatch(/^rc1\.[A-Za-z0-9_-]{22}$/u);
    expect(committed).toMatchObject({
      id: candidate.id,
      ownerId: accepted[0]?.ownerId,
      fence: candidate.fence + 1,
      expiresAt: accepted[0]?.expiresAt,
      reconcileAfter: accepted[0]?.reconcileAfter,
      recoveryClaimId: recoveryClaimId(accepted[0])
    });
    expect(barrier.transformCalls()).toBeGreaterThanOrEqual(3);
  });

  it("keeps a claim bound across lease renewal and rejects a stale snapshot, a CAS loser, and token tampering", async () => {
    const fixture = await setup();
    const ownerClock = { value: Date.parse("2026-08-24T12:00:00.000Z") };
    const candidate = await seedAmbiguousUpload(fixture, ownerClock, false);
    const owner = new AttachmentService({ storage: fixture.raw, indexStore: fixture.indexStore, vault: fixture.vault, assetsRootId: fixture.ids.assets.id, now: () => new Date(ownerClock.value) });
    const claimed = await recoveryProbe(owner).claimRecovery(candidate);
    if (claimed === undefined) throw new Error("expected the initial recovery claim");
    const paused = createPausedClaimStore(fixture);
    const loserClock = Date.parse(claimed.expiresAt) + 1;
    const loser = new AttachmentService({ storage: fixture.raw, indexStore: paused.store, vault: fixture.vault, assetsRootId: fixture.ids.assets.id, now: () => new Date(loserClock) });

    const losingClaim = recoveryProbe(loser).claimRecovery(claimed);
    await paused.entered;
    ownerClock.value += 1_000;
    const renewed = await recoveryProbe(owner).renewRecoveryLease(claimed);
    paused.release();

    await expect(losingClaim).resolves.toBeUndefined();
    expect(paused.transformCalls()).toBeGreaterThanOrEqual(2);
    expect(renewed.fence).toBe(claimed.fence + 1);
    expect(recoveryClaimId(renewed)).toBe(recoveryClaimId(claimed));
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(claimed.expiresAt));
    await recoveryProbe(owner).clearOwnedMutation(claimed);
    expect((await fixture.indexStore.read()).value.pendingMutations).toHaveLength(1);

    const forgedClaimId = `rc1.${"z".repeat(22)}`;
    await fixture.indexStore.compareAndSet((index) => ({
      ...index,
      generation: index.generation + 1,
      pendingMutations: index.pendingMutations.map((mutation) => mutation.id === renewed.id
        ? { ...mutation, recoveryClaimId: forgedClaimId }
        : mutation)
    }));
    await recoveryProbe(owner).clearOwnedMutation(renewed);
    expect((await fixture.indexStore.read()).value.pendingMutations[0]).toMatchObject({ recoveryClaimId: forgedClaimId });
  });

  it("allows only one concurrent claimant to finalize an exact ambiguous upload", async () => {
    const fixture = await setup();
    const clock = { value: Date.parse("2026-08-24T12:00:00.000Z") };
    const candidate = await seedAmbiguousUpload(fixture, clock, true);
    const barrier = createClaimBarrierStore(fixture);
    const service = new AttachmentService({ storage: fixture.raw, indexStore: barrier.store, vault: fixture.vault, assetsRootId: fixture.ids.assets.id, now: () => new Date(clock.value) });

    barrier.arm();
    const claims = (await Promise.all([
      recoveryProbe(service).claimRecovery(candidate),
      recoveryProbe(service).claimRecovery(candidate)
    ])).filter((claim): claim is VaultPendingMutation => claim !== undefined);
    await Promise.all(claims.map((claim) => recoveryProbe(service).reconcileUpload(claim)));

    expect(claims).toHaveLength(1);
    expect((await fixture.indexStore.read()).value.entries[0]?.attachments).toHaveLength(1);
    expect((await fixture.indexStore.read()).value.pendingMutations).toHaveLength(0);
  });

  it("allows only one concurrent claimant to conditionally Trash exact duplicate artifacts", async () => {
    const fixture = await setup();
    const clock = { value: Date.parse("2026-08-24T12:00:00.000Z") };
    const candidate = await seedAmbiguousUpload(fixture, clock, true);
    if (candidate.parentId === undefined || candidate.attachmentMarker === undefined) throw new Error("missing exact upload identity");
    await fixture.raw.createBytes({
      parentId: candidate.parentId,
      name: candidate.targetName as string,
      mimeType: candidate.attachmentMimeType as string,
      bytes: png,
      appProperties: { nxtAttachmentMutation: candidate.attachmentMarker }
    });
    let trashCalls = 0;
    const storage = delegateStorage(fixture.raw, {
      trash: async (input, context) => {
        trashCalls += 1;
        return fixture.raw.trash(input, context);
      }
    });
    const barrier = createClaimBarrierStore(fixture);
    const service = new AttachmentService({ storage, indexStore: barrier.store, vault: fixture.vault, assetsRootId: fixture.ids.assets.id, now: () => new Date(clock.value) });

    barrier.arm();
    const claims = (await Promise.all([
      recoveryProbe(service).claimRecovery(candidate),
      recoveryProbe(service).claimRecovery(candidate)
    ])).filter((claim): claim is VaultPendingMutation => claim !== undefined);
    await Promise.all(claims.map((claim) => recoveryProbe(service).reconcileUpload(claim)));

    expect(claims).toHaveLength(1);
    expect(trashCalls).toBe(2);
    expect((await fixture.indexStore.read()).value.pendingMutations).toHaveLength(0);
  });

  it("rejects a readback mismatch without projecting an attachment", async () => {
    const { raw, indexStore, ids, vault } = await setup();
    const storage: StoragePort = {
      get: raw.get.bind(raw), listChildren: raw.listChildren.bind(raw), readText: raw.readText.bind(raw),
      readBytes: async (fileId) => {
        const readback = await raw.readBytes(fileId);
        return { ...readback, checksum: "0".repeat(64) };
      },
      createFolder: raw.createFolder.bind(raw), createText: raw.createText.bind(raw), createBytes: raw.createBytes.bind(raw),
      updateText: raw.updateText.bind(raw), move: raw.move.bind(raw), trash: raw.trash.bind(raw), listRevisions: raw.listRevisions.bind(raw)
    };
    const service = new AttachmentService({ storage, indexStore, vault, assetsRootId: ids.assets.id });

    await expect(service.upload({ noteId, name: "mismatch.png", declaredMime: "image/png", bytes: png })).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
    expect((await indexStore.read()).value.entries[0]?.attachments).toHaveLength(0);
    expect((await indexStore.read()).value.pendingMutations[0]).toMatchObject({ operation: "create-attachment", phase: "drive-applied" });
  });

  it("rechecks owner Markdown after reserving Trash so a new reference wins the race", async () => {
    const { service, raw, vault, ids, indexStore } = await setup();
    const uploaded = await service.upload({ noteId, name: "race.png", declaredMime: "image/png", bytes: png });
    let reads = 0;
    vault.getNote.mockImplementation(async () => {
      reads += 1;
      if (reads === 2) {
        const before = await raw.get(ids.note.id);
        await raw.updateText({
          fileId: ids.note.id,
          expectedVersion: before.version,
          mimeType: "text/markdown",
          text: sourceFor(noteId, "Plan", `![race](../../_assets/${noteId}/race.png)`)
        });
      }
      const current = await raw.readText(ids.note.id);
      return { note: { ...parseNote(current.text), path: "Notes/Inbox/Plan.md" }, source: current.text, driveId: ids.note.id, version: current.file.version, path: "Notes/Inbox/Plan.md", checksum: current.checksum };
    });

    await expect(service.trash({ assetId: uploaded.driveId })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await raw.get(uploaded.driveId)).trashed).toBe(false);
    expect((await indexStore.read()).value.pendingMutations).toHaveLength(0);
  });

  it("serializes Trash behind even conflicted note and folder path mutations", async () => {
    const { service, indexStore, raw } = await setup();
    const uploaded = await service.upload({ noteId, name: "serialized.png", declaredMime: "image/png", bytes: png });
    const current = await indexStore.read();
    const base = {
      ownerId: noteId,
      fence: 1,
      createdAt: "2026-08-23T12:00:00.000Z",
      expiresAt: "2026-08-23T12:15:00.000Z",
      phase: "conflicted" as const
    };
    await indexStore.update({
      ...current.value,
      pendingMutations: [{
        ...base,
        id: "018f47d2-6a34-7b2a-9f21-8a7034963af1",
        operation: "update-note",
        noteId,
        driveId: current.value.entries[0]!.driveId,
        parentId: "folder",
        targetName: "Plan.md"
      }]
    });
    await expect(service.trash({ assetId: uploaded.driveId })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await raw.get(uploaded.driveId)).trashed).toBe(false);

    await indexStore.update({ ...current.value, pendingMutations: [{
      ...base,
      id: "018f47d2-6a34-7b2a-9f21-8a7034963af2",
      operation: "move-folder",
      folderId: "folder",
      oldPath: "Notes/Inbox",
      newPath: "Notes/Archive"
    }] });
    await expect(service.trash({ assetId: uploaded.driveId })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await raw.get(uploaded.driveId)).trashed).toBe(false);
  });

  it("never retries Trash after an external version drift", async () => {
    const { raw, indexStore, vault, ids } = await setup();
    let rawTrashCalls = 0;
    const storage: StoragePort = {
      get: raw.get.bind(raw), listChildren: raw.listChildren.bind(raw), readText: raw.readText.bind(raw), readBytes: raw.readBytes.bind(raw),
      createFolder: raw.createFolder.bind(raw), createText: raw.createText.bind(raw), createBytes: raw.createBytes.bind(raw), updateText: raw.updateText.bind(raw),
      move: raw.move.bind(raw), listRevisions: raw.listRevisions.bind(raw),
      trash: async (input, context) => {
        rawTrashCalls += 1;
        const before = await raw.get(input.fileId, context);
        await raw.move({ fileId: before.id, fromParentId: before.parentIds[0]!, toParentId: before.parentIds[0]!, expectedVersion: before.version, newName: "drifted.png" }, context);
        return raw.trash(input, context);
      }
    };
    const service = new AttachmentService({ storage, indexStore, vault, assetsRootId: ids.assets.id });
    const uploaded = await service.upload({ noteId, name: "drift.png", declaredMime: "image/png", bytes: png });

    await expect(service.trash({ assetId: uploaded.driveId })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(new AttachmentService({ storage: raw, indexStore, vault, assetsRootId: ids.assets.id }).read(uploaded.driveId))
      .rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
    expect(rawTrashCalls).toBe(1);
    expect((await raw.get(uploaded.driveId)).trashed).toBe(false);
    expect((await indexStore.read()).value.pendingMutations[0]).toMatchObject({ phase: "conflicted" });
  });
});

describe("private attachment handlers", () => {
  it("keeps a real opaque codec token through the Markdown attachment renderer", async () => {
    const codec = new OpaqueIdCodec("handler-test-opaque-id-secret-more-than-32-bytes");
    const assetId = codec.encode("raw-drive-id");
    const rendered = await renderMarkdown(`![asset](/api/private/attachments/${assetId})`);
    expect(rendered.html).toContain(`src="/api/private/attachments/${assetId}"`);
    expect(rendered.html).not.toContain("raw-drive-id");
  });

  it("registers only the approved three attachment routes without changing Task 7 routes", () => {
    expect(task8Routes.map(({ method, route }) => `${method} ${route}`)).toEqual([
      "POST private/attachments",
      "GET private/attachments/{assetId}",
      "DELETE private/attachments/{assetId}"
    ]);
  });

  it("authorizes before resolving services and returns static 413 errors", async () => {
    const resolveServices = vi.fn();
    const handlers = createAttachmentHandlers({
      authorize: () => { throw new ApiResponseError("FORBIDDEN"); },
      resolveServices,
      idCodec: new OpaqueIdCodec("handler-test-opaque-id-secret-more-than-32-bytes")
    });
    const denied = await handlers.create(request("POST", "https://nxt.example/api/private/attachments", {}));

    expect(denied.status).toBe(403);
    expect(resolveServices).not.toHaveBeenCalled();
  });

  it("encodes asset IDs and sets no-sniff plus RFC 5987 download headers", async () => {
    const codec = new OpaqueIdCodec("handler-test-opaque-id-secret-more-than-32-bytes");
    const upload = vi.fn(async () => ({ driveId: "raw-drive-id", name: "evil\r\nname.svg", mimeType: "image/svg+xml", size: 1, checksum: "a".repeat(64), disposition: "download" as const }));
    const read = vi.fn(async () => ({ bytes: Uint8Array.of(1), name: "evil\r\nname.svg", mimeType: "image/svg+xml", disposition: "download" as const }));
    const handlers = createAttachmentHandlers({
      authorize: () => ({ provider: "github", userId: "owner", userDetails: "aserdargun" }),
      resolveServices: () => ({ attachments: { upload, read, trash: vi.fn() } }) as never,
      idCodec: codec
    });
    const assetId = codec.encode("raw-drive-id");
    const response = await handlers.get(request("GET", `https://nxt.example/api/private/attachments/${assetId}`, undefined, { assetId }));

    expect(response.status).toBe(200);
    expect(response.headers).toMatchObject({
      "x-content-type-options": "nosniff",
      "content-type": "image/svg+xml"
    });
    expect(response.headers?.["content-disposition"]).toBe("attachment; filename*=UTF-8''evilname.svg");
    expect(JSON.stringify(response)).not.toContain("raw-drive-id");
  });

  it("strictly parses uploads, enforces decoded size, and returns a schema-shaped opaque response", async () => {
    const codec = new OpaqueIdCodec("handler-test-opaque-id-secret-more-than-32-bytes");
    const upload = vi.fn(async () => ({ driveId: "raw-drive-id", name: "diagram.png", mimeType: "image/png", size: 1, checksum: "a".repeat(64), disposition: "inline" as const }));
    const handlers = createAttachmentHandlers({
      authorize: () => ({ provider: "github", userId: "owner", userDetails: "aserdargun" }),
      resolveServices: () => ({ attachments: { upload, read: vi.fn(), trash: vi.fn() } }) as never,
      idCodec: codec
    });
    const response = await handlers.create(request("POST", "https://nxt.example/api/private/attachments", {
      noteId,
      name: "diagram.png",
      declaredMime: "image/png",
      bytesBase64: "AQ=="
    }));
    const oversized = await handlers.create(request("POST", "https://nxt.example/api/private/attachments", {
      noteId,
      name: "diagram.png",
      declaredMime: "image/png",
      bytesBase64: "AQ=="
    }, {}, { "content-length": String(30 * 1024 * 1024) }));

    expect(response.status).toBe(201);
    expect(codec.decode((response.jsonBody as { asset: { assetId: string } }).asset.assetId)).toBe("raw-drive-id");
    expect(JSON.stringify(response.jsonBody)).not.toContain("raw-drive-id");
    expect(oversized.status).toBe(413);
    expect(upload).toHaveBeenCalledOnce();
  });

  it("accepts exactly 20 MiB and rejects max-plus-one, missing or lying lengths before service resolution", async () => {
    const codec = new OpaqueIdCodec("handler-test-opaque-id-secret-more-than-32-bytes");
    const upload = vi.fn(async () => ({ driveId: "raw-drive-id", name: "boundary.bin", mimeType: "application/octet-stream", size: 20 * 1024 * 1024, checksum: "a".repeat(64), disposition: "download" as const }));
    const resolveServices = vi.fn(() => ({ attachments: { upload, read: vi.fn(), trash: vi.fn() } }) as never);
    const handlers = createAttachmentHandlers({
      authorize: () => ({ provider: "github", userId: "owner", userDetails: "aserdargun" }),
      resolveServices,
      idCodec: codec
    });
    const exact = Buffer.alloc(20 * 1024 * 1024, 0x61).toString("base64");
    const over = Buffer.alloc(20 * 1024 * 1024 + 1, 0x61).toString("base64");
    const body = (bytesBase64: string) => ({ noteId, name: "boundary.bin", declaredMime: "application/octet-stream", bytesBase64 });

    expect((await handlers.create(request("POST", "https://nxt.example/api/private/attachments", body(exact)))).status).toBe(201);
    expect((await handlers.create(request("POST", "https://nxt.example/api/private/attachments", body(over)))).status).toBe(413);
    expect((await handlers.create(request("POST", "https://nxt.example/api/private/attachments", body(over), {}, { "content-length": "1" }))).status).toBe(413);
    expect((await handlers.create(request("POST", "https://nxt.example/api/private/attachments", body("A=AA"), {}, { "content-length": "1, 1" }))).status).toBe(400);
    expect(upload).toHaveBeenCalledOnce();
    expect(resolveServices).toHaveBeenCalledOnce();
  });
});
