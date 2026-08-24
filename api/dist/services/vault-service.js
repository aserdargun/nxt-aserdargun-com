import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { posix } from "node:path";
import { MAX_NOTE_SOURCE_BYTES, NoteIdSchema, NoteTitleSchema } from "@nxt/contracts";
import { deriveMarkdownPlainText, extractWikiLinks, parseNote, resolveWikiTarget, serializeNote } from "@nxt/domain";
import { ApiResponseError } from "../http/api-response.js";
import { StorageMutationNotAppliedError, StorageMutationOutcomeUnknownError, StorageVersionConflictError } from "../storage/storage-port.js";
import { preserveApiError } from "./system-file-store.js";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const MARKDOWN_MIME_TYPE = "text/markdown";
const MAX_FOLDER_DEPTH = 20;
const MAX_LIST_PAGES = 1_000;
const CONFIRMATION_TTL_MS = 5 * 60 * 1_000;
const MUTATION_TTL_MS = 30 * 1_000;
const DRIVE_INFLIGHT_HORIZON_MS = 15 * 60 * 1_000;
const MAX_PREFLIGHT_RETRIES = 3;
const CONFIRMATION_TOKEN = /^c1\.([A-Za-z0-9_-]{16,430})\.([A-Za-z0-9_-]{43})$/u;
class ReservationStaleError extends ApiResponseError {
    constructor() { super("CONFLICT"); }
}
export class VaultService {
    options;
    noteOperations = new Map();
    protectedFolders;
    ownerId = randomUUID();
    constructor(options) {
        this.options = options;
        if (options.confirmationSecret.length < 32)
            throw new Error("folder confirmation secret is too short");
        this.protectedFolders = new Set([
            options.folders.notesId,
            options.folders.inboxId,
            options.folders.plansId,
            options.folders.archiveId
        ]);
    }
    readIndex() {
        return this.options.indexStore.read();
    }
    async createNote(input) {
        const title = this.noteTitle(input.title);
        this.assertSourceSize(input.body);
        await this.reconcileRecoverableMutations();
        await this.assertFolderDestination(input.folderId);
        const targetName = `${sanitizeName(title)}.md`;
        await this.assertNameAvailable(input.folderId, targetName);
        const noteId = this.options.createId?.() ?? randomUUID();
        try {
            NoteIdSchema.parse(noteId);
        }
        catch {
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        }
        const timestamp = this.timestamp();
        const source = serializeNote({
            frontmatter: { id: noteId, title, created: timestamp, updated: timestamp, tags: [], aliases: [] },
            body: input.body
        });
        this.assertSourceSize(source);
        const parentPath = await this.folderPath(input.folderId);
        const mutation = this.newMutation({
            operation: "create-note",
            noteId,
            parentId: input.folderId,
            targetName,
            newPath: `${parentPath}/${targetName}`,
            expectedChecksum: sha256(source),
            source
        });
        await this.reserve(mutation);
        let created;
        try {
            await this.beginDriveMutation(mutation.id);
            created = await this.options.storage.createText({
                parentId: input.folderId,
                name: targetName,
                mimeType: MARKDOWN_MIME_TYPE,
                text: source
            });
            await this.markDriveApplied(mutation.id, created.id);
            const verified = await this.verifyNoteReadback(created.id, source, created.version);
            const path = await this.notePath(verified.file);
            await this.finalizeEntry(mutation.id, source, verified.file, path, []);
            return this.result(source, verified.file, path, verified.checksum);
        }
        catch (error) {
            await this.handleMutationFailure(mutation.id, error, created?.id);
            throw preserveApiError(error, "DRIVE_UNAVAILABLE");
        }
    }
    async getNote(noteId) {
        const { entry } = await this.findEntry(noteId);
        const readback = await this.readNote(entry.driveId);
        this.assertMarkdownFile(readback.file);
        const note = this.parseOwnedNote(readback.text, noteId, "DRIVE_UNAVAILABLE", "DRIVE_UNAVAILABLE");
        const path = await this.notePath(readback.file);
        return {
            note: { ...note, path },
            source: readback.text,
            driveId: readback.file.id,
            version: readback.file.version,
            path,
            checksum: readback.checksum
        };
    }
    updateNote(input) {
        return this.serializeNoteOperation(input.noteId, () => this.updateNoteUnserialized(input));
    }
    renameNote(input) {
        return this.serializeNoteOperation(input.noteId, async () => {
            const title = this.noteTitle(input.title);
            const opened = await this.getNote(input.noteId);
            if (opened.version !== input.expectedVersion)
                throw new ApiResponseError("CONFLICT");
            const source = serializeNote({
                frontmatter: {
                    ...opened.note.frontmatter,
                    title,
                    aliases: uniqueFolded([...opened.note.frontmatter.aliases, opened.note.frontmatter.title]),
                    updated: this.timestamp()
                },
                body: opened.note.body
            });
            return this.updateNoteUnserialized({ ...input, source });
        });
    }
    moveNote(input) {
        return this.serializeNoteOperation(input.noteId, () => this.moveNoteUnserialized(input));
    }
    archiveNote(input) {
        return this.moveNote({ ...input, folderId: this.options.folders.archiveId });
    }
    trashNote(input) {
        return this.serializeNoteOperation(input.noteId, async () => {
            await this.reconcileRecoverableMutations();
            const { entry } = await this.findEntry(input.noteId);
            const file = await this.preflight(entry.driveId, input.expectedVersion);
            const mutation = this.newMutation({
                operation: "trash-note",
                noteId: input.noteId,
                driveId: entry.driveId,
                expectedVersion: input.expectedVersion,
                oldPath: entry.path
            });
            await this.reserve(mutation);
            try {
                await this.beginDriveMutation(mutation.id);
                const trashed = await this.options.storage.trash(file.id);
                if (!trashed.trashed)
                    throw new ApiResponseError("DRIVE_UNAVAILABLE");
                await this.markDriveApplied(mutation.id, trashed.id);
                await this.applyIndexKeepingMutation(mutation.id, (index) => removeEntries(index, new Set([input.noteId])));
                await this.prunePreferences();
                await this.clearMutation(mutation.id);
                return { trashed: true };
            }
            catch (error) {
                await this.handleMutationFailure(mutation.id, error, file.id);
                throw preserveApiError(error, "DRIVE_UNAVAILABLE");
            }
        });
    }
    async createFolder(input) {
        await this.reconcileRecoverableMutations();
        const parentDepth = await this.folderDepth(input.parentId);
        if (parentDepth >= MAX_FOLDER_DEPTH)
            throw new ApiResponseError("INVALID_INPUT");
        const name = sanitizeName(input.name);
        await this.assertNameAvailable(input.parentId, name);
        const mutation = this.newMutation({
            operation: "create-folder",
            parentId: input.parentId,
            targetName: name,
            newPath: `${await this.folderPath(input.parentId)}/${name}`
        });
        await this.reserve(mutation);
        let created;
        try {
            await this.beginDriveMutation(mutation.id);
            created = await this.options.storage.createFolder({ parentId: input.parentId, name });
            await this.markDriveApplied(mutation.id, created.id);
            const verified = await this.options.storage.get(created.id);
            if (verified.version !== created.version || verified.mimeType !== FOLDER_MIME_TYPE || verified.parentIds[0] !== input.parentId || verified.name !== name) {
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            }
            await this.clearMutation(mutation.id);
            return verified;
        }
        catch (error) {
            await this.handleMutationFailure(mutation.id, error, created?.id);
            throw preserveApiError(error, "DRIVE_UNAVAILABLE");
        }
    }
    async renameFolder(input) {
        return this.updateFolder(input);
    }
    async moveFolder(input) {
        return this.updateFolder(input);
    }
    async updateFolder(input) {
        await this.reconcileRecoverableMutations();
        let sawStaleReservation = false;
        for (let attempt = 0; attempt < MAX_PREFLIGHT_RETRIES; attempt += 1) {
            try {
                return await this.updateFolderAttempt(input);
            }
            catch (error) {
                if (error instanceof ReservationStaleError) {
                    sawStaleReservation = true;
                    if (attempt < MAX_PREFLIGHT_RETRIES - 1)
                        continue;
                    throw error;
                }
                if (sawStaleReservation && error instanceof ApiResponseError &&
                    (error.code === "INVALID_INPUT" || error.code === "DRIVE_UNAVAILABLE"))
                    throw new ApiResponseError("CONFLICT");
                throw error;
            }
        }
        throw new ApiResponseError("CONFLICT");
    }
    async updateFolderAttempt(input) {
        if (this.protectedFolders.has(input.folderId))
            throw new ApiResponseError("INVALID_INPUT");
        const index = await this.options.indexStore.read();
        const file = await this.preflight(input.folderId, input.expectedVersion);
        this.assertFolder(file);
        const oldParentId = file.parentIds[0];
        if (oldParentId === undefined)
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        const targetParentId = input.parentId ?? oldParentId;
        const targetName = input.name === undefined ? file.name : sanitizeName(input.name);
        if (targetParentId === oldParentId && targetName === file.name)
            throw new ApiResponseError("INVALID_INPUT");
        const destination = await this.folderAncestry(targetParentId);
        if (destination.chain.some((ancestor) => ancestor.id === file.id))
            throw new ApiResponseError("INVALID_INPUT");
        const parentDepth = destination.depth;
        const subtreeDepth = await this.maximumSubtreeDepth(input.folderId);
        if (parentDepth + 1 + subtreeDepth > MAX_FOLDER_DEPTH)
            throw new ApiResponseError("INVALID_INPUT");
        await this.assertNameAvailable(targetParentId, targetName, targetParentId === oldParentId ? file.id : undefined);
        const oldPath = await this.folderPath(file.id);
        const newPath = `${destination.path}/${targetName}`;
        const mutation = this.newMutation({
            operation: input.name !== undefined && input.parentId !== undefined
                ? "update-folder"
                : input.name !== undefined ? "rename-folder" : "move-folder",
            folderId: file.id,
            parentId: oldParentId,
            targetParentId,
            targetName,
            oldPath,
            newPath,
            expectedVersion: input.expectedVersion,
            preflightGeneration: index.value.generation,
            destinationAncestry: destination.chain
        });
        await this.reserve(mutation, { generation: index.value.generation });
        try {
            await this.revalidateReservedFile(mutation, file, oldPath);
            await this.revalidateDestinationAncestry(mutation);
            await this.beginDriveMutation(mutation.id);
            const moved = await this.options.storage.move({
                fileId: file.id,
                fromParentId: oldParentId,
                toParentId: targetParentId,
                expectedVersion: file.version,
                ...(targetName === file.name ? {} : { newName: targetName })
            });
            await this.markDriveApplied(mutation.id, moved.id);
            const verified = await this.options.storage.get(moved.id);
            if (verified.version !== moved.version || verified.parentIds[0] !== targetParentId || verified.name !== targetName) {
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            }
            const committedPath = await this.folderPath(verified.id);
            await this.finalize(mutation.id, (index) => replacePathPrefix(index, oldPath, committedPath));
            return verified;
        }
        catch (error) {
            await this.handleMutationFailure(mutation.id, error, file.id);
            if (error instanceof StorageVersionConflictError)
                throw new ApiResponseError("CONFLICT");
            throw preserveApiError(error, "DRIVE_UNAVAILABLE");
        }
    }
    async issueFolderDeleteConfirmation(folderId) {
        const snapshot = await this.vaultTree();
        const folder = snapshot.folders.find((item) => item.id === folderId);
        if (folder === undefined || folder.protected || folder.deleteConfirmation === undefined)
            throw new ApiResponseError("INVALID_INPUT");
        return folder.deleteConfirmation;
    }
    async trashFolder(input) {
        await this.reconcileRecoverableMutations();
        if (this.protectedFolders.has(input.folderId))
            throw new ApiResponseError("INVALID_INPUT");
        const tree = await this.vaultTree();
        const folder = tree.folders.find((item) => item.id === input.folderId);
        if (folder === undefined || folder.deleteConfirmation === undefined)
            throw new ApiResponseError("NOT_FOUND");
        const confirmation = folder.deleteConfirmation;
        if (confirmation.treeVersion !== input.expectedTreeVersion)
            throw new ApiResponseError("CONFLICT");
        if (confirmation.descendantCount > 0) {
            if (input.confirmationToken === undefined)
                throw new ApiResponseError("CONFLICT");
            this.verifyConfirmation(input.folderId, input.confirmationToken, confirmation);
        }
        const mutation = this.newMutation({ operation: "trash-folder", folderId: input.folderId, oldPath: folder.path });
        await this.reserve(mutation);
        try {
            await this.beginDriveMutation(mutation.id);
            const trashed = await this.options.storage.trash(input.folderId);
            if (!trashed.trashed)
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            await this.markDriveApplied(mutation.id, trashed.id);
            await this.applyIndexKeepingMutation(mutation.id, (index) => removePathPrefix(index, folder.path));
            await this.prunePreferences();
            await this.clearMutation(mutation.id);
            return { trashed: true };
        }
        catch (error) {
            await this.handleMutationFailure(mutation.id, error, input.folderId);
            throw preserveApiError(error, "DRIVE_UNAVAILABLE");
        }
    }
    async vaultTree() {
        const [tree, index] = await Promise.all([this.collectTree(), this.options.indexStore.read()]);
        const treeVersion = hashTree(tree);
        const expiresAt = new Date(this.now().getTime() + CONFIRMATION_TTL_MS).toISOString();
        return {
            treeVersion,
            folders: tree.filter((item) => item.file.mimeType === FOLDER_MIME_TYPE).map((item) => {
                const protectedFolder = this.protectedFolders.has(item.file.id);
                const descendantCount = tree.filter((candidate) => candidate.path.startsWith(`${item.path}/`)).length +
                    index.value.entries.filter((entry) => entry.path.startsWith(`${item.path}/`)).reduce((count, entry) => count + entry.attachments.length, 0);
                const confirmation = {
                    descendantCount,
                    treeVersion,
                    expiresAt,
                    confirmationToken: this.signConfirmation({ folder: hashValue(item.file.id), descendantCount, treeVersion, expiresAt })
                };
                return {
                    id: item.file.id,
                    name: item.file.name,
                    path: item.path,
                    version: item.file.version,
                    protected: protectedFolder,
                    ...(protectedFolder ? {} : { deleteConfirmation: confirmation })
                };
            })
        };
    }
    async updateNoteUnserialized(input) {
        this.assertSourceSize(input.source);
        await this.reconcileRecoverableMutations();
        let sawStaleReservation = false;
        for (let attempt = 0; attempt < MAX_PREFLIGHT_RETRIES; attempt += 1) {
            try {
                return await this.updateNoteAttempt(input);
            }
            catch (error) {
                if (error instanceof ReservationStaleError) {
                    sawStaleReservation = true;
                    if (attempt < MAX_PREFLIGHT_RETRIES - 1)
                        continue;
                    throw error;
                }
                if (sawStaleReservation && error instanceof ApiResponseError &&
                    (error.code === "INVALID_INPUT" || error.code === "DRIVE_UNAVAILABLE"))
                    throw new ApiResponseError("CONFLICT");
                throw error;
            }
        }
        throw new ApiResponseError("CONFLICT");
    }
    async updateNoteAttempt(input) {
        const { index, entry } = await this.findEntry(input.noteId);
        const beforeFile = await this.preflight(entry.driveId, input.expectedVersion);
        this.assertMarkdownFile(beforeFile);
        const beforeRead = await this.readNote(beforeFile.id);
        const beforeNote = this.parseOwnedNote(beforeRead.text, input.noteId, "DRIVE_UNAVAILABLE", "DRIVE_UNAVAILABLE");
        let nextNote = this.parseOwnedNote(input.source, input.noteId, "INVALID_INPUT", "CONFLICT");
        const titleChanged = nextNote.frontmatter.title !== beforeNote.frontmatter.title;
        if (titleChanged) {
            nextNote = { ...nextNote, frontmatter: { ...nextNote.frontmatter, aliases: uniqueFolded([...nextNote.frontmatter.aliases, beforeNote.frontmatter.title]) } };
        }
        const source = serializeNote(nextNote);
        this.assertSourceSize(source);
        const parentId = beforeFile.parentIds[0];
        if (parentId === undefined)
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        const newName = `${sanitizeName(nextNote.frontmatter.title)}.md`;
        if (beforeFile.name !== newName)
            await this.assertNameAvailable(parentId, newName, beforeFile.id);
        const oldPath = await this.notePath(beforeFile);
        const destination = await this.folderAncestry(parentId);
        const newPath = `${destination.path}/${newName}`;
        const mutation = this.newMutation({
            operation: "update-note",
            noteId: input.noteId,
            driveId: beforeFile.id,
            parentId,
            targetName: newName,
            oldPath,
            newPath,
            expectedVersion: input.expectedVersion,
            expectedChecksum: sha256(source),
            originalChecksum: beforeRead.checksum,
            source,
            preflightGeneration: index.value.generation,
            destinationAncestry: destination.chain
        });
        await this.reserve(mutation, { generation: index.value.generation, entry });
        let written;
        try {
            await this.revalidateReservedFile(mutation, beforeFile, oldPath);
            await this.revalidateDestinationAncestry(mutation);
            await this.beginDriveMutation(mutation.id);
            written = await this.options.storage.updateText({ fileId: beforeFile.id, expectedVersion: beforeFile.version, mimeType: MARKDOWN_MIME_TYPE, text: source });
            if (beforeFile.name !== newName) {
                await this.checkpointMutation(mutation.id, { moveExpectedVersion: written.version });
                written = await this.options.storage.move({ fileId: written.id, fromParentId: parentId, toParentId: parentId, expectedVersion: written.version, newName });
            }
            await this.markDriveApplied(mutation.id, written.id);
            const verified = await this.verifyNoteReadback(written.id, source, written.version);
            const path = await this.notePath(verified.file);
            await this.finalizeEntry(mutation.id, source, verified.file, path, entry.attachments);
            return this.result(source, verified.file, path, verified.checksum);
        }
        catch (error) {
            await this.handleMutationFailure(mutation.id, error, written?.id ?? beforeFile.id, written?.version);
            if (error instanceof StorageVersionConflictError)
                throw new ApiResponseError("CONFLICT");
            throw preserveApiError(error, "DRIVE_UNAVAILABLE");
        }
    }
    async moveNoteUnserialized(input) {
        await this.reconcileRecoverableMutations();
        let sawStaleReservation = false;
        for (let attempt = 0; attempt < MAX_PREFLIGHT_RETRIES; attempt += 1) {
            try {
                return await this.moveNoteAttempt(input);
            }
            catch (error) {
                if (error instanceof ReservationStaleError) {
                    sawStaleReservation = true;
                    if (attempt < MAX_PREFLIGHT_RETRIES - 1)
                        continue;
                    throw error;
                }
                if (sawStaleReservation && error instanceof ApiResponseError &&
                    (error.code === "INVALID_INPUT" || error.code === "DRIVE_UNAVAILABLE"))
                    throw new ApiResponseError("CONFLICT");
                throw error;
            }
        }
        throw new ApiResponseError("CONFLICT");
    }
    async moveNoteAttempt(input) {
        const { index, entry } = await this.findEntry(input.noteId);
        let file = await this.preflight(entry.driveId, input.expectedVersion);
        this.assertMarkdownFile(file);
        const fromParentId = file.parentIds[0];
        if (fromParentId === undefined || fromParentId === input.folderId)
            throw new ApiResponseError("INVALID_INPUT");
        await this.assertNameAvailable(input.folderId, file.name);
        const readback = await this.readNote(file.id);
        this.parseOwnedNote(readback.text, input.noteId, "DRIVE_UNAVAILABLE", "DRIVE_UNAVAILABLE");
        const oldPath = await this.notePath(file);
        const destination = await this.folderAncestry(input.folderId);
        const newPath = `${destination.path}/${file.name}`;
        const source = recalculateAttachmentLinks(readback.text, input.noteId, oldPath, newPath);
        this.assertSourceSize(source);
        const mutation = this.newMutation({
            operation: "move-note",
            noteId: input.noteId,
            driveId: file.id,
            parentId: fromParentId,
            targetParentId: input.folderId,
            targetName: file.name,
            oldPath,
            newPath,
            expectedVersion: input.expectedVersion,
            expectedChecksum: sha256(source),
            originalChecksum: readback.checksum,
            source,
            preflightGeneration: index.value.generation,
            destinationAncestry: destination.chain
        });
        await this.reserve(mutation, { generation: index.value.generation, entry });
        try {
            await this.revalidateReservedFile(mutation, file, oldPath);
            await this.revalidateDestinationAncestry(mutation);
            await this.beginDriveMutation(mutation.id);
            if (source !== readback.text) {
                file = await this.options.storage.updateText({ fileId: file.id, expectedVersion: file.version, mimeType: MARKDOWN_MIME_TYPE, text: source });
            }
            await this.checkpointMutation(mutation.id, { moveExpectedVersion: file.version });
            file = await this.options.storage.move({ fileId: file.id, fromParentId, toParentId: input.folderId, expectedVersion: file.version });
            await this.markDriveApplied(mutation.id, file.id);
            const verified = await this.verifyNoteReadback(file.id, source, file.version);
            const path = await this.notePath(verified.file);
            await this.finalizeEntry(mutation.id, source, verified.file, path, entry.attachments);
            return this.result(source, verified.file, path, verified.checksum);
        }
        catch (error) {
            await this.handleMutationFailure(mutation.id, error, file.id, file.version);
            if (error instanceof StorageVersionConflictError)
                throw new ApiResponseError("CONFLICT");
            throw preserveApiError(error, "DRIVE_UNAVAILABLE");
        }
    }
    async reserve(mutation, precondition) {
        await this.options.indexStore.compareAndSet((index) => {
            if (precondition !== undefined &&
                (index.generation !== precondition.generation || mutation.preflightGeneration !== precondition.generation))
                throw new ReservationStaleError();
            if (precondition?.entry !== undefined) {
                const current = index.entries.find((entry) => entry.id === precondition.entry?.id);
                if (current === undefined || current.driveId !== precondition.entry.driveId ||
                    current.path !== precondition.entry.path || current.driveVersion !== precondition.entry.driveVersion ||
                    (mutation.oldPath !== undefined && current.path !== mutation.oldPath))
                    throw new ReservationStaleError();
            }
            if (index.rescanState !== null)
                throw new ApiResponseError("CONFLICT");
            if (index.entries.some((entry) => mutation.noteId !== undefined && entry.id === mutation.noteId && mutation.operation === "create-note"))
                throw new ApiResponseError("CONFLICT");
            const targetPath = mutation.newPath === undefined ? undefined : fold(mutation.newPath);
            if (index.entries.some((entry) => targetPath !== undefined && fold(entry.path) === targetPath && entry.id !== mutation.noteId))
                throw new ApiResponseError("CONFLICT");
            if (index.pendingMutations.some((pending) => mutationsOverlap(pending, mutation)))
                throw new ApiResponseError("CONFLICT");
            return bump(index, { pendingMutations: [...index.pendingMutations, mutation] });
        });
    }
    async revalidateReservedFile(mutation, expected, expectedPath) {
        await this.assertOwnedReservation(mutation);
        let actual;
        try {
            actual = await this.options.storage.get(expected.id);
        }
        catch {
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        }
        const actualPath = actual.mimeType === FOLDER_MIME_TYPE ? await this.folderPath(actual.id) : await this.notePath(actual);
        if (actual.version !== expected.version || actual.name !== expected.name || actual.trashed !== expected.trashed ||
            actual.parentIds.length !== 1 || actual.parentIds[0] !== expected.parentIds[0] || actualPath !== expectedPath) {
            await this.cancel(mutation.id);
            throw new ReservationStaleError();
        }
    }
    async revalidateDestinationAncestry(mutation) {
        if (mutation.destinationAncestry === undefined)
            return;
        if (!(await this.matchesDestinationAncestry(mutation.destinationAncestry))) {
            await this.cancel(mutation.id);
            throw new ReservationStaleError();
        }
        await this.assertOwnedReservation(mutation);
    }
    async assertOwnedReservation(mutation) {
        const index = await this.options.indexStore.read();
        const reserved = index.value.pendingMutations.find((candidate) => candidate.id === mutation.id);
        if (reserved === undefined || reserved.ownerId !== this.ownerId || reserved.fence !== mutation.fence ||
            reserved.phase !== "reserved" || reserved.preflightGeneration !== mutation.preflightGeneration)
            throw new ApiResponseError("CONFLICT");
    }
    async matchesDestinationAncestry(expected) {
        for (const ancestor of expected) {
            let actual;
            try {
                actual = await this.options.storage.get(ancestor.id);
            }
            catch {
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            }
            if (actual.id !== ancestor.id || actual.name !== ancestor.name || actual.mimeType !== FOLDER_MIME_TYPE ||
                actual.trashed || actual.version !== ancestor.version || actual.parentIds.length !== 1 ||
                actual.parentIds[0] !== ancestor.parentId)
                return false;
        }
        return true;
    }
    async checkpointMutation(mutationId, changes) {
        await this.options.indexStore.compareAndSet((index) => {
            const mutation = index.pendingMutations.find((candidate) => candidate.id === mutationId);
            if (mutation === undefined || mutation.ownerId !== this.ownerId)
                throw new ApiResponseError("CONFLICT");
            return bump(index, {
                pendingMutations: index.pendingMutations.map((candidate) => candidate.id === mutationId ? { ...candidate, ...changes } : candidate)
            });
        });
    }
    async markMutationConflicted(mutationId) {
        await this.options.indexStore.compareAndSet((index) => bump(index, {
            pendingMutations: index.pendingMutations.map((mutation) => mutation.id === mutationId
                ? { ...mutation, phase: "conflicted", ownerId: this.ownerId }
                : mutation)
        }));
    }
    async finalizeEntry(mutationId, source, file, path, attachments) {
        await this.finalize(mutationId, (index) => mergeEntry(index, source, file, path, attachments));
    }
    async finalize(mutationId, update) {
        await this.options.indexStore.compareAndSet((index) => {
            if (!index.pendingMutations.some((mutation) => mutation.id === mutationId))
                throw new ApiResponseError("CONFLICT");
            const changed = update(index);
            return bump(changed, { pendingMutations: changed.pendingMutations.filter((mutation) => mutation.id !== mutationId) });
        });
    }
    async applyIndexKeepingMutation(mutationId, update) {
        await this.options.indexStore.compareAndSet((index) => {
            const mutation = index.pendingMutations.find((candidate) => candidate.id === mutationId);
            if (mutation === undefined)
                throw new ApiResponseError("CONFLICT");
            const changed = mutation.phase === "index-applied" ? index : update(index);
            return bump(changed, {
                pendingMutations: changed.pendingMutations.map((candidate) => candidate.id === mutationId
                    ? { ...candidate, phase: "index-applied", ownerId: this.ownerId }
                    : candidate)
            });
        });
    }
    async cancel(mutationId) {
        await this.options.indexStore.compareAndSet((index) => bump(index, { pendingMutations: index.pendingMutations.filter((mutation) => mutation.id !== mutationId) })).catch(() => undefined);
    }
    async clearMutation(mutationId) {
        await this.options.indexStore.compareAndSet((index) => bump(index, {
            pendingMutations: index.pendingMutations.filter((mutation) => mutation.id !== mutationId)
        }));
    }
    async beginDriveMutation(mutationId) {
        const until = new Date(this.now().getTime() + DRIVE_INFLIGHT_HORIZON_MS).toISOString();
        await this.options.indexStore.compareAndSet((index) => {
            const mutation = index.pendingMutations.find((candidate) => candidate.id === mutationId);
            if (mutation === undefined || mutation.ownerId !== this.ownerId)
                throw new ApiResponseError("CONFLICT");
            return bump(index, {
                pendingMutations: index.pendingMutations.map((candidate) => candidate.id === mutationId
                    ? { ...candidate, phase: "drive-inflight", expiresAt: until, reconcileAfter: until }
                    : candidate)
            });
        });
    }
    async markDriveApplied(mutationId, driveId) {
        await this.options.indexStore.compareAndSet((index) => {
            const mutation = index.pendingMutations.find((candidate) => candidate.id === mutationId);
            if (mutation === undefined || mutation.ownerId !== this.ownerId)
                throw new ApiResponseError("CONFLICT");
            return bump(index, {
                pendingMutations: index.pendingMutations.map((candidate) => candidate.id === mutationId
                    ? { ...candidate, driveId, phase: "drive-applied", reconcileAfter: this.timestamp() }
                    : candidate)
            });
        });
    }
    async handleMutationFailure(mutationId, error, knownDriveId, knownMoveExpectedVersion) {
        if (error instanceof StorageMutationNotAppliedError) {
            await this.cancel(mutationId);
            return;
        }
        if (error instanceof StorageVersionConflictError) {
            await this.markMutationConflicted(mutationId).catch(() => undefined);
            return;
        }
        const driveId = error instanceof StorageMutationOutcomeUnknownError ? error.fileId ?? knownDriveId : knownDriveId;
        const expiresAt = new Date(this.now().getTime() + DRIVE_INFLIGHT_HORIZON_MS).toISOString();
        await this.options.indexStore.compareAndSet((index) => {
            if (!index.pendingMutations.some((candidate) => candidate.id === mutationId))
                return index;
            return bump(index, {
                pendingMutations: index.pendingMutations.map((candidate) => candidate.id === mutationId
                    ? {
                        ...candidate,
                        ...(driveId === undefined ? {} : { driveId }),
                        ...(knownMoveExpectedVersion === undefined ? {} : { moveExpectedVersion: knownMoveExpectedVersion }),
                        phase: candidate.phase === "index-applied" || candidate.phase === "drive-applied"
                            ? candidate.phase
                            : "outcome-unknown",
                        expiresAt,
                        reconcileAfter: this.timestamp()
                    }
                    : candidate)
            });
        }).catch(() => undefined);
    }
    async reconcileRecoverableMutations() {
        const snapshot = await this.options.indexStore.read();
        const now = this.now().getTime();
        const recoverable = snapshot.value.pendingMutations.filter((mutation) => {
            if (mutation.operation === "create-attachment" || mutation.operation === "trash-attachment")
                return false;
            if (mutation.phase === "conflicted")
                return false;
            if (mutation.phase === "reserved")
                return Date.parse(mutation.expiresAt) <= now;
            if (mutation.phase === "drive-inflight")
                return Date.parse(mutation.reconcileAfter ?? mutation.expiresAt) <= now;
            return true;
        });
        for (const candidate of recoverable) {
            let claimed;
            await this.options.indexStore.compareAndSet((index) => {
                const current = index.pendingMutations.find((mutation) => mutation.id === candidate.id);
                if (current === undefined || current.fence !== candidate.fence)
                    throw new ApiResponseError("CONFLICT");
                claimed = {
                    ...current,
                    ownerId: this.ownerId,
                    fence: current.fence + 1,
                    phase: current.phase === "drive-inflight" ? "outcome-unknown" : current.phase
                };
                return bump(index, {
                    pendingMutations: index.pendingMutations.map((mutation) => mutation.id === candidate.id ? claimed : mutation)
                });
            });
            await this.reconcile(claimed);
        }
    }
    async prunePreferences() {
        if (this.options.preferencesStore === undefined)
            return;
        const index = await this.options.indexStore.read();
        const present = new Set(index.value.entries.map((entry) => entry.id));
        await this.options.preferencesStore.compareAndSet((preferences) => ({
            ...preferences,
            favorites: [...new Set(preferences.favorites)].filter((id) => present.has(id)),
            recent: [...new Set(preferences.recent)].filter((id) => present.has(id))
        }));
    }
    async reconcile(mutation) {
        if (mutation.phase === "reserved")
            return this.cancel(mutation.id);
        if (mutation.operation === "create-folder") {
            if (mutation.parentId === undefined || mutation.targetName === undefined)
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            const matches = (await this.listAllChildren(mutation.parentId)).filter((file) => fold(file.name) === fold(mutation.targetName));
            if (matches.length > 1 || (matches[0] !== undefined && matches[0].mimeType !== FOLDER_MIME_TYPE))
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            if (matches.length === 1)
                return this.clearMutation(mutation.id);
            if (Date.parse(mutation.expiresAt) <= this.now().getTime())
                return this.cancel(mutation.id);
            return;
        }
        if (mutation.operation === "create-note") {
            if (mutation.parentId === undefined || mutation.targetName === undefined || mutation.noteId === undefined || mutation.expectedChecksum === undefined)
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            const matches = (await this.listAllChildren(mutation.parentId)).filter((file) => fold(file.name) === fold(mutation.targetName));
            if (matches.length === 0) {
                if (Date.parse(mutation.expiresAt) <= this.now().getTime())
                    return this.cancel(mutation.id);
                return;
            }
            if (matches.length !== 1)
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            const readback = await this.readNote(matches[0].id);
            this.parseOwnedNote(readback.text, mutation.noteId, "DRIVE_UNAVAILABLE", "DRIVE_UNAVAILABLE");
            if (readback.checksum !== mutation.expectedChecksum)
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            return this.finalizeEntry(mutation.id, readback.text, readback.file, await this.notePath(readback.file), []);
        }
        if (mutation.operation === "trash-note") {
            if (mutation.noteId === undefined || mutation.driveId === undefined)
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            if (mutation.phase === "index-applied") {
                await this.prunePreferences();
                return this.clearMutation(mutation.id);
            }
            const file = await this.options.storage.get(mutation.driveId).catch(() => { throw new ApiResponseError("DRIVE_UNAVAILABLE"); });
            if (!file.trashed) {
                if (Date.parse(mutation.expiresAt) <= this.now().getTime())
                    return this.cancel(mutation.id);
                return;
            }
            await this.applyIndexKeepingMutation(mutation.id, (index) => removeEntries(index, new Set([mutation.noteId])));
            await this.prunePreferences();
            return this.clearMutation(mutation.id);
        }
        if (mutation.operation === "update-note" || mutation.operation === "move-note") {
            if (mutation.noteId === undefined || mutation.driveId === undefined || mutation.expectedChecksum === undefined ||
                mutation.originalChecksum === undefined || mutation.expectedVersion === undefined || mutation.source === undefined)
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            let readback = await this.readNote(mutation.driveId);
            this.parseOwnedNote(readback.text, mutation.noteId, "DRIVE_UNAVAILABLE", "DRIVE_UNAVAILABLE");
            let actualPath = await this.notePath(readback.file);
            if (readback.checksum === mutation.expectedChecksum && (mutation.newPath === undefined || actualPath === mutation.newPath)) {
                const current = await this.options.indexStore.read();
                const attachments = current.value.entries.find((entry) => entry.id === mutation.noteId)?.attachments ?? [];
                return this.finalizeEntry(mutation.id, readback.text, readback.file, actualPath, attachments);
            }
            const exactOriginal = readback.checksum === mutation.originalChecksum && actualPath === mutation.oldPath &&
                readback.file.version === mutation.expectedVersion;
            const intendedContentAwaitingMove = readback.checksum === mutation.expectedChecksum && actualPath === mutation.oldPath &&
                mutation.moveExpectedVersion !== undefined && readback.file.version === mutation.moveExpectedVersion;
            if (!exactOriginal && !intendedContentAwaitingMove) {
                await this.markMutationConflicted(mutation.id);
                return;
            }
            if (mutation.destinationAncestry !== undefined &&
                !(await this.matchesDestinationAncestry(mutation.destinationAncestry))) {
                await this.markMutationConflicted(mutation.id);
                return;
            }
            if (exactOriginal && readback.checksum !== mutation.expectedChecksum) {
                await this.beginDriveMutation(mutation.id);
                const written = await this.options.storage.updateText({
                    fileId: readback.file.id,
                    expectedVersion: readback.file.version,
                    mimeType: MARKDOWN_MIME_TYPE,
                    text: mutation.source
                }).catch(async (error) => {
                    await this.handleMutationFailure(mutation.id, error, mutation.driveId);
                    throw error;
                });
                readback = await this.readNote(written.id);
                actualPath = await this.notePath(readback.file);
            }
            if (mutation.newPath !== undefined && actualPath !== mutation.newPath) {
                const fromParentId = readback.file.parentIds[0];
                const targetParentId = mutation.targetParentId ?? mutation.parentId;
                if (fromParentId === undefined || targetParentId === undefined || mutation.targetName === undefined)
                    throw new ApiResponseError("DRIVE_UNAVAILABLE");
                await this.checkpointMutation(mutation.id, { moveExpectedVersion: readback.file.version });
                await this.beginDriveMutation(mutation.id);
                const moved = await this.options.storage.move({
                    fileId: readback.file.id,
                    fromParentId,
                    toParentId: targetParentId,
                    expectedVersion: readback.file.version,
                    ...(readback.file.name === mutation.targetName ? {} : { newName: mutation.targetName })
                }).catch(async (error) => {
                    await this.handleMutationFailure(mutation.id, error, mutation.driveId);
                    throw error;
                });
                readback = await this.readNote(moved.id);
                actualPath = await this.notePath(readback.file);
            }
            if (readback.checksum !== mutation.expectedChecksum || (mutation.newPath !== undefined && actualPath !== mutation.newPath)) {
                await this.markMutationConflicted(mutation.id);
                return;
            }
            const current = await this.options.indexStore.read();
            const attachments = current.value.entries.find((entry) => entry.id === mutation.noteId)?.attachments ?? [];
            return this.finalizeEntry(mutation.id, readback.text, readback.file, actualPath, attachments);
        }
        if (mutation.folderId === undefined || mutation.oldPath === undefined)
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        const folder = await this.options.storage.get(mutation.folderId).catch(() => { throw new ApiResponseError("DRIVE_UNAVAILABLE"); });
        if (mutation.operation === "trash-folder") {
            if (mutation.phase === "index-applied") {
                await this.prunePreferences();
                return this.clearMutation(mutation.id);
            }
            if (!folder.trashed) {
                if (Date.parse(mutation.expiresAt) <= this.now().getTime())
                    return this.cancel(mutation.id);
                return;
            }
            await this.applyIndexKeepingMutation(mutation.id, (index) => removePathPrefix(index, mutation.oldPath));
            await this.prunePreferences();
            return this.clearMutation(mutation.id);
        }
        if (folder.trashed)
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        let actualPath = await this.folderPath(folder.id);
        if (mutation.newPath !== undefined && actualPath !== mutation.newPath) {
            if (mutation.expectedVersion === undefined || actualPath !== mutation.oldPath || folder.version !== mutation.expectedVersion) {
                await this.markMutationConflicted(mutation.id);
                return;
            }
            if (mutation.destinationAncestry !== undefined &&
                !(await this.matchesDestinationAncestry(mutation.destinationAncestry))) {
                await this.markMutationConflicted(mutation.id);
                return;
            }
            const fromParentId = folder.parentIds[0];
            if (fromParentId === undefined || mutation.targetParentId === undefined || mutation.targetName === undefined)
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            await this.beginDriveMutation(mutation.id);
            const moved = await this.options.storage.move({
                fileId: folder.id,
                fromParentId,
                toParentId: mutation.targetParentId,
                expectedVersion: folder.version,
                ...(folder.name === mutation.targetName ? {} : { newName: mutation.targetName })
            }).catch(async (error) => {
                await this.handleMutationFailure(mutation.id, error, mutation.folderId);
                throw error;
            });
            actualPath = await this.folderPath(moved.id);
        }
        return this.finalize(mutation.id, (index) => replacePathPrefix(index, mutation.oldPath, actualPath));
    }
    newMutation(fields) {
        const now = this.now();
        return {
            id: randomUUID(),
            ownerId: this.ownerId,
            fence: 1,
            phase: "reserved",
            ...fields,
            createdAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + MUTATION_TTL_MS).toISOString()
        };
    }
    async findEntry(noteId) {
        try {
            NoteIdSchema.parse(noteId);
        }
        catch {
            throw new ApiResponseError("INVALID_INPUT");
        }
        const index = await this.options.indexStore.read();
        const entry = index.value.entries.find((candidate) => candidate.id === noteId);
        if (entry === undefined)
            throw new ApiResponseError("NOT_FOUND");
        return { index, entry };
    }
    async verifyNoteReadback(fileId, source, expectedVersion) {
        const readback = await this.readNote(fileId);
        this.assertMarkdownFile(readback.file);
        if (readback.file.version !== expectedVersion || readback.text !== source || readback.checksum !== createHash("sha256").update(source).digest("hex")) {
            throw new ApiResponseError("CONFLICT");
        }
        return { file: readback.file, checksum: readback.checksum };
    }
    async readNote(fileId) {
        try {
            return await this.options.storage.readText(fileId);
        }
        catch (error) {
            throw preserveApiError(error, "DRIVE_UNAVAILABLE");
        }
    }
    async preflight(fileId, expectedVersion) {
        let file;
        try {
            file = await this.options.storage.get(fileId);
        }
        catch {
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        }
        if (file.version !== expectedVersion)
            throw new ApiResponseError("CONFLICT");
        return file;
    }
    parseOwnedNote(source, noteId, parseCode = "DRIVE_UNAVAILABLE", mismatchCode = "DRIVE_UNAVAILABLE") {
        let note;
        try {
            note = parseNote(source);
        }
        catch {
            throw new ApiResponseError(parseCode);
        }
        if (note.frontmatter.id !== noteId)
            throw new ApiResponseError(mismatchCode);
        return note;
    }
    result(source, file, path, checksum) {
        return { note: { ...parseNote(source), path }, source, driveId: file.id, version: file.version, path, checksum };
    }
    noteTitle(value) {
        try {
            return NoteTitleSchema.parse(value);
        }
        catch {
            throw new ApiResponseError("INVALID_INPUT");
        }
    }
    assertSourceSize(source) {
        if (new TextEncoder().encode(source).byteLength > MAX_NOTE_SOURCE_BYTES)
            throw new ApiResponseError("TOO_LARGE");
    }
    assertMarkdownFile(file) {
        if (file.trashed || file.mimeType !== MARKDOWN_MIME_TYPE || !file.name.toLocaleLowerCase("en-US").endsWith(".md"))
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
    }
    assertFolder(file) {
        if (file.trashed || file.mimeType !== FOLDER_MIME_TYPE)
            throw new ApiResponseError("INVALID_INPUT");
    }
    async assertFolderDestination(folderId) { await this.folderDepth(folderId); }
    async folderDepth(folderId) {
        return (await this.folderAncestry(folderId)).depth;
    }
    async folderPath(folderId) {
        return (await this.folderAncestry(folderId)).path;
    }
    async folderAncestry(folderId) {
        let currentId = folderId;
        const names = [];
        const chain = [];
        const seen = new Set();
        for (let depth = 0; depth <= MAX_FOLDER_DEPTH; depth += 1) {
            if (seen.has(currentId))
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            seen.add(currentId);
            let file;
            try {
                file = await this.options.storage.get(currentId);
            }
            catch {
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            }
            this.assertFolder(file);
            if (file.parentIds.length !== 1)
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            const parentId = file.parentIds[0];
            chain.push({ id: file.id, name: file.name, parentId, version: file.version });
            if (file.id === this.options.folders.notesId) {
                return { path: ["Notes", ...names.reverse()].join("/"), depth, chain };
            }
            names.push(file.name);
            currentId = parentId;
        }
        throw new ApiResponseError("INVALID_INPUT");
    }
    async notePath(file) {
        const parentId = file.parentIds[0];
        if (parentId === undefined)
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        return `${await this.folderPath(parentId)}/${file.name}`;
    }
    async assertNameAvailable(parentId, name, ignoredId) {
        const folded = fold(name);
        for (const file of await this.listAllChildren(parentId))
            if (file.id !== ignoredId && fold(file.name) === folded)
                throw new ApiResponseError("CONFLICT");
    }
    async listAllChildren(parentId) {
        const files = [];
        const seenTokens = new Set();
        let pageToken;
        for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
            let result;
            try {
                result = await this.options.storage.listChildren({ parentId, pageSize: 100, ...(pageToken === undefined ? {} : { pageToken }) });
            }
            catch (error) {
                throw preserveApiError(error, "DRIVE_UNAVAILABLE");
            }
            files.push(...result.files);
            if (result.nextPageToken === undefined)
                return files;
            if (seenTokens.has(result.nextPageToken))
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            seenTokens.add(result.nextPageToken);
            pageToken = result.nextPageToken;
        }
        throw new ApiResponseError("DRIVE_UNAVAILABLE");
    }
    async collectTree() {
        let root;
        try {
            root = await this.options.storage.get(this.options.folders.notesId);
        }
        catch {
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        }
        this.assertFolder(root);
        const tree = [{ file: root, path: "Notes" }];
        const queue = [{ file: root, path: "Notes" }];
        while (queue.length > 0) {
            const parent = queue.shift();
            const children = (await this.listAllChildren(parent.file.id)).sort(compareStoredFiles);
            for (const file of children) {
                const item = { file, path: `${parent.path}/${file.name}` };
                tree.push(item);
                if (file.mimeType === FOLDER_MIME_TYPE)
                    queue.push(item);
            }
        }
        return tree.sort((first, second) => compareTreeItems(first, second));
    }
    async maximumSubtreeDepth(folderId) {
        let maximum = 0;
        const queue = [{ id: folderId, depth: 0 }];
        while (queue.length > 0) {
            const current = queue.shift();
            maximum = Math.max(maximum, current.depth);
            for (const child of await this.listAllChildren(current.id))
                if (child.mimeType === FOLDER_MIME_TYPE)
                    queue.push({ id: child.id, depth: current.depth + 1 });
        }
        return maximum;
    }
    signConfirmation(payload) {
        const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
        const signature = createHmac("sha256", this.options.confirmationSecret).update(encoded).digest("base64url");
        return `c1.${encoded}.${signature}`;
    }
    verifyConfirmation(folderId, token, current) {
        const match = CONFIRMATION_TOKEN.exec(token);
        if (match === null)
            throw new ApiResponseError("CONFLICT");
        const encoded = match[1];
        const signature = match[2];
        const expected = createHmac("sha256", this.options.confirmationSecret).update(encoded).digest("base64url");
        if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected)))
            throw new ApiResponseError("CONFLICT");
        let payload;
        try {
            payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
        }
        catch {
            throw new ApiResponseError("CONFLICT");
        }
        if (!isConfirmationPayload(payload))
            throw new ApiResponseError("CONFLICT");
        if (payload.folder !== hashValue(folderId) || payload.descendantCount !== current.descendantCount || payload.treeVersion !== current.treeVersion || Date.parse(payload.expiresAt) <= this.now().getTime()) {
            throw new ApiResponseError("CONFLICT");
        }
    }
    serializeNoteOperation(noteId, operation) {
        const previous = this.noteOperations.get(noteId) ?? Promise.resolve();
        const result = previous.catch(() => undefined).then(operation);
        const settled = result.then(() => undefined, () => undefined);
        this.noteOperations.set(noteId, settled);
        return result.finally(() => { if (this.noteOperations.get(noteId) === settled)
            this.noteOperations.delete(noteId); });
    }
    now() { return this.options.now?.() ?? new Date(); }
    timestamp() { return this.now().toISOString(); }
}
const bump = (index, changes) => ({ ...index, ...changes, generation: index.generation + 1 });
const mergeEntry = (index, source, file, path, attachments) => {
    const note = parseNote(source);
    const existing = index.entries.find((entry) => entry.id === note.frontmatter.id);
    const targets = index.entries.filter((entry) => entry.id !== note.frontmatter.id).map((entry) => ({ id: entry.id, title: entry.title, aliases: entry.aliases }));
    targets.push({ id: note.frontmatter.id, title: note.frontmatter.title, aliases: note.frontmatter.aliases });
    const resolutions = extractWikiLinks(note.body).map((link) => ({ target: link.target, resolution: resolveWikiTarget(link.target, targets) }));
    const outboundNoteIds = unique(resolutions.flatMap(({ resolution }) => resolution.kind === "resolved" ? [resolution.noteId] : []));
    const unresolvedWikiTargets = unique(resolutions.filter(({ resolution }) => resolution.kind !== "resolved").map(({ target }) => target));
    const bodyText = deriveMarkdownPlainText(note.body);
    const entry = {
        id: note.frontmatter.id,
        title: note.frontmatter.title,
        aliases: [...note.frontmatter.aliases],
        driveId: file.id,
        path,
        created: note.frontmatter.created,
        updated: note.frontmatter.updated,
        driveVersion: file.version,
        tags: [...note.frontmatter.tags],
        searchText: fold([note.frontmatter.title, ...note.frontmatter.aliases, ...note.frontmatter.tags, bodyText].join(" ")).slice(0, 100_000),
        excerpt: bodyText.slice(0, 4_000),
        outboundNoteIds,
        unresolvedWikiTargets,
        attachments: attachments.map((attachment) => ({ ...attachment })),
        backlinks: [...(existing?.backlinks ?? [])]
    };
    const entries = index.entries.filter((candidate) => candidate.id !== entry.id).map((candidate) => ({ ...candidate, backlinks: candidate.backlinks.filter((sourceId) => sourceId !== entry.id) }));
    entries.push(entry);
    for (const targetId of outboundNoteIds) {
        const target = entries.find((candidate) => candidate.id === targetId);
        if (target !== undefined)
            target.backlinks = unique([...target.backlinks, entry.id]);
    }
    return { ...index, entries };
};
const removeEntries = (index, removed) => ({
    ...index,
    entries: index.entries.filter((entry) => !removed.has(entry.id)).map((entry) => ({
        ...entry,
        outboundNoteIds: entry.outboundNoteIds.filter((id) => !removed.has(id)),
        backlinks: entry.backlinks.filter((id) => !removed.has(id))
    }))
});
const removePathPrefix = (index, prefix) => removeEntries(index, new Set(index.entries.filter((entry) => entry.path.startsWith(`${prefix}/`)).map((entry) => entry.id)));
const replacePathPrefix = (index, oldPrefix, newPrefix) => ({
    ...index,
    entries: index.entries.map((entry) => entry.path.startsWith(`${oldPrefix}/`) ? { ...entry, path: `${newPrefix}${entry.path.slice(oldPrefix.length)}` } : entry)
});
const sanitizeName = (value) => {
    const withoutMarkdown = value.normalize("NFKC").trim().replace(/\.md$/iu, "");
    const sanitized = [...withoutMarkdown].map((character) => {
        const code = character.codePointAt(0);
        return code <= 31 || code === 127 ? " - " : character;
    }).join("").replace(/[\\/:*?"<>|]/gu, " - ").replace(/\s+/gu, " ").replace(/(?:\s*-\s*)+/gu, " - ").replace(/[. ]+$/gu, "").trim();
    if (sanitized.length === 0 || sanitized === "." || sanitized === "..")
        throw new ApiResponseError("INVALID_INPUT");
    return [...sanitized].slice(0, 240).join("");
};
const uniqueFolded = (values) => {
    const seen = new Set();
    return values.filter((value) => { const key = fold(value); if (seen.has(key))
        return false; seen.add(key); return true; });
};
const unique = (values) => [...new Set(values)];
const fold = (value) => value.normalize("NFKC").toLocaleLowerCase("en-US");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const pathsOverlap = (first, second) => {
    if (first === undefined || second === undefined)
        return false;
    const a = fold(first).replace(/\/+$/u, "");
    const b = fold(second).replace(/\/+$/u, "");
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
};
const mutationsOverlap = (first, second) => (first.noteId !== undefined && first.noteId === second.noteId) ||
    (first.folderId !== undefined && first.folderId === second.folderId) ||
    pathsOverlap(first.oldPath, second.oldPath) ||
    pathsOverlap(first.oldPath, second.newPath) ||
    pathsOverlap(first.newPath, second.oldPath) ||
    pathsOverlap(first.newPath, second.newPath);
const recalculateAttachmentLinks = (source, noteId, oldPath, newPath) => {
    const rewrite = (rawUrl) => {
        const wrapped = rawUrl.startsWith("<") && rawUrl.endsWith(">");
        const url = wrapped ? rawUrl.slice(1, -1) : rawUrl;
        if (/^[a-z][a-z0-9+.-]*:/iu.test(url) || url.startsWith("/"))
            return rawUrl;
        const absolute = posix.normalize(posix.join(posix.dirname(oldPath), url));
        const assetPrefix = `_assets/${noteId}/`;
        if (!absolute.startsWith(assetPrefix))
            return rawUrl;
        const next = posix.relative(posix.dirname(newPath), absolute);
        return wrapped ? `<${next}>` : next;
    };
    const inline = source.replace(/(\]\(\s*)(<[^>\r\n]+>|[^\s)\r\n]+)(?=(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^)\r\n]*\)))?\s*\))/gu, (_full, prefix, destination) => `${prefix}${rewrite(destination)}`);
    return inline.replace(/^(\s{0,3}\[[^\]\r\n]+\]:\s*)(<[^>\r\n]+>|[^\s\r\n]+)/gmu, (_full, prefix, destination) => `${prefix}${rewrite(destination)}`);
};
const hashTree = (tree) => createHash("sha256")
    .update(tree.map(({ file }) => `${file.id}\0${file.parentIds.join(",")}\0${file.version}\0${file.trashed ? "1" : "0"}`).join("\n"))
    .digest("hex");
const compareStoredFiles = (first, second) => fold(first.name).localeCompare(fold(second.name), "en-US") || first.id.localeCompare(second.id, "en-US");
const compareTreeItems = (first, second) => fold(first.path).localeCompare(fold(second.path), "en-US") || first.file.id.localeCompare(second.file.id, "en-US");
const hashValue = (value) => createHash("sha256").update(value).digest("base64url");
const isConfirmationPayload = (value) => typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 4 &&
    typeof value.folder === "string" && Number.isSafeInteger(value.descendantCount) &&
    typeof value.treeVersion === "string" && typeof value.expiresAt === "string";
//# sourceMappingURL=vault-service.js.map