import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { setTimeout as sleepTimer } from "node:timers/promises";
import { assertStorageVersion, StorageMutationOutcomeUnknownError, StorageOperationBudgetExceededError, StorageVersionConflictError } from "./storage-port.js";
const FILE_FIELDS = "id,name,mimeType,parents,version,modifiedTime,size,trashed,md5Checksum,appProperties";
const LIST_FIELDS = `nextPageToken,files(${FILE_FIELDS})`;
const REVISION_FIELDS = "nextPageToken,revisions(id,modifiedTime)";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const SHORTCUT_MIME_TYPE = "application/vnd.google-apps.shortcut";
const MAX_FILE_ID_LENGTH = 512;
const MAX_PAGE_SIZE = 1000;
const MAX_READ_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 50;
const MAX_REVISION_PAGES = 1000;
const RETRYABLE_READ_STATUSES = new Set([429, 500, 502, 503, 504]);
export class GoogleDriveAdapter {
    client;
    sleep;
    random;
    rootId;
    constructor(client, options = {}) {
        this.client = client;
        this.sleep = options.sleep ?? ((milliseconds) => sleepTimer(milliseconds));
        this.random = options.random ?? Math.random;
        if (options.rootId !== undefined)
            assertFileId(options.rootId);
        this.rootId = options.rootId;
    }
    async get(fileId, context) {
        assertFileId(fileId);
        try {
            return toStoredFile(await this.readMetadata(fileId, context), this.rootId);
        }
        catch (error) {
            throw preserveSafeError(error, "Google Drive read failed.");
        }
    }
    async listChildren(input, context) {
        assertFileId(input.parentId);
        assertPageSize(input.pageSize);
        try {
            const response = await this.readWithRetry(() => this.client.files.list({
                q: `'${escapeDriveQueryLiteral(input.parentId)}' in parents and trashed = false`,
                spaces: "drive",
                pageSize: input.pageSize,
                ...(input.pageToken === undefined
                    ? {}
                    : { pageToken: input.pageToken }),
                fields: LIST_FIELDS
            }), context);
            const data = requireRecord(response.data);
            const rawFiles = data.files === undefined ? [] : requireArray(data.files);
            const files = rawFiles.map((file) => toStoredFile(file, this.rootId));
            for (const file of files) {
                if (file.trashed)
                    throw new DriveContractError("Google Drive returned a trashed list item.");
            }
            const nextPageToken = optionalString(data.nextPageToken);
            return nextPageToken === undefined ? { files } : { files, nextPageToken };
        }
        catch (error) {
            throw preserveSafeError(error, "Google Drive read failed.");
        }
    }
    async readText(fileId, context) {
        const result = await this.readBytes(fileId, context);
        try {
            return {
                file: result.file,
                text: new TextDecoder("utf-8", { fatal: true }).decode(result.bytes),
                checksum: result.checksum
            };
        }
        catch {
            throw new DriveContractError("Google Drive text content is not valid UTF-8.");
        }
    }
    async readBytes(fileId, context) {
        assertFileId(fileId);
        try {
            const metadata = await this.readMetadata(fileId, context);
            const file = toStoredFile(metadata, this.rootId);
            assertReadableContent(file);
            const response = await this.readWithRetry(() => this.client.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" }), context);
            const bytes = toBytes(response.data);
            const expectedChecksum = requireNonEmptyString(requireRecord(metadata).md5Checksum);
            if (md5(bytes) !== expectedChecksum) {
                throw new DriveContractError("Google Drive checksum verification failed.");
            }
            return { file, bytes, checksum: sha256(bytes) };
        }
        catch (error) {
            throw preserveSafeError(error, "Google Drive read failed.");
        }
    }
    async createFolder(input, context) {
        return this.create({
            parentId: input.parentId,
            name: input.name,
            mimeType: FOLDER_MIME_TYPE
        }, context);
    }
    async createText(input, context) {
        const bytes = new TextEncoder().encode(input.text);
        return this.create({ ...input, body: input.text, checksum: md5(bytes) }, context);
    }
    async createBytes(input, context) {
        return this.create({
            ...input,
            body: input.bytes,
            checksum: md5(input.bytes)
        }, context);
    }
    async updateText(input, context) {
        assertFileId(input.fileId);
        assertMimeType(input.mimeType);
        assertStorageVersion(input.expectedVersion);
        assertVersion(input.expectedVersion);
        let before;
        let etag;
        try {
            const snapshot = await this.readMetadataSnapshot(input.fileId, context);
            before = toStoredFile(snapshot.data, this.rootId);
            etag = responseEtag(snapshot.headers);
        }
        catch (error) {
            throw preserveSafeError(error, "Google Drive read failed.");
        }
        assertWritableContent(before);
        assertSingleParent(before, "Google Drive upload verification failed.");
        if (before.version !== input.expectedVersion)
            throw new StorageVersionConflictError();
        const bytes = new TextEncoder().encode(input.text);
        let response;
        context?.operationBudget?.consume();
        try {
            response = await this.client.files.update({
                fileId: input.fileId,
                requestBody: { mimeType: input.mimeType },
                media: { mimeType: input.mimeType, body: input.text },
                fields: "id"
            }, { headers: { "If-Match": etag } });
        }
        catch (error) {
            if (errorStatus(error) === 412)
                throw new StorageVersionConflictError();
            throw new StorageMutationOutcomeUnknownError(input.fileId, "Google Drive write outcome is unknown.");
        }
        try {
            assertWriteResponseId(response.data, input.fileId, "Google Drive upload verification failed.");
            const after = await this.verifyUpload(input.fileId, md5(bytes), before.version, context);
            if (!matchesActiveSnapshot(after, before, input.mimeType)) {
                throw new DriveContractError("Google Drive upload verification failed.");
            }
            return after;
        }
        catch (error) {
            throw mutationOutcomeUnknown(error, input.fileId, "Google Drive upload verification failed.");
        }
    }
    async move(input, context) {
        assertFileId(input.fileId);
        assertFileId(input.fromParentId);
        assertFileId(input.toParentId);
        assertStorageVersion(input.expectedVersion);
        assertVersion(input.expectedVersion);
        if (input.newName !== undefined)
            assertName(input.newName);
        let before;
        let etag;
        try {
            const snapshot = await this.readMetadataSnapshot(input.fileId, context);
            before = toStoredFile(snapshot.data, this.rootId);
            etag = responseEtag(snapshot.headers);
        }
        catch (error) {
            throw preserveSafeError(error, "Google Drive read failed.");
        }
        assertActiveNonShortcut(before);
        if (before.version !== input.expectedVersion)
            throw new StorageVersionConflictError();
        if (before.parentIds.length !== 1 ||
            before.parentIds[0] !== input.fromParentId) {
            throw new DriveContractError("Google Drive ancestry does not match the requested move.");
        }
        const sameParent = input.fromParentId === input.toParentId;
        if (sameParent && input.newName === undefined) {
            throw new DriveContractError("same-parent move requires a rename");
        }
        const request = {
            fileId: input.fileId,
            ...(input.newName === undefined
                ? {}
                : { requestBody: { name: input.newName } }),
            ...(sameParent
                ? {}
                : {
                    addParents: input.toParentId,
                    removeParents: input.fromParentId
                }),
            fields: "id"
        };
        let response;
        context?.operationBudget?.consume();
        try {
            response = await this.client.files.update(request, { headers: { "If-Match": etag } });
        }
        catch (error) {
            if (errorStatus(error) === 412)
                throw new StorageVersionConflictError();
            throw new StorageMutationOutcomeUnknownError(input.fileId, "Google Drive move outcome is unknown.");
        }
        try {
            assertWriteResponseId(response.data, input.fileId, "Google Drive move verification failed.");
            const after = await this.readBackAfterWrite(input.fileId, context);
            if (after.id !== before.id ||
                after.name !== (input.newName ?? before.name) ||
                after.mimeType !== before.mimeType ||
                after.trashed ||
                after.parentIds.length !== 1 ||
                after.parentIds[0] !== input.toParentId ||
                !isNewerVersion(after.version, before.version)) {
                throw new DriveContractError("Google Drive move verification failed.");
            }
            return after;
        }
        catch (error) {
            throw mutationOutcomeUnknown(error, input.fileId, "Google Drive move verification failed.");
        }
    }
    async trash(input, context) {
        const { fileId, expectedVersion } = input;
        assertFileId(fileId);
        assertStorageVersion(expectedVersion);
        assertVersion(expectedVersion);
        if (fileId === this.rootId)
            throw new DriveContractError("cannot trash configured root");
        let before;
        let etag;
        try {
            const snapshot = await this.readMetadataSnapshot(fileId, context);
            before = toStoredFile(snapshot.data, this.rootId);
            etag = responseEtag(snapshot.headers);
        }
        catch (error) {
            throw preserveSafeError(error, "Google Drive read failed.");
        }
        assertActiveNonShortcut(before);
        if (before.version !== expectedVersion)
            throw new StorageVersionConflictError();
        assertSingleParent(before, "Google Drive Trash verification failed.");
        let response;
        context?.operationBudget?.consume();
        try {
            response = await this.client.files.update({
                fileId,
                requestBody: { trashed: true },
                fields: "id"
            }, { headers: { "If-Match": etag } });
        }
        catch (error) {
            if (errorStatus(error) === 412)
                throw new StorageVersionConflictError();
            throw new StorageMutationOutcomeUnknownError(fileId, "Google Drive Trash outcome is unknown.");
        }
        try {
            assertWriteResponseId(response.data, fileId, "Google Drive Trash verification failed.");
            const file = await this.readBackAfterWrite(fileId, context);
            if (file.id !== before.id ||
                file.name !== before.name ||
                file.mimeType !== before.mimeType ||
                !file.trashed ||
                file.parentIds.length !== 1 ||
                file.parentIds[0] !== before.parentIds[0] ||
                !isNewerVersion(file.version, before.version))
                throw new DriveContractError("Google Drive Trash verification failed.");
            return file;
        }
        catch (error) {
            throw mutationOutcomeUnknown(error, fileId, "Google Drive Trash verification failed.");
        }
    }
    async listRevisions(fileId, context) {
        assertFileId(fileId);
        const revisions = [];
        const seenTokens = new Set();
        let pageToken;
        try {
            for (let page = 0; page < MAX_REVISION_PAGES; page += 1) {
                const response = await this.readWithRetry(() => this.client.revisions.list({
                    fileId,
                    pageSize: 100,
                    fields: REVISION_FIELDS,
                    ...(pageToken === undefined ? {} : { pageToken })
                }), context);
                const data = requireRecord(response.data);
                for (const rawRevision of data.revisions === undefined
                    ? []
                    : requireArray(data.revisions)) {
                    const revision = requireRecord(rawRevision);
                    revisions.push({
                        id: requireNonEmptyString(revision.id),
                        modifiedTime: requireNonEmptyString(revision.modifiedTime)
                    });
                }
                const nextPageToken = optionalString(data.nextPageToken);
                if (nextPageToken === undefined)
                    return revisions;
                if (seenTokens.has(nextPageToken))
                    throw new DriveContractError("Google Drive pagination cycle detected.");
                seenTokens.add(nextPageToken);
                pageToken = nextPageToken;
            }
            throw new DriveContractError("Google Drive pagination limit exceeded.");
        }
        catch (error) {
            throw preserveSafeError(error, "Google Drive read failed.");
        }
    }
    async create(input, context) {
        assertFileId(input.parentId);
        assertName(input.name);
        assertMimeType(input.mimeType);
        const request = {
            requestBody: {
                name: input.name,
                mimeType: input.mimeType,
                parents: [input.parentId],
                ...(input.appProperties === undefined ? {} : { appProperties: input.appProperties })
            },
            ...(input.body === undefined
                ? {}
                : { media: { mimeType: input.mimeType, body: input.body } }),
            fields: "id"
        };
        let response;
        context?.operationBudget?.consume();
        try {
            response = await this.client.files.create(request);
        }
        catch {
            throw new StorageMutationOutcomeUnknownError(undefined, "Google Drive create outcome is unknown.");
        }
        let createdId;
        try {
            createdId = requireFileIdFromWrite(response.data);
            const created = input.checksum === undefined
                ? await this.readBackAfterWrite(createdId, context)
                : await this.verifyUpload(createdId, input.checksum, undefined, context);
            if (created.id !== createdId ||
                created.name !== input.name ||
                created.mimeType !== input.mimeType ||
                created.parentIds.length !== 1 ||
                created.parentIds[0] !== input.parentId ||
                created.trashed) {
                throw new DriveContractError("Google Drive create verification failed.");
            }
            return created;
        }
        catch (error) {
            throw mutationOutcomeUnknown(error, createdId, input.checksum === undefined ? "Google Drive create verification failed." : "Google Drive upload verification failed.");
        }
    }
    async verifyUpload(fileId, expectedChecksum, previousVersion, context) {
        const metadata = await this.readMetadataAfterWrite(fileId, context);
        const file = toStoredFile(metadata, this.rootId);
        const checksum = requireRecord(metadata).md5Checksum;
        if (checksum !== expectedChecksum)
            throw new DriveContractError("Google Drive upload verification failed.");
        if (previousVersion !== undefined &&
            !isNewerVersion(file.version, previousVersion)) {
            throw new DriveContractError("Google Drive upload verification failed.");
        }
        return file;
    }
    async readBackAfterWrite(fileId, context) {
        return toStoredFile(await this.readMetadataAfterWrite(fileId, context), this.rootId);
    }
    async readMetadataAfterWrite(fileId, context) {
        try {
            return await this.readMetadata(fileId, context);
        }
        catch (error) {
            if (error instanceof StorageOperationBudgetExceededError)
                throw error;
            throw new DriveContractError("Google Drive write readback failed.");
        }
    }
    async readMetadata(fileId, context) {
        return (await this.readMetadataSnapshot(fileId, context)).data;
    }
    async readMetadataSnapshot(fileId, context) {
        assertFileId(fileId);
        const response = await this.readWithRetry(() => this.client.files.get({ fileId, fields: FILE_FIELDS }), context);
        return response;
    }
    async readWithRetry(operation, context) {
        let lastError;
        for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt += 1) {
            try {
                context?.operationBudget?.consume();
                return await operation();
            }
            catch (error) {
                lastError = error;
                const status = errorStatus(error);
                if (status === undefined ||
                    !RETRYABLE_READ_STATUSES.has(status) ||
                    attempt === MAX_READ_ATTEMPTS - 1)
                    break;
                const exponential = BASE_RETRY_DELAY_MS * 2 ** attempt;
                const jitter = Math.floor(exponential * clampRandom(this.random()));
                await this.sleep(exponential + jitter);
            }
        }
        throw lastError;
    }
}
export const escapeDriveQueryLiteral = (value) => value.replace(/\\/gu, "\\\\").replace(/'/gu, "\\'");
const toStoredFile = (raw, rootId) => {
    const file = requireRecord(raw);
    const id = requireNonEmptyString(file.id);
    assertFileId(id);
    const name = requireNonEmptyString(file.name);
    const mimeType = requireNonEmptyString(file.mimeType);
    const parents = id === rootId ? [] : requireStringArray(file.parents);
    const version = requireNonEmptyString(file.version);
    assertVersion(version);
    const modifiedTime = requireNonEmptyString(file.modifiedTime);
    const trashed = requireBoolean(file.trashed);
    const appProperties = optionalStringRecord(file.appProperties);
    return {
        id,
        name,
        mimeType,
        parentIds: parents,
        version,
        modifiedTime,
        size: parseSize(file.size, mimeType),
        trashed,
        ...(appProperties === undefined ? {} : { appProperties })
    };
};
const optionalStringRecord = (value) => {
    if (value === undefined)
        return undefined;
    const record = requireRecord(value);
    const entries = Object.entries(record);
    if (entries.length > 16 || entries.some(([key, item]) => !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(key) || typeof item !== "string" || item.length > 128 || /[\r\n\0]/u.test(item)))
        throw new DriveContractError("Google Drive app properties are invalid.");
    return Object.fromEntries(entries);
};
const assertReadableContent = (file) => {
    assertActiveNonShortcut(file);
    if (file.mimeType === FOLDER_MIME_TYPE)
        throw new DriveContractError("Google Drive item has no readable content.");
};
const assertWritableContent = (file) => {
    assertReadableContent(file);
};
const assertSingleParent = (file, message) => {
    if (file.parentIds.length !== 1)
        throw new DriveContractError(message);
};
const matchesActiveSnapshot = (after, before, expectedMimeType) => after.id === before.id &&
    after.name === before.name &&
    after.mimeType === expectedMimeType &&
    !after.trashed &&
    after.parentIds.length === 1 &&
    after.parentIds[0] === before.parentIds[0];
const assertActiveNonShortcut = (file) => {
    if (file.trashed)
        throw new DriveContractError("Google Drive item is trashed.");
    if (file.mimeType === SHORTCUT_MIME_TYPE)
        throw new DriveContractError("Google Drive shortcuts are not allowed.");
};
const parseSize = (value, mimeType) => {
    if (value === undefined && mimeType === FOLDER_MIME_TYPE)
        return 0;
    if (typeof value !== "string" || !/^\d+$/u.test(value))
        throw new DriveContractError("Google Drive metadata is invalid.");
    const size = Number(value);
    if (!Number.isSafeInteger(size))
        throw new DriveContractError("Google Drive metadata is invalid.");
    return size;
};
const requireFileIdFromWrite = (value) => {
    const id = requireNonEmptyString(requireRecord(value).id);
    assertFileId(id);
    return id;
};
const assertWriteResponseId = (value, expectedId, message) => {
    let id;
    try {
        id = requireFileIdFromWrite(value);
    }
    catch {
        throw new DriveContractError(message);
    }
    if (id !== expectedId)
        throw new DriveContractError(message);
};
const requireRecord = (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new DriveContractError("Google Drive response is invalid.");
    }
    return value;
};
const requireArray = (value) => {
    if (!Array.isArray(value))
        throw new DriveContractError("Google Drive response is invalid.");
    return value;
};
const requireStringArray = (value) => {
    if (value === undefined)
        return [];
    if (!Array.isArray(value) ||
        !value.every((entry) => typeof entry === "string")) {
        throw new DriveContractError("Google Drive response is invalid.");
    }
    return [...value];
};
const requireNonEmptyString = (value) => {
    if (typeof value !== "string" || value === "")
        throw new DriveContractError("Google Drive response is invalid.");
    return value;
};
const responseEtag = (headers) => {
    const record = requireRecord(headers);
    let etag = record.etag ?? record.ETag;
    if (typeof etag !== "string" && typeof record.get === "function") {
        try {
            etag = record.get("etag");
        }
        catch {
            etag = undefined;
        }
    }
    if (typeof etag !== "string" ||
        etag.length > 512 ||
        !/^(?:W\/)?"[\x21\x23-\x7E\x80-\xFF]*"$/u.test(etag)) {
        throw new DriveContractError("Google Drive version precondition is unavailable.");
    }
    return etag;
};
const optionalString = (value) => {
    if (value === undefined || value === null || value === "")
        return undefined;
    return requireNonEmptyString(value);
};
const requireBoolean = (value) => {
    if (typeof value !== "boolean")
        throw new DriveContractError("Google Drive response is invalid.");
    return value;
};
const assertFileId = (value) => {
    if (typeof value !== "string" ||
        value.length === 0 ||
        value.length > MAX_FILE_ID_LENGTH) {
        throw new DriveContractError("Invalid Google Drive file ID.");
    }
};
const assertName = (value) => {
    if (typeof value !== "string" ||
        [...value.normalize("NFC")].length === 0 ||
        [...value.normalize("NFC")].length > 255 ||
        /[\r\n\0]/u.test(value)) {
        throw new DriveContractError("Invalid Google Drive item name.");
    }
};
const assertMimeType = (value) => {
    if (typeof value !== "string" ||
        value.length === 0 ||
        value.length > 256 ||
        /[\r\n\0]/u.test(value)) {
        throw new DriveContractError("Invalid Google Drive MIME type.");
    }
};
const assertVersion = (value) => {
    if (!/^[1-9]\d*$/u.test(value))
        throw new DriveContractError("Invalid Google Drive version.");
};
const assertPageSize = (value) => {
    if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
        throw new DriveContractError("Invalid Google Drive page size.");
    }
};
const isNewerVersion = (next, previous) => {
    try {
        return BigInt(next) > BigInt(previous);
    }
    catch {
        return false;
    }
};
const errorStatus = (error) => {
    if (typeof error !== "object" || error === null)
        return undefined;
    const errorRecord = error;
    const response = errorRecord.response;
    if (typeof response === "object" && response !== null) {
        const status = response.status;
        if (typeof status === "number")
            return status;
    }
    const code = errorRecord.code;
    if (typeof code === "number")
        return code;
    if (typeof code === "string" && /^\d{3}$/u.test(code))
        return Number(code);
    return undefined;
};
const clampRandom = (value) => Number.isFinite(value) ? Math.max(0, Math.min(0.999_999, value)) : 0;
const toBytes = (value) => {
    if (value instanceof Uint8Array)
        return new Uint8Array(value);
    if (value instanceof ArrayBuffer)
        return new Uint8Array(value);
    if (typeof value === "string")
        return new Uint8Array(Buffer.from(value));
    throw new DriveContractError("Google Drive media response is invalid.");
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const md5 = (bytes) => createHash("md5").update(bytes).digest("hex");
const preserveSafeError = (error, fallback) => error instanceof DriveContractError || error instanceof StorageOperationBudgetExceededError
    ? error
    : new DriveContractError(fallback);
const mutationOutcomeUnknown = (error, fileId, fallback) => new StorageMutationOutcomeUnknownError(fileId, error instanceof DriveContractError ? error.message : fallback);
class DriveContractError extends Error {
    constructor(message) {
        super(message);
        this.name = "DriveContractError";
    }
}
//# sourceMappingURL=google-drive-adapter.js.map