import { createHash, randomBytes } from "node:crypto";
import {
  NoteIdSchema,
  MAX_PUBLICATION_ASSETS,
  MAX_PUBLICATION_TOTAL_ASSET_BYTES,
  PublicIdSchema,
  PublicNoteResponseSchema,
  type PublicationAsset,
  type PublicationManifest,
  type PublicationRevision,
  type PublicNoteResponse,
  type VaultAttachment,
  type VaultIndex
} from "@nxt/contracts";
import {
  attachmentReferenceProjection,
  canonicalAttachmentReference,
  projectionReferencesAttachment,
  renderMarkdown
} from "@nxt/domain";
import { ApiResponseError } from "../http/api-response.js";
import {
  StorageMutationOutcomeUnknownError,
  StorageOperationBudget,
  StorageOperationBudgetExceededError,
  StorageVersionConflictError,
  type StorageOperationContext,
  type StoragePort,
  type StoredFile
} from "../storage/storage-port.js";
import {
  MAX_ATTACHMENT_BYTES,
  detectAttachment,
  safeAttachmentDisposition,
  type AttachmentDisposition
} from "./attachment-policy.js";
import type { AttachmentDelivery, AttachmentService } from "./attachment-service.js";
import { preserveApiError, type SystemFileStore } from "./system-file-store.js";
import type { VaultNoteResult, VaultService } from "./vault-service.js";

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const SHORTCUT_MIME_TYPE = "application/vnd.google-apps.shortcut";
const JSON_MIME_TYPE = "application/json";
const MAX_MANIFEST_OPERATIONS = 64;
const MAX_CLEANUP_RECORDS = 64;
const MAX_CLEANUPS_PER_REQUEST = 4;
const MAX_CHILDREN_PER_FOLDER = 100;
const MAX_REVISION_COLLISIONS = 16;
const MAX_RANDOM_ID_COLLISIONS = 16;
const MAX_STORAGE_OPERATIONS = 900;
const MAX_NOTE_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const OPERATION_RECOVERY_AFTER_MS = 5 * 60 * 1000;
const PRIVATE_ATTACHMENT_PREFIX = "/api/private/attachments/";
const PUBLIC_ATTACHMENT_PREFIX = "/api/public/assets/";
const PATH_ATTACHMENT = /^_assets\/([^/]+)\/(.+)$/u;

type ManifestOperation = PublicationManifest["operations"][number];
type ManifestCleanup = PublicationManifest["cleanup"][number];
type ManifestEntry = PublicationManifest["entries"][number];
type ManifestTombstone = PublicationManifest["tombstones"][number];
type IndexedAsset = { noteId: string; attachment: VaultAttachment };

export interface PublicationResult {
  publicId: string;
  publishedAt: string;
}

export type PublicAssetDelivery = AttachmentDelivery;

interface PreparedAsset {
  assetId: string;
  sourceNoteId: string;
  sourceDriveId: string;
  bytes: Uint8Array;
  name: string;
  mimeType: string;
  disposition: AttachmentDisposition;
  checksum: string;
}

interface PreparedAssets {
  assets: PreparedAsset[];
  byReference: ReadonlyMap<string, PreparedAsset>;
}

interface CreatedFolder {
  file: StoredFile;
  marker: string;
  created: boolean;
}

interface SnapshotArtifact {
  revision: PublicationRevision;
  publicFolder: StoredFile;
}

type PublicationOwner = Pick<VaultService, "getNote">;
type PublicationAttachments = Pick<AttachmentService, "readForNote">;

export class PublicationService {
  private readonly reader: PublicPublicationReader;

  public constructor(private readonly options: {
    storage: StoragePort;
    manifestStore: SystemFileStore<PublicationManifest>;
    indexStore: SystemFileStore<VaultIndex>;
    vault: PublicationOwner;
    attachments: PublicationAttachments;
    privateRootId: string;
    publishedRootId: string;
    decodeAttachmentId?: (opaqueId: string) => string;
    now?: () => Date;
    createId?: () => string;
  }) {
    this.reader = new PublicPublicationReader({
      storage: options.storage,
      manifestStore: options.manifestStore,
      privateRootId: options.privateRootId,
      publishedRootId: options.publishedRootId
    });
  }

  public async publish(input: { noteId: string; expectedVersion: string }): Promise<PublicationResult> {
    this.assertNoteId(input.noteId);
    this.assertVersion(input.expectedVersion);
    const context = this.context();
    await this.processCleanup(context);
    const source = await this.options.vault.getNote(input.noteId).catch((error) => { throw preserveApiError(error, "DRIVE_UNAVAILABLE"); });
    this.assertExpectedSource(source, input.expectedVersion);
    const operation = await this.reservePublish(source, context);
    let orphan: { folderId: string; version: string; marker: string; kind: "revision" } | undefined;
    try {
      const manifest = await this.options.manifestStore.read(context);
      const reserved = manifest.value.operations.find((candidate) => candidate.operationId === operation.operationId);
      if (reserved === undefined || !sameOperationSource(reserved, operation)) throw new ApiResponseError("CONFLICT");
      const index = await this.options.indexStore.read(context);
      const prepared = await this.prepareAssets(source, index.value, manifestIdentifierSet(manifest.value));
      const rendered = await renderMarkdown(source.source, {
        rewriteUrl: (value) => {
          if (value.startsWith(PUBLIC_ATTACHMENT_PREFIX)) throw new ApiResponseError("INVALID_INPUT");
          const reference = canonicalAttachmentReference(value, source.path);
          if (reference === undefined) return value;
          const asset = prepared.byReference.get(reference);
          if (asset === undefined) throw new ApiResponseError("NOT_FOUND");
          return `/api/public/assets/${operation.publicId}/${asset.assetId}`;
        }
      });
      const publishedRoot = await this.verifyPublishedRoot(context);
      const publicFolder = await this.ensurePublicFolder(operation, publishedRoot, context);
      let activeOperation = await this.persistOperationFolder(operation, publicFolder.file, context);
      const revisionId = activeOperation.revisionId ?? await this.chooseRevisionId(publicFolder.file.id, source.version, context);
      const revisionMarker = activeOperation.revisionMarker ?? publicationMarker(activeOperation.operationId, "revision");
      activeOperation = await this.persistOperationRevisionName(activeOperation, revisionId, revisionMarker, context);
      const revisionFolder = await this.ensureOwnedFolder({
        parentId: publicFolder.file.id,
        name: revisionId,
        marker: revisionMarker,
        kind: "revision",
        publicId: activeOperation.publicId,
        operationId: activeOperation.operationId,
        context
      });
      orphan = { folderId: revisionFolder.file.id, version: revisionFolder.file.version, marker: revisionMarker, kind: "revision" };
      activeOperation = await this.persistOperationRevisionFolder(activeOperation, revisionFolder.file, context);
      const snapshot = await this.writeSnapshot({
        operation: activeOperation,
        source,
        renderedHtml: rendered.html,
        assets: prepared.assets,
        publicFolder: publicFolder.file,
        revisionFolder: revisionFolder.file,
        revisionMarker,
        context
      });
      await this.assertSourceStillCurrent(source);
      const result = await this.commitPublication(activeOperation, snapshot, context);
      orphan = undefined;
      return result;
    } catch (error) {
      await this.abandonOperation(operation.operationId, operation.publicId, orphan).catch(() => undefined);
      throw toPrivateApiError(error);
    }
  }

  public async revoke(input: { publicId: string }): Promise<{ revoked: true }> {
    this.assertPublicId(input.publicId);
    const context = this.context();
    await this.processCleanup(context);
    const now = this.now().toISOString();
    const cleanupCandidates = Array.from({ length: MAX_RANDOM_ID_COLLISIONS }, () => this.id());
    try {
      await this.options.manifestStore.compareAndSet((manifest) => {
        const entry = manifest.entries.find((candidate) => candidate.publicId === input.publicId);
        if (entry === undefined) {
          if (manifest.tombstones.some((candidate) => candidate.publicId === input.publicId)) return manifest;
          throw new ApiResponseError("NOT_FOUND");
        }
        const active = activeRevision(entry);
        const relatedOperations = manifest.operations.filter((operation) => operation.publicId === input.publicId);
        const usedIds = manifestIdentifierSet(manifest);
        const cleanupId = cleanupCandidates.find((candidate) => !usedIds.has(candidate));
        if (cleanupId === undefined) throw new ApiResponseError("CONFLICT");
        const epoch = Math.max(entry.epoch, ...relatedOperations.map((operation) => operation.epoch)) + 1;
        const tombstone: ManifestTombstone = {
          publicId: entry.publicId,
          sourceNoteId: entry.sourceNoteId,
          epoch,
          publicFolderId: entry.publicFolderId,
          publicFolderVersion: entry.publicFolderVersion,
          revokedAt: now
        };
        const cleanup: ManifestCleanup = {
          cleanupId,
          publicId: entry.publicId,
          folderId: active.snapshotFolderId,
          expectedVersion: active.snapshotFolderVersion,
          marker: active.snapshotMarker,
          kind: "revision",
          queuedAt: now
        };
        const queued = [...manifest.cleanup, cleanup, ...relatedOperations.flatMap((operation) => cleanupForOperation(operation, now, operation.operationId))];
        return bumpManifest(manifest, {
          entries: manifest.entries.filter((candidate) => candidate.publicId !== input.publicId),
          tombstones: [...manifest.tombstones.filter((candidate) => candidate.publicId !== input.publicId && candidate.sourceNoteId !== entry.sourceNoteId), tombstone],
          operations: manifest.operations.filter((operation) => operation.publicId !== input.publicId),
          cleanup: boundedCleanup(queued)
        });
      }, { context });
    } catch (error) {
      const recovered = await this.options.manifestStore.read(context).catch(() => undefined);
      if (
        recovered === undefined || recovered.value.entries.some((entry) => entry.publicId === input.publicId) ||
        !recovered.value.tombstones.some((entry) => entry.publicId === input.publicId)
      ) throw toPrivateApiError(error);
    }
    if (await this.reader.getNote(input.publicId) !== null) throw new ApiResponseError("DRIVE_UNAVAILABLE");
    await this.processCleanup(context);
    return { revoked: true };
  }

  private async reservePublish(source: VaultNoteResult, context: StorageOperationContext): Promise<ManifestOperation> {
    const candidateIds = Array.from({ length: MAX_RANDOM_ID_COLLISIONS * 3 }, () => this.id());
    const startedAt = this.now().toISOString();
    let operationId: string | undefined;
    let proposed: ManifestOperation | undefined;
    try {
      const committed = await this.options.manifestStore.compareAndSet((manifest) => {
        const stale = manifest.operations.find((operation) => operation.sourceNoteId === source.note.frontmatter.id);
        if (stale !== undefined && !operationCanBeRecovered(stale, startedAt)) throw new ApiResponseError("CONFLICT");
        const active = manifest.entries.find((entry) => entry.sourceNoteId === source.note.frontmatter.id);
        const tombstone = manifest.tombstones.find((entry) => entry.sourceNoteId === source.note.frontmatter.id);
        const previous = active ?? tombstone;
        const usedIds = manifestIdentifierSet(manifest);
        operationId = candidateIds.find((candidate) => !usedIds.has(candidate));
        if (operationId === undefined) throw new ApiResponseError("CONFLICT");
        usedIds.add(operationId);
        const publicId = previous?.publicId ?? stale?.publicId ?? candidateIds.find((candidate) => !usedIds.has(candidate));
        if (publicId === undefined) throw new ApiResponseError("CONFLICT");
        if (manifest.operations.some((operation) => operation.publicId === publicId && operation.sourceNoteId !== source.note.frontmatter.id)) throw new ApiResponseError("CONFLICT");
        usedIds.add(publicId);
        const cleanupId = candidateIds.find((candidate) => !usedIds.has(candidate));
        const staleNeedsCleanup = stale?.revisionFolderId !== null && stale?.revisionFolderId !== undefined &&
          stale.revisionFolderVersion !== null && stale.revisionMarker !== null;
        if (staleNeedsCleanup && cleanupId === undefined) throw new ApiResponseError("CONFLICT");
        const staleCleanup = stale === undefined || cleanupId === undefined ? [] : cleanupForOperation(stale, startedAt, cleanupId);
        const remainingOperations = manifest.operations.filter((operation) => operation.operationId !== stale?.operationId);
        if (
          remainingOperations.length + 1 > MAX_MANIFEST_OPERATIONS ||
          manifest.cleanup.length + staleCleanup.length > MAX_CLEANUP_RECORDS ||
          remainingOperations.length + 1 + manifest.cleanup.length + staleCleanup.length > MAX_CLEANUP_RECORDS
        ) throw new ApiResponseError("CONFLICT");
        proposed = {
          operationId,
          publicId,
          sourceNoteId: source.note.frontmatter.id,
          epoch: Math.max(previous?.epoch ?? 0, (stale?.epoch ?? 1) - 1) + 1,
          startedAt,
          sourceVersion: source.version,
          sourceChecksum: source.checksum,
          sourcePath: source.path,
          publicFolderId: previous?.publicFolderId ?? stale?.publicFolderId ?? null,
          publicFolderVersion: previous?.publicFolderVersion ?? stale?.publicFolderVersion ?? null,
          revisionFolderId: null,
          revisionFolderVersion: null,
          revisionId: null,
          revisionMarker: null
        };
        return bumpManifest(manifest, {
          operations: [...remainingOperations, proposed],
          cleanup: [...manifest.cleanup, ...staleCleanup]
        });
      }, { context });
      if (operationId === undefined) throw new ApiResponseError("CONFLICT");
      const operation = committed.value.operations.find((candidate) => candidate.operationId === operationId);
      if (operation === undefined) throw new ApiResponseError("CONFLICT");
      return operation;
    } catch (error) {
      const recovered = await this.options.manifestStore.read(context).catch(() => undefined);
      const operation = recovered?.value.operations.find((candidate) => candidate.operationId === operationId);
      if (operation !== undefined && proposed !== undefined && sameOperationSource(operation, proposed)) return operation;
      throw toPrivateApiError(error);
    }
  }

  private async ensurePublicFolder(operation: ManifestOperation, publishedRoot: StoredFile, context: StorageOperationContext): Promise<CreatedFolder> {
    const marker = publicationMarker(operation.publicId, "public");
    if (operation.publicFolderId !== null) {
      const file = await this.options.storage.get(operation.publicFolderId, context);
      this.assertFolder(file, publishedRoot.id, operation.publicId, marker, "public", operation.publicId);
      if (operation.publicFolderVersion !== null && operation.publicFolderVersion !== file.version) throw new ApiResponseError("CONFLICT");
      const exact = await this.exactChildren(publishedRoot.id, operation.publicId, context);
      if (exact.length !== 1 || exact[0]?.id !== file.id) throw new ApiResponseError("CONFLICT");
      return { file, marker, created: false };
    }
    return this.ensureOwnedFolder({
      parentId: publishedRoot.id,
      name: operation.publicId,
      marker,
      kind: "public",
      publicId: operation.publicId,
      operationId: operation.operationId,
      context
    });
  }

  private async ensureOwnedFolder(input: {
    parentId: string;
    name: string;
    marker: string;
    kind: "public" | "revision" | "assets";
    publicId: string;
    operationId: string;
    context: StorageOperationContext;
  }): Promise<CreatedFolder> {
    const existing = await this.exactChildren(input.parentId, input.name, input.context);
    const owned = existing.filter((file) => markerMatches(file, input.marker, input.kind, input.publicId, input.kind === "public" ? undefined : input.operationId));
    if (owned.length === 1 && existing.length === 1) {
      const file = await this.options.storage.get((owned[0] as StoredFile).id, input.context);
      this.assertFolder(file, input.parentId, input.name, input.marker, input.kind, input.publicId, input.kind === "public" ? undefined : input.operationId);
      return { file, marker: input.marker, created: false };
    }
    if (existing.length !== 0) throw new ApiResponseError("CONFLICT");
    const appProperties = publicationProperties(input.marker, input.kind, input.publicId, input.kind === "public" ? undefined : input.operationId);
    let createdId: string | undefined;
    let createdVersion: string | undefined;
    let outcomeUnknown: StorageMutationOutcomeUnknownError | undefined;
    try {
      const created = await this.options.storage.createFolder({ parentId: input.parentId, name: input.name, appProperties }, input.context);
      createdId = created.id;
      createdVersion = created.version;
    } catch (error) {
      if (!(error instanceof StorageMutationOutcomeUnknownError)) throw error;
      outcomeUnknown = error;
      createdId = error.fileId;
    }
    const recovered = await this.exactChildren(input.parentId, input.name, input.context);
    if (recovered.length !== 1) {
      if (recovered.length === 0) throw outcomeUnknown ?? new ApiResponseError("DRIVE_UNAVAILABLE");
      throw new ApiResponseError("CONFLICT");
    }
    const candidate = recovered[0] as StoredFile;
    if (createdId !== undefined && candidate.id !== createdId) throw new ApiResponseError("CONFLICT");
    const file = await this.options.storage.get(candidate.id, input.context);
    this.assertFolder(file, input.parentId, input.name, input.marker, input.kind, input.publicId, input.kind === "public" ? undefined : input.operationId);
    if (createdVersion !== undefined && file.version !== createdVersion) throw new ApiResponseError("DRIVE_UNAVAILABLE");
    return { file, marker: input.marker, created: true };
  }

  private async chooseRevisionId(publicFolderId: string, sourceVersion: string, context: StorageOperationContext): Promise<string> {
    const base = `v-${createHash("sha256").update(sourceVersion, "utf8").digest("base64url").slice(0, 16)}`;
    const page = await this.options.storage.listChildren({ parentId: publicFolderId, pageSize: MAX_CHILDREN_PER_FOLDER }, context);
    if (page.nextPageToken !== undefined) throw new ApiResponseError("CONFLICT");
    const names = new Set(page.files.map((file) => file.name));
    for (let collision = 1; collision <= MAX_REVISION_COLLISIONS; collision += 1) {
      const candidate = collision === 1 ? base : `${base}-${collision}`;
      if (!names.has(candidate)) return candidate;
    }
    throw new ApiResponseError("CONFLICT");
  }

  private async prepareAssets(source: VaultNoteResult, index: VaultIndex, forbiddenIds: ReadonlySet<string>): Promise<PreparedAssets> {
    const owner = index.entries.find((entry) => entry.id === source.note.frontmatter.id);
    if (
      owner === undefined || owner.driveId !== source.driveId || owner.driveVersion !== source.version || owner.path !== source.path ||
      index.pendingMutations.some((mutation) => mutation.noteId === source.note.frontmatter.id)
    ) throw new ApiResponseError("CONFLICT");
    const references = attachmentReferenceProjection(source.source, source.path);
    if (references.length > MAX_PUBLICATION_ASSETS) throw new ApiResponseError("TOO_LARGE");
    const resolved = new Map<string, IndexedAsset>();
    const referenceDriveIds = new Map<string, string>();
    for (const reference of references) {
      const indexed = this.resolveIndexedAsset(reference, index);
      if (indexed === undefined) throw new ApiResponseError("NOT_FOUND");
      resolved.set(indexed.attachment.driveId, indexed);
      referenceDriveIds.set(reference, indexed.attachment.driveId);
    }
    const prepared: PreparedAsset[] = [];
    const assetIds = new Set(forbiddenIds);
    let totalBytes = 0;
    for (const indexed of resolved.values()) {
      const delivery = await this.options.attachments.readForNote({ noteId: indexed.noteId, assetId: indexed.attachment.driveId });
      if (delivery.bytes.byteLength > MAX_ATTACHMENT_BYTES || delivery.name !== indexed.attachment.name || delivery.mimeType !== indexed.attachment.mimeType) {
        throw new ApiResponseError("DRIVE_UNAVAILABLE");
      }
      totalBytes += delivery.bytes.byteLength;
      if (totalBytes > MAX_PUBLICATION_TOTAL_ASSET_BYTES) throw new ApiResponseError("TOO_LARGE");
      let assetId: string | undefined;
      for (let collision = 0; collision < MAX_RANDOM_ID_COLLISIONS; collision += 1) {
        const candidate = this.id();
        if (!assetIds.has(candidate)) { assetId = candidate; break; }
      }
      if (assetId === undefined) throw new ApiResponseError("CONFLICT");
      assetIds.add(assetId);
      const disposition = safeAttachmentDisposition(indexed.attachment.disposition ?? delivery.disposition, {
        mimeType: delivery.mimeType,
        disposition: delivery.disposition
      });
      prepared.push({
        assetId,
        sourceNoteId: indexed.noteId,
        sourceDriveId: indexed.attachment.driveId,
        bytes: Uint8Array.from(delivery.bytes),
        name: delivery.name,
        mimeType: delivery.mimeType,
        disposition,
        checksum: sha256(delivery.bytes)
      });
    }
    const byDriveId = new Map(prepared.map((asset) => [asset.sourceDriveId, asset]));
    const byReference = new Map<string, PreparedAsset>();
    for (const [reference, driveId] of referenceDriveIds) {
      const asset = byDriveId.get(driveId);
      if (asset === undefined) throw new ApiResponseError("DRIVE_UNAVAILABLE");
      byReference.set(reference, asset);
    }
    return { assets: prepared, byReference };
  }

  private resolveIndexedAsset(reference: string, index: VaultIndex): IndexedAsset | undefined {
    if (reference.startsWith(PRIVATE_ATTACHMENT_PREFIX)) {
      const opaqueId = reference.slice(PRIVATE_ATTACHMENT_PREFIX.length);
      if (this.options.decodeAttachmentId === undefined) return undefined;
      let driveId: string;
      try { driveId = this.options.decodeAttachmentId(opaqueId); } catch { return undefined; }
      const matches = index.entries.flatMap((entry) => entry.attachments
        .filter((attachment) => attachment.driveId === driveId && projectionReferencesAttachment([reference], { noteId: entry.id, name: attachment.name, opaqueId }))
        .map((attachment) => ({ noteId: entry.id, attachment })));
      return matches.length === 1 ? matches[0] : undefined;
    }
    const match = PATH_ATTACHMENT.exec(reference);
    if (match === null) return undefined;
    const [ownerId, name] = [match[1] as string, match[2] as string];
    const owner = index.entries.find((entry) => entry.id === ownerId);
    if (owner === undefined) return undefined;
    const assets = owner.attachments.filter((attachment) => attachment.name.normalize("NFC") === name.normalize("NFC"));
    return assets.length === 1 ? { noteId: owner.id, attachment: assets[0] as VaultAttachment } : undefined;
  }

  private async writeSnapshot(input: {
    operation: ManifestOperation;
    source: VaultNoteResult;
    renderedHtml: string;
    assets: PreparedAsset[];
    publicFolder: StoredFile;
    revisionFolder: StoredFile;
    revisionMarker: string;
    context: StorageOperationContext;
  }): Promise<SnapshotArtifact> {
    const assetsMarker = publicationMarker(input.operation.operationId, "assets");
    const assetsFolder = await this.ensureOwnedFolder({
      parentId: input.revisionFolder.id,
      name: "assets",
      marker: assetsMarker,
      kind: "assets",
      publicId: input.operation.publicId,
      operationId: input.operation.operationId,
      context: input.context
    });
    const copiedAssets: PublicationAsset[] = [];
    for (const asset of input.assets) {
      const marker = publicationMarker(input.operation.operationId, asset.assetId);
      const snapshotName = snapshotAssetName(asset.assetId, asset.name);
      const created = await this.createVerifiedBytes({
        parentId: assetsFolder.file.id,
        name: snapshotName,
        mimeType: asset.mimeType,
        bytes: asset.bytes,
        marker,
        kind: "asset",
        publicId: input.operation.publicId,
        operationId: input.operation.operationId,
        assetId: asset.assetId,
        context: input.context
      });
      copiedAssets.push({
        assetId: asset.assetId,
        snapshotDriveId: created.id,
        mimeType: asset.mimeType,
        fileName: asset.name,
        size: asset.bytes.byteLength,
        checksum: asset.checksum,
        disposition: asset.disposition,
        marker,
        version: created.version
      });
    }
    const publishedAt = this.now().toISOString();
    const noteProjection: PublicNoteResponse = PublicNoteResponseSchema.parse({
      title: input.source.note.frontmatter.title,
      html: input.renderedHtml,
      publishedAt,
      assets: copiedAssets.map((asset) => ({
        assetId: asset.assetId,
        url: `/api/public/assets/${input.operation.publicId}/${asset.assetId}`,
        name: asset.fileName,
        mimeType: asset.mimeType,
        disposition: asset.disposition
      }))
    });
    const noteSource = `${JSON.stringify(noteProjection, null, 2)}\n`;
    const noteBytes = new TextEncoder().encode(noteSource);
    if (noteBytes.byteLength > MAX_NOTE_SNAPSHOT_BYTES) throw new ApiResponseError("TOO_LARGE");
    const noteMarker = publicationMarker(input.operation.operationId, "note");
    const noteFile = await this.createVerifiedBytes({
      parentId: input.revisionFolder.id,
      name: "note.json",
      mimeType: JSON_MIME_TYPE,
      bytes: noteBytes,
      marker: noteMarker,
      kind: "note",
      publicId: input.operation.publicId,
      operationId: input.operation.operationId,
      context: input.context
    });
    const finalPublicFolder = await this.options.storage.get(input.publicFolder.id, input.context);
    const finalRevisionFolder = await this.options.storage.get(input.revisionFolder.id, input.context);
    const finalAssetsFolder = await this.options.storage.get(assetsFolder.file.id, input.context);
    this.assertFolder(finalPublicFolder, this.options.publishedRootId, input.operation.publicId, publicationMarker(input.operation.publicId, "public"), "public", input.operation.publicId);
    this.assertFolder(finalRevisionFolder, finalPublicFolder.id, input.operation.revisionId as string, input.revisionMarker, "revision", input.operation.publicId, input.operation.operationId);
    this.assertFolder(finalAssetsFolder, finalRevisionFolder.id, "assets", assetsMarker, "assets", input.operation.publicId, input.operation.operationId);
    return {
      publicFolder: finalPublicFolder,
      revision: {
        revisionId: input.operation.revisionId as string,
        operationId: input.operation.operationId,
        snapshotFolderId: finalRevisionFolder.id,
        snapshotFolderVersion: finalRevisionFolder.version,
        snapshotMarker: input.revisionMarker,
        assetsFolderId: finalAssetsFolder.id,
        assetsFolderVersion: finalAssetsFolder.version,
        assetsMarker,
        noteSnapshotDriveId: noteFile.id,
        noteVersion: noteFile.version,
        noteChecksum: sha256(noteBytes),
        noteSize: noteBytes.byteLength,
        noteMarker,
        sourceVersion: input.source.version,
        sourceChecksum: input.source.checksum,
        sourcePath: input.source.path,
        publishedAt,
        assets: copiedAssets
      }
    };
  }

  private async createVerifiedBytes(input: {
    parentId: string;
    name: string;
    mimeType: string;
    bytes: Uint8Array;
    marker: string;
    kind: "note" | "asset";
    publicId: string;
    operationId: string;
    assetId?: string;
    context: StorageOperationContext;
  }): Promise<StoredFile> {
    const appProperties = publicationProperties(input.marker, input.kind, input.publicId, input.operationId, input.assetId);
    const existing = await this.exactChildren(input.parentId, input.name, input.context);
    if (existing.length !== 0) {
      if (
        existing.length !== 1 ||
        !markerMatches(existing[0] as StoredFile, input.marker, input.kind, input.publicId, input.operationId, input.assetId)
      ) throw new ApiResponseError("CONFLICT");
      return this.readAndVerifyBytes(input, (existing[0] as StoredFile).id);
    }
    let createdId: string | undefined;
    let outcomeUnknown: StorageMutationOutcomeUnknownError | undefined;
    try {
      const created = await this.options.storage.createBytes({ parentId: input.parentId, name: input.name, mimeType: input.mimeType, bytes: input.bytes, appProperties }, input.context);
      createdId = created.id;
    } catch (error) {
      if (!(error instanceof StorageMutationOutcomeUnknownError)) throw error;
      outcomeUnknown = error;
      createdId = error.fileId;
    }
    const recovered = await this.exactChildren(input.parentId, input.name, input.context);
    if (recovered.length !== 1) {
      if (recovered.length === 0) throw outcomeUnknown ?? new ApiResponseError("DRIVE_UNAVAILABLE");
      throw new ApiResponseError("CONFLICT");
    }
    if (
      !markerMatches(recovered[0] as StoredFile, input.marker, input.kind, input.publicId, input.operationId, input.assetId) ||
      (createdId !== undefined && recovered[0]?.id !== createdId)
    ) throw new ApiResponseError("CONFLICT");
    return this.readAndVerifyBytes(input, (recovered[0] as StoredFile).id);
  }

  private async readAndVerifyBytes(input: {
    parentId: string;
    name: string;
    mimeType: string;
    bytes: Uint8Array;
    marker: string;
    kind: "note" | "asset";
    publicId: string;
    operationId: string;
    assetId?: string;
    context: StorageOperationContext;
  }, fileId: string): Promise<StoredFile> {
    const metadata = await this.options.storage.get(fileId, input.context);
    const readback = await this.options.storage.readBytes(fileId, input.context);
    const expectedChecksum = sha256(input.bytes);
    if (
      metadata.id !== readback.file.id || metadata.version !== readback.file.version || readback.file.id !== fileId ||
      readback.file.trashed || readback.file.mimeType === FOLDER_MIME_TYPE || readback.file.mimeType === SHORTCUT_MIME_TYPE ||
      readback.file.parentIds.length !== 1 || readback.file.parentIds[0] !== input.parentId || readback.file.name !== input.name ||
      readback.file.mimeType !== input.mimeType || readback.file.size !== input.bytes.byteLength || readback.bytes.byteLength !== input.bytes.byteLength ||
      readback.checksum !== expectedChecksum || !equalBytes(readback.bytes, input.bytes) ||
      !markerMatches(readback.file, input.marker, input.kind, input.publicId, input.operationId, input.assetId)
    ) throw new ApiResponseError("DRIVE_UNAVAILABLE");
    return readback.file;
  }

  private async commitPublication(operation: ManifestOperation, snapshot: SnapshotArtifact, context: StorageOperationContext): Promise<PublicationResult> {
    try {
      const committed = await this.options.manifestStore.compareAndSet((manifest) => {
        const currentOperation = manifest.operations.find((candidate) => candidate.operationId === operation.operationId);
        if (currentOperation === undefined || !sameOperationState(currentOperation, operation)) throw new ApiResponseError("CONFLICT");
        const active = manifest.entries.find((entry) => entry.sourceNoteId === operation.sourceNoteId);
        const tombstone = manifest.tombstones.find((entry) => entry.sourceNoteId === operation.sourceNoteId);
        const previous = active ?? tombstone;
        if ((previous?.epoch ?? 0) !== operation.epoch - 1 || (previous !== undefined && previous.publicId !== operation.publicId)) throw new ApiResponseError("CONFLICT");
        const revisions = [...(active?.revisions ?? []), snapshot.revision].slice(-32);
        const entry: ManifestEntry = {
          publicId: operation.publicId,
          sourceNoteId: operation.sourceNoteId,
          epoch: operation.epoch,
          publicFolderId: snapshot.publicFolder.id,
          publicFolderVersion: snapshot.publicFolder.version,
          activeRevisionId: snapshot.revision.revisionId,
          revisions
        };
        return bumpManifest(manifest, {
          entries: [...manifest.entries.filter((candidate) => candidate.sourceNoteId !== operation.sourceNoteId && candidate.publicId !== operation.publicId), entry],
          tombstones: manifest.tombstones.filter((candidate) => candidate.sourceNoteId !== operation.sourceNoteId && candidate.publicId !== operation.publicId),
          operations: manifest.operations.filter((candidate) => candidate.operationId !== operation.operationId)
        });
      }, { context });
      const entry = committed.value.entries.find((candidate) => candidate.publicId === operation.publicId);
      if (entry === undefined || activeRevision(entry).operationId !== operation.operationId) throw new ApiResponseError("CONFLICT");
      return { publicId: operation.publicId, publishedAt: snapshot.revision.publishedAt };
    } catch (error) {
      const recovered = await this.options.manifestStore.read(context).catch(() => undefined);
      const entry = recovered?.value.entries.find((candidate) => candidate.publicId === operation.publicId);
      if (entry !== undefined && activeRevision(entry).operationId === operation.operationId) {
        return { publicId: operation.publicId, publishedAt: snapshot.revision.publishedAt };
      }
      throw error;
    }
  }

  private async persistOperationFolder(operation: ManifestOperation, folder: StoredFile, context: StorageOperationContext): Promise<ManifestOperation> {
    if (operation.publicFolderId === folder.id && operation.publicFolderVersion === folder.version) return operation;
    return this.updateOperation(operation, (current) => ({ ...current, publicFolderId: folder.id, publicFolderVersion: folder.version }), context);
  }

  private async persistOperationRevisionName(operation: ManifestOperation, revisionId: string, marker: string, context: StorageOperationContext): Promise<ManifestOperation> {
    if (operation.revisionId === revisionId && operation.revisionMarker === marker) return operation;
    return this.updateOperation(operation, (current) => ({ ...current, revisionId, revisionMarker: marker }), context);
  }

  private async persistOperationRevisionFolder(operation: ManifestOperation, folder: StoredFile, context: StorageOperationContext): Promise<ManifestOperation> {
    if (operation.revisionFolderId === folder.id && operation.revisionFolderVersion === folder.version) return operation;
    return this.updateOperation(operation, (current) => ({ ...current, revisionFolderId: folder.id, revisionFolderVersion: folder.version }), context);
  }

  private async updateOperation(operation: ManifestOperation, transform: (current: ManifestOperation) => ManifestOperation, context: StorageOperationContext): Promise<ManifestOperation> {
    const committed = await this.options.manifestStore.compareAndSet((manifest) => {
      const current = manifest.operations.find((candidate) => candidate.operationId === operation.operationId);
      if (current === undefined || !sameOperationState(current, operation)) throw new ApiResponseError("CONFLICT");
      return bumpManifest(manifest, { operations: manifest.operations.map((candidate) => candidate.operationId === operation.operationId ? transform(current) : candidate) });
    }, { context });
    const result = committed.value.operations.find((candidate) => candidate.operationId === operation.operationId);
    if (result === undefined) throw new ApiResponseError("CONFLICT");
    return result;
  }

  private async abandonOperation(operationId: string, publicId: string, orphan?: { folderId: string; version: string; marker: string; kind: "revision" }): Promise<void> {
    const cleanupCandidates = Array.from({ length: MAX_RANDOM_ID_COLLISIONS }, () => this.id());
    const queuedAt = this.now().toISOString();
    await this.options.manifestStore.compareAndSet((manifest) => {
      if (manifest.entries.some((entry) => entry.revisions.some((revision) => revision.operationId === operationId))) return manifest;
      const operation = manifest.operations.find((candidate) => candidate.operationId === operationId);
      const derived = orphan ?? (operation?.revisionFolderId !== null && operation?.revisionFolderId !== undefined && operation.revisionFolderVersion !== null && operation.revisionMarker !== null
        ? { folderId: operation.revisionFolderId, version: operation.revisionFolderVersion, marker: operation.revisionMarker, kind: "revision" as const }
        : undefined);
      const usedIds = manifestIdentifierSet(manifest);
      const cleanupId = cleanupCandidates.find((candidate) => !usedIds.has(candidate));
      if (derived !== undefined && cleanupId === undefined) throw new ApiResponseError("CONFLICT");
      const cleanup = derived === undefined ? [] : [{
        cleanupId: cleanupId as string,
        publicId,
        folderId: derived.folderId,
        expectedVersion: derived.version,
        marker: derived.marker,
        kind: derived.kind,
        queuedAt
      } satisfies ManifestCleanup];
      return bumpManifest(manifest, {
        operations: manifest.operations.filter((candidate) => candidate.operationId !== operationId),
        cleanup: boundedCleanup([...manifest.cleanup, ...cleanup])
      });
    });
  }

  private async processCleanup(context: StorageOperationContext): Promise<void> {
    const snapshot = await this.options.manifestStore.read(context);
    for (const cleanup of snapshot.value.cleanup.slice(0, MAX_CLEANUPS_PER_REQUEST)) {
      let cleared = false;
      try {
        const currentManifest = await this.options.manifestStore.read(context);
        if (!currentManifest.value.cleanup.some((candidate) => candidate.cleanupId === cleanup.cleanupId)) continue;
        if (manifestReferencesFolder(currentManifest.value, cleanup.folderId)) continue;
        const file = await this.options.storage.get(cleanup.folderId, { ...context, allowTrashed: true });
        if (!markerMatches(file, cleanup.marker, cleanup.kind === "public-root" ? "public" : "revision", cleanup.publicId)) continue;
        if (!file.trashed) {
          if (file.version !== cleanup.expectedVersion) continue;
          const trashed = await this.options.storage.trash({ fileId: file.id, expectedVersion: cleanup.expectedVersion }, context);
          if (trashed.id !== file.id || !trashed.trashed) continue;
        }
        cleared = true;
      } catch {
        // Cleanup is durable and retried by a later bounded request.
      }
      if (!cleared) continue;
      await this.options.manifestStore.compareAndSet((manifest) => bumpManifest(manifest, {
        cleanup: manifest.cleanup.filter((candidate) => candidate.cleanupId !== cleanup.cleanupId)
      }), { context }).catch(() => undefined);
    }
  }

  private async exactChildren(parentId: string, name: string, context: StorageOperationContext): Promise<StoredFile[]> {
    const page = await this.options.storage.listChildren({ parentId, pageSize: MAX_CHILDREN_PER_FOLDER }, context);
    if (page.nextPageToken !== undefined) throw new ApiResponseError("CONFLICT");
    return page.files.filter((file) => file.name === name && !file.trashed);
  }

  private async verifyPublishedRoot(context: StorageOperationContext): Promise<StoredFile> {
    const privateRoot = await this.options.storage.get(this.options.privateRootId, context);
    if (privateRoot.id !== this.options.privateRootId || privateRoot.parentIds.length !== 0 || privateRoot.trashed || privateRoot.mimeType !== FOLDER_MIME_TYPE) {
      throw new ApiResponseError("DRIVE_UNAVAILABLE");
    }
    const published = await this.options.storage.get(this.options.publishedRootId, context);
    if (
      published.id !== this.options.publishedRootId || published.name !== "published" || published.mimeType !== FOLDER_MIME_TYPE ||
      published.trashed || published.parentIds.length !== 1 || published.parentIds[0] !== privateRoot.id
    ) throw new ApiResponseError("DRIVE_UNAVAILABLE");
    return published;
  }

  private assertFolder(file: StoredFile, parentId: string, name: string, marker: string, kind: "public" | "revision" | "assets", publicId: string, operationId?: string): void {
    if (
      file.name !== name || file.mimeType !== FOLDER_MIME_TYPE || file.trashed || file.parentIds.length !== 1 || file.parentIds[0] !== parentId ||
      !markerMatches(file, marker, kind, publicId, operationId)
    ) throw new ApiResponseError("DRIVE_UNAVAILABLE");
  }

  private async assertSourceStillCurrent(source: VaultNoteResult): Promise<void> {
    const current = await this.options.vault.getNote(source.note.frontmatter.id);
    if (
      current.driveId !== source.driveId || current.version !== source.version || current.checksum !== source.checksum ||
      current.path !== source.path || current.source !== source.source
    ) throw new ApiResponseError("CONFLICT");
  }

  private assertExpectedSource(source: VaultNoteResult, expectedVersion: string): void {
    if (source.version !== expectedVersion || source.note.frontmatter.id.length === 0 || source.checksum !== sha256(new TextEncoder().encode(source.source))) {
      throw new ApiResponseError(source.version === expectedVersion ? "DRIVE_UNAVAILABLE" : "CONFLICT");
    }
  }

  private assertNoteId(value: string): void {
    try { NoteIdSchema.parse(value); } catch { throw new ApiResponseError("INVALID_INPUT"); }
  }

  private assertPublicId(value: string): void {
    try { PublicIdSchema.parse(value); } catch { throw new ApiResponseError("INVALID_INPUT"); }
  }

  private assertVersion(value: string): void {
    if (
      typeof value !== "string" || value.length === 0 || value.length > 512 ||
      [...value].some((character) => {
        const code = character.codePointAt(0) as number;
        return code <= 31 || code === 127;
      })
    ) throw new ApiResponseError("INVALID_INPUT");
  }

  private id(): string {
    const value = this.options.createId?.() ?? randomBytes(16).toString("base64url");
    try { return PublicIdSchema.parse(value); } catch { throw new ApiResponseError("DRIVE_UNAVAILABLE"); }
  }

  private context(): StorageOperationContext { return { operationBudget: new StorageOperationBudget(MAX_STORAGE_OPERATIONS) }; }
  private now(): Date { return this.options.now?.() ?? new Date(); }
}

export class PublicPublicationReader {
  public constructor(private readonly options: {
    storage: StoragePort;
    manifestStore: SystemFileStore<PublicationManifest>;
    privateRootId: string;
    publishedRootId: string;
  }) {}

  public async getNote(publicId: string): Promise<PublicNoteResponse | null> {
    try {
      this.assertId(publicId);
      const context = this.context();
      const { entry, revision } = await this.resolve(publicId, context);
      await this.verifySnapshotFolders(entry, revision, context);
      const readback = await this.options.storage.readBytes(revision.noteSnapshotDriveId, context);
      if (
        !snapshotFileMatches(readback.file, {
          id: revision.noteSnapshotDriveId,
          parentId: revision.snapshotFolderId,
          name: "note.json",
          mimeType: JSON_MIME_TYPE,
          size: revision.noteSize,
          version: revision.noteVersion,
          marker: revision.noteMarker,
          kind: "note",
          publicId,
          operationId: revision.operationId
        }) || readback.bytes.byteLength !== revision.noteSize || readback.checksum !== revision.noteChecksum || sha256(readback.bytes) !== revision.noteChecksum
      ) throw new Error("invalid public note snapshot");
      const source = new TextDecoder("utf-8", { fatal: true }).decode(readback.bytes);
      const parsed = PublicNoteResponseSchema.parse(JSON.parse(source) as unknown);
      const expectedAssets = revision.assets.map((asset) => ({
        assetId: asset.assetId,
        url: `/api/public/assets/${publicId}/${asset.assetId}`,
        name: asset.fileName,
        mimeType: asset.mimeType,
        disposition: asset.disposition
      }));
      if (parsed.publishedAt !== revision.publishedAt || JSON.stringify(parsed.assets) !== JSON.stringify(expectedAssets)) throw new Error("public note projection mismatch");
      if (revision.assets.reduce((total, asset) => total + asset.size, 0) > MAX_PUBLICATION_TOTAL_ASSET_BYTES) throw new Error("public asset snapshot is too large");
      const safeAssets = [];
      for (const asset of revision.assets) {
        const delivery = await this.readVerifiedAsset(publicId, revision, asset, context);
        safeAssets.push({
          assetId: asset.assetId,
          url: `/api/public/assets/${publicId}/${asset.assetId}`,
          name: delivery.name,
          mimeType: delivery.mimeType,
          disposition: delivery.disposition
        });
      }
      return PublicNoteResponseSchema.parse({ ...parsed, assets: safeAssets });
    } catch {
      return null;
    }
  }

  public async getAsset(publicId: string, assetId: string): Promise<PublicAssetDelivery> {
    try {
      this.assertId(publicId);
      this.assertId(assetId);
      const context = this.context();
      const { entry, revision } = await this.resolve(publicId, context);
      await this.verifySnapshotFolders(entry, revision, context);
      const asset = revision.assets.find((candidate) => candidate.assetId === assetId);
      if (asset === undefined) throw new Error("asset is not allowlisted");
      return await this.readVerifiedAsset(publicId, revision, asset, context);
    } catch {
      throw new ApiResponseError("NOT_FOUND");
    }
  }

  private async readVerifiedAsset(
    publicId: string,
    revision: PublicationRevision,
    asset: PublicationAsset,
    context: StorageOperationContext
  ): Promise<PublicAssetDelivery> {
    const readback = await this.options.storage.readBytes(asset.snapshotDriveId, context);
    if (
      !snapshotFileMatches(readback.file, {
        id: asset.snapshotDriveId,
        parentId: revision.assetsFolderId,
        name: snapshotAssetName(asset.assetId, asset.fileName),
        mimeType: asset.mimeType,
        size: asset.size,
        version: asset.version,
        marker: asset.marker,
        kind: "asset",
        publicId,
        operationId: revision.operationId,
        assetId: asset.assetId
      }) || readback.bytes.byteLength !== asset.size || readback.checksum !== asset.checksum ||
      sha256(readback.bytes) !== asset.checksum || asset.size > MAX_ATTACHMENT_BYTES
    ) throw new Error("invalid public asset snapshot");
    const detected = await detectAttachment({ name: asset.fileName, declaredMime: readback.file.mimeType, bytes: readback.bytes });
    if (detected.mimeType !== asset.mimeType) throw new Error("public asset MIME changed");
    return {
      bytes: Uint8Array.from(readback.bytes),
      name: asset.fileName,
      mimeType: detected.mimeType,
      disposition: safeAttachmentDisposition(asset.disposition, detected)
    };
  }

  private async resolve(publicId: string, context: StorageOperationContext): Promise<{ entry: ManifestEntry; revision: PublicationRevision }> {
    const manifest = await this.options.manifestStore.read(context);
    const entry = manifest.value.entries.find((candidate) => candidate.publicId === publicId);
    if (entry === undefined) throw new Error("unknown public ID");
    return { entry, revision: activeRevision(entry) };
  }

  private async verifySnapshotFolders(entry: ManifestEntry, revision: PublicationRevision, context: StorageOperationContext): Promise<void> {
    const privateRoot = await this.options.storage.get(this.options.privateRootId, context);
    const published = await this.options.storage.get(this.options.publishedRootId, context);
    const publicFolder = await this.options.storage.get(entry.publicFolderId, context);
    const revisionFolder = await this.options.storage.get(revision.snapshotFolderId, context);
    const assetsFolder = await this.options.storage.get(revision.assetsFolderId, context);
    if (
      privateRoot.id !== this.options.privateRootId || privateRoot.parentIds.length !== 0 || privateRoot.mimeType !== FOLDER_MIME_TYPE || privateRoot.trashed ||
      published.id !== this.options.publishedRootId || published.name !== "published" || published.parentIds.length !== 1 || published.parentIds[0] !== privateRoot.id || published.mimeType !== FOLDER_MIME_TYPE || published.trashed ||
      !folderMatches(publicFolder, published.id, entry.publicId, publicationMarker(entry.publicId, "public"), "public", entry.publicId) || publicFolder.version !== entry.publicFolderVersion ||
      !folderMatches(revisionFolder, publicFolder.id, revision.revisionId, revision.snapshotMarker, "revision", entry.publicId, revision.operationId) || revisionFolder.version !== revision.snapshotFolderVersion ||
      !folderMatches(assetsFolder, revisionFolder.id, "assets", revision.assetsMarker, "assets", entry.publicId, revision.operationId) || assetsFolder.version !== revision.assetsFolderVersion
    ) throw new Error("invalid public snapshot ancestry");
  }

  private assertId(value: string): void { PublicIdSchema.parse(value); }
  private context(): StorageOperationContext { return { operationBudget: new StorageOperationBudget(MAX_STORAGE_OPERATIONS) }; }
}

const activeRevision = (entry: ManifestEntry): PublicationRevision => {
  const revision = entry.revisions.find((candidate) => candidate.revisionId === entry.activeRevisionId);
  if (revision === undefined) throw new ApiResponseError("DRIVE_UNAVAILABLE");
  return revision;
};

const bumpManifest = (manifest: PublicationManifest, changes: Partial<PublicationManifest>): PublicationManifest => ({
  ...manifest,
  ...changes,
  generation: manifest.generation + 1
});

const boundedCleanup = (records: ManifestCleanup[]): ManifestCleanup[] => {
  const byId = new Map(records.map((record) => [record.cleanupId, record]));
  return [...byId.values()].slice(-MAX_CLEANUP_RECORDS);
};

const cleanupForOperation = (operation: ManifestOperation, queuedAt: string, cleanupId: string): ManifestCleanup[] =>
  operation.revisionFolderId !== null && operation.revisionFolderVersion !== null && operation.revisionMarker !== null
    ? [{ cleanupId, publicId: operation.publicId, folderId: operation.revisionFolderId, expectedVersion: operation.revisionFolderVersion, marker: operation.revisionMarker, kind: "revision", queuedAt }]
    : [];

const operationCanBeRecovered = (operation: ManifestOperation, now: string): boolean => {
  const startedAt = Date.parse(operation.startedAt);
  const observedAt = Date.parse(now);
  return Number.isFinite(startedAt) && Number.isFinite(observedAt) && observedAt - startedAt >= OPERATION_RECOVERY_AFTER_MS;
};

const manifestIdentifierSet = (manifest: PublicationManifest): Set<string> => {
  const ids = new Set<string>();
  for (const entry of manifest.entries) {
    ids.add(entry.publicId);
    for (const revision of entry.revisions) {
      ids.add(revision.operationId);
      revision.assets.forEach((asset) => ids.add(asset.assetId));
    }
  }
  manifest.tombstones.forEach((tombstone) => ids.add(tombstone.publicId));
  manifest.operations.forEach((operation) => { ids.add(operation.operationId); ids.add(operation.publicId); });
  manifest.cleanup.forEach((cleanup) => ids.add(cleanup.cleanupId));
  return ids;
};

const manifestReferencesFolder = (manifest: PublicationManifest, folderId: string): boolean =>
  manifest.entries.some((entry) => entry.publicFolderId === folderId || entry.revisions.some((revision) =>
    revision.snapshotFolderId === folderId || revision.assetsFolderId === folderId
  )) || manifest.operations.some((operation) => operation.publicFolderId === folderId || operation.revisionFolderId === folderId);

const publicationMarker = (ownerId: string, kind: string): string => `pm1.${ownerId}.${kind}`;

const publicationProperties = (
  marker: string,
  kind: string,
  publicId: string,
  operationId?: string,
  assetId?: string
): Record<string, string> => ({
  nxtPublicationMarker: marker,
  nxtPublicationKind: kind,
  nxtPublicationPublicId: publicId,
  ...(operationId === undefined ? {} : { nxtPublicationOperation: operationId }),
  ...(assetId === undefined ? {} : { nxtPublicationAssetId: assetId })
});

const markerMatches = (
  file: StoredFile,
  marker: string,
  kind: string,
  publicId: string,
  operationId?: string,
  assetId?: string
): boolean =>
  file.appProperties?.nxtPublicationMarker === marker && file.appProperties?.nxtPublicationKind === kind &&
  file.appProperties?.nxtPublicationPublicId === publicId &&
  (operationId === undefined || file.appProperties?.nxtPublicationOperation === operationId) &&
  (assetId === undefined || file.appProperties?.nxtPublicationAssetId === assetId);

const folderMatches = (
  file: StoredFile,
  parentId: string,
  name: string,
  marker: string,
  kind: string,
  publicId: string,
  operationId?: string
): boolean =>
  file.name === name && file.mimeType === FOLDER_MIME_TYPE && !file.trashed && file.parentIds.length === 1 && file.parentIds[0] === parentId &&
  markerMatches(file, marker, kind, publicId, operationId);

const snapshotFileMatches = (file: StoredFile, expected: {
  id: string;
  parentId: string;
  name: string;
  mimeType: string;
  size: number;
  version: string;
  marker: string;
  kind: string;
  publicId: string;
  operationId: string;
  assetId?: string;
}): boolean =>
  file.id === expected.id && file.parentIds.length === 1 && file.parentIds[0] === expected.parentId && file.name === expected.name &&
  file.mimeType === expected.mimeType && file.size === expected.size && file.version === expected.version && !file.trashed &&
  file.mimeType !== FOLDER_MIME_TYPE && file.mimeType !== SHORTCUT_MIME_TYPE &&
  markerMatches(file, expected.marker, expected.kind, expected.publicId, expected.operationId, expected.assetId);

const snapshotAssetName = (assetId: string, originalName: string): string => {
  const index = originalName.lastIndexOf(".");
  const extension = index > 0 && /^[.][a-z0-9]{1,16}$/iu.test(originalName.slice(index))
    ? originalName.slice(index).toLocaleLowerCase("en-US")
    : "";
  return `${assetId}${extension}`;
};

const sameOperationSource = (left: ManifestOperation, right: ManifestOperation): boolean =>
  left.operationId === right.operationId && left.publicId === right.publicId && left.sourceNoteId === right.sourceNoteId &&
  left.epoch === right.epoch && left.sourceVersion === right.sourceVersion && left.sourceChecksum === right.sourceChecksum && left.sourcePath === right.sourcePath;

const sameOperationState = (left: ManifestOperation, right: ManifestOperation): boolean => JSON.stringify(left) === JSON.stringify(right);
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);

const toPrivateApiError = (error: unknown): Error => {
  if (error instanceof ApiResponseError || error instanceof StorageOperationBudgetExceededError) return error;
  if (error instanceof StorageVersionConflictError) return new ApiResponseError("CONFLICT");
  return new ApiResponseError("DRIVE_UNAVAILABLE");
};
