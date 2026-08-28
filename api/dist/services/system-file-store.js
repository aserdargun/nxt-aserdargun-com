import { createHash } from "node:crypto";
import { ApiResponseError } from "../http/api-response.js";
import { StorageOperationBudgetExceededError, StorageVersionConflictError } from "../storage/storage-port.js";
const JSON_MIME_TYPE = "application/json";
const CHECKSUM = /^[a-f0-9]{64}$/u;
export class SystemFileStore {
    options;
    cachedSnapshot;
    cachedRead;
    constructor(options) {
        this.options = options;
        if (options.maxBytes !== undefined &&
            (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1))
            throw new Error("invalid system file byte limit");
    }
    readVersionCached(context) {
        this.cachedRead ??= this.readVersionCachedFresh(context).finally(() => {
            this.cachedRead = undefined;
        });
        return this.cachedRead;
    }
    async read(context) {
        try {
            if (this.options.maxBytes !== undefined) {
                const metadata = await this.options.storage.get(this.options.fileId, context);
                this.assertPinnedFile(metadata);
                this.assertWithinByteLimit(metadata);
            }
            return await this.readBody(context);
        }
        catch (error) {
            throw preserveApiError(error, "DRIVE_UNAVAILABLE");
        }
    }
    async readVersionCachedFresh(context) {
        try {
            const file = await this.options.storage.get(this.options.fileId, context);
            this.assertPinnedFile(file);
            this.assertWithinByteLimit(file);
            if (this.cachedSnapshot?.file.version === file.version)
                return this.cachedSnapshot;
            const snapshot = await this.readBody(context);
            this.cachedSnapshot = snapshot;
            return snapshot;
        }
        catch (error) {
            throw preserveApiError(error, "DRIVE_UNAVAILABLE");
        }
    }
    async readBody(context) {
        const readback = await this.options.storage.readText(this.options.fileId, context);
        this.assertPinnedFile(readback.file);
        this.assertWithinByteLimit(readback.file, readback.text);
        this.assertChecksum(readback.text, readback.checksum);
        return {
            value: this.options.schema.parse(JSON.parse(readback.text)),
            file: readback.file,
            source: readback.text,
            checksum: readback.checksum
        };
    }
    async update(value, expectedVersion, context) {
        const before = await this.read(context);
        if (expectedVersion !== undefined && before.file.version !== expectedVersion) {
            throw new ApiResponseError("CONFLICT");
        }
        const prepared = this.prepare(value);
        const source = prepared.source;
        this.assertSourceWithinByteLimit(source);
        let updated;
        try {
            updated = await this.options.storage.updateText({
                fileId: this.options.fileId,
                expectedVersion: before.file.version,
                mimeType: JSON_MIME_TYPE,
                text: source
            }, context);
        }
        catch (error) {
            if (error instanceof StorageOperationBudgetExceededError)
                throw error;
            throw new ApiResponseError(error instanceof StorageVersionConflictError ? "CONFLICT" : "DRIVE_UNAVAILABLE");
        }
        try {
            this.assertPinnedFile(updated);
            const after = await this.read(context);
            if (after.file.version !== updated.version || after.source !== source) {
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            }
            return after;
        }
        catch (error) {
            throw preserveApiError(error, "DRIVE_UNAVAILABLE");
        }
    }
    prepare(value) {
        let parsed;
        try {
            parsed = this.options.schema.parse(value);
        }
        catch {
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        }
        const source = `${JSON.stringify(parsed, null, 2)}\n`;
        return { value: parsed, source, checksum: createHash("sha256").update(source).digest("hex") };
    }
    async compareAndSet(transform, options = {}) {
        const attempts = options.attempts ?? 8;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            const current = await this.read(options.context);
            let next;
            try {
                next = transform(current.value);
            }
            catch (error) {
                throw preserveApiError(error, "DRIVE_UNAVAILABLE");
            }
            try {
                return await this.update(next, current.file.version, options.context);
            }
            catch (error) {
                if (!(error instanceof ApiResponseError) || error.code !== "CONFLICT" || attempt === attempts - 1)
                    throw error;
            }
        }
        throw new ApiResponseError("CONFLICT");
    }
    assertPinnedFile(file) {
        if (file.id !== this.options.fileId ||
            file.name !== this.options.name ||
            file.mimeType !== JSON_MIME_TYPE ||
            file.trashed ||
            file.parentIds.length !== 1 ||
            file.parentIds[0] !== this.options.parentId ||
            file.version.length === 0) {
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        }
    }
    assertChecksum(source, checksum) {
        if (!CHECKSUM.test(checksum) || createHash("sha256").update(source).digest("hex") !== checksum) {
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        }
    }
    assertWithinByteLimit(file, source) {
        const maxBytes = this.options.maxBytes;
        if (maxBytes !== undefined &&
            (file.size > maxBytes || (source !== undefined && !this.sourceIsWithinByteLimit(source))))
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
    }
    assertSourceWithinByteLimit(source) {
        if (!this.sourceIsWithinByteLimit(source))
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
    }
    sourceIsWithinByteLimit(source) {
        return this.options.maxBytes === undefined ||
            new TextEncoder().encode(source).byteLength <= this.options.maxBytes;
    }
}
export const preserveApiError = (error, fallback) => error instanceof ApiResponseError || error instanceof StorageOperationBudgetExceededError
    ? error
    : new ApiResponseError(fallback);
//# sourceMappingURL=system-file-store.js.map