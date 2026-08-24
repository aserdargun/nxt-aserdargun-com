import { createHash, randomBytes, randomUUID } from "node:crypto";
import { NoteIdSchema } from "@nxt/contracts";
import { attachmentIsReferenced, projectionReferencesAttachment } from "@nxt/domain";
import { ApiResponseError } from "../http/api-response.js";
import { StorageMutationNotAppliedError, StorageMutationOutcomeUnknownError, StorageOperationBudget, StorageOperationBudgetExceededError, StorageVersionConflictError } from "../storage/storage-port.js";
import { preserveApiError } from "./system-file-store.js";
import { MAX_ATTACHMENT_BYTES, assertAttachmentDeclaration, detectAttachment, normalizeAttachmentName, resolveAttachmentName } from "./attachment-policy.js";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const SHORTCUT_MIME_TYPE = "application/vnd.google-apps.shortcut";
const MAX_LIST_PAGES = 20;
const MAX_DRIVE_OPERATIONS = 80;
const MAX_RECOVERY_MUTATIONS = 8;
const MUTATION_TTL_MS = 15 * 60 * 1_000;
export class AttachmentService {
    options;
    ownerId = randomUUID();
    noteOperations = new Map();
    constructor(options) {
        this.options = options;
    }
    upload(input) {
        return this.serialize(input.noteId, () => this.uploadUnserialized(input));
    }
    async read(assetId) {
        return this.readInternal(assetId);
    }
    async readForNote(input) {
        const indexed = await this.findAttachment(input.assetId);
        if (indexed.noteId !== input.noteId)
            throw new ApiResponseError("NOT_FOUND");
        return this.readInternal(input.assetId, indexed);
    }
    trash(input) {
        return this.trashUnserialized(input);
    }
    async uploadUnserialized(input) {
        this.assertNoteId(input.noteId);
        if (!(input.bytes instanceof Uint8Array))
            throw new ApiResponseError("INVALID_INPUT");
        if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES)
            throw new ApiResponseError("TOO_LARGE");
        assertAttachmentDeclaration(input.declaredMime);
        await this.reconcileRecoverableMutations();
        const context = this.context();
        const owner = await this.getOwnedNote(input.noteId);
        const folder = await this.assetFolder(input.noteId, context);
        const name = resolveAttachmentName(normalizeAttachmentName(input.name), (await this.listAll(folder.id, context)).map((file) => file.name));
        const detected = await detectAttachment({ name, declaredMime: input.declaredMime, bytes: input.bytes });
        const marker = `am1.${randomBytes(16).toString("base64url")}`;
        const mutation = this.newMutation({
            operation: "create-attachment",
            noteId: input.noteId,
            parentId: folder.id,
            targetName: name,
            expectedChecksum: checksum(input.bytes),
            attachmentMimeType: detected.mimeType,
            attachmentSize: input.bytes.byteLength,
            attachmentDisposition: detected.disposition,
            attachmentMarker: marker
        });
        await this.reserve(mutation);
        let createdId;
        try {
            const inflight = await this.beginDriveMutation(mutation.id, mutation.fence);
            await this.assertOwnedMutation(inflight, "drive-inflight");
            const created = await this.options.storage.createBytes({ parentId: folder.id, name, mimeType: detected.mimeType, bytes: input.bytes, appProperties: { nxtAttachmentMutation: marker } }, context);
            createdId = created.id;
            const applied = await this.markDriveApplied(mutation.id, inflight.fence, created.id);
            const verified = await this.verifyReadback({
                driveId: created.id,
                noteId: input.noteId,
                folderId: folder.id,
                attachment: { driveId: created.id, name, mimeType: detected.mimeType, size: input.bytes.byteLength, checksum: checksum(input.bytes), disposition: detected.disposition, version: created.version, marker },
                context
            });
            const result = {
                driveId: verified.file.id,
                name,
                mimeType: verified.mimeType,
                size: verified.file.size,
                checksum: verified.checksum,
                disposition: detected.disposition,
                version: verified.file.version,
                marker
            };
            await this.finalizeUpload(mutation.id, applied.fence, input.noteId, result, owner.driveId);
            return result;
        }
        catch (error) {
            await this.handleFailure(mutation.id, error, createdId, createdId === undefined);
            throw toApiError(error);
        }
    }
    async readInternal(assetId, indexed) {
        await this.reconcileRecoverableMutations();
        const target = indexed ?? await this.findAttachment(assetId);
        const owner = await this.getOwnedNote(target.noteId);
        const context = this.context();
        const folder = await this.assetFolder(target.noteId, context);
        const record = this.toRecord(target.attachment);
        const verified = await this.verifyReadback({
            driveId: assetId,
            noteId: target.noteId,
            folderId: folder.id,
            attachment: record,
            context
        });
        if (owner.driveId.length === 0)
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        return {
            bytes: verified.bytes,
            name: record.name,
            mimeType: verified.mimeType,
            disposition: record.disposition
        };
    }
    async trashUnserialized(input) {
        await this.reconcileRecoverableMutations();
        const indexed = await this.findAttachment(input.assetId);
        return this.serialize(indexed.noteId, async () => {
            const current = await this.findAttachment(input.assetId);
            const owner = await this.getOwnedNote(current.noteId);
            const record = this.toRecord(current.attachment);
            const preflight = await this.assertAttachmentUnreferenced({
                noteId: current.noteId,
                name: record.name,
                ...(input.referenceId === undefined ? {} : { opaqueId: input.referenceId }),
                owner
            });
            const context = this.context();
            const folder = await this.assetFolder(current.noteId, context);
            const readback = await this.verifyReadback({ driveId: input.assetId, noteId: current.noteId, folderId: folder.id, attachment: record, context });
            const mutation = this.newMutation({
                operation: "trash-attachment",
                noteId: current.noteId,
                driveId: input.assetId,
                parentId: folder.id,
                targetName: record.name,
                expectedChecksum: record.checksum,
                originalChecksum: owner.checksum,
                oldPath: owner.path,
                expectedVersion: readback.file.version,
                preflightGeneration: preflight.generation,
                attachmentMimeType: record.mimeType,
                attachmentSize: record.size,
                attachmentDisposition: record.disposition,
                attachmentReferenceId: input.referenceId,
                attachmentMarker: record.marker
            });
            await this.reserve(mutation);
            let driveStarted = false;
            try {
                const reserved = await this.assertTrashReservationCurrent(mutation, record, input.referenceId);
                const inflight = await this.beginDriveMutation(mutation.id, reserved.fence);
                await this.assertOwnedMutation(inflight, "drive-inflight");
                driveStarted = true;
                const trashed = await this.options.storage.trash(input.assetId, context, record.version);
                if (trashed.id !== input.assetId || !trashed.trashed || trashed.name !== record.name ||
                    trashed.parentIds.length !== 1 || trashed.parentIds[0] !== folder.id || trashed.mimeType !== record.mimeType ||
                    trashed.size !== record.size || trashed.appProperties?.nxtAttachmentMutation !== record.marker || trashed.version === record.version)
                    throw new ApiResponseError("DRIVE_UNAVAILABLE");
                const applied = await this.markDriveApplied(mutation.id, inflight.fence, input.assetId);
                await this.applyTrashProjection(mutation.id, applied.fence, current.noteId, input.assetId);
                await this.clearMutation(mutation.id, applied.fence);
                return { trashed: true };
            }
            catch (error) {
                await this.handleFailure(mutation.id, error, input.assetId, !driveStarted);
                throw toApiError(error);
            }
        });
    }
    async findAttachment(assetId) {
        if (typeof assetId !== "string" || assetId.length === 0 || assetId.length > 512)
            throw new ApiResponseError("INVALID_INPUT");
        const index = await this.options.indexStore.read();
        const found = index.value.entries.flatMap((entry) => entry.attachments
            .filter((attachment) => attachment.driveId === assetId)
            .map((attachment) => ({ noteId: entry.id, attachment })));
        if (found.length === 0)
            throw new ApiResponseError("NOT_FOUND");
        if (found.length !== 1)
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        return found[0];
    }
    async getOwnedNote(noteId) {
        this.assertNoteId(noteId);
        try {
            const result = await this.options.vault.getNote(noteId);
            if (result.note.frontmatter.id !== noteId || result.driveId.length === 0 || result.checksum !== checksum(new TextEncoder().encode(result.source))) {
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            }
            return result;
        }
        catch (error) {
            throw preserveApiError(error, "DRIVE_UNAVAILABLE");
        }
    }
    async assertAttachmentUnreferenced(input) {
        const index = await this.options.indexStore.read();
        if (this.indexReferencesAttachment(index.value, input.noteId, input.name, input.opaqueId) || attachmentIsReferenced({
            source: input.owner.source,
            notePath: input.owner.path,
            noteId: input.noteId,
            name: input.name,
            ...(input.opaqueId === undefined ? {} : { opaqueId: input.opaqueId })
        }))
            throw new ApiResponseError("CONFLICT");
        return { generation: index.value.generation };
    }
    indexReferencesAttachment(index, noteId, name, opaqueId) {
        return index.entries.some((entry) => entry.id !== noteId && projectionReferencesAttachment(entry.attachmentReferences, { noteId, name, ...(opaqueId === undefined ? {} : { opaqueId }) }));
    }
    async assertTrashReservationCurrent(mutation, record, opaqueId) {
        const owner = await this.getOwnedNote(mutation.noteId);
        if (owner.checksum !== mutation.originalChecksum || owner.path !== mutation.oldPath)
            throw new ApiResponseError("CONFLICT");
        const index = await this.options.indexStore.read();
        const reservation = index.value.pendingMutations.find((candidate) => candidate.id === mutation.id);
        if (reservation === undefined || reservation.ownerId !== this.ownerId || reservation.fence !== mutation.fence ||
            reservation.phase !== "reserved" || this.indexReferencesAttachment(index.value, mutation.noteId, record.name, opaqueId) ||
            attachmentIsReferenced({ source: owner.source, notePath: owner.path, noteId: mutation.noteId, name: record.name, ...(opaqueId === undefined ? {} : { opaqueId }) }))
            throw new ApiResponseError("CONFLICT");
        return reservation;
    }
    async assetFolder(noteId, context) {
        const root = await this.getActiveFolder(this.options.assetsRootId, context);
        if (root.name !== "_assets" || root.parentIds.length !== 1)
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        const matching = (await this.listAll(root.id, context)).filter((file) => sameName(file.name, noteId) && !file.trashed);
        if (matching.length > 1)
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        if (matching.length === 1) {
            const folder = matching[0];
            this.assertExactChildFolder(folder, root.id, noteId);
            return folder;
        }
        let created;
        try {
            created = await this.options.storage.createFolder({ parentId: root.id, name: noteId }, context);
        }
        catch (error) {
            throw preserveApiError(error, "DRIVE_UNAVAILABLE");
        }
        try {
            const readback = await this.options.storage.get(created.id, context);
            this.assertExactChildFolder(readback, root.id, noteId);
            return readback;
        }
        catch (error) {
            throw preserveApiError(error, "DRIVE_UNAVAILABLE");
        }
    }
    /** Recovery must never recreate a parent while deciding an old mutation. */
    async existingAssetFolder(noteId, context) {
        const root = await this.getActiveFolder(this.options.assetsRootId, context);
        if (root.name !== "_assets" || root.parentIds.length !== 1)
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        const matching = (await this.listAll(root.id, context)).filter((file) => !file.trashed && sameName(file.name, noteId));
        if (matching.length !== 1)
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        const folder = matching[0];
        this.assertExactChildFolder(folder, root.id, noteId);
        return folder;
    }
    async getActiveFolder(fileId, context) {
        try {
            const file = await this.options.storage.get(fileId, context);
            if (file.trashed || file.mimeType !== FOLDER_MIME_TYPE || file.parentIds.length > 1)
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            return file;
        }
        catch (error) {
            throw preserveApiError(error, "DRIVE_UNAVAILABLE");
        }
    }
    assertExactChildFolder(file, parentId, name) {
        if (file.trashed || file.mimeType !== FOLDER_MIME_TYPE || file.name !== name || file.parentIds.length !== 1 || file.parentIds[0] !== parentId) {
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        }
    }
    async verifyReadback(input) {
        let readback;
        try {
            const metadata = await this.options.storage.get(input.driveId, input.context);
            if (metadata.size > MAX_ATTACHMENT_BYTES)
                throw new ApiResponseError("TOO_LARGE");
            readback = await this.options.storage.readBytes(input.driveId, input.context);
            if (metadata.id !== readback.file.id || metadata.version !== readback.file.version)
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
        }
        catch (error) {
            throw preserveApiError(error, "DRIVE_UNAVAILABLE");
        }
        const { file, bytes, checksum: readbackChecksum } = readback;
        if (file.trashed || file.mimeType === FOLDER_MIME_TYPE || file.mimeType === SHORTCUT_MIME_TYPE ||
            file.parentIds.length !== 1 || file.parentIds[0] !== input.folderId || file.name !== input.attachment.name ||
            file.size !== input.attachment.size || file.size !== bytes.byteLength || bytes.byteLength > MAX_ATTACHMENT_BYTES ||
            readbackChecksum !== checksum(bytes) || readbackChecksum !== input.attachment.checksum ||
            (input.attachment.version !== undefined && file.version !== input.attachment.version) ||
            (input.attachment.marker !== undefined && file.appProperties?.nxtAttachmentMutation !== input.attachment.marker))
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        const detected = await detectAttachment({ name: file.name, declaredMime: file.mimeType, bytes });
        if (detected.mimeType !== input.attachment.mimeType || file.mimeType !== input.attachment.mimeType) {
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        }
        if (input.attachment.disposition === "inline" && detected.disposition !== "inline")
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        return { file, bytes, checksum: readbackChecksum, mimeType: detected.mimeType };
    }
    toRecord(attachment) {
        if (attachment.checksum === undefined || attachment.disposition === undefined || attachment.version === undefined || attachment.marker === undefined)
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        if (attachment.size > MAX_ATTACHMENT_BYTES)
            throw new ApiResponseError("TOO_LARGE");
        return { driveId: attachment.driveId, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size, checksum: attachment.checksum, disposition: attachment.disposition, version: attachment.version, marker: attachment.marker };
    }
    newMutation(changes) {
        const now = this.now();
        return {
            id: this.options.createId?.() ?? randomUUID(),
            ...changes,
            ownerId: this.ownerId,
            fence: 1,
            phase: "reserved",
            createdAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + MUTATION_TTL_MS).toISOString()
        };
    }
    async reserve(mutation) {
        await this.options.indexStore.compareAndSet((index) => {
            if (!index.entries.some((entry) => entry.id === mutation.noteId))
                throw new ApiResponseError("NOT_FOUND");
            if (mutation.operation === "trash-attachment") {
                if (mutation.preflightGeneration !== index.generation ||
                    this.indexReferencesAttachment(index, mutation.noteId, mutation.targetName, mutation.attachmentReferenceId) ||
                    index.pendingMutations.some((candidate) => candidate.phase !== "conflicted" && (candidate.operation === "create-note" || candidate.operation === "update-note" || candidate.operation === "move-note"))) {
                    throw new ApiResponseError("CONFLICT");
                }
            }
            if (index.pendingMutations.some((candidate) => candidate.noteId === mutation.noteId || (candidate.parentId === mutation.parentId && candidate.targetName === mutation.targetName))) {
                throw new ApiResponseError("CONFLICT");
            }
            if (mutation.operation === "create-attachment" && index.entries.some((entry) => entry.id === mutation.noteId && entry.attachments.some((attachment) => sameName(attachment.name, mutation.targetName)))) {
                throw new ApiResponseError("CONFLICT");
            }
            return bump(index, { pendingMutations: [...index.pendingMutations, mutation] });
        });
    }
    async beginDriveMutation(mutationId, expectedFence) {
        return this.updateMutation(mutationId, expectedFence, (mutation) => ({
            ...mutation,
            phase: "drive-inflight",
            expiresAt: new Date(this.now().getTime() + MUTATION_TTL_MS).toISOString(),
            reconcileAfter: new Date(this.now().getTime() + MUTATION_TTL_MS).toISOString()
        }));
    }
    async markDriveApplied(mutationId, expectedFence, driveId) {
        return this.updateMutation(mutationId, expectedFence, (mutation) => ({ ...mutation, driveId, phase: "drive-applied", reconcileAfter: new Date(this.now().getTime() + MUTATION_TTL_MS).toISOString() }));
    }
    async updateMutation(mutationId, expectedFence, update) {
        await this.options.indexStore.compareAndSet((index) => {
            const found = index.pendingMutations.find((mutation) => mutation.id === mutationId && mutation.ownerId === this.ownerId && (expectedFence === undefined || mutation.fence === expectedFence));
            if (found === undefined)
                throw new ApiResponseError("CONFLICT");
            return bump(index, { pendingMutations: index.pendingMutations.map((mutation) => mutation.id === mutationId ? update(found) : mutation) });
        });
        const current = await this.options.indexStore.read();
        const committed = current.value.pendingMutations.find((mutation) => mutation.id === mutationId && mutation.ownerId === this.ownerId && (expectedFence === undefined || mutation.fence === expectedFence));
        if (committed === undefined)
            throw new ApiResponseError("CONFLICT");
        return committed;
    }
    async assertOwnedMutation(mutation, phase) {
        const index = await this.options.indexStore.read();
        const current = index.value.pendingMutations.find((candidate) => candidate.id === mutation.id && candidate.ownerId === this.ownerId && candidate.fence === mutation.fence);
        if (current === undefined || (phase !== undefined && current.phase !== phase))
            throw new ApiResponseError("CONFLICT");
        return current;
    }
    async finalizeUpload(mutationId, expectedFence, noteId, record, expectedNoteDriveId) {
        await this.options.indexStore.compareAndSet((index) => {
            const mutation = index.pendingMutations.find((candidate) => candidate.id === mutationId && candidate.ownerId === this.ownerId && candidate.fence === expectedFence && candidate.phase === "drive-applied");
            const entry = index.entries.find((candidate) => candidate.id === noteId);
            if (mutation === undefined || entry === undefined || entry.driveId !== expectedNoteDriveId || entry.attachments.some((attachment) => attachment.driveId === record.driveId || sameName(attachment.name, record.name))) {
                throw new ApiResponseError("CONFLICT");
            }
            const attachment = { ...record };
            return bump(index, {
                entries: index.entries.map((candidate) => candidate.id === noteId ? { ...candidate, attachments: [...candidate.attachments, attachment] } : candidate),
                pendingMutations: index.pendingMutations.filter((candidate) => candidate.id !== mutationId)
            });
        });
    }
    async applyTrashProjection(mutationId, expectedFence, noteId, assetId) {
        await this.options.indexStore.compareAndSet((index) => {
            const mutation = index.pendingMutations.find((candidate) => candidate.id === mutationId && candidate.ownerId === this.ownerId && candidate.fence === expectedFence && candidate.phase === "drive-applied");
            if (mutation === undefined)
                throw new ApiResponseError("CONFLICT");
            return bump(index, {
                entries: index.entries.map((entry) => entry.id === noteId ? { ...entry, attachments: entry.attachments.filter((attachment) => attachment.driveId !== assetId) } : entry),
                pendingMutations: index.pendingMutations.map((candidate) => candidate.id === mutationId ? { ...candidate, phase: "index-applied" } : candidate)
            });
        });
    }
    async clearMutation(mutationId, expectedFence) {
        await this.options.indexStore.compareAndSet((index) => {
            const current = index.pendingMutations.find((candidate) => candidate.id === mutationId);
            if (current === undefined)
                return index;
            if (current.ownerId !== this.ownerId || (expectedFence !== undefined && current.fence !== expectedFence))
                throw new ApiResponseError("CONFLICT");
            return bump(index, { pendingMutations: index.pendingMutations.filter((candidate) => candidate.id !== mutationId) });
        });
    }
    async handleFailure(mutationId, error, knownDriveId, knownNotApplied = false) {
        if (knownNotApplied && error instanceof ApiResponseError) {
            await this.clearMutation(mutationId).catch(() => undefined);
            return;
        }
        if (error instanceof StorageMutationNotAppliedError) {
            await this.clearMutation(mutationId).catch(() => undefined);
            return;
        }
        const driveId = error instanceof StorageMutationOutcomeUnknownError ? error.fileId ?? knownDriveId : knownDriveId;
        await this.options.indexStore.compareAndSet((index) => {
            const current = index.pendingMutations.find((mutation) => mutation.id === mutationId);
            if (current === undefined)
                return index;
            return bump(index, {
                pendingMutations: index.pendingMutations.map((mutation) => mutation.id === mutationId ? {
                    ...mutation,
                    ...(driveId === undefined ? {} : { driveId }),
                    phase: mutation.phase === "drive-applied" || mutation.phase === "index-applied" ? mutation.phase : "outcome-unknown",
                    expiresAt: new Date(this.now().getTime() + MUTATION_TTL_MS).toISOString(),
                    reconcileAfter: this.now().toISOString()
                } : mutation)
            });
        }).catch(() => undefined);
    }
    async reconcileRecoverableMutations() {
        const snapshot = await this.options.indexStore.read();
        const now = this.now().getTime();
        const mutations = snapshot.value.pendingMutations.filter((mutation) => {
            if (mutation.operation !== "create-attachment" && mutation.operation !== "trash-attachment")
                return false;
            if (mutation.phase === "conflicted")
                return false;
            return Date.parse(mutation.reconcileAfter ?? mutation.expiresAt) <= now;
        }).sort((left, right) => Date.parse(left.reconcileAfter ?? left.expiresAt) - Date.parse(right.reconcileAfter ?? right.expiresAt)).slice(0, MAX_RECOVERY_MUTATIONS);
        for (const candidate of mutations) {
            const mutation = await this.claimRecovery(candidate);
            if (mutation === undefined)
                continue;
            if (mutation.operation === "create-attachment")
                await this.reconcileUpload(mutation);
            else
                await this.reconcileTrash(mutation);
        }
    }
    async claimRecovery(candidate) {
        const lease = new Date(this.now().getTime() + MUTATION_TTL_MS).toISOString();
        await this.options.indexStore.compareAndSet((index) => {
            const current = index.pendingMutations.find((mutation) => mutation.id === candidate.id);
            if (current === undefined || current.fence !== candidate.fence)
                return index;
            const claimed = {
                ...current,
                ownerId: this.ownerId,
                fence: current.fence + 1,
                phase: current.phase === "drive-inflight" ? "outcome-unknown" : current.phase,
                expiresAt: lease,
                reconcileAfter: lease
            };
            return bump(index, { pendingMutations: index.pendingMutations.map((mutation) => mutation.id === candidate.id ? claimed : mutation) });
        }).catch(() => undefined);
        const committed = await this.options.indexStore.read();
        const claimed = committed.value.pendingMutations.find((mutation) => mutation.id === candidate.id && mutation.ownerId === this.ownerId && mutation.fence === candidate.fence + 1);
        return claimed;
    }
    async reconcileUpload(mutation) {
        if (!this.hasUploadIdentity(mutation))
            return;
        if (mutation.phase === "reserved") {
            // No phase boundary reached Drive: never inspect/adopt an identically
            // named file that appeared while this reservation expired.
            await this.clearOwnedMutation(mutation);
            return;
        }
        const context = this.context();
        try {
            await this.assertOwnedMutation(mutation);
            const folder = await this.existingAssetFolder(mutation.noteId, context);
            if (folder.id !== mutation.parentId)
                return;
            const candidates = (await this.listAll(folder.id, context)).filter((file) => !file.trashed && sameName(file.name, mutation.targetName));
            if (candidates.length === 0) {
                await this.rescheduleUnknownUpload(mutation);
                return;
            }
            if (mutation.driveId !== undefined && !candidates.some((candidate) => candidate.id === mutation.driveId))
                return;
            const exact = [];
            for (const candidate of candidates) {
                const record = await this.recoverExactUploadRecord(mutation, candidate.id, folder.id, context);
                if (record !== undefined)
                    exact.push(record);
            }
            if (exact.length === 1 && candidates.length === 1) {
                const record = exact[0];
                const projection = await this.uploadProjectionState(mutation, record);
                if (projection === "already-applied") {
                    await this.clearOwnedMutation(mutation);
                    return;
                }
                if (projection === "name-conflict") {
                    await this.assertOwnedMutation(mutation);
                    const trashed = await this.options.storage.trash(record.driveId, context, record.version);
                    if (trashed.id === record.driveId && trashed.trashed)
                        await this.clearOwnedMutation(mutation);
                    return;
                }
                await this.finalizeRecoveredUpload(mutation, record);
                return;
            }
            // Duplicate matching artifacts are never exposed.  They can only be
            // quarantined after every candidate proves it is this mutation's exact,
            // unindexed artifact; unrelated or ambiguous files retain the fence.
            if (exact.length === candidates.length && exact.length > 1 && await this.areUnindexedArtifacts(mutation, exact)) {
                for (const record of exact) {
                    await this.assertOwnedMutation(mutation);
                    const trashed = await this.options.storage.trash(record.driveId, context, record.version);
                    if (!trashed.trashed || trashed.id !== record.driveId)
                        return;
                }
                await this.clearOwnedMutation(mutation);
            }
            else if (candidates.length > 0) {
                // Identical names and bytes are not ownership. A markerless matching
                // file remains user data and the intent is delegated to rescan.
                await this.markAttachmentConflict(mutation);
            }
        }
        catch {
            // A missing parent, marker mismatch, version drift, or unavailable
            // readback is never replayed blindly. It becomes a terminal rescan item.
            await this.markAttachmentConflict(mutation).catch(() => undefined);
        }
    }
    async finalizeRecoveredUpload(mutation, record) {
        await this.options.indexStore.compareAndSet((index) => {
            const current = index.pendingMutations.find((candidate) => candidate.id === mutation.id && candidate.ownerId === this.ownerId && candidate.fence === mutation.fence && candidate.phase !== "conflicted");
            const entry = index.entries.find((candidate) => candidate.id === mutation.noteId);
            if (current === undefined || entry === undefined)
                return index;
            if (entry.attachments.some((attachment) => attachment.driveId === record.driveId)) {
                return bump(index, { pendingMutations: index.pendingMutations.filter((candidate) => candidate.id !== mutation.id) });
            }
            if (entry.attachments.some((attachment) => sameName(attachment.name, record.name)))
                return index;
            return bump(index, {
                entries: index.entries.map((candidate) => candidate.id === mutation.noteId ? { ...candidate, attachments: [...candidate.attachments, record] } : candidate),
                pendingMutations: index.pendingMutations.filter((candidate) => candidate.id !== mutation.id)
            });
        });
    }
    async reconcileTrash(mutation) {
        if (!this.hasTrashIdentity(mutation))
            return;
        const context = { ...this.context(), allowTrashed: true };
        try {
            const attachment = this.recordFromMutation(mutation);
            const file = await this.verifyTrashReadback(mutation, attachment, context);
            if (file.trashed) {
                const applied = await this.markDriveApplied(mutation.id, mutation.fence, mutation.driveId);
                await this.applyTrashProjection(mutation.id, applied.fence, mutation.noteId, mutation.driveId);
                await this.clearMutation(mutation.id, applied.fence);
                return;
            }
            // The trash did not apply.  Preserve (or restore) the projection and
            // release the expired reservation so retries cannot exhaust capacity.
            await this.restoreActiveProjection(mutation, attachment);
            await this.clearOwnedMutation(mutation);
        }
        catch {
            await this.markAttachmentConflict(mutation).catch(() => undefined);
        }
    }
    hasUploadIdentity(mutation) {
        return mutation.noteId !== undefined && mutation.parentId !== undefined && mutation.targetName !== undefined && mutation.expectedChecksum !== undefined && mutation.attachmentMimeType !== undefined && mutation.attachmentSize !== undefined && mutation.attachmentDisposition !== undefined && mutation.attachmentMarker !== undefined;
    }
    hasTrashIdentity(mutation) {
        return mutation.noteId !== undefined && mutation.driveId !== undefined && mutation.parentId !== undefined && mutation.targetName !== undefined && mutation.expectedChecksum !== undefined && mutation.attachmentMimeType !== undefined && mutation.attachmentSize !== undefined && mutation.attachmentDisposition !== undefined && mutation.attachmentMarker !== undefined && mutation.expectedVersion !== undefined;
    }
    recordFromMutation(mutation) {
        return { driveId: mutation.driveId, name: mutation.targetName, checksum: mutation.expectedChecksum, mimeType: mutation.attachmentMimeType, size: mutation.attachmentSize, disposition: mutation.attachmentDisposition, marker: mutation.attachmentMarker, version: mutation.expectedVersion };
    }
    async recoverExactUploadRecord(mutation, driveId, folderId, context) {
        const record = {
            driveId,
            name: mutation.targetName,
            checksum: mutation.expectedChecksum,
            mimeType: mutation.attachmentMimeType,
            size: mutation.attachmentSize,
            disposition: mutation.attachmentDisposition,
            marker: mutation.attachmentMarker
        };
        try {
            const verified = await this.verifyReadback({ driveId, noteId: mutation.noteId, folderId, attachment: record, context });
            return { ...record, version: verified.file.version };
        }
        catch {
            return undefined;
        }
    }
    async areUnindexedArtifacts(mutation, records) {
        const index = await this.options.indexStore.read();
        const owner = index.value.entries.find((entry) => entry.id === mutation.noteId);
        return owner !== undefined && records.every((record) => !owner.attachments.some((attachment) => attachment.driveId === record.driveId || sameName(attachment.name, record.name)));
    }
    async uploadProjectionState(mutation, record) {
        const index = await this.options.indexStore.read();
        const entry = index.value.entries.find((candidate) => candidate.id === mutation.noteId);
        if (entry === undefined)
            return "name-conflict";
        if (entry.attachments.some((attachment) => attachment.driveId === record.driveId))
            return "already-applied";
        return entry.attachments.some((attachment) => sameName(attachment.name, record.name)) ? "name-conflict" : "absent";
    }
    async restoreActiveProjection(mutation, attachment) {
        await this.options.indexStore.compareAndSet((index) => {
            const current = index.pendingMutations.find((candidate) => candidate.id === mutation.id && candidate.ownerId === this.ownerId && candidate.fence === mutation.fence);
            const entry = index.entries.find((candidate) => candidate.id === mutation.noteId);
            if (current === undefined || entry === undefined)
                return index;
            if (entry.attachments.some((candidate) => candidate.driveId === attachment.driveId || sameName(candidate.name, attachment.name)))
                return index;
            return bump(index, { entries: index.entries.map((candidate) => candidate.id === mutation.noteId ? { ...candidate, attachments: [...candidate.attachments, attachment] } : candidate) });
        });
    }
    async verifyTrashReadback(mutation, attachment, context) {
        const metadata = await this.options.storage.get(mutation.driveId, context);
        if (!this.matchesTrashMetadata(mutation, metadata))
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        let readback;
        try {
            readback = await this.options.storage.readBytes(mutation.driveId, context);
        }
        catch (error) {
            // Drive can make a confirmed trashed object non-downloadable. Its
            // returned metadata is still the bounded authoritative readback; the
            // checksum was fenced by the active pre-Drive verification.
            if (metadata.trashed)
                return metadata;
            throw error;
        }
        const file = readback.file;
        if (metadata.id !== file.id || metadata.version !== file.version || file.id !== mutation.driveId ||
            file.parentIds.length !== 1 || file.parentIds[0] !== mutation.parentId || file.name !== mutation.targetName ||
            file.mimeType !== mutation.attachmentMimeType || file.size !== mutation.attachmentSize || readback.bytes.byteLength !== mutation.attachmentSize ||
            readback.checksum !== mutation.expectedChecksum || checksum(readback.bytes) !== mutation.expectedChecksum ||
            file.appProperties?.nxtAttachmentMutation !== mutation.attachmentMarker || (!file.trashed && file.version !== mutation.expectedVersion))
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        const detected = await detectAttachment({ name: file.name, declaredMime: file.mimeType, bytes: readback.bytes });
        if (detected.mimeType !== attachment.mimeType || (attachment.disposition === "inline" && detected.disposition !== "inline"))
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        return file;
    }
    matchesTrashMetadata(mutation, metadata) {
        return metadata.id === mutation.driveId && metadata.parentIds.length === 1 && metadata.parentIds[0] === mutation.parentId && metadata.name === mutation.targetName && metadata.mimeType === mutation.attachmentMimeType && metadata.size === mutation.attachmentSize && metadata.appProperties?.nxtAttachmentMutation === mutation.attachmentMarker && (metadata.trashed || metadata.version === mutation.expectedVersion);
    }
    async clearOwnedMutation(mutation) {
        await this.options.indexStore.compareAndSet((index) => {
            const current = index.pendingMutations.find((candidate) => candidate.id === mutation.id);
            if (current === undefined || current.ownerId !== this.ownerId || current.fence !== mutation.fence)
                return index;
            return bump(index, { pendingMutations: index.pendingMutations.filter((candidate) => candidate.id !== mutation.id) });
        });
    }
    async markAttachmentConflict(mutation) {
        await this.options.indexStore.compareAndSet((index) => {
            const current = index.pendingMutations.find((candidate) => candidate.id === mutation.id && candidate.ownerId === this.ownerId && candidate.fence === mutation.fence);
            if (current === undefined)
                return index;
            return bump(index, { pendingMutations: index.pendingMutations.map((candidate) => candidate.id === mutation.id ? { ...candidate, phase: "conflicted", reconcileAfter: new Date(this.now().getTime() + MUTATION_TTL_MS).toISOString() } : candidate) });
        });
    }
    async rescheduleUnknownUpload(mutation) {
        await this.options.indexStore.compareAndSet((index) => {
            const current = index.pendingMutations.find((candidate) => candidate.id === mutation.id && candidate.ownerId === this.ownerId && candidate.fence === mutation.fence);
            if (current === undefined)
                return index;
            const attempts = (current.recoveryAttempts ?? 0) + 1;
            const next = attempts >= 3
                ? { ...current, phase: "conflicted", recoveryAttempts: attempts, reconcileAfter: new Date(this.now().getTime() + MUTATION_TTL_MS).toISOString() }
                : { ...current, phase: "outcome-unknown", recoveryAttempts: attempts, expiresAt: new Date(this.now().getTime() + MUTATION_TTL_MS).toISOString(), reconcileAfter: new Date(this.now().getTime() + MUTATION_TTL_MS).toISOString() };
            return bump(index, { pendingMutations: index.pendingMutations.map((candidate) => candidate.id === mutation.id ? next : candidate) });
        });
    }
    async listAll(parentId, context) {
        const files = [];
        const seen = new Set();
        let pageToken;
        for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
            let result;
            try {
                result = await this.options.storage.listChildren({
                    parentId,
                    pageSize: 100,
                    ...(pageToken === undefined ? {} : { pageToken })
                }, context);
            }
            catch (error) {
                throw preserveApiError(error, "DRIVE_UNAVAILABLE");
            }
            files.push(...result.files);
            if (result.nextPageToken === undefined)
                return files;
            if (seen.has(result.nextPageToken))
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            seen.add(result.nextPageToken);
            pageToken = result.nextPageToken;
        }
        throw new ApiResponseError("DRIVE_UNAVAILABLE");
    }
    context() {
        return { operationBudget: new StorageOperationBudget(MAX_DRIVE_OPERATIONS) };
    }
    serialize(noteId, operation) {
        const prior = this.noteOperations.get(noteId) ?? Promise.resolve();
        const result = prior.catch(() => undefined).then(operation);
        const settled = result.then(() => undefined, () => undefined);
        this.noteOperations.set(noteId, settled);
        return result.finally(() => { if (this.noteOperations.get(noteId) === settled)
            this.noteOperations.delete(noteId); });
    }
    assertNoteId(noteId) {
        try {
            NoteIdSchema.parse(noteId);
        }
        catch {
            throw new ApiResponseError("INVALID_INPUT");
        }
    }
    now() { return this.options.now?.() ?? new Date(); }
}
const checksum = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bump = (index, changes) => ({ ...index, ...changes, generation: index.generation + 1 });
const sameName = (first, second) => first.normalize("NFC").toLocaleLowerCase("en-US") === second.normalize("NFC").toLocaleLowerCase("en-US");
const toApiError = (error) => {
    if (error instanceof ApiResponseError || error instanceof StorageOperationBudgetExceededError)
        return error;
    if (error instanceof StorageVersionConflictError)
        return new ApiResponseError("CONFLICT");
    return new ApiResponseError("DRIVE_UNAVAILABLE");
};
//# sourceMappingURL=attachment-service.js.map