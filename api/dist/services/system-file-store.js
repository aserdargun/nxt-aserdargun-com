import { createHash } from "node:crypto";
import { ApiResponseError } from "../http/api-response.js";
const JSON_MIME_TYPE = "application/json";
const CHECKSUM = /^[a-f0-9]{64}$/u;
export class SystemFileStore {
    options;
    constructor(options) {
        this.options = options;
    }
    async read() {
        try {
            const readback = await this.options.storage.readText(this.options.fileId);
            this.assertPinnedFile(readback.file);
            this.assertChecksum(readback.text, readback.checksum);
            return {
                value: this.options.schema.parse(JSON.parse(readback.text)),
                file: readback.file,
                source: readback.text,
                checksum: readback.checksum
            };
        }
        catch (error) {
            throw preserveApiError(error, "DRIVE_UNAVAILABLE");
        }
    }
    async update(value, expectedVersion) {
        const before = await this.read();
        if (expectedVersion !== undefined && before.file.version !== expectedVersion) {
            throw new ApiResponseError("CONFLICT");
        }
        let parsed;
        try {
            parsed = this.options.schema.parse(value);
        }
        catch {
            throw new ApiResponseError("INVALID_INPUT");
        }
        const source = `${JSON.stringify(parsed, null, 2)}\n`;
        let updated;
        try {
            updated = await this.options.storage.updateText({
                fileId: this.options.fileId,
                expectedVersion: before.file.version,
                mimeType: JSON_MIME_TYPE,
                text: source
            });
        }
        catch (error) {
            throw new ApiResponseError(isVersionConflict(error) ? "CONFLICT" : "DRIVE_UNAVAILABLE");
        }
        try {
            this.assertPinnedFile(updated);
            const after = await this.read();
            if (after.file.version !== updated.version || after.source !== source) {
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            }
            return after;
        }
        catch (error) {
            throw preserveApiError(error, "DRIVE_UNAVAILABLE");
        }
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
}
const isVersionConflict = (error) => error instanceof Error && /version conflict/iu.test(error.message);
export const preserveApiError = (error, fallback) => error instanceof ApiResponseError ? error : new ApiResponseError(fallback);
//# sourceMappingURL=system-file-store.js.map