import { createHash, randomBytes } from "node:crypto";
import { NoteIdSchema, MAX_PUBLICATION_ASSETS, MAX_PUBLICATION_TOTAL_ASSET_BYTES, PublicIdSchema, PublicNoteResponseSchema } from "@nxt/contracts";
import { attachmentReferenceProjection, canonicalAttachmentReference, projectionReferencesAttachment, renderMarkdown } from "@nxt/domain";
import { ApiResponseError } from "../http/api-response.js";
import { StorageMutationOutcomeUnknownError, StorageOperationBudget, StorageOperationBudgetExceededError, StorageVersionConflictError } from "../storage/storage-port.js";
import { MAX_ATTACHMENT_BYTES, detectAttachment, safeAttachmentDisposition } from "./attachment-policy.js";
import { preserveApiError } from "./system-file-store.js";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const SHORTCUT_MIME_TYPE = "application/vnd.google-apps.shortcut";
const JSON_MIME_TYPE = "application/json";
const MAX_MANIFEST_OPERATIONS = 64;
const MAX_CLEANUP_RECORDS = 64;
const MAX_TOMBSTONE_CLEANUP_RECORDS = 32;
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
export class PublicationService {
    options;
    reader;
    constructor(options) {
        this.options = options;
        this.reader = new PublicPublicationReader({
            storage: options.storage,
            manifestStore: options.manifestStore,
            privateRootId: options.privateRootId,
            publishedRootId: options.publishedRootId
        });
    }
    async publish(input) {
        this.assertNoteId(input.noteId);
        this.assertVersion(input.expectedVersion);
        const context = this.context();
        const initialCausality = await this.observePublicationCausality(input.noteId, context);
        await this.processCleanup(context);
        const causality = await this.observePublicationCausality(input.noteId, context);
        if (initialCausality.identity !== causality.identity)
            throw new ApiResponseError("CONFLICT");
        const source = await this.options.vault.getNote(input.noteId).catch((error) => { throw preserveApiError(error, "DRIVE_UNAVAILABLE"); });
        this.assertExpectedSource(source, input.expectedVersion);
        const operation = await this.reservePublish(source, causality, context);
        const orphans = [];
        try {
            const manifest = await this.options.manifestStore.read(context);
            const reserved = manifest.value.operations.find((candidate) => candidate.operationId === operation.operationId);
            if (reserved === undefined || !sameOperationSource(reserved, operation))
                throw new ApiResponseError("CONFLICT");
            const index = await this.options.indexStore.read(context);
            const prepared = await this.prepareAssets(source, index.value, manifestIdentifierSet(manifest.value));
            const rendered = await renderMarkdown(source.source, {
                rewriteUrl: (value) => {
                    if (value.startsWith(PUBLIC_ATTACHMENT_PREFIX))
                        throw new ApiResponseError("INVALID_INPUT");
                    const reference = canonicalAttachmentReference(value, source.path);
                    if (reference === undefined)
                        return value;
                    const asset = prepared.byReference.get(reference);
                    if (asset === undefined)
                        throw new ApiResponseError("NOT_FOUND");
                    return `/api/public/assets/${operation.publicId}/${asset.assetId}`;
                }
            });
            const publishedRoot = await this.verifyPublishedRoot(context);
            const publicFolder = await this.ensurePublicFolder(operation, publishedRoot, context);
            if (operation.cleanupSlots === 2) {
                orphans.push(publicRootCleanupArtifact(operation.publicId, publicFolder.file, publishedRoot.id));
            }
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
            orphans.push(revisionCleanupArtifact(activeOperation.publicId, activeOperation.operationId, revisionId, revisionMarker, revisionFolder.file, publicFolder.file.id));
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
            return result;
        }
        catch (error) {
            await this.abandonOperation(operation.operationId, operation.publicId, orphans).catch(() => undefined);
            throw toPrivateApiError(error);
        }
    }
    async revoke(input) {
        this.assertPublicId(input.publicId);
        const context = this.context();
        await this.processCleanup(context);
        const now = this.now().toISOString();
        const cleanupCandidates = Array.from({ length: MAX_TOMBSTONE_CLEANUP_RECORDS * MAX_RANDOM_ID_COLLISIONS }, () => this.id());
        try {
            await this.options.manifestStore.compareAndSet((manifest) => {
                const entry = manifest.entries.find((candidate) => candidate.publicId === input.publicId);
                if (entry === undefined) {
                    if (manifest.tombstones.some((candidate) => candidate.publicId === input.publicId))
                        return manifest;
                    throw new ApiResponseError("NOT_FOUND");
                }
                const relatedOperations = manifest.operations.filter((operation) => operation.publicId === input.publicId);
                const usedIds = manifestIdentifierSet(manifest);
                const cleanupIds = takeUniqueIdentifiers(cleanupCandidates, entry.revisions.length, usedIds);
                if (cleanupIds.length !== entry.revisions.length)
                    throw new ApiResponseError("CONFLICT");
                const epoch = Math.max(entry.epoch, ...relatedOperations.map((operation) => operation.epoch)) + 1;
                const cleanup = entry.revisions.map((revision, index) => revisionCleanupRecord({
                    cleanupId: cleanupIds[index],
                    publicId: entry.publicId,
                    operationId: revision.operationId,
                    revisionId: revision.revisionId,
                    folderId: revision.snapshotFolderId,
                    folderVersion: revision.snapshotFolderVersion,
                    marker: revision.snapshotMarker,
                    publicFolderId: entry.publicFolderId,
                    queuedAt: now
                }));
                const tombstone = {
                    publicId: entry.publicId,
                    sourceNoteId: entry.sourceNoteId,
                    epoch,
                    publicFolderId: entry.publicFolderId,
                    publicFolderVersion: entry.publicFolderVersion,
                    revokedAt: now,
                    cleanup
                };
                return bumpManifest(manifest, {
                    entries: manifest.entries.filter((candidate) => candidate.publicId !== input.publicId),
                    tombstones: [...manifest.tombstones.filter((candidate) => candidate.publicId !== input.publicId && candidate.sourceNoteId !== entry.sourceNoteId), tombstone],
                    operations: manifest.operations,
                    cleanup: manifest.cleanup
                });
            }, { context });
        }
        catch (error) {
            const recovered = await this.options.manifestStore.read(context).catch(() => undefined);
            if (recovered === undefined || recovered.value.entries.some((entry) => entry.publicId === input.publicId) ||
                !recovered.value.tombstones.some((entry) => entry.publicId === input.publicId))
                throw toPrivateApiError(error);
        }
        if (await this.reader.getNote(input.publicId) !== null)
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        await this.processCleanup(context);
        return { revoked: true };
    }
    async observePublicationCausality(noteId, context) {
        const snapshot = await this.options.manifestStore.read(context);
        return publicationCausality(snapshot.value, noteId);
    }
    async reservePublish(source, causality, context) {
        const candidateIds = Array.from({ length: MAX_RANDOM_ID_COLLISIONS * 3 }, () => this.id());
        const startedAt = this.now().toISOString();
        let operationId;
        let proposed;
        try {
            const committed = await this.options.manifestStore.compareAndSet((manifest) => {
                if (!samePublicationCausality(publicationCausality(manifest, source.note.frontmatter.id), causality)) {
                    throw new ApiResponseError("CONFLICT");
                }
                const stale = manifest.operations.find((operation) => operation.sourceNoteId === source.note.frontmatter.id);
                if (stale !== undefined && !operationCanBeRecovered(stale, startedAt))
                    throw new ApiResponseError("CONFLICT");
                const active = manifest.entries.find((entry) => entry.sourceNoteId === source.note.frontmatter.id);
                const tombstone = manifest.tombstones.find((entry) => entry.sourceNoteId === source.note.frontmatter.id);
                if (tombstone !== undefined && tombstone.cleanup.length !== 0)
                    throw new ApiResponseError("CONFLICT");
                const previous = active ?? tombstone;
                const usedIds = manifestIdentifierSet(manifest);
                operationId = candidateIds.find((candidate) => !usedIds.has(candidate));
                if (operationId === undefined)
                    throw new ApiResponseError("CONFLICT");
                usedIds.add(operationId);
                const publicId = previous?.publicId ?? stale?.publicId ?? candidateIds.find((candidate) => !usedIds.has(candidate));
                if (publicId === undefined)
                    throw new ApiResponseError("CONFLICT");
                if (manifest.operations.some((operation) => operation.publicId === publicId && operation.sourceNoteId !== source.note.frontmatter.id))
                    throw new ApiResponseError("CONFLICT");
                usedIds.add(publicId);
                const cleanupId = candidateIds.find((candidate) => !usedIds.has(candidate));
                const staleNeedsCleanup = stale?.revisionFolderId !== null && stale?.revisionFolderId !== undefined &&
                    stale.revisionFolderVersion !== null && stale.revisionMarker !== null;
                if (staleNeedsCleanup && cleanupId === undefined)
                    throw new ApiResponseError("CONFLICT");
                const staleCleanup = stale === undefined || cleanupId === undefined ? [] : cleanupForOperation(stale, startedAt, cleanupId);
                const remainingOperations = manifest.operations.filter((operation) => operation.operationId !== stale?.operationId);
                const cleanupSlots = previous?.publicFolderId !== undefined || stale?.publicFolderId !== null && stale?.publicFolderId !== undefined ? 1 : 2;
                if (remainingOperations.length + 1 > MAX_MANIFEST_OPERATIONS ||
                    manifest.cleanup.length + staleCleanup.length > MAX_CLEANUP_RECORDS ||
                    manifest.cleanup.length + staleCleanup.length +
                        remainingOperations.reduce((total, operation) => total + operation.cleanupSlots, 0) + cleanupSlots > MAX_CLEANUP_RECORDS)
                    throw new ApiResponseError("CONFLICT");
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
                    revisionMarker: null,
                    cleanupSlots
                };
                return bumpManifest(manifest, {
                    operations: [...remainingOperations, proposed],
                    cleanup: boundedCleanup([...manifest.cleanup, ...staleCleanup])
                });
            }, { context });
            if (operationId === undefined)
                throw new ApiResponseError("CONFLICT");
            const operation = committed.value.operations.find((candidate) => candidate.operationId === operationId);
            if (operation === undefined)
                throw new ApiResponseError("CONFLICT");
            return operation;
        }
        catch (error) {
            const recovered = await this.options.manifestStore.read(context).catch(() => undefined);
            const operation = recovered?.value.operations.find((candidate) => candidate.operationId === operationId);
            if (operation !== undefined && proposed !== undefined && sameOperationSource(operation, proposed))
                return operation;
            throw toPrivateApiError(error);
        }
    }
    async ensurePublicFolder(operation, publishedRoot, context) {
        const marker = publicationMarker(operation.publicId, "public");
        if (operation.publicFolderId !== null) {
            const file = await this.options.storage.get(operation.publicFolderId, context);
            this.assertFolder(file, publishedRoot.id, operation.publicId, marker, "public", operation.publicId);
            if (operation.publicFolderVersion !== null && operation.publicFolderVersion !== file.version)
                throw new ApiResponseError("CONFLICT");
            const exact = await this.exactChildren(publishedRoot.id, operation.publicId, context);
            if (exact.length !== 1 || exact[0]?.id !== file.id)
                throw new ApiResponseError("CONFLICT");
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
    async ensureOwnedFolder(input) {
        const existing = await this.exactChildren(input.parentId, input.name, input.context);
        const owned = existing.filter((file) => markerMatches(file, input.marker, input.kind, input.publicId, input.kind === "public" ? undefined : input.operationId));
        if (owned.length === 1 && existing.length === 1) {
            const file = await this.options.storage.get(owned[0].id, input.context);
            this.assertFolder(file, input.parentId, input.name, input.marker, input.kind, input.publicId, input.kind === "public" ? undefined : input.operationId);
            return { file, marker: input.marker, created: false };
        }
        if (existing.length !== 0)
            throw new ApiResponseError("CONFLICT");
        const appProperties = publicationProperties(input.marker, input.kind, input.publicId, input.kind === "public" ? undefined : input.operationId);
        let createdId;
        let createdVersion;
        let outcomeUnknown;
        try {
            const created = await this.options.storage.createFolder({ parentId: input.parentId, name: input.name, appProperties }, input.context);
            createdId = created.id;
            createdVersion = created.version;
        }
        catch (error) {
            if (!(error instanceof StorageMutationOutcomeUnknownError))
                throw error;
            outcomeUnknown = error;
            createdId = error.fileId;
        }
        const recovered = await this.exactChildren(input.parentId, input.name, input.context);
        if (recovered.length !== 1) {
            if (recovered.length === 0)
                throw outcomeUnknown ?? new ApiResponseError("DRIVE_UNAVAILABLE");
            throw new ApiResponseError("CONFLICT");
        }
        const candidate = recovered[0];
        if (createdId !== undefined && candidate.id !== createdId)
            throw new ApiResponseError("CONFLICT");
        const file = await this.options.storage.get(candidate.id, input.context);
        this.assertFolder(file, input.parentId, input.name, input.marker, input.kind, input.publicId, input.kind === "public" ? undefined : input.operationId);
        if (createdVersion !== undefined && file.version !== createdVersion)
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        return { file, marker: input.marker, created: true };
    }
    async chooseRevisionId(publicFolderId, sourceVersion, context) {
        const base = `v-${createHash("sha256").update(sourceVersion, "utf8").digest("base64url").slice(0, 16)}`;
        const page = await this.options.storage.listChildren({ parentId: publicFolderId, pageSize: MAX_CHILDREN_PER_FOLDER }, context);
        if (page.nextPageToken !== undefined)
            throw new ApiResponseError("CONFLICT");
        const names = new Set(page.files.map((file) => file.name));
        for (let collision = 1; collision <= MAX_REVISION_COLLISIONS; collision += 1) {
            const candidate = collision === 1 ? base : `${base}-${collision}`;
            if (!names.has(candidate))
                return candidate;
        }
        throw new ApiResponseError("CONFLICT");
    }
    async prepareAssets(source, index, forbiddenIds) {
        const owner = index.entries.find((entry) => entry.id === source.note.frontmatter.id);
        if (owner === undefined || owner.driveId !== source.driveId || owner.driveVersion !== source.version || owner.path !== source.path ||
            index.pendingMutations.some((mutation) => mutation.noteId === source.note.frontmatter.id))
            throw new ApiResponseError("CONFLICT");
        const references = attachmentReferenceProjection(source.source, source.path);
        if (references.length > MAX_PUBLICATION_ASSETS)
            throw new ApiResponseError("TOO_LARGE");
        const resolved = new Map();
        const referenceDriveIds = new Map();
        for (const reference of references) {
            const indexed = this.resolveIndexedAsset(reference, index);
            if (indexed === undefined)
                throw new ApiResponseError("NOT_FOUND");
            resolved.set(indexed.attachment.driveId, indexed);
            referenceDriveIds.set(reference, indexed.attachment.driveId);
        }
        const prepared = [];
        const assetIds = new Set(forbiddenIds);
        let totalBytes = 0;
        for (const indexed of resolved.values()) {
            const delivery = await this.options.attachments.readForNote({ noteId: indexed.noteId, assetId: indexed.attachment.driveId });
            if (delivery.bytes.byteLength > MAX_ATTACHMENT_BYTES || delivery.name !== indexed.attachment.name || delivery.mimeType !== indexed.attachment.mimeType) {
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            }
            totalBytes += delivery.bytes.byteLength;
            if (totalBytes > MAX_PUBLICATION_TOTAL_ASSET_BYTES)
                throw new ApiResponseError("TOO_LARGE");
            let assetId;
            for (let collision = 0; collision < MAX_RANDOM_ID_COLLISIONS; collision += 1) {
                const candidate = this.id();
                if (!assetIds.has(candidate)) {
                    assetId = candidate;
                    break;
                }
            }
            if (assetId === undefined)
                throw new ApiResponseError("CONFLICT");
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
        const byReference = new Map();
        for (const [reference, driveId] of referenceDriveIds) {
            const asset = byDriveId.get(driveId);
            if (asset === undefined)
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            byReference.set(reference, asset);
        }
        return { assets: prepared, byReference };
    }
    resolveIndexedAsset(reference, index) {
        if (reference.startsWith(PRIVATE_ATTACHMENT_PREFIX)) {
            const opaqueId = reference.slice(PRIVATE_ATTACHMENT_PREFIX.length);
            if (this.options.decodeAttachmentId === undefined)
                return undefined;
            let driveId;
            try {
                driveId = this.options.decodeAttachmentId(opaqueId);
            }
            catch {
                return undefined;
            }
            const matches = index.entries.flatMap((entry) => entry.attachments
                .filter((attachment) => attachment.driveId === driveId && projectionReferencesAttachment([reference], { noteId: entry.id, name: attachment.name, opaqueId }))
                .map((attachment) => ({ noteId: entry.id, attachment })));
            return matches.length === 1 ? matches[0] : undefined;
        }
        const match = PATH_ATTACHMENT.exec(reference);
        if (match === null)
            return undefined;
        const [ownerId, name] = [match[1], match[2]];
        const owner = index.entries.find((entry) => entry.id === ownerId);
        if (owner === undefined)
            return undefined;
        const assets = owner.attachments.filter((attachment) => attachment.name.normalize("NFC") === name.normalize("NFC"));
        return assets.length === 1 ? { noteId: owner.id, attachment: assets[0] } : undefined;
    }
    async writeSnapshot(input) {
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
        const copiedAssets = [];
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
        const noteProjection = PublicNoteResponseSchema.parse({
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
        if (noteBytes.byteLength > MAX_NOTE_SNAPSHOT_BYTES)
            throw new ApiResponseError("TOO_LARGE");
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
        this.assertFolder(finalRevisionFolder, finalPublicFolder.id, input.operation.revisionId, input.revisionMarker, "revision", input.operation.publicId, input.operation.operationId);
        this.assertFolder(finalAssetsFolder, finalRevisionFolder.id, "assets", assetsMarker, "assets", input.operation.publicId, input.operation.operationId);
        return {
            publicFolder: finalPublicFolder,
            revision: {
                revisionId: input.operation.revisionId,
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
    async createVerifiedBytes(input) {
        const appProperties = publicationProperties(input.marker, input.kind, input.publicId, input.operationId, input.assetId);
        const existing = await this.exactChildren(input.parentId, input.name, input.context);
        if (existing.length !== 0) {
            if (existing.length !== 1 ||
                !markerMatches(existing[0], input.marker, input.kind, input.publicId, input.operationId, input.assetId))
                throw new ApiResponseError("CONFLICT");
            return this.readAndVerifyBytes(input, existing[0].id);
        }
        let createdId;
        let outcomeUnknown;
        try {
            const created = await this.options.storage.createBytes({ parentId: input.parentId, name: input.name, mimeType: input.mimeType, bytes: input.bytes, appProperties }, input.context);
            createdId = created.id;
        }
        catch (error) {
            if (!(error instanceof StorageMutationOutcomeUnknownError))
                throw error;
            outcomeUnknown = error;
            createdId = error.fileId;
        }
        const recovered = await this.exactChildren(input.parentId, input.name, input.context);
        if (recovered.length !== 1) {
            if (recovered.length === 0)
                throw outcomeUnknown ?? new ApiResponseError("DRIVE_UNAVAILABLE");
            throw new ApiResponseError("CONFLICT");
        }
        if (!markerMatches(recovered[0], input.marker, input.kind, input.publicId, input.operationId, input.assetId) ||
            (createdId !== undefined && recovered[0]?.id !== createdId))
            throw new ApiResponseError("CONFLICT");
        return this.readAndVerifyBytes(input, recovered[0].id);
    }
    async readAndVerifyBytes(input, fileId) {
        const metadata = await this.options.storage.get(fileId, input.context);
        const readback = await this.options.storage.readBytes(fileId, input.context);
        const expectedChecksum = sha256(input.bytes);
        if (metadata.id !== readback.file.id || metadata.version !== readback.file.version || readback.file.id !== fileId ||
            readback.file.trashed || readback.file.mimeType === FOLDER_MIME_TYPE || readback.file.mimeType === SHORTCUT_MIME_TYPE ||
            readback.file.parentIds.length !== 1 || readback.file.parentIds[0] !== input.parentId || readback.file.name !== input.name ||
            readback.file.mimeType !== input.mimeType || readback.file.size !== input.bytes.byteLength || readback.bytes.byteLength !== input.bytes.byteLength ||
            readback.checksum !== expectedChecksum || !equalBytes(readback.bytes, input.bytes) ||
            !markerMatches(readback.file, input.marker, input.kind, input.publicId, input.operationId, input.assetId))
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        return readback.file;
    }
    async commitPublication(operation, snapshot, context) {
        const cleanupCandidates = Array.from({ length: MAX_RANDOM_ID_COLLISIONS }, () => this.id());
        try {
            const committed = await this.options.manifestStore.compareAndSet((manifest) => {
                const currentOperation = manifest.operations.find((candidate) => candidate.operationId === operation.operationId);
                if (currentOperation === undefined || !sameOperationState(currentOperation, operation))
                    throw new ApiResponseError("CONFLICT");
                const active = manifest.entries.find((entry) => entry.sourceNoteId === operation.sourceNoteId);
                const tombstone = manifest.tombstones.find((entry) => entry.sourceNoteId === operation.sourceNoteId);
                const previous = active ?? tombstone;
                if ((previous?.epoch ?? 0) !== operation.epoch - 1 || (previous !== undefined && previous.publicId !== operation.publicId))
                    throw new ApiResponseError("CONFLICT");
                const completeHistory = [...(active?.revisions ?? []), snapshot.revision];
                const evicted = completeHistory.slice(0, Math.max(0, completeHistory.length - 32));
                const usedIds = manifestIdentifierSet(manifest);
                const cleanupIds = takeUniqueIdentifiers(cleanupCandidates, evicted.length, usedIds);
                if (cleanupIds.length !== evicted.length)
                    throw new ApiResponseError("CONFLICT");
                const evictionCleanup = evicted.map((revision, index) => revisionCleanupRecord({
                    cleanupId: cleanupIds[index],
                    publicId: operation.publicId,
                    operationId: revision.operationId,
                    revisionId: revision.revisionId,
                    folderId: revision.snapshotFolderId,
                    folderVersion: revision.snapshotFolderVersion,
                    marker: revision.snapshotMarker,
                    publicFolderId: active?.publicFolderId ?? snapshot.publicFolder.id,
                    queuedAt: snapshot.revision.publishedAt
                }));
                const revisions = completeHistory.slice(-32);
                const entry = {
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
                    operations: manifest.operations.filter((candidate) => candidate.operationId !== operation.operationId),
                    cleanup: boundedCleanup([...manifest.cleanup, ...evictionCleanup])
                });
            }, { context });
            const entry = committed.value.entries.find((candidate) => candidate.publicId === operation.publicId);
            if (entry === undefined || activeRevision(entry).operationId !== operation.operationId)
                throw new ApiResponseError("CONFLICT");
            return { publicId: operation.publicId, publishedAt: snapshot.revision.publishedAt };
        }
        catch (error) {
            const recovered = await this.options.manifestStore.read(context).catch(() => undefined);
            const entry = recovered?.value.entries.find((candidate) => candidate.publicId === operation.publicId);
            if (entry !== undefined && activeRevision(entry).operationId === operation.operationId) {
                return { publicId: operation.publicId, publishedAt: snapshot.revision.publishedAt };
            }
            throw error;
        }
    }
    async persistOperationFolder(operation, folder, context) {
        if (operation.publicFolderId === folder.id && operation.publicFolderVersion === folder.version)
            return operation;
        return this.updateOperation(operation, (current) => ({ ...current, publicFolderId: folder.id, publicFolderVersion: folder.version }), context);
    }
    async persistOperationRevisionName(operation, revisionId, marker, context) {
        if (operation.revisionId === revisionId && operation.revisionMarker === marker)
            return operation;
        return this.updateOperation(operation, (current) => ({ ...current, revisionId, revisionMarker: marker }), context);
    }
    async persistOperationRevisionFolder(operation, folder, context) {
        if (operation.revisionFolderId === folder.id && operation.revisionFolderVersion === folder.version)
            return operation;
        return this.updateOperation(operation, (current) => ({ ...current, revisionFolderId: folder.id, revisionFolderVersion: folder.version }), context);
    }
    async updateOperation(operation, transform, context) {
        const committed = await this.options.manifestStore.compareAndSet((manifest) => {
            const current = manifest.operations.find((candidate) => candidate.operationId === operation.operationId);
            if (current === undefined || !sameOperationState(current, operation))
                throw new ApiResponseError("CONFLICT");
            return bumpManifest(manifest, { operations: manifest.operations.map((candidate) => candidate.operationId === operation.operationId ? transform(current) : candidate) });
        }, { context });
        const result = committed.value.operations.find((candidate) => candidate.operationId === operation.operationId);
        if (result === undefined)
            throw new ApiResponseError("CONFLICT");
        return result;
    }
    async abandonOperation(operationId, publicId, orphans) {
        const cleanupCandidates = Array.from({ length: MAX_RANDOM_ID_COLLISIONS * 2 }, () => this.id());
        const queuedAt = this.now().toISOString();
        await this.options.manifestStore.compareAndSet((manifest) => {
            if (manifest.entries.some((entry) => entry.revisions.some((revision) => revision.operationId === operationId)))
                return manifest;
            const operation = manifest.operations.find((candidate) => candidate.operationId === operationId);
            const derived = [...orphans];
            if (operation?.revisionFolderId !== null && operation?.revisionFolderId !== undefined &&
                operation.revisionFolderVersion !== null && operation.revisionMarker !== null &&
                operation.revisionId !== null && operation.publicFolderId !== null) {
                derived.push(revisionCleanupArtifact(operation.publicId, operation.operationId, operation.revisionId, operation.revisionMarker, { id: operation.revisionFolderId, version: operation.revisionFolderVersion }, operation.publicFolderId));
            }
            if (operation?.cleanupSlots === 2 && operation.publicFolderId !== null && operation.publicFolderVersion !== null) {
                derived.push(publicRootCleanupArtifact(operation.publicId, { id: operation.publicFolderId, version: operation.publicFolderVersion }, this.options.publishedRootId));
            }
            const artifacts = [...new Map(derived.map((artifact) => [artifact.folderId, artifact])).values()]
                .sort((left, right) => left.kind === right.kind ? 0 : left.kind === "revision" ? -1 : 1);
            if (operation !== undefined && artifacts.length > operation.cleanupSlots)
                throw new ApiResponseError("CONFLICT");
            const usedIds = manifestIdentifierSet(manifest);
            const cleanupIds = takeUniqueIdentifiers(cleanupCandidates, artifacts.length, usedIds);
            if (cleanupIds.length !== artifacts.length)
                throw new ApiResponseError("CONFLICT");
            const cleanup = artifacts.map((artifact, index) => ({
                ...artifact,
                cleanupId: cleanupIds[index],
                publicId,
                queuedAt
            }));
            return bumpManifest(manifest, {
                operations: manifest.operations.filter((candidate) => candidate.operationId !== operationId),
                cleanup: boundedCleanup([...manifest.cleanup, ...cleanup])
            });
        });
    }
    async processCleanup(context) {
        const snapshot = await this.options.manifestStore.read(context);
        const records = manifestCleanupRecords(snapshot.value);
        if (records.length === 0)
            return;
        const start = snapshot.value.cleanupOffset % records.length;
        const selected = Array.from({ length: Math.min(MAX_CLEANUPS_PER_REQUEST, records.length) }, (_value, index) => records[(start + index) % records.length]);
        for (const cleanup of selected) {
            try {
                const currentManifest = await this.options.manifestStore.read(context);
                const currentCleanup = findManifestCleanup(currentManifest.value, cleanup.cleanupId);
                if (currentCleanup === undefined || !sameCleanupRecord(currentCleanup, cleanup))
                    continue;
                if (manifestReferencesFolder(currentManifest.value, cleanup.folderId))
                    continue;
                if (cleanup.kind === "public-root" &&
                    manifestCleanupRecords(currentManifest.value).some((candidate) => candidate.cleanupId !== cleanup.cleanupId && candidate.kind === "revision" && candidate.publicId === cleanup.publicId))
                    continue;
                const file = await this.verifyCleanupTarget(cleanup, context);
                if (!file.trashed) {
                    if (file.version !== cleanup.expectedVersion)
                        continue;
                    let trashed;
                    try {
                        trashed = await this.options.storage.trash({ fileId: file.id, expectedVersion: file.version }, context);
                    }
                    catch {
                        // An ambiguous Trash is recovered only by a later independently verified read.
                        continue;
                    }
                    if (trashed.version === file.version ||
                        !cleanupFolderMatches(trashed, cleanup, true) ||
                        trashed.id !== file.id)
                        continue;
                    const readback = await this.verifyCleanupTarget(cleanup, context);
                    if (readback.version !== trashed.version || !cleanupFolderMatches(readback, cleanup, true))
                        continue;
                }
                else if (file.version === cleanup.expectedVersion) {
                    continue;
                }
                await this.clearCleanupRecord(cleanup, context);
            }
            catch {
                // Cleanup is durable and retried by a later bounded request.
            }
        }
        await this.options.manifestStore.compareAndSet((manifest) => {
            const remaining = manifestCleanupRecords(manifest).length;
            const cleanupOffset = remaining === 0 ? 0 : (manifest.cleanupOffset + selected.length) % remaining;
            return bumpManifest(manifest, { cleanupOffset });
        }, { context }).catch(() => undefined);
    }
    async verifyCleanupTarget(cleanup, context) {
        if (cleanup.ownershipVersion !== 1 || cleanup.parentFolderId === null || cleanup.folderName === null ||
            (cleanup.kind === "revision" && cleanup.operationId === null))
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        const publishedRoot = await this.verifyPublishedRoot(context);
        if (cleanup.kind === "public-root") {
            if (cleanup.parentFolderId !== publishedRoot.id || cleanup.folderName !== cleanup.publicId || cleanup.operationId !== null ||
                cleanup.marker !== publicationMarker(cleanup.publicId, "public"))
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            const file = await this.options.storage.get(cleanup.folderId, { ...context, allowTrashed: true });
            if (!cleanupFolderMatches(file, cleanup, file.trashed))
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            if (!file.trashed)
                await this.assertUniqueCleanupChild(publishedRoot.id, cleanup.folderName, file.id, context);
            return file;
        }
        const publicFolder = await this.options.storage.get(cleanup.parentFolderId, context);
        if (!folderMatches(publicFolder, publishedRoot.id, cleanup.publicId, publicationMarker(cleanup.publicId, "public"), "public", cleanup.publicId) || publicFolder.appProperties?.nxtPublicationOperation !== undefined ||
            publicFolder.appProperties?.nxtPublicationAssetId !== undefined)
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        await this.assertUniqueCleanupChild(publishedRoot.id, cleanup.publicId, publicFolder.id, context);
        const file = await this.options.storage.get(cleanup.folderId, { ...context, allowTrashed: true });
        if (!cleanupFolderMatches(file, cleanup, file.trashed))
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        if (!file.trashed)
            await this.assertUniqueCleanupChild(publicFolder.id, cleanup.folderName, file.id, context);
        return file;
    }
    async assertUniqueCleanupChild(parentId, name, fileId, context) {
        const exact = await this.exactChildren(parentId, name, context);
        if (exact.length !== 1 || exact[0]?.id !== fileId)
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
    }
    async clearCleanupRecord(cleanup, context) {
        await this.options.manifestStore.compareAndSet((manifest) => {
            const current = findManifestCleanup(manifest, cleanup.cleanupId);
            if (current === undefined || !sameCleanupRecord(current, cleanup) ||
                manifestReferencesFolder(manifest, cleanup.folderId))
                return manifest;
            return bumpManifest(manifest, {
                cleanup: manifest.cleanup.filter((candidate) => candidate.cleanupId !== cleanup.cleanupId),
                tombstones: manifest.tombstones.map((tombstone) => ({
                    ...tombstone,
                    cleanup: tombstone.cleanup.filter((candidate) => candidate.cleanupId !== cleanup.cleanupId)
                }))
            });
        }, { context });
    }
    async exactChildren(parentId, name, context) {
        const page = await this.options.storage.listChildren({ parentId, pageSize: MAX_CHILDREN_PER_FOLDER }, context);
        if (page.nextPageToken !== undefined)
            throw new ApiResponseError("CONFLICT");
        return page.files.filter((file) => file.name === name && !file.trashed);
    }
    async verifyPublishedRoot(context) {
        const privateRoot = await this.options.storage.get(this.options.privateRootId, context);
        if (privateRoot.id !== this.options.privateRootId || privateRoot.parentIds.length !== 0 || privateRoot.trashed || privateRoot.mimeType !== FOLDER_MIME_TYPE) {
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        }
        const published = await this.options.storage.get(this.options.publishedRootId, context);
        if (published.id !== this.options.publishedRootId || published.name !== "published" || published.mimeType !== FOLDER_MIME_TYPE ||
            published.trashed || published.parentIds.length !== 1 || published.parentIds[0] !== privateRoot.id)
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        return published;
    }
    assertFolder(file, parentId, name, marker, kind, publicId, operationId) {
        if (file.name !== name || file.mimeType !== FOLDER_MIME_TYPE || file.trashed || file.parentIds.length !== 1 || file.parentIds[0] !== parentId ||
            !markerMatches(file, marker, kind, publicId, operationId))
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
    }
    async assertSourceStillCurrent(source) {
        const current = await this.options.vault.getNote(source.note.frontmatter.id);
        if (current.driveId !== source.driveId || current.version !== source.version || current.checksum !== source.checksum ||
            current.path !== source.path || current.source !== source.source)
            throw new ApiResponseError("CONFLICT");
    }
    assertExpectedSource(source, expectedVersion) {
        if (source.version !== expectedVersion || source.note.frontmatter.id.length === 0 || source.checksum !== sha256(new TextEncoder().encode(source.source))) {
            throw new ApiResponseError(source.version === expectedVersion ? "DRIVE_UNAVAILABLE" : "CONFLICT");
        }
    }
    assertNoteId(value) {
        try {
            NoteIdSchema.parse(value);
        }
        catch {
            throw new ApiResponseError("INVALID_INPUT");
        }
    }
    assertPublicId(value) {
        try {
            PublicIdSchema.parse(value);
        }
        catch {
            throw new ApiResponseError("INVALID_INPUT");
        }
    }
    assertVersion(value) {
        if (typeof value !== "string" || value.length === 0 || value.length > 512 ||
            [...value].some((character) => {
                const code = character.codePointAt(0);
                return code <= 31 || code === 127;
            }))
            throw new ApiResponseError("INVALID_INPUT");
    }
    id() {
        const value = this.options.createId?.() ?? randomBytes(16).toString("base64url");
        try {
            return PublicIdSchema.parse(value);
        }
        catch {
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        }
    }
    context() { return { operationBudget: new StorageOperationBudget(MAX_STORAGE_OPERATIONS) }; }
    now() { return this.options.now?.() ?? new Date(); }
}
export class PublicPublicationReader {
    options;
    constructor(options) {
        this.options = options;
    }
    async getNote(publicId) {
        try {
            this.assertId(publicId);
            const context = this.context();
            const { entry, revision } = await this.resolve(publicId, context);
            await this.verifySnapshotFolders(entry, revision, context);
            const readback = await this.options.storage.readBytes(revision.noteSnapshotDriveId, context);
            if (!snapshotFileMatches(readback.file, {
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
            }) || readback.bytes.byteLength !== revision.noteSize || readback.checksum !== revision.noteChecksum || sha256(readback.bytes) !== revision.noteChecksum)
                throw new Error("invalid public note snapshot");
            const source = new TextDecoder("utf-8", { fatal: true }).decode(readback.bytes);
            const parsed = PublicNoteResponseSchema.parse(JSON.parse(source));
            const expectedAssets = revision.assets.map((asset) => ({
                assetId: asset.assetId,
                url: `/api/public/assets/${publicId}/${asset.assetId}`,
                name: asset.fileName,
                mimeType: asset.mimeType,
                disposition: asset.disposition
            }));
            if (parsed.publishedAt !== revision.publishedAt || JSON.stringify(parsed.assets) !== JSON.stringify(expectedAssets))
                throw new Error("public note projection mismatch");
            if (revision.assets.reduce((total, asset) => total + asset.size, 0) > MAX_PUBLICATION_TOTAL_ASSET_BYTES)
                throw new Error("public asset snapshot is too large");
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
        }
        catch {
            return null;
        }
    }
    async getAsset(publicId, assetId) {
        try {
            this.assertId(publicId);
            this.assertId(assetId);
            const context = this.context();
            const { entry, revision } = await this.resolve(publicId, context);
            await this.verifySnapshotFolders(entry, revision, context);
            const asset = revision.assets.find((candidate) => candidate.assetId === assetId);
            if (asset === undefined)
                throw new Error("asset is not allowlisted");
            return await this.readVerifiedAsset(publicId, revision, asset, context);
        }
        catch {
            throw new ApiResponseError("NOT_FOUND");
        }
    }
    async readVerifiedAsset(publicId, revision, asset, context) {
        const readback = await this.options.storage.readBytes(asset.snapshotDriveId, context);
        if (!snapshotFileMatches(readback.file, {
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
            sha256(readback.bytes) !== asset.checksum || asset.size > MAX_ATTACHMENT_BYTES)
            throw new Error("invalid public asset snapshot");
        const detected = await detectAttachment({ name: asset.fileName, declaredMime: readback.file.mimeType, bytes: readback.bytes });
        if (detected.mimeType !== asset.mimeType)
            throw new Error("public asset MIME changed");
        return {
            bytes: Uint8Array.from(readback.bytes),
            name: asset.fileName,
            mimeType: detected.mimeType,
            disposition: safeAttachmentDisposition(asset.disposition, detected)
        };
    }
    async resolve(publicId, context) {
        const manifest = await this.options.manifestStore.read(context);
        const entry = manifest.value.entries.find((candidate) => candidate.publicId === publicId);
        if (entry === undefined)
            throw new Error("unknown public ID");
        return { entry, revision: activeRevision(entry) };
    }
    async verifySnapshotFolders(entry, revision, context) {
        const privateRoot = await this.options.storage.get(this.options.privateRootId, context);
        const published = await this.options.storage.get(this.options.publishedRootId, context);
        const publicFolder = await this.options.storage.get(entry.publicFolderId, context);
        const revisionFolder = await this.options.storage.get(revision.snapshotFolderId, context);
        const assetsFolder = await this.options.storage.get(revision.assetsFolderId, context);
        if (privateRoot.id !== this.options.privateRootId || privateRoot.parentIds.length !== 0 || privateRoot.mimeType !== FOLDER_MIME_TYPE || privateRoot.trashed ||
            published.id !== this.options.publishedRootId || published.name !== "published" || published.parentIds.length !== 1 || published.parentIds[0] !== privateRoot.id || published.mimeType !== FOLDER_MIME_TYPE || published.trashed ||
            !folderMatches(publicFolder, published.id, entry.publicId, publicationMarker(entry.publicId, "public"), "public", entry.publicId) || publicFolder.version !== entry.publicFolderVersion ||
            !folderMatches(revisionFolder, publicFolder.id, revision.revisionId, revision.snapshotMarker, "revision", entry.publicId, revision.operationId) || revisionFolder.version !== revision.snapshotFolderVersion ||
            !folderMatches(assetsFolder, revisionFolder.id, "assets", revision.assetsMarker, "assets", entry.publicId, revision.operationId) || assetsFolder.version !== revision.assetsFolderVersion)
            throw new Error("invalid public snapshot ancestry");
    }
    assertId(value) { PublicIdSchema.parse(value); }
    context() { return { operationBudget: new StorageOperationBudget(MAX_STORAGE_OPERATIONS) }; }
}
const activeRevision = (entry) => {
    const revision = entry.revisions.find((candidate) => candidate.revisionId === entry.activeRevisionId);
    if (revision === undefined)
        throw new ApiResponseError("DRIVE_UNAVAILABLE");
    return revision;
};
const bumpManifest = (manifest, changes) => ({
    ...manifest,
    ...changes,
    generation: manifest.generation + 1
});
const boundedCleanup = (records) => {
    const byId = new Map();
    for (const record of records) {
        const existing = byId.get(record.cleanupId);
        if (existing !== undefined && !sameCleanupRecord(existing, record))
            throw new ApiResponseError("CONFLICT");
        byId.set(record.cleanupId, record);
    }
    if (byId.size > MAX_CLEANUP_RECORDS)
        throw new ApiResponseError("CONFLICT");
    return [...byId.values()];
};
const cleanupForOperation = (operation, queuedAt, cleanupId) => operation.revisionFolderId !== null && operation.revisionFolderVersion !== null && operation.revisionMarker !== null &&
    operation.revisionId !== null && operation.publicFolderId !== null
    ? [{
            ...revisionCleanupArtifact(operation.publicId, operation.operationId, operation.revisionId, operation.revisionMarker, { id: operation.revisionFolderId, version: operation.revisionFolderVersion }, operation.publicFolderId),
            cleanupId,
            queuedAt
        }]
    : [];
const publicRootCleanupArtifact = (publicId, folder, publishedRootId) => ({
    publicId,
    folderId: folder.id,
    expectedVersion: folder.version,
    marker: publicationMarker(publicId, "public"),
    kind: "public-root",
    ownershipVersion: 1,
    parentFolderId: publishedRootId,
    folderName: publicId,
    operationId: null
});
const revisionCleanupArtifact = (publicId, operationId, revisionId, marker, folder, publicFolderId) => ({
    publicId,
    folderId: folder.id,
    expectedVersion: folder.version,
    marker,
    kind: "revision",
    ownershipVersion: 1,
    parentFolderId: publicFolderId,
    folderName: revisionId,
    operationId
});
const revisionCleanupRecord = (input) => ({
    ...revisionCleanupArtifact(input.publicId, input.operationId, input.revisionId, input.marker, { id: input.folderId, version: input.folderVersion }, input.publicFolderId),
    cleanupId: input.cleanupId,
    queuedAt: input.queuedAt
});
const publicationCausality = (manifest, noteId) => {
    const active = manifest.entries.find((entry) => entry.sourceNoteId === noteId);
    const tombstone = manifest.tombstones.find((entry) => entry.sourceNoteId === noteId);
    const predecessor = active === undefined
        ? tombstone === undefined ? null : {
            kind: "tombstone",
            value: {
                publicId: tombstone.publicId,
                sourceNoteId: tombstone.sourceNoteId,
                epoch: tombstone.epoch,
                publicFolderId: tombstone.publicFolderId,
                publicFolderVersion: tombstone.publicFolderVersion,
                revokedAt: tombstone.revokedAt
            }
        }
        : { kind: "entry", value: active };
    const operations = manifest.operations
        .filter((operation) => operation.sourceNoteId === noteId)
        .map((operation) => operation)
        .sort((left, right) => left.operationId < right.operationId ? -1 : left.operationId > right.operationId ? 1 : 0);
    const identity = createHash("sha256")
        .update(JSON.stringify({ predecessor, operations }), "utf8")
        .digest("hex");
    return { generation: manifest.generation, identity };
};
const samePublicationCausality = (left, right) => left.generation === right.generation && left.identity === right.identity;
const takeUniqueIdentifiers = (candidates, count, used) => {
    if (count === 0)
        return [];
    const selected = [];
    for (const candidate of candidates) {
        if (used.has(candidate))
            continue;
        used.add(candidate);
        selected.push(candidate);
        if (selected.length === count)
            break;
    }
    return selected;
};
const manifestCleanupRecords = (manifest) => [
    ...manifest.cleanup,
    ...manifest.tombstones.flatMap((tombstone) => tombstone.cleanup)
];
const findManifestCleanup = (manifest, cleanupId) => manifestCleanupRecords(manifest).find((cleanup) => cleanup.cleanupId === cleanupId);
const sameCleanupRecord = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const operationCanBeRecovered = (operation, now) => {
    const startedAt = Date.parse(operation.startedAt);
    const observedAt = Date.parse(now);
    return Number.isFinite(startedAt) && Number.isFinite(observedAt) && observedAt - startedAt >= OPERATION_RECOVERY_AFTER_MS;
};
const manifestIdentifierSet = (manifest) => {
    const ids = new Set();
    for (const entry of manifest.entries) {
        ids.add(entry.publicId);
        for (const revision of entry.revisions) {
            ids.add(revision.operationId);
            revision.assets.forEach((asset) => ids.add(asset.assetId));
        }
    }
    manifest.tombstones.forEach((tombstone) => {
        ids.add(tombstone.publicId);
        tombstone.cleanup.forEach((cleanup) => ids.add(cleanup.cleanupId));
    });
    manifest.operations.forEach((operation) => { ids.add(operation.operationId); ids.add(operation.publicId); });
    manifest.cleanup.forEach((cleanup) => ids.add(cleanup.cleanupId));
    return ids;
};
const manifestReferencesFolder = (manifest, folderId) => manifest.entries.some((entry) => entry.publicFolderId === folderId || entry.revisions.some((revision) => revision.snapshotFolderId === folderId || revision.assetsFolderId === folderId)) || manifest.tombstones.some((tombstone) => tombstone.publicFolderId === folderId) ||
    manifest.operations.some((operation) => operation.publicFolderId === folderId || operation.revisionFolderId === folderId);
const publicationMarker = (ownerId, kind) => `pm1.${ownerId}.${kind}`;
const publicationProperties = (marker, kind, publicId, operationId, assetId) => ({
    nxtPublicationMarker: marker,
    nxtPublicationKind: kind,
    nxtPublicationPublicId: publicId,
    ...(operationId === undefined ? {} : { nxtPublicationOperation: operationId }),
    ...(assetId === undefined ? {} : { nxtPublicationAssetId: assetId })
});
const markerMatches = (file, marker, kind, publicId, operationId, assetId) => file.appProperties?.nxtPublicationMarker === marker && file.appProperties?.nxtPublicationKind === kind &&
    file.appProperties?.nxtPublicationPublicId === publicId &&
    (operationId === undefined || file.appProperties?.nxtPublicationOperation === operationId) &&
    (assetId === undefined || file.appProperties?.nxtPublicationAssetId === assetId);
const folderMatches = (file, parentId, name, marker, kind, publicId, operationId) => file.name === name && file.mimeType === FOLDER_MIME_TYPE && !file.trashed && file.parentIds.length === 1 && file.parentIds[0] === parentId &&
    markerMatches(file, marker, kind, publicId, operationId);
const cleanupFolderMatches = (file, cleanup, trashed) => cleanup.parentFolderId !== null && cleanup.folderName !== null &&
    file.id === cleanup.folderId && file.name === cleanup.folderName && file.mimeType === FOLDER_MIME_TYPE &&
    file.trashed === trashed && file.parentIds.length === 1 && file.parentIds[0] === cleanup.parentFolderId &&
    file.appProperties?.nxtPublicationAssetId === undefined &&
    (cleanup.kind === "revision"
        ? file.appProperties?.nxtPublicationOperation === cleanup.operationId
        : file.appProperties?.nxtPublicationOperation === undefined) &&
    markerMatches(file, cleanup.marker, cleanup.kind === "public-root" ? "public" : "revision", cleanup.publicId, cleanup.kind === "revision" ? cleanup.operationId ?? undefined : undefined);
const snapshotFileMatches = (file, expected) => file.id === expected.id && file.parentIds.length === 1 && file.parentIds[0] === expected.parentId && file.name === expected.name &&
    file.mimeType === expected.mimeType && file.size === expected.size && file.version === expected.version && !file.trashed &&
    file.mimeType !== FOLDER_MIME_TYPE && file.mimeType !== SHORTCUT_MIME_TYPE &&
    markerMatches(file, expected.marker, expected.kind, expected.publicId, expected.operationId, expected.assetId);
const snapshotAssetName = (assetId, originalName) => {
    const index = originalName.lastIndexOf(".");
    const extension = index > 0 && /^[.][a-z0-9]{1,16}$/iu.test(originalName.slice(index))
        ? originalName.slice(index).toLocaleLowerCase("en-US")
        : "";
    return `${assetId}${extension}`;
};
const sameOperationSource = (left, right) => left.operationId === right.operationId && left.publicId === right.publicId && left.sourceNoteId === right.sourceNoteId &&
    left.epoch === right.epoch && left.startedAt === right.startedAt && left.sourceVersion === right.sourceVersion &&
    left.sourceChecksum === right.sourceChecksum && left.sourcePath === right.sourcePath && left.cleanupSlots === right.cleanupSlots;
const sameOperationState = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const equalBytes = (left, right) => left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
const toPrivateApiError = (error) => {
    if (error instanceof ApiResponseError || error instanceof StorageOperationBudgetExceededError)
        return error;
    if (error instanceof StorageVersionConflictError)
        return new ApiResponseError("CONFLICT");
    return new ApiResponseError("DRIVE_UNAVAILABLE");
};
//# sourceMappingURL=publication-service.js.map