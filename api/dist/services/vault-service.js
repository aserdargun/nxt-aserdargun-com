import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { posix } from "node:path";
import { MAX_NOTE_SOURCE_BYTES, NoteIdSchema, NoteTitleSchema } from "@nxt/contracts";
import { deriveMarkdownPlainText, extractWikiLinks, parseNote, resolveWikiTarget, serializeNote } from "@nxt/domain";
import { ApiResponseError } from "../http/api-response.js";
import { StorageVersionConflictError } from "../storage/storage-port.js";
import { preserveApiError } from "./system-file-store.js";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const MARKDOWN_MIME_TYPE = "text/markdown";
const MAX_FOLDER_DEPTH = 20;
const MAX_LIST_PAGES = 1_000;
const CONFIRMATION_TTL_MS = 5 * 60 * 1_000;
const MUTATION_TTL_MS = 30 * 1_000;
const CONFIRMATION_TOKEN = /^c1\.([A-Za-z0-9_-]{16,430})\.([A-Za-z0-9_-]{43})$/u;
export class VaultService {
    options;
    noteOperations = new Map();
    protectedFolders;
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
        await this.reconcileExpiredMutations();
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
            newPath: `${parentPath}/${targetName}`
        });
        await this.reserve(mutation);
        let created;
        try {
            created = await this.options.storage.createText({
                parentId: input.folderId,
                name: targetName,
                mimeType: MARKDOWN_MIME_TYPE,
                text: source
            });
            const verified = await this.verifyNoteReadback(created.id, source, created.version);
            const path = await this.notePath(verified.file);
            await this.finalizeEntry(mutation.id, source, verified.file, path, []);
            return this.result(source, verified.file, path, verified.checksum);
        }
        catch (error) {
            if (created === undefined)
                await this.cancel(mutation.id);
            else
                await this.expire(mutation.id);
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
            await this.reconcileExpiredMutations();
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
            let changed = false;
            try {
                const trashed = await this.options.storage.trash(file.id);
                if (!trashed.trashed)
                    throw new ApiResponseError("DRIVE_UNAVAILABLE");
                changed = true;
                await this.finalize(mutation.id, (index) => removeEntries(index, new Set([input.noteId])));
                await this.prunePreferences();
                return { trashed: true };
            }
            catch (error) {
                if (changed)
                    await this.expire(mutation.id);
                else
                    await this.cancel(mutation.id);
                throw preserveApiError(error, "DRIVE_UNAVAILABLE");
            }
        });
    }
    async createFolder(input) {
        await this.reconcileExpiredMutations();
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
            created = await this.options.storage.createFolder({ parentId: input.parentId, name });
            const verified = await this.options.storage.get(created.id);
            if (verified.version !== created.version || verified.mimeType !== FOLDER_MIME_TYPE || verified.parentIds[0] !== input.parentId || verified.name !== name) {
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            }
            await this.clearMutation(mutation.id);
            return verified;
        }
        catch (error) {
            if (created === undefined)
                await this.cancel(mutation.id);
            else
                await this.expire(mutation.id);
            throw preserveApiError(error, "DRIVE_UNAVAILABLE");
        }
    }
    async renameFolder(input) {
        await this.reconcileExpiredMutations();
        if (this.protectedFolders.has(input.folderId))
            throw new ApiResponseError("INVALID_INPUT");
        const file = await this.preflight(input.folderId, input.expectedVersion);
        this.assertFolder(file);
        const parentId = file.parentIds[0];
        if (parentId === undefined)
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        const name = sanitizeName(input.name);
        await this.assertNameAvailable(parentId, name, file.id);
        const oldPath = await this.folderPath(file.id);
        const newPath = `${posix.dirname(oldPath)}/${name}`;
        const mutation = this.newMutation({ operation: "rename-folder", folderId: file.id, oldPath, newPath, expectedVersion: input.expectedVersion });
        await this.reserve(mutation);
        let changed = false;
        try {
            const moved = await this.options.storage.move({ fileId: file.id, fromParentId: parentId, toParentId: parentId, newName: name });
            changed = true;
            const verified = await this.options.storage.get(moved.id);
            if (verified.version !== moved.version || verified.name !== name)
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            await this.finalize(mutation.id, (index) => replacePathPrefix(index, oldPath, newPath));
            return verified;
        }
        catch (error) {
            if (changed)
                await this.expire(mutation.id);
            else
                await this.cancel(mutation.id);
            throw preserveApiError(error, "DRIVE_UNAVAILABLE");
        }
    }
    async moveFolder(input) {
        await this.reconcileExpiredMutations();
        if (this.protectedFolders.has(input.folderId))
            throw new ApiResponseError("INVALID_INPUT");
        const file = await this.preflight(input.folderId, input.expectedVersion);
        this.assertFolder(file);
        const oldParentId = file.parentIds[0];
        if (oldParentId === undefined || input.folderId === input.parentId)
            throw new ApiResponseError("INVALID_INPUT");
        const parentDepth = await this.folderDepth(input.parentId);
        const subtreeDepth = await this.maximumSubtreeDepth(input.folderId);
        if (parentDepth + 1 + subtreeDepth > MAX_FOLDER_DEPTH)
            throw new ApiResponseError("INVALID_INPUT");
        await this.assertNameAvailable(input.parentId, file.name);
        const oldPath = await this.folderPath(file.id);
        const newPath = `${await this.folderPath(input.parentId)}/${file.name}`;
        const mutation = this.newMutation({
            operation: "move-folder",
            folderId: file.id,
            targetParentId: input.parentId,
            oldPath,
            newPath,
            expectedVersion: input.expectedVersion
        });
        await this.reserve(mutation);
        let changed = false;
        try {
            const moved = await this.options.storage.move({ fileId: file.id, fromParentId: oldParentId, toParentId: input.parentId });
            changed = true;
            const verified = await this.options.storage.get(moved.id);
            if (verified.version !== moved.version || verified.parentIds[0] !== input.parentId)
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            await this.finalize(mutation.id, (index) => replacePathPrefix(index, oldPath, newPath));
            return verified;
        }
        catch (error) {
            if (changed)
                await this.expire(mutation.id);
            else
                await this.cancel(mutation.id);
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
        await this.reconcileExpiredMutations();
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
        let changed = false;
        try {
            const trashed = await this.options.storage.trash(input.folderId);
            if (!trashed.trashed)
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            changed = true;
            await this.finalize(mutation.id, (index) => removePathPrefix(index, folder.path));
            await this.prunePreferences();
            return { trashed: true };
        }
        catch (error) {
            if (changed)
                await this.expire(mutation.id);
            else
                await this.cancel(mutation.id);
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
        await this.reconcileExpiredMutations();
        const { entry } = await this.findEntry(input.noteId);
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
        const newPath = `${posix.dirname(oldPath)}/${newName}`;
        const mutation = this.newMutation({
            operation: "update-note",
            noteId: input.noteId,
            driveId: beforeFile.id,
            parentId,
            targetName: newName,
            oldPath,
            newPath,
            expectedVersion: input.expectedVersion
        });
        await this.reserve(mutation);
        let written;
        try {
            written = await this.options.storage.updateText({ fileId: beforeFile.id, expectedVersion: beforeFile.version, mimeType: MARKDOWN_MIME_TYPE, text: source });
            if (beforeFile.name !== newName)
                written = await this.options.storage.move({ fileId: written.id, fromParentId: parentId, toParentId: parentId, newName });
            const verified = await this.verifyNoteReadback(written.id, source, written.version);
            const path = await this.notePath(verified.file);
            await this.finalizeEntry(mutation.id, source, verified.file, path, entry.attachments);
            return this.result(source, verified.file, path, verified.checksum);
        }
        catch (error) {
            if (written === undefined)
                await this.cancel(mutation.id);
            else
                await this.expire(mutation.id);
            if (error instanceof StorageVersionConflictError)
                throw new ApiResponseError("CONFLICT");
            throw preserveApiError(error, "DRIVE_UNAVAILABLE");
        }
    }
    async moveNoteUnserialized(input) {
        await this.reconcileExpiredMutations();
        await this.assertFolderDestination(input.folderId);
        const { entry } = await this.findEntry(input.noteId);
        let file = await this.preflight(entry.driveId, input.expectedVersion);
        this.assertMarkdownFile(file);
        const fromParentId = file.parentIds[0];
        if (fromParentId === undefined || fromParentId === input.folderId)
            throw new ApiResponseError("INVALID_INPUT");
        await this.assertNameAvailable(input.folderId, file.name);
        const readback = await this.readNote(file.id);
        this.parseOwnedNote(readback.text, input.noteId, "DRIVE_UNAVAILABLE", "DRIVE_UNAVAILABLE");
        const oldPath = await this.notePath(file);
        const newPath = `${await this.folderPath(input.folderId)}/${file.name}`;
        const source = recalculateAttachmentLinks(readback.text, input.noteId, oldPath, newPath);
        this.assertSourceSize(source);
        const mutation = this.newMutation({
            operation: "move-note",
            noteId: input.noteId,
            driveId: file.id,
            targetParentId: input.folderId,
            targetName: file.name,
            oldPath,
            newPath,
            expectedVersion: input.expectedVersion
        });
        await this.reserve(mutation);
        let changed = false;
        try {
            if (source !== readback.text) {
                file = await this.options.storage.updateText({ fileId: file.id, expectedVersion: file.version, mimeType: MARKDOWN_MIME_TYPE, text: source });
                changed = true;
            }
            file = await this.options.storage.move({ fileId: file.id, fromParentId, toParentId: input.folderId });
            changed = true;
            const verified = await this.verifyNoteReadback(file.id, source, file.version);
            const path = await this.notePath(verified.file);
            await this.finalizeEntry(mutation.id, source, verified.file, path, entry.attachments);
            return this.result(source, verified.file, path, verified.checksum);
        }
        catch (error) {
            if (changed)
                await this.expire(mutation.id);
            else
                await this.cancel(mutation.id);
            if (error instanceof StorageVersionConflictError)
                throw new ApiResponseError("CONFLICT");
            throw preserveApiError(error, "DRIVE_UNAVAILABLE");
        }
    }
    async reserve(mutation) {
        await this.options.indexStore.compareAndSet((index) => {
            if (index.rescanState !== null)
                throw new ApiResponseError("CONFLICT");
            if (index.entries.some((entry) => mutation.noteId !== undefined && entry.id === mutation.noteId && mutation.operation === "create-note"))
                throw new ApiResponseError("CONFLICT");
            const targetPath = mutation.newPath === undefined ? undefined : fold(mutation.newPath);
            if (index.entries.some((entry) => targetPath !== undefined && fold(entry.path) === targetPath && entry.id !== mutation.noteId))
                throw new ApiResponseError("CONFLICT");
            if (index.pendingMutations.some((pending) => (mutation.noteId !== undefined && pending.noteId === mutation.noteId) ||
                (targetPath !== undefined && pending.newPath !== undefined && fold(pending.newPath) === targetPath) ||
                (mutation.folderId !== undefined && pending.folderId === mutation.folderId)))
                throw new ApiResponseError("CONFLICT");
            return bump(index, { pendingMutations: [...index.pendingMutations, mutation] });
        });
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
    async cancel(mutationId) {
        await this.options.indexStore.compareAndSet((index) => bump(index, { pendingMutations: index.pendingMutations.filter((mutation) => mutation.id !== mutationId) })).catch(() => undefined);
    }
    async clearMutation(mutationId) {
        await this.options.indexStore.compareAndSet((index) => bump(index, {
            pendingMutations: index.pendingMutations.filter((mutation) => mutation.id !== mutationId)
        }));
    }
    async expire(mutationId) {
        const expiresAt = this.timestamp();
        await this.options.indexStore.compareAndSet((index) => bump(index, {
            pendingMutations: index.pendingMutations.map((mutation) => mutation.id === mutationId ? { ...mutation, expiresAt } : mutation)
        })).catch(() => undefined);
    }
    async reconcileExpiredMutations() {
        const snapshot = await this.options.indexStore.read();
        const expired = snapshot.value.pendingMutations.filter((mutation) => Date.parse(mutation.expiresAt) <= this.now().getTime());
        for (const mutation of expired)
            await this.reconcile(mutation);
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
        if (mutation.operation === "create-folder") {
            if (mutation.parentId === undefined || mutation.targetName === undefined)
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            const matches = (await this.listAllChildren(mutation.parentId)).filter((file) => fold(file.name) === fold(mutation.targetName));
            if (matches.length > 1 || (matches[0] !== undefined && matches[0].mimeType !== FOLDER_MIME_TYPE))
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            return this.clearMutation(mutation.id);
        }
        if (mutation.operation === "create-note") {
            if (mutation.parentId === undefined || mutation.targetName === undefined || mutation.noteId === undefined)
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            const matches = (await this.listAllChildren(mutation.parentId)).filter((file) => fold(file.name) === fold(mutation.targetName));
            if (matches.length === 0)
                return this.cancel(mutation.id);
            if (matches.length !== 1)
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            const readback = await this.readNote(matches[0].id);
            this.parseOwnedNote(readback.text, mutation.noteId, "DRIVE_UNAVAILABLE", "DRIVE_UNAVAILABLE");
            return this.finalizeEntry(mutation.id, readback.text, readback.file, await this.notePath(readback.file), []);
        }
        if (mutation.operation === "trash-note") {
            if (mutation.noteId === undefined || mutation.driveId === undefined)
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            const file = await this.options.storage.get(mutation.driveId).catch(() => { throw new ApiResponseError("DRIVE_UNAVAILABLE"); });
            return file.trashed ? this.finalize(mutation.id, (index) => removeEntries(index, new Set([mutation.noteId]))) : this.cancel(mutation.id);
        }
        if (mutation.operation === "update-note" || mutation.operation === "move-note") {
            if (mutation.noteId === undefined || mutation.driveId === undefined)
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            const readback = await this.readNote(mutation.driveId);
            this.parseOwnedNote(readback.text, mutation.noteId, "DRIVE_UNAVAILABLE", "DRIVE_UNAVAILABLE");
            const current = await this.options.indexStore.read();
            const attachments = current.value.entries.find((entry) => entry.id === mutation.noteId)?.attachments ?? [];
            return this.finalizeEntry(mutation.id, readback.text, readback.file, await this.notePath(readback.file), attachments);
        }
        if (mutation.folderId === undefined || mutation.oldPath === undefined)
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        const folder = await this.options.storage.get(mutation.folderId).catch(() => { throw new ApiResponseError("DRIVE_UNAVAILABLE"); });
        if (mutation.operation === "trash-folder") {
            return folder.trashed ? this.finalize(mutation.id, (index) => removePathPrefix(index, mutation.oldPath)) : this.cancel(mutation.id);
        }
        if (folder.trashed)
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        const actualPath = await this.folderPath(folder.id);
        return this.finalize(mutation.id, (index) => replacePathPrefix(index, mutation.oldPath, actualPath));
    }
    newMutation(fields) {
        const now = this.now();
        return { id: randomUUID(), ...fields, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + MUTATION_TTL_MS).toISOString() };
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
        let currentId = folderId;
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
            if (file.id === this.options.folders.notesId)
                return depth;
            if (file.parentIds.length !== 1)
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            currentId = file.parentIds[0];
        }
        throw new ApiResponseError("INVALID_INPUT");
    }
    async folderPath(folderId) {
        let currentId = folderId;
        const names = [];
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
            if (file.id === this.options.folders.notesId)
                return ["Notes", ...names.reverse()].join("/");
            names.push(file.name);
            if (file.parentIds.length !== 1)
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            currentId = file.parentIds[0];
        }
        throw new ApiResponseError("INVALID_INPUT");
    }
    async notePath(file) {
        const parentId = file.parentIds[0];
        if (parentId === undefined)
            throw new ApiResponseError("UNSAFE_FILE");
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
            for (const file of await this.listAllChildren(parent.file.id)) {
                const item = { file, path: `${parent.path}/${file.name}` };
                tree.push(item);
                if (file.mimeType === FOLDER_MIME_TYPE)
                    queue.push(item);
            }
        }
        return tree;
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
    .update(tree.map(({ file }) => `${file.id}\0${file.parentIds.join(",")}\0${file.version}\0${file.trashed ? "1" : "0"}`).sort().join("\n"))
    .digest("hex");
const hashValue = (value) => createHash("sha256").update(value).digest("base64url");
const isConfirmationPayload = (value) => typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 4 &&
    typeof value.folder === "string" && Number.isSafeInteger(value.descendantCount) &&
    typeof value.treeVersion === "string" && typeof value.expiresAt === "string";
//# sourceMappingURL=vault-service.js.map