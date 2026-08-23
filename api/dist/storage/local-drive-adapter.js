import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
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
    operation = Promise.resolve();
    constructor(root, beforeMetadataWrite) {
        this.root = root;
        this.beforeMetadataWrite = beforeMetadataWrite;
    }
    static async create(root, options = {}) {
        const safeRoot = await canonicalizeTemporaryPath(root);
        await ensureDirectory(safeRoot);
        const adapter = new LocalDriveAdapter(await realpath(safeRoot), options.beforeMetadataWrite);
        await adapter.initialize();
        return adapter;
    }
    get(fileId) {
        return this.run(async () => this.toStoredFile(this.getFile(await this.loadMetadata(), fileId)));
    }
    listChildren(input) {
        return this.run(async () => {
            assertPageSize(input.pageSize);
            const metadata = await this.loadMetadata();
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
        return this.run(async () => {
            const metadata = await this.loadMetadata();
            const file = this.getActiveContentFile(metadata, fileId);
            const bytes = await this.readRevision(file.id, this.getContentRevision(file));
            return { file: this.toStoredFile(file), text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), checksum: checksum(bytes) };
        });
    }
    readBytes(fileId) {
        return this.run(async () => {
            const metadata = await this.loadMetadata();
            const file = this.getActiveContentFile(metadata, fileId);
            const bytes = await this.readRevision(file.id, this.getContentRevision(file));
            return { file: this.toStoredFile(file), bytes, checksum: checksum(bytes) };
        });
    }
    createFolder(input) {
        return this.run(async () => {
            assertName(input.name);
            const metadata = await this.loadMetadata();
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
        return this.run(async () => {
            assertName(input.name);
            assertMimeType(input.mimeType);
            const metadata = await this.loadMetadata();
            this.getActiveFolder(metadata, input.parentId);
            const file = this.newFile(metadata, input.parentId, input.name, input.mimeType, "file", input.bytes.byteLength);
            await this.writeRevision(metadata, file.id, file.version, input.bytes);
            await this.saveMetadata(metadata);
            await this.writeContent(file.id, input.bytes).catch(() => undefined);
            return this.toStoredFile(file);
        });
    }
    updateText(input) {
        return this.run(async () => {
            assertMimeType(input.mimeType);
            const metadata = await this.loadMetadata();
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
        return this.run(async () => {
            if (input.newName !== undefined) {
                assertName(input.newName);
            }
            const metadata = await this.loadMetadata();
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
        return this.run(async () => {
            const metadata = await this.loadMetadata();
            const file = this.getActiveFile(metadata, fileId);
            if (file.kind === "root") {
                throw new Error("cannot trash configured root");
            }
            this.bumpFile(metadata, file, { trashed: true });
            await this.saveMetadata(metadata);
            if (file.kind === "file") {
                await this.moveContentToTrash(file.id).catch(() => undefined);
            }
            return this.toStoredFile(file);
        });
    }
    listRevisions(fileId) {
        return this.run(async () => {
            const metadata = await this.loadMetadata();
            this.getFile(metadata, fileId);
            return [...(metadata.revisions[fileId] ?? [])];
        });
    }
    async initialize() {
        await ensureDirectory(this.root);
        await ensureDirectory(this.contentDirectory());
        await ensureDirectory(this.revisionsDirectory());
        await ensureDirectory(this.trashDirectory());
        try {
            await lstat(this.metadataPath());
        }
        catch (error) {
            if (isNotFound(error)) {
                await this.saveMetadata(initialMetadata());
                return;
            }
            throw error;
        }
        const metadataStat = await lstat(this.metadataPath());
        if (metadataStat.isSymbolicLink() || !metadataStat.isFile()) {
            throw new Error("unsafe metadata path");
        }
        await this.loadMetadata();
    }
    run(operation) {
        const result = this.operation.then(operation, operation);
        this.operation = result.then(() => undefined, () => undefined);
        return result;
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
    async saveMetadata(metadata) {
        await this.beforeMetadataWrite?.();
        await this.atomicWrite(this.metadataPath(), new TextEncoder().encode(`${JSON.stringify(metadata, null, 2)}\n`));
    }
    newFile(metadata, parentId, name, mimeType, kind, size) {
        const id = `file_${(metadata.sequence + 1).toString(36)}`;
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
        const destination = join(this.trashDirectory(), fileId);
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
const assertMetadata = (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("invalid local metadata");
    }
    const metadata = value;
    if (metadata.schemaVersion !== 1 || !Number.isInteger(metadata.sequence) || !Number.isInteger(metadata.generation) || metadata.files === undefined || metadata.revisions === undefined) {
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
const isNotFound = (error) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
const isAlreadyExists = (error) => typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
const equalBytes = (left, right) => left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
//# sourceMappingURL=local-drive-adapter.js.map