import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const MAX_FILE_ID_LENGTH = 512;
const MAX_NAME_LENGTH = 255;
const MAX_PAGE_SIZE = 1000;
const GENERATED_ID = /^file_[0-9a-z]+$/;
export class LocalDriveAdapter {
    root;
    beforeMetadataWrite;
    beforeMetadataRollbackWrite;
    beforeMutationLoad;
    beforeLockRelease;
    onLockExists;
    beforeJournalOpen;
    lockTimeoutMs;
    operation = Promise.resolve();
    constructor(root, beforeMetadataWrite, beforeMetadataRollbackWrite, beforeMutationLoad, beforeLockRelease, onLockExists, beforeJournalOpen, lockTimeoutMs) {
        this.root = root;
        this.beforeMetadataWrite = beforeMetadataWrite;
        this.beforeMetadataRollbackWrite = beforeMetadataRollbackWrite;
        this.beforeMutationLoad = beforeMutationLoad;
        this.beforeLockRelease = beforeLockRelease;
        this.onLockExists = onLockExists;
        this.beforeJournalOpen = beforeJournalOpen;
        this.lockTimeoutMs = lockTimeoutMs;
    }
    static async create(root, options = {}) {
        const safeRoot = await canonicalizeTemporaryPath(root);
        await ensureDirectory(safeRoot);
        const adapter = new LocalDriveAdapter(await realpath(safeRoot), options.beforeMetadataWrite, options.beforeMetadataRollbackWrite, options.beforeMutationLoad, options.beforeLockRelease, options.onLockExists, options.beforeJournalOpen, options.lockTimeoutMs);
        await adapter.initialize();
        return adapter;
    }
    get(fileId) {
        return this.read((metadata) => this.toStoredFile(this.getFile(metadata, fileId)));
    }
    listChildren(input) {
        return this.read((metadata) => {
            assertPageSize(input.pageSize);
            const parent = this.getActiveFolder(metadata, input.parentId);
            const cursor = input.pageToken === undefined ? undefined : decodeCursor(input.pageToken);
            if (cursor !== undefined && (cursor.parentId !== parent.id || cursor.generation !== metadata.generation)) {
                throw new Error("stale page token");
            }
            const offset = cursor?.offset ?? 0;
            const files = Object.values(metadata.files)
                .filter((file) => !file.trashed && file.parentIds.length === 1 && file.parentIds[0] === parent.id)
                .sort(compareFiles)
                .slice(offset, offset + input.pageSize)
                .map((file) => this.toStoredFile(file));
            const total = Object.values(metadata.files).filter((file) => !file.trashed && file.parentIds.length === 1 && file.parentIds[0] === parent.id).length;
            const nextOffset = offset + files.length;
            if (nextOffset >= total) {
                return { files };
            }
            return { files, nextPageToken: encodeCursor({ parentId: parent.id, offset: nextOffset, generation: metadata.generation }) };
        });
    }
    readText(fileId) {
        return this.read(async (metadata) => {
            const file = this.getActiveContentFile(metadata, fileId);
            const bytes = await this.readRevision(file.id, this.getContentRevision(file));
            return { file: this.toStoredFile(file), text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), checksum: checksum(bytes) };
        });
    }
    readBytes(fileId) {
        return this.read(async (metadata) => {
            const file = this.getActiveContentFile(metadata, fileId);
            const bytes = await this.readRevision(file.id, this.getContentRevision(file));
            return { file: this.toStoredFile(file), bytes, checksum: checksum(bytes) };
        });
    }
    createFolder(input) {
        return this.mutate(async (metadata) => {
            assertName(input.name);
            this.getActiveFolder(metadata, input.parentId);
            const file = this.newFile(metadata, input.parentId, input.name, FOLDER_MIME_TYPE, "folder", 0);
            await this.saveMetadata(metadata);
            return this.toStoredFile(file);
        });
    }
    createText(input) {
        return this.createBytes({ ...input, bytes: new TextEncoder().encode(input.text) });
    }
    createBytes(input) {
        return this.mutate(async (metadata) => {
            assertName(input.name);
            assertMimeType(input.mimeType);
            this.getActiveFolder(metadata, input.parentId);
            await this.reconcileUncommittedCreate(metadata, this.nextFileId(metadata));
            const file = this.newFile(metadata, input.parentId, input.name, input.mimeType, "file", input.bytes.byteLength);
            await this.writeRevision(metadata, file.id, file.version, input.bytes);
            await this.saveMetadata(metadata);
            await this.writeContent(file.id, input.bytes).catch(() => undefined);
            return this.toStoredFile(file);
        });
    }
    updateText(input) {
        return this.mutate(async (metadata) => {
            assertMimeType(input.mimeType);
            const file = this.getActiveContentFile(metadata, input.fileId);
            if (file.version !== input.expectedVersion) {
                throw new Error("version conflict");
            }
            const bytes = new TextEncoder().encode(input.text);
            this.bumpFile(metadata, file, { mimeType: input.mimeType, size: bytes.byteLength });
            file.contentRevision = file.version;
            await this.writeRevision(metadata, file.id, file.version, bytes);
            await this.saveMetadata(metadata);
            await this.writeContent(file.id, bytes).catch(() => undefined);
            return this.toStoredFile(file);
        });
    }
    move(input) {
        return this.mutate(async (metadata) => {
            if (input.newName !== undefined) {
                assertName(input.newName);
            }
            const file = this.getActiveFile(metadata, input.fileId);
            if (file.kind === "root") {
                throw new Error("cannot move configured root");
            }
            if (file.parentIds.length !== 1 || file.parentIds[0] !== input.fromParentId) {
                throw new Error("from parent does not match file parent");
            }
            const destination = this.getActiveFolder(metadata, input.toParentId);
            if (file.kind === "folder") {
                this.assertMoveDoesNotCycle(metadata, file.id, destination.id);
            }
            this.bumpFile(metadata, file, { parentIds: [destination.id], ...(input.newName === undefined ? {} : { name: input.newName }) });
            await this.saveMetadata(metadata);
            return this.toStoredFile(file);
        });
    }
    trash(fileId) {
        return this.mutate(async (metadata) => {
            const file = this.getActiveFile(metadata, fileId);
            if (file.kind === "root") {
                throw new Error("cannot trash configured root");
            }
            const originalMetadata = cloneMetadata(metadata);
            const expectedContent = file.kind === "file" ? contentDescriptor(await this.readRevision(file.id, this.getContentRevision(file))) : undefined;
            await this.saveTrashRollbackJournal({
                schemaVersion: 1,
                fileId: file.id,
                originalMetadata,
                ...(expectedContent === undefined ? {} : { expectedContent })
            });
            this.bumpFile(metadata, file, { trashed: true });
            await this.saveMetadata(metadata, "normal");
            try {
                if (file.kind === "file") {
                    await this.moveContentToTrash(file.id);
                }
            }
            catch (error) {
                await this.saveMetadata(originalMetadata, "rollback");
                await this.archiveTrashRollbackJournal();
                throw error;
            }
            await this.archiveTrashRollbackJournal();
            return this.toStoredFile(file);
        });
    }
    listRevisions(fileId) {
        return this.read((metadata) => {
            this.getFile(metadata, fileId);
            return [...(metadata.revisions[fileId] ?? [])];
        });
    }
    async initialize() {
        await this.withRootLock(async () => {
            await ensureDirectory(this.root);
            await ensureDirectory(this.contentDirectory());
            await ensureDirectory(this.revisionsDirectory());
            await ensureDirectory(this.trashDirectory());
            try {
                await lstat(this.metadataPath());
            }
            catch (error) {
                if (isNotFound(error)) {
                    await this.saveMetadata(initialMetadata(), "normal");
                    return;
                }
                throw error;
            }
            const metadataStat = await lstat(this.metadataPath());
            if (metadataStat.isSymbolicLink() || !metadataStat.isFile()) {
                throw new Error("unsafe metadata path");
            }
            await this.loadMetadata();
            await this.recoverTrashRollback();
        });
    }
    run(operation) {
        const result = this.operation.then(operation, operation);
        this.operation = result.then(() => undefined, () => undefined);
        return result;
    }
    read(operation) {
        return this.run(() => this.withRootLock(async () => {
            await this.recoverTrashRollback();
            return operation(await this.loadMetadata());
        }));
    }
    mutate(operation) {
        return this.run(() => this.withRootLock(async () => {
            await this.beforeMutationLoad?.();
            await this.recoverTrashRollback();
            return operation(await this.loadMetadata());
        }));
    }
    async withRootLock(operation) {
        const lock = await acquireRootLock(this.root, this.lockTimeoutMs, this.onLockExists);
        try {
            return await operation();
        }
        finally {
            await this.beforeLockRelease?.();
            await releaseRootLock(lock);
        }
    }
    async loadMetadata() {
        await ensureDirectory(this.root);
        const metadataStat = await lstat(this.metadataPath());
        if (metadataStat.isSymbolicLink() || !metadataStat.isFile()) {
            throw new Error("unsafe metadata path");
        }
        const parsed = JSON.parse(await readFile(this.metadataPath(), "utf8"));
        return assertMetadata(parsed);
    }
    async saveMetadata(metadata, mode = "normal") {
        if (mode === "normal") {
            await this.beforeMetadataWrite?.();
        }
        if (mode === "rollback") {
            await this.beforeMetadataRollbackWrite?.();
        }
        await this.atomicWrite(this.metadataPath(), new TextEncoder().encode(`${JSON.stringify(metadata, null, 2)}\n`));
    }
    newFile(metadata, parentId, name, mimeType, kind, size) {
        const id = this.nextFileId(metadata);
        if (metadata.files[id] !== undefined) {
            throw new Error("duplicate deterministic file ID");
        }
        const modifiedTime = nextTime(metadata);
        const file = {
            id,
            name,
            mimeType,
            parentIds: [parentId],
            version: "1",
            modifiedTime,
            size,
            trashed: false,
            kind,
            ...(kind === "file" ? { contentRevision: "1" } : {})
        };
        metadata.files[id] = file;
        metadata.revisions[id] = [];
        metadata.generation += 1;
        return file;
    }
    nextFileId(metadata) {
        return `file_${(metadata.sequence + 1).toString(36)}`;
    }
    bumpFile(metadata, file, changes) {
        Object.assign(file, changes);
        file.version = (BigInt(file.version) + 1n).toString();
        file.modifiedTime = nextTime(metadata);
        metadata.generation += 1;
    }
    getFile(metadata, fileId) {
        assertOpaqueFileId(fileId);
        const file = metadata.files[fileId];
        if (file === undefined) {
            throw new Error("file not found");
        }
        return file;
    }
    getActiveFile(metadata, fileId) {
        const file = this.getFile(metadata, fileId);
        if (file.trashed) {
            throw new Error("file is trashed");
        }
        return file;
    }
    getActiveFolder(metadata, fileId) {
        const file = this.getActiveFile(metadata, fileId);
        if (file.kind !== "root" && file.kind !== "folder") {
            throw new Error("parent is not a folder");
        }
        return file;
    }
    getActiveContentFile(metadata, fileId) {
        const file = this.getActiveFile(metadata, fileId);
        if (file.kind !== "file") {
            throw new Error("file has no content");
        }
        return file;
    }
    getContentRevision(file) {
        if (file.contentRevision === undefined) {
            throw new Error("content file is missing its revision");
        }
        return file.contentRevision;
    }
    assertMoveDoesNotCycle(metadata, fileId, destinationId) {
        let currentId = destinationId;
        const visited = new Set();
        for (let depth = 0; depth < 100; depth += 1) {
            if (currentId === fileId) {
                throw new Error("move would create a cycle");
            }
            if (visited.has(currentId)) {
                throw new Error("cycle in local metadata");
            }
            visited.add(currentId);
            const current = this.getFile(metadata, currentId);
            if (current.kind === "root") {
                return;
            }
            if (current.parentIds.length !== 1) {
                throw new Error("ambiguous parent in local metadata");
            }
            currentId = current.parentIds[0];
        }
        throw new Error("ancestry limit exceeded");
    }
    async writeContent(fileId, bytes) {
        await this.atomicWrite(this.contentPath(fileId), bytes);
    }
    async reconcileUncommittedCreate(metadata, fileId) {
        if (metadata.files[fileId] !== undefined) {
            return;
        }
        const revisionDirectory = join(this.revisionsDirectory(), fileId);
        try {
            const revisionStat = await lstat(revisionDirectory);
            if (revisionStat.isSymbolicLink() || !revisionStat.isDirectory()) {
                throw new Error("unsafe orphan revision path");
            }
        }
        catch (error) {
            if (isNotFound(error)) {
                return;
            }
            throw error;
        }
        const archiveDirectory = join(this.root, ".orphaned-revisions");
        await ensureDirectory(archiveDirectory);
        let archiveIndex = 1;
        for (;;) {
            const archivePath = join(archiveDirectory, `${fileId}-${archiveIndex}`);
            try {
                await lstat(archivePath);
                archiveIndex += 1;
            }
            catch (error) {
                if (!isNotFound(error)) {
                    throw error;
                }
                await rename(revisionDirectory, archivePath);
                return;
            }
        }
    }
    async recoverTrashRollback() {
        const journal = await this.loadTrashRollbackJournal();
        if (journal === undefined) {
            return;
        }
        const currentMetadata = await this.loadMetadata();
        const currentFile = currentMetadata.files[journal.fileId];
        const finalTrashPath = this.trashContentPath(journal.fileId);
        const committed = currentFile?.trashed === true && (journal.expectedContent === undefined || (await matchesContentDescriptor(finalTrashPath, journal.expectedContent)));
        if (!committed) {
            await this.saveMetadata(journal.originalMetadata, "recovery");
        }
        await this.archiveTrashRollbackJournal();
    }
    async saveTrashRollbackJournal(journal) {
        await this.atomicWrite(this.trashRollbackJournalPath(), new TextEncoder().encode(`${JSON.stringify(journal, null, 2)}\n`));
    }
    async loadTrashRollbackJournal() {
        const path = this.trashRollbackJournalPath();
        let text;
        try {
            await this.beforeJournalOpen?.();
            const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                const journalStat = await handle.stat();
                if (!journalStat.isFile()) {
                    throw new Error("unsafe Trash rollback journal path");
                }
                text = await handle.readFile({ encoding: "utf8" });
            }
            finally {
                await handle.close();
            }
        }
        catch (error) {
            if (isNotFound(error)) {
                return undefined;
            }
            if (isNoFollowViolation(error)) {
                throw new Error("unsafe Trash rollback journal path", { cause: error });
            }
            throw error;
        }
        if (text === undefined) {
            throw new Error("invalid Trash rollback journal");
        }
        const value = JSON.parse(text);
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            throw new Error("invalid Trash rollback journal");
        }
        const journal = value;
        if (journal.schemaVersion !== 1 || typeof journal.fileId !== "string" || journal.originalMetadata === undefined) {
            throw new Error("invalid Trash rollback journal");
        }
        assertOpaqueFileId(journal.fileId);
        const expectedContent = journal.expectedContent;
        if (expectedContent !== undefined && (typeof expectedContent !== "object" || expectedContent === null || !Number.isInteger(expectedContent.size) || expectedContent.size < 0 || typeof expectedContent.checksum !== "string" || !/^[a-f0-9]{64}$/u.test(expectedContent.checksum))) {
            throw new Error("invalid Trash rollback journal");
        }
        return {
            schemaVersion: 1,
            fileId: journal.fileId,
            originalMetadata: assertMetadata(journal.originalMetadata),
            ...(expectedContent === undefined ? {} : { expectedContent })
        };
    }
    async archiveTrashRollbackJournal() {
        const journalPath = this.trashRollbackJournalPath();
        try {
            const journalStat = await lstat(journalPath);
            if (journalStat.isSymbolicLink() || !journalStat.isFile()) {
                throw new Error("unsafe Trash rollback journal path");
            }
        }
        catch (error) {
            if (isNotFound(error)) {
                return;
            }
            throw error;
        }
        const archiveDirectory = join(this.root, ".transaction-history");
        await ensureDirectory(archiveDirectory);
        let archiveIndex = 1;
        for (;;) {
            const archivePath = join(archiveDirectory, `trash-rollback-${archiveIndex}.json`);
            try {
                await lstat(archivePath);
                archiveIndex += 1;
            }
            catch (error) {
                if (!isNotFound(error)) {
                    throw error;
                }
                await rename(journalPath, archivePath);
                return;
            }
        }
    }
    async writeRevision(metadata, fileId, revisionId, bytes) {
        const revisionDirectory = join(this.revisionsDirectory(), fileId);
        await ensureDirectory(revisionDirectory);
        const revisionPath = join(revisionDirectory, revisionId);
        try {
            await writeFile(revisionPath, bytes, { flag: "wx" });
        }
        catch (error) {
            if (!isAlreadyExists(error)) {
                throw error;
            }
            const existing = await this.readRevision(fileId, revisionId);
            if (!equalBytes(existing, bytes)) {
                throw new Error("immutable revision already exists", { cause: error });
            }
        }
        const revisions = metadata.revisions[fileId];
        const file = metadata.files[fileId];
        if (revisions === undefined || file === undefined) {
            throw new Error("file metadata changed during revision write");
        }
        if (!revisions.some((revision) => revision.id === revisionId)) {
            revisions.push({ id: revisionId, modifiedTime: file.modifiedTime });
        }
    }
    async moveContentToTrash(fileId) {
        const source = this.contentPath(fileId);
        await ensureDirectory(dirname(source));
        const sourceStat = await lstat(source);
        if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
            throw new Error("unsafe content path");
        }
        const destination = this.trashContentPath(fileId);
        await ensureDirectory(dirname(destination));
        try {
            await lstat(destination);
            throw new Error("trash destination already exists");
        }
        catch (error) {
            if (!isNotFound(error)) {
                throw error;
            }
        }
        await rename(source, destination);
    }
    async readRevision(fileId, revisionId) {
        const revisionDirectory = join(this.revisionsDirectory(), fileId);
        await ensureDirectory(revisionDirectory);
        const revisionPath = join(revisionDirectory, revisionId);
        const revisionStat = await lstat(revisionPath);
        if (revisionStat.isSymbolicLink() || !revisionStat.isFile()) {
            throw new Error("unsafe revision path");
        }
        return readFile(revisionPath);
    }
    async atomicWrite(path, bytes) {
        await ensureDirectory(dirname(path));
        const temporaryPath = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporaryPath, bytes, { flag: "wx" });
        await rename(temporaryPath, path);
    }
    contentDirectory() {
        return join(this.root, ".content");
    }
    revisionsDirectory() {
        return join(this.root, ".revisions");
    }
    trashDirectory() {
        return join(this.root, ".trash");
    }
    trashContentPath(fileId) {
        assertOpaqueFileId(fileId);
        return join(this.trashDirectory(), fileId);
    }
    trashRollbackJournalPath() {
        return join(this.root, ".trash-rollback.json");
    }
    metadataPath() {
        return join(this.root, ".metadata.json");
    }
    contentPath(fileId) {
        assertOpaqueFileId(fileId);
        return join(this.contentDirectory(), fileId);
    }
    toStoredFile(file) {
        return {
            id: file.id,
            name: file.name,
            mimeType: file.mimeType,
            parentIds: [...file.parentIds],
            version: file.version,
            modifiedTime: file.modifiedTime,
            size: file.size,
            trashed: file.trashed
        };
    }
}
const initialMetadata = () => ({
    schemaVersion: 1,
    sequence: 0,
    generation: 0,
    files: {
        vault: rootFile("vault"),
        private: rootFile("private")
    },
    revisions: {
        vault: [],
        private: []
    }
});
const rootFile = (id) => ({
    id,
    name: id,
    mimeType: FOLDER_MIME_TYPE,
    parentIds: [],
    version: "1",
    modifiedTime: "1970-01-01T00:00:00.000Z",
    size: 0,
    trashed: false,
    kind: "root"
});
const nextTime = (metadata) => {
    metadata.sequence += 1;
    return new Date(metadata.sequence).toISOString();
};
const cloneMetadata = (metadata) => JSON.parse(JSON.stringify(metadata));
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const assertMetadata = (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("invalid local metadata");
    }
    const metadata = value;
    if (metadata.schemaVersion !== 1 || !Number.isInteger(metadata.sequence) || !Number.isInteger(metadata.generation) || !isRecord(metadata.files) || !isRecord(metadata.revisions)) {
        throw new Error("invalid local metadata");
    }
    return metadata;
};
const assertOpaqueFileId = (fileId) => {
    if (typeof fileId !== "string" || fileId.length === 0 || fileId.length > MAX_FILE_ID_LENGTH || (fileId !== "vault" && fileId !== "private" && !GENERATED_ID.test(fileId))) {
        throw new Error("invalid file ID");
    }
};
const assertName = (name) => {
    if (typeof name !== "string" || name.length === 0 || name.length > MAX_NAME_LENGTH || name === "." || name === ".." || /[\\/\0]/u.test(name)) {
        throw new Error("invalid name");
    }
};
const assertMimeType = (mimeType) => {
    if (typeof mimeType !== "string" || mimeType.length === 0 || mimeType.length > 255 || /[\0\r\n]/u.test(mimeType)) {
        throw new Error("invalid MIME type");
    }
};
const assertPageSize = (pageSize) => {
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
        throw new Error("invalid page size");
    }
};
const compareFiles = (left, right) => left.name === right.name ? left.id.localeCompare(right.id, "en") : left.name.localeCompare(right.name, "en");
const checksum = (bytes) => createHash("sha256").update(bytes).digest("hex");
const contentDescriptor = (bytes) => ({ size: bytes.byteLength, checksum: checksum(bytes) });
const encodeCursor = (cursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url");
const decodeCursor = (token) => {
    if (typeof token !== "string" || token.length === 0 || token.length > 4096 || !/^[A-Za-z0-9_-]+$/u.test(token)) {
        throw new Error("invalid page token");
    }
    try {
        const value = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            throw new Error("invalid page token");
        }
        const cursor = value;
        if (typeof cursor.parentId !== "string" || !Number.isInteger(cursor.offset) || cursor.offset < 0 || !Number.isInteger(cursor.generation)) {
            throw new Error("invalid page token");
        }
        assertOpaqueFileId(cursor.parentId);
        return cursor;
    }
    catch (error) {
        if (error instanceof Error && error.message === "invalid file ID") {
            throw error;
        }
        throw new Error("invalid page token", { cause: error });
    }
};
const ensureDirectory = async (path) => {
    const absolutePath = resolve(path);
    const root = parse(absolutePath).root;
    let currentPath = root;
    await assertDirectory(currentPath);
    for (const component of relative(root, absolutePath).split(sep).filter(Boolean)) {
        currentPath = join(currentPath, component);
        try {
            await assertDirectory(currentPath);
        }
        catch (error) {
            if (!isNotFound(error)) {
                throw error;
            }
            try {
                await mkdir(currentPath);
            }
            catch (mkdirError) {
                if (!isAlreadyExists(mkdirError)) {
                    throw mkdirError;
                }
            }
            await assertDirectory(currentPath);
        }
    }
};
const canonicalizeTemporaryPath = async (path) => {
    const absolutePath = resolve(path);
    const logicalTemporaryRoot = resolve(tmpdir());
    const relativePath = relative(logicalTemporaryRoot, absolutePath);
    if (relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))) {
        return join(await realpath(logicalTemporaryRoot), relativePath);
    }
    return absolutePath;
};
const assertDirectory = async (path) => {
    const directoryStat = await lstat(path);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
        throw new Error("unsafe storage directory");
    }
};
const matchesContentDescriptor = async (path, expected) => {
    try {
        const fileStat = await lstat(path);
        if (fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.size !== expected.size) {
            return false;
        }
        return checksum(await readFile(path)) === expected.checksum;
    }
    catch (error) {
        if (isNotFound(error)) {
            return false;
        }
        throw error;
    }
};
const isNotFound = (error) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
const isAlreadyExists = (error) => typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
const isNoFollowViolation = (error) => typeof error === "object" && error !== null && "code" in error && error.code === "ELOOP";
const equalBytes = (left, right) => left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 2_000;
const acquireRootLock = async (root, timeoutMs = LOCK_TIMEOUT_MS, onLockExists) => {
    const path = join(root, ".mutation.lock");
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const token = randomUUID();
        try {
            await mkdir(path, { mode: 0o700 });
            try {
                await writeFile(join(path, "owner.json"), JSON.stringify({ token, createdAt: Date.now() }), { flag: "wx", mode: 0o600 });
            }
            catch (error) {
                await archiveRootLock(path, root, token);
                throw error;
            }
            return { path, token };
        }
        catch (error) {
            if (!isAlreadyExists(error)) {
                throw error;
            }
            await onLockExists?.();
            try {
                await assertLockDirectory(path);
            }
            catch (lockError) {
                if (isNotFound(lockError)) {
                    continue;
                }
                throw lockError;
            }
            if (Date.now() >= deadline) {
                throw new Error("timed out waiting for storage mutation lock", { cause: error });
            }
            await delay(LOCK_WAIT_MS);
        }
    }
};
const releaseRootLock = async (lock) => {
    try {
        await assertLockDirectory(lock.path);
        const value = JSON.parse(await readFile(join(lock.path, "owner.json"), "utf8"));
        if (typeof value === "object" && value !== null && "token" in value && value.token === lock.token) {
            await archiveRootLock(lock.path, dirname(lock.path), lock.token);
        }
    }
    catch (error) {
        if (!isNotFound(error)) {
            throw error;
        }
    }
};
const assertLockDirectory = async (path) => {
    const lockStat = await lstat(path);
    if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) {
        throw new Error("unsafe storage mutation lock");
    }
};
const archiveRootLock = async (lockPath, root, token) => {
    const archiveDirectory = join(root, ".lock-history");
    await ensureDirectory(archiveDirectory);
    let archiveIndex = 1;
    for (;;) {
        const archivePath = join(archiveDirectory, `${token}-${archiveIndex}.lock`);
        try {
            await lstat(archivePath);
            archiveIndex += 1;
        }
        catch (error) {
            if (!isNotFound(error)) {
                throw error;
            }
            try {
                await rename(lockPath, archivePath);
                return;
            }
            catch (renameError) {
                if (isNotFound(renameError)) {
                    return;
                }
                throw renameError;
            }
        }
    }
};
const delay = async (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
//# sourceMappingURL=local-drive-adapter.js.map