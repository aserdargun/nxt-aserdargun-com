import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { setTimeout as sleepTimer } from "node:timers/promises";
import type {
  GoogleDriveClient,
  GoogleDriveCreateInput,
  GoogleDriveUpdateInput
} from "./google-drive-client.js";
import type { StoragePort, StoredFile } from "./storage-port.js";

const FILE_FIELDS =
  "id,name,mimeType,parents,version,modifiedTime,size,trashed,md5Checksum";
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

  public async get(fileId: string): Promise<StoredFile> {
    assertFileId(fileId);
    try {
      return toStoredFile(await this.readMetadata(fileId), this.rootId);
    } catch (error) {
      throw preserveSafeError(error, "Google Drive read failed.");
    }
  }

  public async listChildren(input: {
    parentId: string;
    pageToken?: string;
    pageSize: number;
  }): Promise<{ files: StoredFile[]; nextPageToken?: string }> {
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
        })
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
    fileId: string
  ): Promise<{ file: StoredFile; text: string; checksum: string }> {
    const result = await this.readBytes(fileId);
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
    fileId: string
  ): Promise<{ file: StoredFile; bytes: Uint8Array; checksum: string }> {
    assertFileId(fileId);
    try {
      const metadata = await this.readMetadata(fileId);
      const file = toStoredFile(metadata, this.rootId);
      assertReadableContent(file);
      const response = await this.readWithRetry(() =>
        this.client.files.get(
          { fileId, alt: "media" },
          { responseType: "arraybuffer" }
        )
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
  }): Promise<StoredFile> {
    return this.create({
      parentId: input.parentId,
      name: input.name,
      mimeType: FOLDER_MIME_TYPE
    });
  }

  public async createText(input: {
    parentId: string;
    name: string;
    mimeType: string;
    text: string;
  }): Promise<StoredFile> {
    const bytes = new TextEncoder().encode(input.text);
    return this.create({ ...input, body: input.text, checksum: md5(bytes) });
  }

  public async createBytes(input: {
    parentId: string;
    name: string;
    mimeType: string;
    bytes: Uint8Array;
  }): Promise<StoredFile> {
    return this.create({
      ...input,
      body: input.bytes,
      checksum: md5(input.bytes)
    });
  }

  public async updateText(input: {
    fileId: string;
    expectedVersion: string;
    mimeType: string;
    text: string;
  }): Promise<StoredFile> {
    assertFileId(input.fileId);
    assertMimeType(input.mimeType);
    assertVersion(input.expectedVersion);
    let before: StoredFile;
    try {
      before = toStoredFile(await this.readMetadata(input.fileId), this.rootId);
    } catch (error) {
      throw preserveSafeError(error, "Google Drive read failed.");
    }
    assertWritableContent(before);
    if (before.version !== input.expectedVersion)
      throw new DriveContractError("version conflict");
    const bytes = new TextEncoder().encode(input.text);
    try {
      await this.client.files.update({
        fileId: input.fileId,
        requestBody: { mimeType: input.mimeType },
        media: { mimeType: input.mimeType, body: input.text },
        fields: "id"
      });
    } catch {
      throw new DriveContractError("Google Drive write failed.");
    }
    return this.verifyUpload(input.fileId, md5(bytes), before.version);
  }

  public async move(input: {
    fileId: string;
    fromParentId: string;
    toParentId: string;
    newName?: string;
  }): Promise<StoredFile> {
    assertFileId(input.fileId);
    assertFileId(input.fromParentId);
    assertFileId(input.toParentId);
    if (input.newName !== undefined) assertName(input.newName);
    let before: StoredFile;
    try {
      before = toStoredFile(await this.readMetadata(input.fileId), this.rootId);
    } catch (error) {
      throw preserveSafeError(error, "Google Drive read failed.");
    }
    assertActiveNonShortcut(before);
    if (
      before.parentIds.length !== 1 ||
      before.parentIds[0] !== input.fromParentId
    ) {
      throw new DriveContractError(
        "Google Drive ancestry does not match the requested move."
      );
    }
    const request: GoogleDriveUpdateInput = {
      fileId: input.fileId,
      ...(input.newName === undefined
        ? {}
        : { requestBody: { name: input.newName } }),
      addParents: input.toParentId,
      removeParents: input.fromParentId,
      fields: "id"
    };
    try {
      await this.client.files.update(request);
    } catch {
      throw new DriveContractError("Google Drive write failed.");
    }
    const after = await this.readBackAfterWrite(input.fileId);
    if (
      after.parentIds.length !== 1 ||
      after.parentIds[0] !== input.toParentId
    ) {
      throw new DriveContractError("Google Drive move verification failed.");
    }
    return after;
  }

  public async trash(fileId: string): Promise<StoredFile> {
    assertFileId(fileId);
    if (fileId === this.rootId)
      throw new DriveContractError("cannot trash configured root");
    try {
      await this.client.files.update({
        fileId,
        requestBody: { trashed: true },
        fields: "id"
      });
    } catch {
      throw new DriveContractError("Google Drive write failed.");
    }
    const file = await this.readBackAfterWrite(fileId);
    if (!file.trashed)
      throw new DriveContractError("Google Drive Trash verification failed.");
    return file;
  }

  public async listRevisions(
    fileId: string
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
          })
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
  }): Promise<StoredFile> {
    assertFileId(input.parentId);
    assertName(input.name);
    assertMimeType(input.mimeType);
    const request: GoogleDriveCreateInput = {
      requestBody: {
        name: input.name,
        mimeType: input.mimeType,
        parents: [input.parentId]
      },
      ...(input.body === undefined
        ? {}
        : { media: { mimeType: input.mimeType, body: input.body } }),
      fields: "id"
    };
    let response;
    try {
      response = await this.client.files.create(request);
    } catch {
      throw new DriveContractError("Google Drive write failed.");
    }
    const createdId = requireFileIdFromWrite(response.data);
    const created =
      input.checksum === undefined
        ? await this.readBackAfterWrite(createdId)
        : await this.verifyUpload(createdId, input.checksum);
    if (
      created.name !== input.name ||
      created.mimeType !== input.mimeType ||
      created.parentIds.length !== 1 ||
      created.parentIds[0] !== input.parentId ||
      created.trashed
    ) {
      throw new DriveContractError("Google Drive create verification failed.");
    }
    return created;
  }

  private async verifyUpload(
    fileId: string,
    expectedChecksum: string,
    previousVersion?: string
  ): Promise<StoredFile> {
    const metadata = await this.readMetadataAfterWrite(fileId);
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

  private async readBackAfterWrite(fileId: string): Promise<StoredFile> {
    return toStoredFile(await this.readMetadataAfterWrite(fileId), this.rootId);
  }

  private async readMetadataAfterWrite(fileId: string): Promise<unknown> {
    try {
      return await this.readMetadata(fileId);
    } catch {
      throw new DriveContractError("Google Drive write readback failed.");
    }
  }

  private async readMetadata(fileId: string): Promise<unknown> {
    assertFileId(fileId);
    const response = await this.readWithRetry(() =>
      this.client.files.get({ fileId, fields: FILE_FIELDS })
    );
    return response.data;
  }

  private async readWithRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt += 1) {
      try {
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
  const modifiedTime = requireNonEmptyString(file.modifiedTime);
  const trashed = requireBoolean(file.trashed);
  return {
    id,
    name,
    mimeType,
    parentIds: parents,
    version,
    modifiedTime,
    size: parseSize(file.size, mimeType),
    trashed
  };
};

const assertReadableContent = (file: StoredFile): void => {
  assertActiveNonShortcut(file);
  if (file.mimeType === FOLDER_MIME_TYPE)
    throw new DriveContractError("Google Drive item has no readable content.");
};

const assertWritableContent = (file: StoredFile): void => {
  assertReadableContent(file);
};

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
  if (!/^\d+$/u.test(value))
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
): DriveContractError =>
  error instanceof DriveContractError
    ? error
    : new DriveContractError(fallback);

class DriveContractError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DriveContractError";
  }
}
