import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { setTimeout as sleepTimer } from "node:timers/promises";
import type {
  GoogleDriveClient,
  GoogleDriveCreateInput,
  GoogleDriveUpdateInput
} from "./google-drive-client.js";
import {
  assertStorageVersion,
  StorageMutationOutcomeUnknownError,
  StorageOperationBudgetExceededError,
  StorageVersionConflictError,
  type StorageOperationContext,
  type StoragePort,
  type StoredFile
} from "./storage-port.js";

const FILE_FIELDS =
  "id,name,mimeType,parents,version,modifiedTime,size,trashed,md5Checksum,appProperties";
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

export interface GoogleDriveAdapterOptions {
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  rootId?: string;
}

export class GoogleDriveAdapter implements StoragePort {
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private readonly rootId: string | undefined;

  public constructor(
    private readonly client: GoogleDriveClient,
    options: GoogleDriveAdapterOptions = {}
  ) {
    this.sleep = options.sleep ?? ((milliseconds) => sleepTimer(milliseconds));
    this.random = options.random ?? Math.random;
    if (options.rootId !== undefined) assertFileId(options.rootId);
    this.rootId = options.rootId;
  }

  public async get(fileId: string, context?: StorageOperationContext): Promise<StoredFile> {
    assertFileId(fileId);
    try {
      return toStoredFile(await this.readMetadata(fileId, context), this.rootId);
    } catch (error) {
      throw preserveSafeError(error, "Google Drive read failed.");
    }
  }

  public async listChildren(input: {
    parentId: string;
    pageToken?: string;
    pageSize: number;
  }, context?: StorageOperationContext): Promise<{ files: StoredFile[]; nextPageToken?: string }> {
    assertFileId(input.parentId);
    assertPageSize(input.pageSize);
    try {
      const response = await this.readWithRetry(() =>
        this.client.files.list({
          q: `'${escapeDriveQueryLiteral(input.parentId)}' in parents and trashed = false`,
          spaces: "drive",
          pageSize: input.pageSize,
          ...(input.pageToken === undefined
            ? {}
            : { pageToken: input.pageToken }),
          fields: LIST_FIELDS
        }), context
      );
      const data = requireRecord(response.data);
      const rawFiles = data.files === undefined ? [] : requireArray(data.files);
      const files = rawFiles.map((file) => toStoredFile(file, this.rootId));
      for (const file of files) {
        if (file.trashed)
          throw new DriveContractError(
            "Google Drive returned a trashed list item."
          );
      }
      const nextPageToken = optionalString(data.nextPageToken);
      return nextPageToken === undefined ? { files } : { files, nextPageToken };
    } catch (error) {
      throw preserveSafeError(error, "Google Drive read failed.");
    }
  }

  public async readText(
    fileId: string,
    context?: StorageOperationContext
  ): Promise<{ file: StoredFile; text: string; checksum: string }> {
    const result = await this.readBytes(fileId, context);
    try {
      return {
        file: result.file,
        text: new TextDecoder("utf-8", { fatal: true }).decode(result.bytes),
        checksum: result.checksum
      };
    } catch {
      throw new DriveContractError(
        "Google Drive text content is not valid UTF-8."
      );
    }
  }

  public async readBytes(
    fileId: string,
    context?: StorageOperationContext
  ): Promise<{ file: StoredFile; bytes: Uint8Array; checksum: string }> {
    assertFileId(fileId);
    try {
      const metadata = await this.readMetadata(fileId, context);
      const file = toStoredFile(metadata, this.rootId);
      assertReadableContent(file);
      const response = await this.readWithRetry(() =>
        this.client.files.get(
          { fileId, alt: "media" },
          { responseType: "arraybuffer" }
        ), context
      );
      const bytes = toBytes(response.data);
      const expectedChecksum = requireNonEmptyString(
        requireRecord(metadata).md5Checksum
      );
      if (md5(bytes) !== expectedChecksum) {
        throw new DriveContractError(
          "Google Drive checksum verification failed."
        );
      }
      return { file, bytes, checksum: sha256(bytes) };
    } catch (error) {
      throw preserveSafeError(error, "Google Drive read failed.");
    }
  }

  public async createFolder(input: {
    parentId: string;
    name: string;
  }, context?: StorageOperationContext): Promise<StoredFile> {
    return this.create({
      parentId: input.parentId,
      name: input.name,
      mimeType: FOLDER_MIME_TYPE
    }, context);
  }

  public async createText(input: {
    parentId: string;
    name: string;
    mimeType: string;
    text: string;
  }, context?: StorageOperationContext): Promise<StoredFile> {
    const bytes = new TextEncoder().encode(input.text);
    return this.create({ ...input, body: input.text, checksum: md5(bytes) }, context);
  }

  public async createBytes(input: {
    parentId: string;
    name: string;
    mimeType: string;
    bytes: Uint8Array;
    appProperties?: Record<string, string>;
  }, context?: StorageOperationContext): Promise<StoredFile> {
    return this.create({
      ...input,
      body: input.bytes,
      checksum: md5(input.bytes)
    }, context);
  }

  public async updateText(input: {
    fileId: string;
    expectedVersion: string;
    mimeType: string;
    text: string;
  }, context?: StorageOperationContext): Promise<StoredFile> {
    assertFileId(input.fileId);
    assertMimeType(input.mimeType);
    assertStorageVersion(input.expectedVersion);
    assertVersion(input.expectedVersion);
    let before: StoredFile;
    let etag: string;
    try {
      const snapshot = await this.readMetadataSnapshot(input.fileId, context);
      before = toStoredFile(snapshot.data, this.rootId);
      etag = responseEtag(snapshot.headers);
    } catch (error) {
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
    } catch (error) {
      if (errorStatus(error) === 412) throw new StorageVersionConflictError();
      throw new StorageMutationOutcomeUnknownError(input.fileId, "Google Drive write outcome is unknown.");
    }
    try {
      assertWriteResponseId(
        response.data,
        input.fileId,
        "Google Drive upload verification failed."
      );
      const after = await this.verifyUpload(
        input.fileId,
        md5(bytes),
        before.version,
        context
      );
      if (!matchesActiveSnapshot(after, before, input.mimeType)) {
        throw new DriveContractError("Google Drive upload verification failed.");
      }
      return after;
    } catch (error) {
      throw mutationOutcomeUnknown(error, input.fileId, "Google Drive upload verification failed.");
    }
  }

  public async move(input: {
    fileId: string;
    fromParentId: string;
    toParentId: string;
    expectedVersion: string;
    newName?: string;
  }, context?: StorageOperationContext): Promise<StoredFile> {
    assertFileId(input.fileId);
    assertFileId(input.fromParentId);
    assertFileId(input.toParentId);
    assertStorageVersion(input.expectedVersion);
    assertVersion(input.expectedVersion);
    if (input.newName !== undefined) assertName(input.newName);
    let before: StoredFile;
    let etag: string;
    try {
      const snapshot = await this.readMetadataSnapshot(input.fileId, context);
      before = toStoredFile(snapshot.data, this.rootId);
      etag = responseEtag(snapshot.headers);
    } catch (error) {
      throw preserveSafeError(error, "Google Drive read failed.");
    }
    assertActiveNonShortcut(before);
    if (before.version !== input.expectedVersion) throw new StorageVersionConflictError();
    if (
      before.parentIds.length !== 1 ||
      before.parentIds[0] !== input.fromParentId
    ) {
      throw new DriveContractError(
        "Google Drive ancestry does not match the requested move."
      );
    }
    const sameParent = input.fromParentId === input.toParentId;
    if (sameParent && input.newName === undefined) {
      throw new DriveContractError("same-parent move requires a rename");
    }
    const request: GoogleDriveUpdateInput = {
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
    } catch (error) {
      if (errorStatus(error) === 412) throw new StorageVersionConflictError();
      throw new StorageMutationOutcomeUnknownError(input.fileId, "Google Drive move outcome is unknown.");
    }
    try {
      assertWriteResponseId(
        response.data,
        input.fileId,
        "Google Drive move verification failed."
      );
      const after = await this.readBackAfterWrite(input.fileId, context);
      if (
        after.id !== before.id ||
        after.name !== (input.newName ?? before.name) ||
        after.mimeType !== before.mimeType ||
        after.trashed ||
        after.parentIds.length !== 1 ||
        after.parentIds[0] !== input.toParentId ||
        !isNewerVersion(after.version, before.version)
      ) {
        throw new DriveContractError("Google Drive move verification failed.");
      }
      return after;
    } catch (error) {
      throw mutationOutcomeUnknown(error, input.fileId, "Google Drive move verification failed.");
    }
  }

  public async trash(fileId: string, context?: StorageOperationContext, expectedVersion?: string): Promise<StoredFile> {
    assertFileId(fileId);
    if (fileId === this.rootId)
      throw new DriveContractError("cannot trash configured root");
    let before: StoredFile;
    let etag: string;
    try {
      const snapshot = await this.readMetadataSnapshot(fileId, context);
      before = toStoredFile(snapshot.data, this.rootId);
      etag = responseEtag(snapshot.headers);
    } catch (error) {
      throw preserveSafeError(error, "Google Drive read failed.");
    }
    assertActiveNonShortcut(before);
    if (expectedVersion !== undefined && before.version !== expectedVersion) throw new StorageVersionConflictError();
    assertSingleParent(before, "Google Drive Trash verification failed.");
    let response;
    context?.operationBudget?.consume();
    try {
      response = await this.client.files.update({
        fileId,
        requestBody: { trashed: true },
        fields: "id"
      }, { headers: { "If-Match": etag } });
    } catch (error) {
      if (errorStatus(error) === 412) throw new StorageVersionConflictError();
      throw new StorageMutationOutcomeUnknownError(fileId, "Google Drive Trash outcome is unknown.");
    }
    try {
      assertWriteResponseId(
        response.data,
        fileId,
        "Google Drive Trash verification failed."
      );
      const file = await this.readBackAfterWrite(fileId, context);
      if (
        file.id !== before.id ||
        file.name !== before.name ||
        file.mimeType !== before.mimeType ||
        !file.trashed ||
        file.parentIds.length !== 1 ||
        file.parentIds[0] !== before.parentIds[0] ||
        !isNewerVersion(file.version, before.version)
      ) throw new DriveContractError("Google Drive Trash verification failed.");
      return file;
    } catch (error) {
      throw mutationOutcomeUnknown(error, fileId, "Google Drive Trash verification failed.");
    }
  }

  public async listRevisions(
    fileId: string,
    context?: StorageOperationContext
  ): Promise<Array<{ id: string; modifiedTime: string }>> {
    assertFileId(fileId);
    const revisions: Array<{ id: string; modifiedTime: string }> = [];
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;
    try {
      for (let page = 0; page < MAX_REVISION_PAGES; page += 1) {
        const response = await this.readWithRetry(() =>
          this.client.revisions.list({
            fileId,
            pageSize: 100,
            fields: REVISION_FIELDS,
            ...(pageToken === undefined ? {} : { pageToken })
          }), context
        );
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
        if (nextPageToken === undefined) return revisions;
        if (seenTokens.has(nextPageToken))
          throw new DriveContractError(
            "Google Drive pagination cycle detected."
          );
        seenTokens.add(nextPageToken);
        pageToken = nextPageToken;
      }
      throw new DriveContractError("Google Drive pagination limit exceeded.");
    } catch (error) {
      throw preserveSafeError(error, "Google Drive read failed.");
    }
  }

  private async create(input: {
    parentId: string;
    name: string;
    mimeType: string;
    body?: string | Uint8Array;
    checksum?: string;
    appProperties?: Record<string, string>;
  }, context?: StorageOperationContext): Promise<StoredFile> {
    assertFileId(input.parentId);
    assertName(input.name);
    assertMimeType(input.mimeType);
    const request: GoogleDriveCreateInput = {
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
    } catch {
      throw new StorageMutationOutcomeUnknownError(undefined, "Google Drive create outcome is unknown.");
    }
    let createdId: string | undefined;
    try {
      createdId = requireFileIdFromWrite(response.data);
      const created =
        input.checksum === undefined
          ? await this.readBackAfterWrite(createdId, context)
          : await this.verifyUpload(createdId, input.checksum, undefined, context);
      if (
        created.id !== createdId ||
        created.name !== input.name ||
        created.mimeType !== input.mimeType ||
        created.parentIds.length !== 1 ||
        created.parentIds[0] !== input.parentId ||
        created.trashed
      ) {
        throw new DriveContractError("Google Drive create verification failed.");
      }
      return created;
    } catch (error) {
      throw mutationOutcomeUnknown(
        error,
        createdId,
        input.checksum === undefined ? "Google Drive create verification failed." : "Google Drive upload verification failed."
      );
    }
  }

  private async verifyUpload(
    fileId: string,
    expectedChecksum: string,
    previousVersion?: string,
    context?: StorageOperationContext
  ): Promise<StoredFile> {
    const metadata = await this.readMetadataAfterWrite(fileId, context);
    const file = toStoredFile(metadata, this.rootId);
    const checksum = requireRecord(metadata).md5Checksum;
    if (checksum !== expectedChecksum)
      throw new DriveContractError("Google Drive upload verification failed.");
    if (
      previousVersion !== undefined &&
      !isNewerVersion(file.version, previousVersion)
    ) {
      throw new DriveContractError("Google Drive upload verification failed.");
    }
    return file;
  }

  private async readBackAfterWrite(fileId: string, context?: StorageOperationContext): Promise<StoredFile> {
    return toStoredFile(await this.readMetadataAfterWrite(fileId, context), this.rootId);
  }

  private async readMetadataAfterWrite(fileId: string, context?: StorageOperationContext): Promise<unknown> {
    try {
      return await this.readMetadata(fileId, context);
    } catch (error) {
      if (error instanceof StorageOperationBudgetExceededError) throw error;
      throw new DriveContractError("Google Drive write readback failed.");
    }
  }

  private async readMetadata(fileId: string, context?: StorageOperationContext): Promise<unknown> {
    return (await this.readMetadataSnapshot(fileId, context)).data;
  }

  private async readMetadataSnapshot(fileId: string, context?: StorageOperationContext): Promise<{ data: unknown; headers?: unknown }> {
    assertFileId(fileId);
    const response = await this.readWithRetry(
      () => this.client.files.get({ fileId, fields: FILE_FIELDS }),
      context
    );
    return response;
  }

  private async readWithRetry<T>(operation: () => Promise<T>, context?: StorageOperationContext): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt += 1) {
      try {
        context?.operationBudget?.consume();
        return await operation();
      } catch (error) {
        lastError = error;
        const status = errorStatus(error);
        if (
          status === undefined ||
          !RETRYABLE_READ_STATUSES.has(status) ||
          attempt === MAX_READ_ATTEMPTS - 1
        )
          break;
        const exponential = BASE_RETRY_DELAY_MS * 2 ** attempt;
        const jitter = Math.floor(exponential * clampRandom(this.random()));
        await this.sleep(exponential + jitter);
      }
    }
    throw lastError;
  }
}

export const escapeDriveQueryLiteral = (value: string): string =>
  value.replace(/\\/gu, "\\\\").replace(/'/gu, "\\'");

const toStoredFile = (raw: unknown, rootId?: string): StoredFile => {
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

const optionalStringRecord = (value: unknown): Record<string, string> | undefined => {
  if (value === undefined) return undefined;
  const record = requireRecord(value);
  const entries = Object.entries(record);
  if (entries.length > 16 || entries.some(([key, item]) => !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(key) || typeof item !== "string" || item.length > 128 || /[\r\n\0]/u.test(item))) throw new DriveContractError("Google Drive app properties are invalid.");
  return Object.fromEntries(entries) as Record<string, string>;
};

const assertReadableContent = (file: StoredFile): void => {
  assertActiveNonShortcut(file);
  if (file.mimeType === FOLDER_MIME_TYPE)
    throw new DriveContractError("Google Drive item has no readable content.");
};

const assertWritableContent = (file: StoredFile): void => {
  assertReadableContent(file);
};

const assertSingleParent = (file: StoredFile, message: string): void => {
  if (file.parentIds.length !== 1) throw new DriveContractError(message);
};

const matchesActiveSnapshot = (
  after: StoredFile,
  before: StoredFile,
  expectedMimeType: string
): boolean =>
  after.id === before.id &&
  after.name === before.name &&
  after.mimeType === expectedMimeType &&
  !after.trashed &&
  after.parentIds.length === 1 &&
  after.parentIds[0] === before.parentIds[0];

const assertActiveNonShortcut = (file: StoredFile): void => {
  if (file.trashed)
    throw new DriveContractError("Google Drive item is trashed.");
  if (file.mimeType === SHORTCUT_MIME_TYPE)
    throw new DriveContractError("Google Drive shortcuts are not allowed.");
};

const parseSize = (value: unknown, mimeType: string): number => {
  if (value === undefined && mimeType === FOLDER_MIME_TYPE) return 0;
  if (typeof value !== "string" || !/^\d+$/u.test(value))
    throw new DriveContractError("Google Drive metadata is invalid.");
  const size = Number(value);
  if (!Number.isSafeInteger(size))
    throw new DriveContractError("Google Drive metadata is invalid.");
  return size;
};

const requireFileIdFromWrite = (value: unknown): string => {
  const id = requireNonEmptyString(requireRecord(value).id);
  assertFileId(id);
  return id;
};

const assertWriteResponseId = (
  value: unknown,
  expectedId: string,
  message: string
): void => {
  let id: string;
  try {
    id = requireFileIdFromWrite(value);
  } catch {
    throw new DriveContractError(message);
  }
  if (id !== expectedId) throw new DriveContractError(message);
};

const requireRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DriveContractError("Google Drive response is invalid.");
  }
  return value as Record<string, unknown>;
};

const requireArray = (value: unknown): unknown[] => {
  if (!Array.isArray(value))
    throw new DriveContractError("Google Drive response is invalid.");
  return value;
};

const requireStringArray = (value: unknown): string[] => {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string")
  ) {
    throw new DriveContractError("Google Drive response is invalid.");
  }
  return [...value];
};

const requireNonEmptyString = (value: unknown): string => {
  if (typeof value !== "string" || value === "")
    throw new DriveContractError("Google Drive response is invalid.");
  return value;
};

const responseEtag = (headers: unknown): string => {
  const record = requireRecord(headers);
  let etag = record.etag ?? record.ETag;
  if (typeof etag !== "string" && typeof record.get === "function") {
    try { etag = (record.get as (name: string) => unknown)("etag"); } catch { etag = undefined; }
  }
  if (
    typeof etag !== "string" ||
    etag.length > 512 ||
    !/^(?:W\/)?"[\x21\x23-\x7E\x80-\xFF]*"$/u.test(etag)
  ) {
    throw new DriveContractError("Google Drive version precondition is unavailable.");
  }
  return etag;
};

const optionalString = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  return requireNonEmptyString(value);
};

const requireBoolean = (value: unknown): boolean => {
  if (typeof value !== "boolean")
    throw new DriveContractError("Google Drive response is invalid.");
  return value;
};

const assertFileId = (value: string): void => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_FILE_ID_LENGTH
  ) {
    throw new DriveContractError("Invalid Google Drive file ID.");
  }
};

const assertName = (value: string): void => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    /[\r\n\0]/u.test(value)
  ) {
    throw new DriveContractError("Invalid Google Drive item name.");
  }
};

const assertMimeType = (value: string): void => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    /[\r\n\0]/u.test(value)
  ) {
    throw new DriveContractError("Invalid Google Drive MIME type.");
  }
};

const assertVersion = (value: string): void => {
  if (!/^[1-9]\d*$/u.test(value))
    throw new DriveContractError("Invalid Google Drive version.");
};

const assertPageSize = (value: number): void => {
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw new DriveContractError("Invalid Google Drive page size.");
  }
};

const isNewerVersion = (next: string, previous: string): boolean => {
  try {
    return BigInt(next) > BigInt(previous);
  } catch {
    return false;
  }
};

const errorStatus = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const errorRecord = error as Record<string, unknown>;
  const response = errorRecord.response;
  if (typeof response === "object" && response !== null) {
    const status = (response as Record<string, unknown>).status;
    if (typeof status === "number") return status;
  }
  const code = errorRecord.code;
  if (typeof code === "number") return code;
  if (typeof code === "string" && /^\d{3}$/u.test(code)) return Number(code);
  return undefined;
};

const clampRandom = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(0.999_999, value)) : 0;

const toBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === "string") return new Uint8Array(Buffer.from(value));
  throw new DriveContractError("Google Drive media response is invalid.");
};

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const md5 = (bytes: Uint8Array): string =>
  createHash("md5").update(bytes).digest("hex");

const preserveSafeError = (
  error: unknown,
  fallback: string
): Error =>
  error instanceof DriveContractError || error instanceof StorageOperationBudgetExceededError
    ? error
    : new DriveContractError(fallback);

const mutationOutcomeUnknown = (
  error: unknown,
  fileId: string | undefined,
  fallback: string
): StorageMutationOutcomeUnknownError => new StorageMutationOutcomeUnknownError(
  fileId,
  error instanceof DriveContractError ? error.message : fallback
);

class DriveContractError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DriveContractError";
  }
}
