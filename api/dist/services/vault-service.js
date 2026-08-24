import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { posix } from "node:path";
import { CreateFolderRequestSchema, CreateNoteRequestSchema, NoteIdSchema, NoteTitleSchema } from "@nxt/contracts";
import { deriveIndex, parseNote, serializeNote } from "@nxt/domain";
import { ApiResponseError } from "../http/api-response.js";
import { preserveApiError } from "./system-file-store.js";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const MARKDOWN_MIME_TYPE = "text/markdown";
const MAX_FOLDER_DEPTH = 20;
const MAX_LIST_PAGES = 1_000;
const CONFIRMATION_TTL_MS = 5 * 60 * 1_000;
const TOKEN_PART = /^[A-Za-z0-9_-]+$/u;
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
        let request;
        try {
            request = CreateNoteRequestSchema.parse(input);
        }
        catch {
            throw new ApiResponseError("INVALID_INPUT");
        }
        await this.assertFolderDestination(request.folderId);
        const fileName = `${sanitizeName(request.title)}.md`;
        await this.assertNameAvailable(request.folderId, fileName);
        const index = await this.options.indexStore.read();
        const id = this.options.createId?.() ?? crypto.randomUUID();
        try {
            NoteIdSchema.parse(id);
        }
        catch {
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        }
        if (index.value.entries.some((entry) => entry.id === id))
            throw new ApiResponseError("CONFLICT");
        const timestamp = this.timestamp();
        const source = serializeNote({
            frontmatter: {
                id,
                title: request.title,
                created: timestamp,
                updated: timestamp,
                tags: [],
                aliases: []
            },
            body: request.body
        });
        let created;
        try {
            created = await this.options.storage.createText({
                parentId: request.folderId,
                name: fileName,
                mimeType: MARKDOWN_MIME_TYPE,
                text: source
            });
        }
        catch (error) {
            throw preserveApiError(error, "DRIVE_UNAVAILABLE");
        }
        const verified = await this.verifyNoteReadback(created.id, source, created.version);
        const path = await this.notePath(verified.file);
        await this.rebuildIndex(index, {
            source,
            driveId: created.id,
            path,
            driveVersion: verified.file.version,
            attachments: []
        });
        return this.result(source, verified.file, path, verified.checksum);
    }
    async getNote(noteId) {
        const { entry } = await this.findEntry(noteId);
        let readback;
        try {
            readback = await this.options.storage.readText(entry.driveId);
        }
        catch (error) {
            throw preserveApiError(error, "NOT_FOUND");
        }
        this.assertMarkdownFile(readback.file);
        const note = this.parseOwnedNote(readback.text, noteId);
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
            let title;
            try {
                title = NoteTitleSchema.parse(input.title);
            }
            catch {
                throw new ApiResponseError("INVALID_INPUT");
            }
            const opened = await this.getNote(input.noteId);
            if (opened.version !== input.expectedVersion)
                throw new ApiResponseError("CONFLICT");
            const aliases = uniqueFolded([...opened.note.frontmatter.aliases, opened.note.frontmatter.title]);
            const source = serializeNote({
                frontmatter: {
                    ...opened.note.frontmatter,
                    title,
                    aliases,
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
        return this.moveNote({
            noteId: input.noteId,
            expectedVersion: input.expectedVersion,
            folderId: this.options.folders.archiveId
        });
    }
    trashNote(input) {
        return this.serializeNoteOperation(input.noteId, async () => {
            const { index, entry } = await this.findEntry(input.noteId);
            const file = await this.preflight(entry.driveId, input.expectedVersion);
            try {
                const trashed = await this.options.storage.trash(file.id);
                if (!trashed.trashed)
                    throw new Error("Trash readback did not confirm deletion");
            }
            catch (error) {
                throw preserveApiError(error, "DRIVE_UNAVAILABLE");
            }
            await this.rebuildIndex(index, undefined, input.noteId);
            return { trashed: true };
        });
    }
    async createFolder(input) {
        let request;
        try {
            request = CreateFolderRequestSchema.parse(input);
        }
        catch {
            throw new ApiResponseError("INVALID_INPUT");
        }
        const parentDepth = await this.folderDepth(request.parentId);
        if (parentDepth >= MAX_FOLDER_DEPTH)
            throw new ApiResponseError("INVALID_INPUT");
        const name = sanitizeName(request.name);
        await this.assertNameAvailable(request.parentId, name);
        try {
            return await this.options.storage.createFolder({ parentId: request.parentId, name });
        }
        catch (error) {
            throw preserveApiError(error, "DRIVE_UNAVAILABLE");
        }
    }
    async renameFolder(input) {
        if (this.protectedFolders.has(input.folderId))
            throw new ApiResponseError("INVALID_INPUT");
        const file = await this.preflight(input.folderId, input.expectedVersion);
        this.assertFolder(file);
        const parentId = file.parentIds[0];
        if (parentId === undefined)
            throw new ApiResponseError("INVALID_INPUT");
        const name = sanitizeName(input.name);
        await this.assertNameAvailable(parentId, name, file.id);
        try {
            return await this.options.storage.move({
                fileId: file.id,
                fromParentId: parentId,
                toParentId: parentId,
                newName: name
            });
        }
        catch (error) {
            throw preserveApiError(error, "DRIVE_UNAVAILABLE");
        }
    }
    async moveFolder(input) {
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
        try {
            return await this.options.storage.move({ fileId: file.id, fromParentId: oldParentId, toParentId: input.parentId });
        }
        catch (error) {
            throw preserveApiError(error, "DRIVE_UNAVAILABLE");
        }
    }
    async issueFolderDeleteConfirmation(folderId) {
        if (this.protectedFolders.has(folderId))
            throw new ApiResponseError("INVALID_INPUT");
        const file = await this.options.storage.get(folderId).catch(() => { throw new ApiResponseError("NOT_FOUND"); });
        this.assertFolder(file);
        await this.folderDepth(folderId);
        const tree = await this.collectTree();
        const descendants = tree.filter((item) => isDescendant(item.file.id, folderId, tree));
        const noteIds = new Set();
        for (const item of descendants) {
            if (item.file.mimeType !== FOLDER_MIME_TYPE && item.file.name.toLocaleLowerCase("en-US").endsWith(".md")) {
                try {
                    noteIds.add(parseNote((await this.options.storage.readText(item.file.id)).text).frontmatter.id);
                }
                catch {
                    // Invalid notes still count as one descendant file, but have no attachment identity.
                }
            }
        }
        const index = await this.options.indexStore.read();
        const attachmentCount = index.value.entries
            .filter((entry) => noteIds.has(entry.id))
            .reduce((count, entry) => count + entry.attachments.length, 0);
        const descendantCount = descendants.length + attachmentCount;
        const treeVersion = hashTree(tree);
        const expiresAt = new Date(this.now().getTime() + CONFIRMATION_TTL_MS).toISOString();
        const payload = {
            folder: hashValue(folderId),
            descendantCount,
            treeVersion,
            expiresAt
        };
        return {
            descendantCount,
            treeVersion,
            expiresAt,
            confirmationToken: this.signConfirmation(payload)
        };
    }
    async trashFolder(input) {
        if (this.protectedFolders.has(input.folderId))
            throw new ApiResponseError("INVALID_INPUT");
        const confirmation = await this.issueFolderDeleteConfirmation(input.folderId);
        if (confirmation.treeVersion !== input.expectedTreeVersion)
            throw new ApiResponseError("CONFLICT");
        if (confirmation.descendantCount > 0) {
            if (input.confirmationToken === undefined)
                throw new ApiResponseError("CONFLICT");
            this.verifyConfirmation(input.folderId, input.confirmationToken, confirmation);
        }
        try {
            const trashed = await this.options.storage.trash(input.folderId);
            if (!trashed.trashed)
                throw new Error("Trash readback did not confirm deletion");
            return { trashed: true };
        }
        catch (error) {
            throw preserveApiError(error, "DRIVE_UNAVAILABLE");
        }
    }
    async vaultTree() {
        const tree = await this.collectTree();
        return {
            treeVersion: hashTree(tree),
            folders: tree
                .filter((item) => item.file.mimeType === FOLDER_MIME_TYPE)
                .map((item) => ({
                id: item.file.id,
                name: item.file.name,
                path: item.path,
                version: item.file.version,
                protected: this.protectedFolders.has(item.file.id)
            }))
        };
    }
    async updateNoteUnserialized(input) {
        const { index, entry } = await this.findEntry(input.noteId);
        const beforeFile = await this.preflight(entry.driveId, input.expectedVersion);
        this.assertMarkdownFile(beforeFile);
        const beforeRead = await this.options.storage.readText(beforeFile.id).catch((error) => {
            throw preserveApiError(error, "DRIVE_UNAVAILABLE");
        });
        const beforeNote = this.parseOwnedNote(beforeRead.text, input.noteId);
        let nextNote = this.parseOwnedNote(input.source, input.noteId);
        const titleChanged = fold(nextNote.frontmatter.title) !== fold(beforeNote.frontmatter.title);
        if (titleChanged) {
            nextNote = {
                ...nextNote,
                frontmatter: {
                    ...nextNote.frontmatter,
                    aliases: uniqueFolded([...nextNote.frontmatter.aliases, beforeNote.frontmatter.title])
                }
            };
        }
        const source = serializeNote(nextNote);
        const parentId = beforeFile.parentIds[0];
        if (parentId === undefined)
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        const newName = `${sanitizeName(nextNote.frontmatter.title)}.md`;
        if (titleChanged || beforeFile.name !== newName)
            await this.assertNameAvailable(parentId, newName, beforeFile.id);
        let written;
        try {
            written = await this.options.storage.updateText({
                fileId: beforeFile.id,
                expectedVersion: beforeFile.version,
                mimeType: MARKDOWN_MIME_TYPE,
                text: source
            });
            if (beforeFile.name !== newName) {
                written = await this.options.storage.move({
                    fileId: written.id,
                    fromParentId: parentId,
                    toParentId: parentId,
                    newName
                });
            }
        }
        catch (error) {
            throw new ApiResponseError(isVersionConflict(error) ? "CONFLICT" : "DRIVE_UNAVAILABLE");
        }
        const verified = await this.verifyNoteReadback(written.id, source, written.version);
        const path = await this.notePath(verified.file);
        await this.rebuildIndex(index, {
            source,
            driveId: verified.file.id,
            path,
            driveVersion: verified.file.version,
            attachments: entry.attachments
        }, input.noteId);
        return this.result(source, verified.file, path, verified.checksum);
    }
    async moveNoteUnserialized(input) {
        await this.assertFolderDestination(input.folderId);
        const { index, entry } = await this.findEntry(input.noteId);
        let file = await this.preflight(entry.driveId, input.expectedVersion);
        this.assertMarkdownFile(file);
        const fromParentId = file.parentIds[0];
        if (fromParentId === undefined || fromParentId === input.folderId)
            throw new ApiResponseError("INVALID_INPUT");
        await this.assertNameAvailable(input.folderId, file.name);
        const readback = await this.options.storage.readText(file.id).catch((error) => {
            throw preserveApiError(error, "DRIVE_UNAVAILABLE");
        });
        this.parseOwnedNote(readback.text, input.noteId);
        const oldPath = await this.notePath(file);
        const destinationFolderPath = await this.folderPath(input.folderId);
        const newPath = `${destinationFolderPath}/${file.name}`;
        const source = recalculateAttachmentLinks(readback.text, input.noteId, oldPath, newPath);
        try {
            if (source !== readback.text) {
                file = await this.options.storage.updateText({
                    fileId: file.id,
                    expectedVersion: file.version,
                    mimeType: MARKDOWN_MIME_TYPE,
                    text: source
                });
            }
            file = await this.options.storage.move({
                fileId: file.id,
                fromParentId,
                toParentId: input.folderId
            });
        }
        catch (error) {
            throw new ApiResponseError(isVersionConflict(error) ? "CONFLICT" : "DRIVE_UNAVAILABLE");
        }
        const verified = await this.verifyNoteReadback(file.id, source, file.version);
        const path = await this.notePath(verified.file);
        await this.rebuildIndex(index, {
            source,
            driveId: verified.file.id,
            path,
            driveVersion: verified.file.version,
            attachments: entry.attachments
        }, input.noteId);
        return this.result(source, verified.file, path, verified.checksum);
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
    async rebuildIndex(base, replacement, replacedOrRemovedId) {
        const records = [];
        for (const entry of base.value.entries) {
            if (entry.id === replacedOrRemovedId)
                continue;
            let readback;
            try {
                readback = await this.options.storage.readText(entry.driveId);
            }
            catch (error) {
                throw preserveApiError(error, "DRIVE_UNAVAILABLE");
            }
            this.parseOwnedNote(readback.text, entry.id);
            records.push({
                source: readback.text,
                driveId: readback.file.id,
                path: await this.notePath(readback.file),
                driveVersion: readback.file.version,
                attachments: entry.attachments
            });
        }
        if (replacement !== undefined)
            records.push(replacement);
        let next;
        try {
            next = deriveIndex(records);
        }
        catch {
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        }
        await this.options.indexStore.update(next, base.file.version);
    }
    async verifyNoteReadback(fileId, source, expectedVersion) {
        let readback;
        try {
            readback = await this.options.storage.readText(fileId);
        }
        catch (error) {
            throw preserveApiError(error, "DRIVE_UNAVAILABLE");
        }
        this.assertMarkdownFile(readback.file);
        if (readback.file.version !== expectedVersion ||
            readback.text !== source ||
            readback.checksum !== createHash("sha256").update(source).digest("hex")) {
            throw new ApiResponseError("CONFLICT");
        }
        return { file: readback.file, checksum: readback.checksum };
    }
    async preflight(fileId, expectedVersion) {
        let file;
        try {
            file = await this.options.storage.get(fileId);
        }
        catch {
            throw new ApiResponseError("NOT_FOUND");
        }
        if (file.version !== expectedVersion)
            throw new ApiResponseError("CONFLICT");
        return file;
    }
    parseOwnedNote(source, noteId) {
        let note;
        try {
            note = parseNote(source);
        }
        catch {
            throw new ApiResponseError("UNSAFE_FILE");
        }
        if (note.frontmatter.id !== noteId)
            throw new ApiResponseError("CONFLICT");
        return note;
    }
    result(source, file, path, checksum) {
        const note = parseNote(source);
        return { note: { ...note, path }, source, driveId: file.id, version: file.version, path, checksum };
    }
    assertMarkdownFile(file) {
        if (file.trashed || file.mimeType !== MARKDOWN_MIME_TYPE || !file.name.toLocaleLowerCase("en-US").endsWith(".md")) {
            throw new ApiResponseError("UNSAFE_FILE");
        }
    }
    assertFolder(file) {
        if (file.trashed || file.mimeType !== FOLDER_MIME_TYPE)
            throw new ApiResponseError("INVALID_INPUT");
    }
    async assertFolderDestination(folderId) {
        await this.folderDepth(folderId);
    }
    async folderDepth(folderId) {
        let currentId = folderId;
        const seen = new Set();
        for (let depth = 0; depth <= MAX_FOLDER_DEPTH; depth += 1) {
            if (seen.has(currentId))
                throw new ApiResponseError("INVALID_INPUT");
            seen.add(currentId);
            const file = await this.options.storage.get(currentId).catch(() => { throw new ApiResponseError("INVALID_INPUT"); });
            this.assertFolder(file);
            if (file.id === this.options.folders.notesId)
                return depth;
            if (file.parentIds.length !== 1)
                throw new ApiResponseError("INVALID_INPUT");
            currentId = file.parentIds[0];
        }
        throw new ApiResponseError("INVALID_INPUT");
    }
    async folderPath(folderId) {
        let currentId = folderId;
        const names = [];
        for (let depth = 0; depth <= MAX_FOLDER_DEPTH; depth += 1) {
            const file = await this.options.storage.get(currentId).catch(() => { throw new ApiResponseError("INVALID_INPUT"); });
            this.assertFolder(file);
            if (file.id === this.options.folders.notesId)
                return ["Notes", ...names.reverse()].join("/");
            names.push(file.name);
            if (file.parentIds.length !== 1)
                throw new ApiResponseError("INVALID_INPUT");
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
        for (const file of await this.listAllChildren(parentId)) {
            if (file.id !== ignoredId && fold(file.name) === folded)
                throw new ApiResponseError("CONFLICT");
        }
    }
    async listAllChildren(parentId) {
        const files = [];
        const seenTokens = new Set();
        let pageToken;
        for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
            const result = await this.options.storage.listChildren({
                parentId,
                pageSize: 100,
                ...(pageToken === undefined ? {} : { pageToken })
            }).catch((error) => { throw preserveApiError(error, "DRIVE_UNAVAILABLE"); });
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
        const root = await this.options.storage.get(this.options.folders.notesId).catch(() => { throw new ApiResponseError("DRIVE_UNAVAILABLE"); });
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
            for (const child of await this.listAllChildren(current.id)) {
                if (child.mimeType === FOLDER_MIME_TYPE)
                    queue.push({ id: child.id, depth: current.depth + 1 });
            }
        }
        return maximum;
    }
    signConfirmation(payload) {
        const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
        const signature = createHmac("sha256", this.options.confirmationSecret).update(encoded).digest("base64url");
        return `${encoded}.${signature}`;
    }
    verifyConfirmation(folderId, token, current) {
        const [encoded, signature, extra] = token.split(".");
        if (encoded === undefined || signature === undefined || extra !== undefined || !TOKEN_PART.test(encoded) || !TOKEN_PART.test(signature)) {
            throw new ApiResponseError("CONFLICT");
        }
        const expected = createHmac("sha256", this.options.confirmationSecret).update(encoded).digest();
        let supplied;
        try {
            supplied = Buffer.from(signature, "base64url");
        }
        catch {
            throw new ApiResponseError("CONFLICT");
        }
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
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
        if (payload.folder !== hashValue(folderId) ||
            payload.descendantCount !== current.descendantCount ||
            payload.treeVersion !== current.treeVersion ||
            Date.parse(payload.expiresAt) <= this.now().getTime()) {
            throw new ApiResponseError("CONFLICT");
        }
    }
    serializeNoteOperation(noteId, operation) {
        const previous = this.noteOperations.get(noteId) ?? Promise.resolve();
        const result = previous.catch(() => undefined).then(operation);
        const settled = result.then(() => undefined, () => undefined);
        this.noteOperations.set(noteId, settled);
        return result.finally(() => {
            if (this.noteOperations.get(noteId) === settled)
                this.noteOperations.delete(noteId);
        });
    }
    now() {
        return this.options.now?.() ?? new Date();
    }
    timestamp() {
        return this.now().toISOString();
    }
}
const sanitizeName = (value) => {
    const withoutMarkdown = value.normalize("NFKC").trim().replace(/\.md$/iu, "");
    const sanitized = [...withoutMarkdown]
        .map((character) => {
        const code = character.codePointAt(0);
        return code <= 31 || code === 127 ? " - " : character;
    })
        .join("")
        .replace(/[\\/:*?"<>|]/gu, " - ")
        .replace(/\s+/gu, " ")
        .replace(/(?:\s*-\s*)+/gu, " - ")
        .replace(/[. ]+$/gu, "")
        .trim();
    if (sanitized.length === 0 || sanitized === "." || sanitized === "..")
        throw new ApiResponseError("INVALID_INPUT");
    return [...sanitized].slice(0, 240).join("");
};
const uniqueFolded = (values) => {
    const seen = new Set();
    return values.filter((value) => {
        const key = fold(value);
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
};
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
    .update(tree
    .map(({ file }) => `${file.id}\0${file.parentIds.join(",")}\0${file.version}\0${file.trashed ? "1" : "0"}`)
    .sort()
    .join("\n"))
    .digest("hex");
const hashValue = (value) => createHash("sha256").update(value).digest("base64url");
const isDescendant = (candidateId, ancestorId, tree) => {
    const byId = new Map(tree.map((item) => [item.file.id, item.file]));
    let current = byId.get(candidateId);
    const seen = new Set();
    while (current !== undefined && current.parentIds.length === 1) {
        const parent = current.parentIds[0];
        if (parent === ancestorId)
            return true;
        if (seen.has(parent))
            return false;
        seen.add(parent);
        current = byId.get(parent);
    }
    return false;
};
const isConfirmationPayload = (value) => typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === 4 &&
    typeof value.folder === "string" &&
    Number.isSafeInteger(value.descendantCount) &&
    typeof value.treeVersion === "string" &&
    typeof value.expiresAt === "string";
const isVersionConflict = (error) => error instanceof Error && /version conflict/iu.test(error.message);
//# sourceMappingURL=vault-service.js.map