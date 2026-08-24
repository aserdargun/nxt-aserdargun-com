import { createHash } from "node:crypto";
import { ApiResponseError } from "../http/api-response.js";
import { StorageVersionConflictError, type StoragePort, type StoredFile } from "../storage/storage-port.js";

const JSON_MIME_TYPE = "application/json";
const CHECKSUM = /^[a-f0-9]{64}$/u;

export interface RuntimeSchema<T> {
  parse(value: unknown): T;
}

export interface SystemFileSnapshot<T> {
  value: T;
  file: StoredFile;
  source: string;
  checksum: string;
}

export class SystemFileStore<T> {
  public constructor(
    private readonly options: {
      storage: StoragePort;
      fileId: string;
      parentId: string;
      name: string;
      schema: RuntimeSchema<T>;
    }
  ) {}

  public async read(): Promise<SystemFileSnapshot<T>> {
    try {
      const readback = await this.options.storage.readText(this.options.fileId);
      this.assertPinnedFile(readback.file);
      this.assertChecksum(readback.text, readback.checksum);
      return {
        value: this.options.schema.parse(JSON.parse(readback.text) as unknown),
        file: readback.file,
        source: readback.text,
        checksum: readback.checksum
      };
    } catch (error) {
      throw preserveApiError(error, "DRIVE_UNAVAILABLE");
    }
  }

  public async update(value: T, expectedVersion?: string): Promise<SystemFileSnapshot<T>> {
    const before = await this.read();
    if (expectedVersion !== undefined && before.file.version !== expectedVersion) {
      throw new ApiResponseError("CONFLICT");
    }
    let parsed: T;
    try {
      parsed = this.options.schema.parse(value);
    } catch {
      throw new ApiResponseError("DRIVE_UNAVAILABLE");
    }
    const source = `${JSON.stringify(parsed, null, 2)}\n`;
    let updated: StoredFile;
    try {
      updated = await this.options.storage.updateText({
        fileId: this.options.fileId,
        expectedVersion: before.file.version,
        mimeType: JSON_MIME_TYPE,
        text: source
      });
    } catch (error) {
      throw new ApiResponseError(error instanceof StorageVersionConflictError ? "CONFLICT" : "DRIVE_UNAVAILABLE");
    }
    try {
      this.assertPinnedFile(updated);
      const after = await this.read();
      if (after.file.version !== updated.version || after.source !== source) {
        throw new ApiResponseError("DRIVE_UNAVAILABLE");
      }
      return after;
    } catch (error) {
      throw preserveApiError(error, "DRIVE_UNAVAILABLE");
    }
  }

  public async compareAndSet(
    transform: (current: T) => T,
    options: { attempts?: number } = {}
  ): Promise<SystemFileSnapshot<T>> {
    const attempts = options.attempts ?? 8;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const current = await this.read();
      let next: T;
      try {
        next = transform(current.value);
      } catch (error) {
        throw preserveApiError(error, "DRIVE_UNAVAILABLE");
      }
      try {
        return await this.update(next, current.file.version);
      } catch (error) {
        if (!(error instanceof ApiResponseError) || error.code !== "CONFLICT" || attempt === attempts - 1) throw error;
      }
    }
    throw new ApiResponseError("CONFLICT");
  }

  private assertPinnedFile(file: StoredFile): void {
    if (
      file.id !== this.options.fileId ||
      file.name !== this.options.name ||
      file.mimeType !== JSON_MIME_TYPE ||
      file.trashed ||
      file.parentIds.length !== 1 ||
      file.parentIds[0] !== this.options.parentId ||
      file.version.length === 0
    ) {
      throw new ApiResponseError("DRIVE_UNAVAILABLE");
    }
  }

  private assertChecksum(source: string, checksum: string): void {
    if (!CHECKSUM.test(checksum) || createHash("sha256").update(source).digest("hex") !== checksum) {
      throw new ApiResponseError("DRIVE_UNAVAILABLE");
    }
  }
}

export const preserveApiError = (
  error: unknown,
  fallback: ConstructorParameters<typeof ApiResponseError>[0]
): ApiResponseError => error instanceof ApiResponseError ? error : new ApiResponseError(fallback);
