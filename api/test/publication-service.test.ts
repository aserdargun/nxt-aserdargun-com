import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  PublicationManifestSchema,
  VaultIndexSchema,
  type PublicationManifest,
  type VaultIndex
} from "@nxt/contracts";
import { deriveIndex, serializeNote } from "@nxt/domain";
import { describe, expect, it } from "vitest";
import { AttachmentService } from "../src/services/attachment-service.js";
import {
  PublicPublicationReader,
  PublicationService
} from "../src/services/publication-service.js";
import { SystemFileStore } from "../src/services/system-file-store.js";
import { VaultService } from "../src/services/vault-service.js";
import { LocalDriveAdapter } from "../src/storage/local-drive-adapter.js";
import { RootBoundaryStorage } from "../src/storage/root-boundary.js";
import {
  StorageMutationOutcomeUnknownError,
  type StoragePort
} from "../src/storage/storage-port.js";

const noteId = "018f47d2-6a34-7b2a-9f21-8a7034963aef";
const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=", "base64"));
const webp = Uint8Array.from(Buffer.from("UklGRiYAAABXRUJQVlA4IBoAAABQAQCdASoBAAEAAgA0JZwABAAAAP75HbIQAA==", "base64"));

const sourceFor = (title: string, body = "# Public body\n"): string => serializeNote({
  frontmatter: {
    id: noteId,
    title,
    created: "2026-08-24T12:00:00.000Z",
    updated: "2026-08-24T12:00:00.000Z",
    tags: ["private-tag"],
    aliases: ["Private alias"]
  },
  body
});

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

const setup = async (options: {
  source?: string;
  privateStorage?: (storage: StoragePort, ids: { manifestId: string; publishedId: string }) => StoragePort;
} = {}) => {
  const raw = await LocalDriveAdapter.create(await mkdtemp(join(tmpdir(), "nxt-publication-")));
  const notes = await raw.createFolder({ parentId: "vault", name: "Notes" });
  const inbox = await raw.createFolder({ parentId: notes.id, name: "Inbox" });
  const plans = await raw.createFolder({ parentId: notes.id, name: "Plans" });
  const archive = await raw.createFolder({ parentId: notes.id, name: "Archive" });
  const assets = await raw.createFolder({ parentId: "vault", name: "_assets" });
  const published = await raw.createFolder({ parentId: "private", name: "published" });
  const source = options.source ?? sourceFor("Share me");
  const note = await raw.createText({ parentId: inbox.id, name: "Share.md", mimeType: "text/markdown", text: source });
  const indexFile = await raw.createText({ parentId: "private", name: "vault-index.json", mimeType: "application/json", text: '{"schemaVersion":1,"entries":[]}\n' });
  const manifestFile = await raw.createText({ parentId: "private", name: "publication-manifest.json", mimeType: "application/json", text: '{"schemaVersion":1,"entries":[]}\n' });
  const privateInner = options.privateStorage?.(raw, { manifestId: manifestFile.id, publishedId: published.id }) ?? raw;
  const privateStorage = new RootBoundaryStorage(privateInner, "private");
  const vaultStorage = new RootBoundaryStorage(raw, "vault");
  const indexStore = new SystemFileStore<VaultIndex>({ storage: privateStorage, fileId: indexFile.id, parentId: "private", name: "vault-index.json", schema: VaultIndexSchema });
  const manifestStore = new SystemFileStore<PublicationManifest>({ storage: privateStorage, fileId: manifestFile.id, parentId: "private", name: "publication-manifest.json", schema: PublicationManifestSchema });
  const entry = deriveIndex([{ source, driveId: note.id, path: "Notes/Inbox/Share.md", driveVersion: note.version, attachments: [] }]).entries[0];
  if (entry === undefined) throw new Error("missing publication note fixture");
  await indexStore.update({ schemaVersion: 1, entries: [entry] });
  const vault = new VaultService({
    storage: vaultStorage,
    indexStore,
    folders: { notesId: notes.id, inboxId: inbox.id, plansId: plans.id, archiveId: archive.id, assetsId: assets.id },
    confirmationSecret: "publication-test-confirmation-secret-more-than-32-bytes",
    now: () => new Date("2026-08-24T12:00:00.000Z")
  });
  const attachments = new AttachmentService({ storage: vaultStorage, indexStore, vault, assetsRootId: assets.id });
  const service = new PublicationService({
    storage: privateStorage,
    manifestStore,
    indexStore,
    vault,
    attachments,
    privateRootId: "private",
    publishedRootId: published.id,
    now: () => new Date("2026-08-24T12:00:00.000Z")
  });
  const reader = new PublicPublicationReader({
    storage: privateStorage,
    manifestStore,
    privateRootId: "private",
    publishedRootId: published.id
  });
  return {
    raw, privateStorage, vaultStorage, indexStore, manifestStore, vault, attachments, service, reader,
    ids: { notes, inbox, plans, archive, assets, published, note, indexFile, manifestFile }
  };
};

const publishCurrent = async (fixture: Awaited<ReturnType<typeof setup>>) => {
  const note = await fixture.vault.getNote(noteId);
  return fixture.service.publish({ noteId, expectedVersion: note.version });
};

describe("immutable publication snapshots", () => {
  it("commits a 128-bit public ID last and exposes only a sanitized frozen projection", async () => {
    const fixture = await setup({ source: sourceFor("Share me", "# Hello\n\n<script>private()</script>\n") });
    const result = await publishCurrent(fixture);
    expect(result.publicId).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect(Object.keys(result).sort()).toEqual(["publicId", "publishedAt"]);

    const manifest = (await fixture.manifestStore.read()).value;
    expect(manifest.entries).toHaveLength(1);
    const publicNote = await fixture.reader.getNote(result.publicId);
    expect(publicNote).toMatchObject({ title: "Share me", publishedAt: result.publishedAt, assets: [] });
    expect(publicNote?.html).toContain("<h1");
    expect(publicNote?.html).not.toMatch(/script|private-tag|Private alias|Notes\/Inbox|drive/iu);
    expect(JSON.stringify(publicNote)).not.toContain(noteId);
  });

  it("does not expose a partial publication and leaves only bounded private cleanup state", async () => {
    let snapshotCreates = 0;
    const fixture = await setup({
      privateStorage: (raw) => delegateStorage(raw, {
        createBytes: async (input, context) => {
          if (input.appProperties?.nxtPublicationOperation !== undefined && ++snapshotCreates === 1) {
            throw new Error("injected snapshot write failure");
          }
          return raw.createBytes(input, context);
        }
      })
    });
    const opened = await fixture.vault.getNote(noteId);
    await expect(fixture.service.publish({ noteId, expectedVersion: opened.version }))
      .rejects.toThrow("The service is temporarily unavailable.");

    const manifest = (await fixture.manifestStore.read()).value;
    expect(manifest.entries).toEqual([]);
    expect(manifest.cleanup.length).toBeLessThanOrEqual(64);
    expect(manifest.operations).toEqual([]);
  });

  it("refuses new snapshot work when every bounded cleanup slot is already reserved", async () => {
    const fixture = await setup();
    const cleanup = Array.from({ length: 64 }, (_, index) => ({
      cleanupId: Buffer.from(Uint8Array.from({ length: 16 }, (_value, offset) => offset === 15 ? index : 0)).toString("base64url"),
      publicId: "Q".repeat(22),
      folderId: `missing-cleanup-${index}`,
      expectedVersion: "1",
      marker: `pm1.${"Q".repeat(22)}.revision`,
      kind: "revision" as const,
      queuedAt: "2026-08-24T11:00:00.000Z"
    }));
    await fixture.manifestStore.compareAndSet((manifest) => ({ ...manifest, cleanup }));

    await expect(publishCurrent(fixture)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await fixture.privateStorage.listChildren({ parentId: fixture.ids.published.id, pageSize: 100 })).files).toEqual([]);
    expect((await fixture.manifestStore.read()).value.cleanup).toHaveLength(64);
  });

  it("keeps the anonymous reader dark until the final manifest commit", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const createdNote = new Promise<void>((resolve) => { entered = resolve; });
    let paused = false;
    const fixture = await setup({
      privateStorage: (raw) => delegateStorage(raw, {
        createBytes: async (input, context) => {
          const created = await raw.createBytes(input, context);
          if (!paused && input.appProperties?.nxtPublicationKind === "note") {
            paused = true;
            entered();
            await gate;
          }
          return created;
        }
      })
    });
    const opened = await fixture.vault.getNote(noteId);
    const publishing = fixture.service.publish({ noteId, expectedVersion: opened.version });
    await createdNote;
    const operation = (await fixture.manifestStore.read()).value.operations[0];
    if (operation === undefined) throw new Error("missing in-flight publication");
    expect(await fixture.reader.getNote(operation.publicId)).toBeNull();
    release();
    await expect(publishing).resolves.toMatchObject({ publicId: operation.publicId });
  });

  it("recovers an accepted final manifest write whose acknowledgement readback was lost", async () => {
    let loseNextRead = false;
    const fixture = await setup({
      privateStorage: (raw, ids) => delegateStorage(raw, {
        updateText: async (input, context) => {
          const updated = await raw.updateText(input, context);
          if (input.fileId === ids.manifestId) {
            const value = JSON.parse(input.text) as { entries?: unknown[]; operations?: unknown[] };
            if (value.entries?.length === 1 && value.operations?.length === 0) loseNextRead = true;
          }
          return updated;
        },
        readText: async (fileId, context) => {
          if (fileId === ids.manifestId && loseNextRead) {
            loseNextRead = false;
            throw new Error("lost accepted manifest readback");
          }
          return raw.readText(fileId, context);
        }
      })
    });
    const result = await publishCurrent(fixture);
    await expect(fixture.reader.getNote(result.publicId)).resolves.toMatchObject({ title: "Share me" });
    expect((await fixture.manifestStore.read()).value.cleanup).toEqual([]);
  });

  it("copies only exact referenced indexed assets and never serves a raw or unallowlisted ID", async () => {
    const fixture = await setup({ source: sourceFor("Assets", `![included](../../_assets/${noteId}/included.png)`) });
    const included = await fixture.attachments.upload({ noteId, name: "included.png", declaredMime: "image/png", bytes: png });
    const unrelated = await fixture.attachments.upload({ noteId, name: "unrelated.png", declaredMime: "image/png", bytes: png });
    const result = await publishCurrent(fixture);
    const note = await fixture.reader.getNote(result.publicId);
    expect(note?.assets).toHaveLength(1);
    expect(note?.assets[0]).toMatchObject({ name: "included.png", disposition: "inline" });
    expect(note?.assets[0]?.url).toBe(`/api/public/assets/${result.publicId}/${note.assets[0]?.assetId}`);
    expect(note?.html).toContain(`src="${note?.assets[0]?.url}"`);
    expect(note?.html).not.toMatch(/_assets|private\/attachments|018f47d2/iu);
    await expect(fixture.reader.getAsset(result.publicId, unrelated.driveId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(fixture.reader.getAsset(result.publicId, included.driveId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(fixture.reader.getAsset(result.publicId, "A".repeat(22))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a preexisting public asset URL that is not part of this snapshot allowlist", async () => {
    const fixture = await setup({ source: sourceFor("Probe", `![probe](/api/public/assets/${"A".repeat(22)}/${"B".repeat(22)})`) });
    await expect(publishCurrent(fixture)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect((await fixture.manifestStore.read()).value.entries).toEqual([]);
  });

  it("publishes legacy WebP bytes only as a fresh verified download", async () => {
    const fixture = await setup({ source: sourceFor("WebP", `![legacy](../../_assets/${noteId}/legacy.webp)`) });
    const uploaded = await fixture.attachments.upload({ noteId, name: "legacy.webp", declaredMime: "image/webp", bytes: webp });
    await fixture.indexStore.compareAndSet((index) => ({
      ...index,
      entries: index.entries.map((entry) => entry.id === noteId
        ? { ...entry, attachments: entry.attachments.map((asset) => asset.driveId === uploaded.driveId ? { ...asset, disposition: "inline" as const } : asset) }
        : entry)
    }));

    const result = await publishCurrent(fixture);
    const note = await fixture.reader.getNote(result.publicId);
    expect(note?.assets[0]?.disposition).toBe("download");
    const delivery = await fixture.reader.getAsset(result.publicId, note?.assets[0]?.assetId ?? "");
    expect(delivery).toMatchObject({ name: "legacy.webp", mimeType: "image/webp", disposition: "download" });
  });

  it("safely downgrades a legacy inline WebP projection while reading a snapshot", async () => {
    const fixture = await setup({ source: sourceFor("WebP", `![legacy](../../_assets/${noteId}/legacy.webp)`) });
    await fixture.attachments.upload({ noteId, name: "legacy.webp", declaredMime: "image/webp", bytes: webp });
    const result = await publishCurrent(fixture);
    const before = (await fixture.manifestStore.read()).value;
    const entry = before.entries[0];
    const revision = entry?.revisions.find((candidate) => candidate.revisionId === entry.activeRevisionId);
    if (entry === undefined || revision === undefined || revision.assets[0] === undefined) throw new Error("missing legacy projection fixture");
    const noteReadback = await fixture.privateStorage.readText(revision.noteSnapshotDriveId);
    const projection = JSON.parse(noteReadback.text) as { assets: Array<{ disposition: "inline" | "download" }> };
    projection.assets[0]!.disposition = "inline";
    const changedNote = `${JSON.stringify(projection, null, 2)}\n`;
    const changed = await fixture.privateStorage.updateText({
      fileId: revision.noteSnapshotDriveId,
      expectedVersion: noteReadback.file.version,
      mimeType: "application/json",
      text: changedNote
    });
    await fixture.manifestStore.compareAndSet((manifest) => ({
      ...manifest,
      entries: manifest.entries.map((candidate) => candidate.publicId !== result.publicId ? candidate : {
        ...candidate,
        revisions: candidate.revisions.map((item) => item.revisionId !== candidate.activeRevisionId ? item : {
          ...item,
          noteVersion: changed.version,
          noteChecksum: createHash("sha256").update(changedNote).digest("hex"),
          noteSize: new TextEncoder().encode(changedNote).byteLength,
          assets: item.assets.map((asset) => ({ ...asset, disposition: "inline" as const }))
        })
      })
    }));

    expect((await fixture.reader.getNote(result.publicId))?.assets[0]?.disposition).toBe("download");
    await expect(fixture.reader.getAsset(result.publicId, revision.assets[0].assetId)).resolves.toMatchObject({ disposition: "download" });
  });

  it("republishes under one stable public ID without mutating the prior revision", async () => {
    const fixture = await setup();
    const first = await publishCurrent(fixture);
    const firstManifest = (await fixture.manifestStore.read()).value;
    const firstRevision = firstManifest.entries[0]?.revisions.find((revision) => revision.revisionId === firstManifest.entries[0]?.activeRevisionId);
    if (firstRevision === undefined) throw new Error("missing first revision");
    const firstBytes = await fixture.privateStorage.readBytes(firstRevision.noteSnapshotDriveId);

    const opened = await fixture.vault.getNote(noteId);
    const updatedSource = sourceFor("Share me again", "# Changed\n");
    const updated = await fixture.vault.updateNote({ noteId, expectedVersion: opened.version, source: updatedSource });
    const second = await fixture.service.publish({ noteId, expectedVersion: updated.version });
    const manifest = (await fixture.manifestStore.read()).value;
    expect(second.publicId).toBe(first.publicId);
    expect(manifest.entries[0]?.revisions).toHaveLength(2);
    expect(manifest.entries[0]?.activeRevisionId).not.toBe(firstRevision.revisionId);
    expect(await fixture.privateStorage.readBytes(firstRevision.noteSnapshotDriveId)).toMatchObject({ checksum: firstBytes.checksum });
    expect((await fixture.reader.getNote(first.publicId))?.title).toBe("Share me again");
  });

  it("revokes the manifest first and keeps the URL revoked when conditional Trash is ambiguous", async () => {
    let failTrash = false;
    const fixture = await setup({
      privateStorage: (raw) => delegateStorage(raw, {
        trash: async (input, context) => {
          if (failTrash) throw new StorageMutationOutcomeUnknownError(input.fileId);
          return raw.trash(input, context);
        }
      })
    });
    const publication = await publishCurrent(fixture);
    failTrash = true;
    await expect(fixture.service.revoke({ publicId: publication.publicId })).resolves.toEqual({ revoked: true });
    expect(await fixture.reader.getNote(publication.publicId)).toBeNull();
    const manifest = (await fixture.manifestStore.read()).value;
    expect(manifest.entries).toEqual([]);
    expect(manifest.tombstones[0]?.publicId).toBe(publication.publicId);
    expect(manifest.cleanup.length).toBeGreaterThan(0);
  });

  it("makes the public URL dark before a successful snapshot Trash can finish", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const trashStarted = new Promise<void>((resolve) => { entered = resolve; });
    let paused = false;
    const fixture = await setup({
      privateStorage: (raw) => delegateStorage(raw, {
        trash: async (input, context) => {
          const target = await raw.get(input.fileId, context);
          if (!paused && target.appProperties?.nxtPublicationKind === "revision") {
            paused = true;
            entered();
            await gate;
          }
          return raw.trash(input, context);
        }
      })
    });
    const publication = await publishCurrent(fixture);
    const manifest = (await fixture.manifestStore.read()).value;
    const entry = manifest.entries[0];
    const revision = entry?.revisions.find((candidate) => candidate.revisionId === entry.activeRevisionId);
    if (revision === undefined) throw new Error("missing revoke-first fixture");
    const revoking = fixture.service.revoke({ publicId: publication.publicId });
    await trashStarted;
    expect(await fixture.reader.getNote(publication.publicId)).toBeNull();
    expect((await fixture.manifestStore.read()).value.entries).toEqual([]);
    expect(await fixture.raw.get(revision.snapshotFolderId)).toMatchObject({ trashed: false });
    release();
    await expect(revoking).resolves.toEqual({ revoked: true });
    expect(await fixture.raw.get(revision.snapshotFolderId)).toMatchObject({ trashed: true });
  });

  it("never trashes a cleanup target whose exact queued version changed", async () => {
    let failTrash = true;
    const fixture = await setup({
      privateStorage: (raw) => delegateStorage(raw, {
        trash: async (input, context) => {
          if (failTrash) throw new StorageMutationOutcomeUnknownError(input.fileId);
          return raw.trash(input, context);
        }
      })
    });
    const publication = await publishCurrent(fixture);
    await fixture.service.revoke({ publicId: publication.publicId });
    const queued = (await fixture.manifestStore.read()).value.cleanup[0];
    if (queued === undefined) throw new Error("missing cleanup fence");
    const folder = await fixture.raw.get(queued.folderId);
    const changed = await fixture.raw.move({
      fileId: folder.id,
      fromParentId: folder.parentIds[0]!,
      toParentId: folder.parentIds[0]!,
      newName: `${folder.name}-changed`,
      expectedVersion: folder.version
    });
    failTrash = false;

    await fixture.service.revoke({ publicId: publication.publicId });
    expect(await fixture.raw.get(changed.id)).toMatchObject({ trashed: false, version: changed.version });
    expect((await fixture.manifestStore.read()).value.cleanup).toContainEqual(expect.objectContaining({ cleanupId: queued.cleanupId }));
  });

  it("fails public reads closed for corrupt manifests and wrong snapshot ancestry", async () => {
    const fixture = await setup();
    const publication = await publishCurrent(fixture);
    const manifest = (await fixture.manifestStore.read()).value;
    const revision = manifest.entries[0]?.revisions.find((candidate) => candidate.revisionId === manifest.entries[0]?.activeRevisionId);
    if (revision === undefined) throw new Error("missing active revision");
    const holding = await fixture.raw.createFolder({ parentId: "private", name: "holding" });
    const folder = await fixture.raw.get(revision.snapshotFolderId);
    await fixture.raw.move({ fileId: folder.id, fromParentId: folder.parentIds[0]!, toParentId: holding.id, expectedVersion: folder.version });
    expect(await fixture.reader.getNote(publication.publicId)).toBeNull();

    const manifestFile = await fixture.raw.get(fixture.ids.manifestFile.id);
    await fixture.raw.updateText({ fileId: manifestFile.id, expectedVersion: manifestFile.version, mimeType: "application/json", text: "{broken" });
    expect(await fixture.reader.getNote(publication.publicId)).toBeNull();
    await expect(fixture.reader.getAsset(publication.publicId, "A".repeat(22))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("recovers a marker-owned ambiguous folder create without adopting lookalikes", async () => {
    let inject = true;
    const fixture = await setup({
      privateStorage: (raw) => delegateStorage(raw, {
        createFolder: async (input, context) => {
          const created = await raw.createFolder(input, context);
          if (inject && input.appProperties?.nxtPublicationKind === "revision") {
            inject = false;
            throw new StorageMutationOutcomeUnknownError(created.id);
          }
          return created;
        }
      })
    });
    await expect(publishCurrent(fixture)).resolves.toMatchObject({ publicId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/u) });
  });

  it("fences and recovers a stale persisted operation after a restart", async () => {
    const fixture = await setup();
    const source = await fixture.vault.getNote(noteId);
    const publicId = "R".repeat(22);
    const oldOperationId = "S".repeat(22);
    const publicMarker = `pm1.${publicId}.public`;
    const revisionMarker = `pm1.${oldOperationId}.revision`;
    const publicFolder = await fixture.raw.createFolder({
      parentId: fixture.ids.published.id,
      name: publicId,
      appProperties: {
        nxtPublicationMarker: publicMarker,
        nxtPublicationKind: "public",
        nxtPublicationPublicId: publicId
      }
    });
    const staleRevision = await fixture.raw.createFolder({
      parentId: publicFolder.id,
      name: "v-stale",
      appProperties: {
        nxtPublicationMarker: revisionMarker,
        nxtPublicationKind: "revision",
        nxtPublicationPublicId: publicId,
        nxtPublicationOperation: oldOperationId
      }
    });
    await fixture.manifestStore.compareAndSet((manifest) => ({
      ...manifest,
      operations: [{
        operationId: oldOperationId,
        publicId,
        sourceNoteId: noteId,
        epoch: 1,
        startedAt: "2026-08-24T11:00:00.000Z",
        sourceVersion: source.version,
        sourceChecksum: source.checksum,
        sourcePath: source.path,
        publicFolderId: publicFolder.id,
        publicFolderVersion: publicFolder.version,
        revisionFolderId: staleRevision.id,
        revisionFolderVersion: staleRevision.version,
        revisionId: staleRevision.name,
        revisionMarker
      }]
    }));

    const result = await fixture.service.publish({ noteId, expectedVersion: source.version });
    expect(result.publicId).toBe(publicId);
    const manifest = (await fixture.manifestStore.read()).value;
    expect(manifest.operations).toEqual([]);
    expect(manifest.entries[0]?.publicId).toBe(publicId);
    expect(manifest.cleanup).toContainEqual(expect.objectContaining({ folderId: staleRevision.id, marker: revisionMarker }));
    expect(await fixture.reader.getNote(publicId)).toMatchObject({ title: "Share me" });
  });

  it("allows only one concurrent publish operation for the same source epoch", async () => {
    const fixture = await setup();
    const opened = await fixture.vault.getNote(noteId);
    const results = await Promise.allSettled([
      fixture.service.publish({ noteId, expectedVersion: opened.version }),
      fixture.service.publish({ noteId, expectedVersion: opened.version })
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await fixture.manifestStore.read()).value.entries).toHaveLength(1);
  });

  it("lets an accepted revoke fence an older in-flight republish", async () => {
    const fixture = await setup({ source: sourceFor("Race", `![race](../../_assets/${noteId}/race.png)`) });
    await fixture.attachments.upload({ noteId, name: "race.png", declaredMime: "image/png", bytes: png });
    const first = await publishCurrent(fixture);
    const opened = await fixture.vault.getNote(noteId);
    const updated = await fixture.vault.updateNote({ noteId, expectedVersion: opened.version, source: sourceFor("Race changed", `![race](../../_assets/${noteId}/race.png)`) });
    let release!: () => void;
    let signal!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { signal = resolve; });
    let paused = false;
    const delayedAttachments = {
      readForNote: async (input: { noteId: string; assetId: string }) => {
        if (!paused) { paused = true; signal(); await gate; }
        return fixture.attachments.readForNote(input);
      }
    };
    const publishing = new PublicationService({
      storage: fixture.privateStorage,
      manifestStore: fixture.manifestStore,
      indexStore: fixture.indexStore,
      vault: fixture.vault,
      attachments: delayedAttachments,
      privateRootId: "private",
      publishedRootId: fixture.ids.published.id,
      now: () => new Date("2026-08-24T12:01:00.000Z")
    });
    const republish = publishing.publish({ noteId, expectedVersion: updated.version });
    await entered;
    await fixture.service.revoke({ publicId: first.publicId });
    release();
    await expect(republish).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await fixture.reader.getNote(first.publicId)).toBeNull();
  });

  it("uses exact checksums for every copied immutable byte sequence", async () => {
    const fixture = await setup();
    await publishCurrent(fixture);
    const manifest = (await fixture.manifestStore.read()).value;
    const entry = manifest.entries[0];
    const revision = entry?.revisions.find((candidate) => candidate.revisionId === entry.activeRevisionId);
    if (revision === undefined) throw new Error("missing checksum revision");
    const readback = await fixture.privateStorage.readBytes(revision.noteSnapshotDriveId);
    expect(readback.checksum).toBe(createHash("sha256").update(readback.bytes).digest("hex"));
    expect(readback.checksum).toBe(revision.noteChecksum);
  });
});
