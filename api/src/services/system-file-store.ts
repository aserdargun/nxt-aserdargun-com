import { createHash } from "node:crypto";
import { ApiResponseError } from "../http/api-response.js";
import {
  StorageOperationBudgetExceededError,
  StorageVersionConflictError,
  type StorageOperationContext,
  type StoragePort,
  type StoredFile
} from "../storage/storage-port.js";

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

export interface PreparedSystemFile<T> {
  value: T;
  source: string;
  checksum: string;
}

export class SystemFileStore<T> {
  private cachedSnapshot: SystemFileSnapshot<T> | undefined;
  private cachedRead: Promise<SystemFileSnapshot<T>> | undefined;

  public constructor(
    private readonly options: {
      storage: StoragePort;
      fileId: string;
      parentId: string;
      name: string;
      schema: RuntimeSchema<T>;
      maxBytes?: number;
    }
  ) {
    if (
      options.maxBytes !== undefined &&
      (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)
    ) throw new Error("invalid system file byte limit");
  }

  public readVersionCached(context?: StorageOperationContext): Promise<SystemFileSnapshot<T>> {
    this.cachedRead ??= this.readVersionCachedFresh(context).finally(() => {
      this.cachedRead = undefined;
    });
    return this.cachedRead;
  }

  public async read(context?: StorageOperationContext): Promise<SystemFileSnapshot<T>> {
    try {
      if (this.options.maxBytes !== undefined) {
        const metadata = await this.options.storage.get(this.options.fileId, context);
        this.assertPinnedFile(metadata);
        this.assertWithinByteLimit(metadata);
      }
      return await this.readBody(context);
    } catch (error) {
      throw preserveApiError(error, "DRIVE_UNAVAILABLE");
    }
  }

  private async readVersionCachedFresh(context?: StorageOperationContext): Promise<SystemFileSnapshot<T>> {
    try {
      const file = await this.options.storage.get(this.options.fileId, context);
      this.assertPinnedFile(file);
      this.assertWithinByteLimit(file);
      if (this.cachedSnapshot?.file.version === file.version) return this.cachedSnapshot;
      const snapshot = await this.readBody(context);
      this.cachedSnapshot = snapshot;
      return snapshot;
    } catch (error) {
      throw preserveApiError(error, "DRIVE_UNAVAILABLE");
    }
  }

  private async readBody(context?: StorageOperationContext): Promise<SystemFileSnapshot<T>> {
    const readback = await this.options.storage.readText(this.options.fileId, context);
    this.assertPinnedFile(readback.file);
    this.assertWithinByteLimit(readback.file, readback.text);
    this.assertChecksum(readback.text, readback.checksum);
    return {
      value: this.options.schema.parse(JSON.parse(readback.text) as unknown),
      file: readback.file,
      source: readback.text,
      checksum: readback.checksum
    };
  }

  public async update(value: T, expectedVersion?: string, context?: StorageOperationContext): Promise<SystemFileSnapshot<T>> {
    const before = await this.read(context);
    if (expectedVersion !== undefined && before.file.version !== expectedVersion) {
      throw new ApiResponseError("CONFLICT");
    }
    const prepared = this.prepare(value);
    const source = prepared.source;
    this.assertSourceWithinByteLimit(source);
    let updated: StoredFile;
    try {
      updated = await this.options.storage.updateText({
        fileId: this.options.fileId,
        expectedVersion: before.file.version,
        mimeType: JSON_MIME_TYPE,
        text: source
      }, context);
    } catch (error) {
      if (error instanceof StorageOperationBudgetExceededError) throw error;
      throw new ApiResponseError(error instanceof StorageVersionConflictError ? "CONFLICT" : "DRIVE_UNAVAILABLE");
    }
    try {
      this.assertPinnedFile(updated);
      const after = await this.read(context);
      if (after.file.version !== updated.version || after.source !== source) {
        throw new ApiResponseError("DRIVE_UNAVAILABLE");
      }
      return after;
    } catch (error) {
      throw preserveApiError(error, "DRIVE_UNAVAILABLE");
    }
  }

  public prepare(value: T): PreparedSystemFile<T> {
    let parsed: T;
    try {
      parsed = this.options.schema.parse(value);
    } catch {
      throw new ApiResponseError("DRIVE_UNAVAILABLE");
    }
    const source = `${JSON.stringify(parsed, null, 2)}\n`;
    return { value: parsed, source, checksum: createHash("sha256").update(source).digest("hex") };
  }

  public async compareAndSet(
    transform: (current: T) => T,
    options: { attempts?: number; context?: StorageOperationContext } = {}
  ): Promise<SystemFileSnapshot<T>> {
    const attempts = options.attempts ?? 8;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const current = await this.read(options.context);
      let next: T;
      try {
        next = transform(current.value);
      } catch (error) {
        throw preserveApiError(error, "DRIVE_UNAVAILABLE");
      }
      try {
        return await this.update(next, current.file.version, options.context);
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

  private assertWithinByteLimit(file: StoredFile, source?: string): void {
    const maxBytes = this.options.maxBytes;
    if (
      maxBytes !== undefined &&
      (file.size > maxBytes || (source !== undefined && !this.sourceIsWithinByteLimit(source)))
    ) throw new ApiResponseError("DRIVE_UNAVAILABLE");
  }

  private assertSourceWithinByteLimit(source: string): void {
    if (!this.sourceIsWithinByteLimit(source)) throw new ApiResponseError("DRIVE_UNAVAILABLE");
  }

  private sourceIsWithinByteLimit(source: string): boolean {
    return this.options.maxBytes === undefined ||
      new TextEncoder().encode(source).byteLength <= this.options.maxBytes;
  }
}

export const preserveApiError = (
  error: unknown,
  fallback: ConstructorParameters<typeof ApiResponseError>[0]
): Error => error instanceof ApiResponseError || error instanceof StorageOperationBudgetExceededError
  ? error
  : new ApiResponseError(fallback);
