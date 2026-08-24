import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { NoteIdSchema } from "@nxt/contracts";
import { ApiResponseError } from "../http/api-response.js";
import { StorageMutationNotAppliedError, StorageMutationOutcomeUnknownError, StorageOperationBudget, StorageOperationBudgetExceededError, StorageVersionConflictError } from "../storage/storage-port.js";
import { preserveApiError } from "./system-file-store.js";
import { MAX_ATTACHMENT_BYTES, detectAttachment, normalizeAttachmentName, resolveAttachmentName } from "./attachment-policy.js";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const SHORTCUT_MIME_TYPE = "application/vnd.google-apps.shortcut";
const MAX_LIST_PAGES = 20;
const MAX_DRIVE_OPERATIONS = 80;
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
        await this.reconcileRecoverableMutations();
        const context = this.context();
        const owner = await this.getOwnedNote(input.noteId);
        const folder = await this.assetFolder(input.noteId, context);
        const name = resolveAttachmentName(normalizeAttachmentName(input.name), (await this.listAll(folder.id, context)).map((file) => file.name));
        const detected = await detectAttachment({ name, declaredMime: input.declaredMime, bytes: input.bytes });
        const mutation = this.newMutation({
            operation: "create-attachment",
            noteId: input.noteId,
            parentId: folder.id,
            targetName: name,
            expectedChecksum: checksum(input.bytes)
        });
        await this.reserve(mutation);
        let createdId;
        try {
            await this.beginDriveMutation(mutation.id);
            const created = await this.options.storage.createBytes({ parentId: folder.id, name, mimeType: detected.mimeType, bytes: input.bytes }, context);
            createdId = created.id;
            await this.markDriveApplied(mutation.id, created.id);
            const verified = await this.verifyReadback({
                driveId: created.id,
                noteId: input.noteId,
                folderId: folder.id,
                attachment: { driveId: created.id, name, mimeType: detected.mimeType, size: input.bytes.byteLength, checksum: checksum(input.bytes), disposition: detected.disposition },
                context
            });
            const result = {
                driveId: verified.file.id,
                name,
                mimeType: verified.mimeType,
                size: verified.file.size,
                checksum: verified.checksum,
                disposition: detected.disposition
            };
            await this.finalizeUpload(mutation.id, input.noteId, result, owner.driveId);
            return result;
        }
        catch (error) {
            await this.handleFailure(mutation.id, error, createdId);
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
            if (isAttachmentReferenced(owner, record.name, input.referenceId))
                throw new ApiResponseError("CONFLICT");
            const context = this.context();
            const folder = await this.assetFolder(current.noteId, context);
            await this.verifyReadback({ driveId: input.assetId, noteId: current.noteId, folderId: folder.id, attachment: record, context });
            const mutation = this.newMutation({
                operation: "trash-attachment",
                noteId: current.noteId,
                driveId: input.assetId,
                parentId: folder.id,
                targetName: record.name,
                expectedChecksum: record.checksum,
                originalChecksum: owner.checksum
            });
            await this.reserve(mutation);
            try {
                const recheckedOwner = await this.getOwnedNote(current.noteId);
                if (recheckedOwner.checksum !== owner.checksum || isAttachmentReferenced(recheckedOwner, record.name, input.referenceId)) {
                    throw new ApiResponseError("CONFLICT");
                }
                await this.beginDriveMutation(mutation.id);
                const trashed = await this.options.storage.trash(input.assetId, context);
                if (trashed.id !== input.assetId || !trashed.trashed || trashed.name !== record.name ||
                    trashed.parentIds.length !== 1 || trashed.parentIds[0] !== folder.id)
                    throw new ApiResponseError("DRIVE_UNAVAILABLE");
                await this.markDriveApplied(mutation.id, input.assetId);
                await this.applyTrashProjection(mutation.id, current.noteId, input.assetId);
                await this.clearMutation(mutation.id);
                return { trashed: true };
            }
            catch (error) {
                await this.handleFailure(mutation.id, error, input.assetId);
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
            readbackChecksum !== checksum(bytes) || readbackChecksum !== input.attachment.checksum)
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
        if (attachment.checksum === undefined || attachment.disposition === undefined)
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        if (attachment.size > MAX_ATTACHMENT_BYTES)
            throw new ApiResponseError("TOO_LARGE");
        return { ...attachment, checksum: attachment.checksum, disposition: attachment.disposition };
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
            if (index.pendingMutations.some((candidate) => candidate.noteId === mutation.noteId || (candidate.parentId === mutation.parentId && candidate.targetName === mutation.targetName))) {
                throw new ApiResponseError("CONFLICT");
            }
            if (mutation.operation === "create-attachment" && index.entries.some((entry) => entry.id === mutation.noteId && entry.attachments.some((attachment) => sameName(attachment.name, mutation.targetName)))) {
                throw new ApiResponseError("CONFLICT");
            }
            return bump(index, { pendingMutations: [...index.pendingMutations, mutation] });
        });
    }
    async beginDriveMutation(mutationId) {
        await this.updateMutation(mutationId, (mutation) => ({
            ...mutation,
            phase: "drive-inflight",
            expiresAt: new Date(this.now().getTime() + MUTATION_TTL_MS).toISOString(),
            reconcileAfter: new Date(this.now().getTime() + MUTATION_TTL_MS).toISOString()
        }));
    }
    async markDriveApplied(mutationId, driveId) {
        await this.updateMutation(mutationId, (mutation) => ({ ...mutation, driveId, phase: "drive-applied", reconcileAfter: this.now().toISOString() }));
    }
    async updateMutation(mutationId, update) {
        await this.options.indexStore.compareAndSet((index) => {
            const found = index.pendingMutations.find((mutation) => mutation.id === mutationId && mutation.ownerId === this.ownerId);
            if (found === undefined)
                throw new ApiResponseError("CONFLICT");
            return bump(index, { pendingMutations: index.pendingMutations.map((mutation) => mutation.id === mutationId ? update(found) : mutation) });
        });
    }
    async finalizeUpload(mutationId, noteId, record, expectedNoteDriveId) {
        await this.options.indexStore.compareAndSet((index) => {
            const mutation = index.pendingMutations.find((candidate) => candidate.id === mutationId && candidate.ownerId === this.ownerId);
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
    async applyTrashProjection(mutationId, noteId, assetId) {
        await this.options.indexStore.compareAndSet((index) => {
            const mutation = index.pendingMutations.find((candidate) => candidate.id === mutationId && candidate.ownerId === this.ownerId);
            if (mutation === undefined)
                throw new ApiResponseError("CONFLICT");
            return bump(index, {
                entries: index.entries.map((entry) => entry.id === noteId ? { ...entry, attachments: entry.attachments.filter((attachment) => attachment.driveId !== assetId) } : entry),
                pendingMutations: index.pendingMutations.map((candidate) => candidate.id === mutationId ? { ...candidate, phase: "index-applied" } : candidate)
            });
        });
    }
    async clearMutation(mutationId) {
        await this.options.indexStore.compareAndSet((index) => bump(index, {
            pendingMutations: index.pendingMutations.filter((candidate) => candidate.id !== mutationId)
        }));
    }
    async handleFailure(mutationId, error, knownDriveId) {
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
        const mutations = snapshot.value.pendingMutations.filter((mutation) => mutation.operation === "create-attachment" || mutation.operation === "trash-attachment");
        for (const mutation of mutations) {
            if (mutation.operation === "create-attachment")
                await this.reconcileUpload(mutation);
            else
                await this.reconcileTrash(mutation);
        }
    }
    async reconcileUpload(mutation) {
        if (mutation.noteId === undefined || mutation.parentId === undefined || mutation.targetName === undefined || mutation.expectedChecksum === undefined)
            return;
        let driveId = mutation.driveId;
        const context = this.context();
        if (driveId === undefined) {
            const matches = (await this.listAll(mutation.parentId, context)).filter((file) => sameName(file.name, mutation.targetName));
            if (matches.length !== 1)
                return;
            driveId = matches[0].id;
        }
        try {
            const folder = await this.assetFolder(mutation.noteId, context);
            if (folder.id !== mutation.parentId)
                return;
            const metadata = await this.options.storage.get(driveId, context);
            const preliminary = {
                driveId,
                name: mutation.targetName,
                mimeType: metadata.mimeType,
                size: metadata.size,
                checksum: mutation.expectedChecksum,
                disposition: "download"
            };
            const verified = await this.verifyReadback({ driveId, noteId: mutation.noteId, folderId: mutation.parentId, attachment: preliminary, context });
            const recovered = {
                driveId,
                name: verified.file.name,
                mimeType: verified.mimeType,
                size: verified.file.size,
                checksum: verified.checksum,
                disposition: "download"
            };
            await this.finalizeRecoveredUpload(mutation.id, mutation.noteId, recovered);
        }
        catch {
            // An unknown mutation remains reserved and is never exposed until an exact readback proves it safe.
        }
    }
    async finalizeRecoveredUpload(mutationId, noteId, record) {
        await this.options.indexStore.compareAndSet((index) => {
            const mutation = index.pendingMutations.find((candidate) => candidate.id === mutationId);
            const entry = index.entries.find((candidate) => candidate.id === noteId);
            if (mutation === undefined || entry === undefined)
                return index;
            if (entry.attachments.some((attachment) => attachment.driveId === record.driveId || sameName(attachment.name, record.name))) {
                return bump(index, { pendingMutations: index.pendingMutations.filter((candidate) => candidate.id !== mutationId) });
            }
            return bump(index, {
                entries: index.entries.map((candidate) => candidate.id === noteId ? { ...candidate, attachments: [...candidate.attachments, record] } : candidate),
                pendingMutations: index.pendingMutations.filter((candidate) => candidate.id !== mutationId)
            });
        });
    }
    async reconcileTrash(mutation) {
        if (mutation.phase !== "index-applied")
            return;
        await this.clearMutation(mutation.id).catch(() => undefined);
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
const isAttachmentReferenced = (note, name, referenceId) => {
    const assetPath = `_assets/${note.note.frontmatter.id}/${name}`;
    const urls = [];
    const collect = (_full, _prefix, destination) => {
        urls.push(destination);
        return _full;
    };
    note.source.replace(/(\]\(\s*)(<[^>\r\n]+>|[^\s)\r\n]+)(?=(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^)\r\n]*\)))?\s*\))/gu, collect);
    note.source.replace(/^(\s{0,3}\[[^\]\r\n]+\]:\s*)(<[^>\r\n]+>|[^\s\r\n]+)/gmu, collect);
    return urls.some((raw) => {
        const url = raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
        if (referenceId !== undefined && url === `/api/private/attachments/${referenceId}`)
            return true;
        if (url.startsWith("/") || /^[a-z][a-z0-9+.-]*:/iu.test(url))
            return false;
        return posix.normalize(posix.join(posix.dirname(note.path), url)) === assetPath;
    });
};
//# sourceMappingURL=attachment-service.js.map