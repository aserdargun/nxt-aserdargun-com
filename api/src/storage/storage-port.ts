export interface StoredFile {
  id: string;
  name: string;
  mimeType: string;
  parentIds: string[];
  version: string;
  modifiedTime: string;
  size: number;
  trashed: boolean;
}

export class StorageVersionConflictError extends Error {
  public constructor() {
    super("storage version conflict");
    this.name = "StorageVersionConflictError";
  }
}

export class StorageOperationBudgetExceededError extends Error {
  public constructor() {
    super("storage operation budget exhausted");
    this.name = "StorageOperationBudgetExceededError";
  }
}

export class StorageOperationBudget {
  private consumed = 0;

  public constructor(public readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("invalid storage operation budget");
  }

  public consume(): void {
    if (this.consumed >= this.limit) throw new StorageOperationBudgetExceededError();
    this.consumed += 1;
  }

  public get remaining(): number { return this.limit - this.consumed; }
  public get used(): number { return this.consumed; }
}

export interface StorageOperationContext {
  operationBudget?: StorageOperationBudget;
}

/** A storage mutation was rejected before it could reach the backing store. */
export class StorageMutationNotAppliedError extends Error {
  public constructor() {
    super("storage mutation was not applied");
    this.name = "StorageMutationNotAppliedError";
  }
}

/** A backing store may have applied a mutation even though acknowledgement failed. */
export class StorageMutationOutcomeUnknownError extends Error {
  public constructor(
    public readonly fileId?: string,
    message = "storage mutation outcome is unknown"
  ) {
    super(message);
    this.name = "StorageMutationOutcomeUnknownError";
  }
}

export interface StoragePort {
  get(fileId: string, context?: StorageOperationContext): Promise<StoredFile>;
  listChildren(input: {
    parentId: string;
    pageToken?: string;
    pageSize: number;
  }, context?: StorageOperationContext): Promise<{ files: StoredFile[]; nextPageToken?: string }>;
  readText(fileId: string, context?: StorageOperationContext): Promise<{ file: StoredFile; text: string; checksum: string }>;
  readBytes(fileId: string, context?: StorageOperationContext): Promise<{ file: StoredFile; bytes: Uint8Array; checksum: string }>;
  createFolder(input: { parentId: string; name: string }, context?: StorageOperationContext): Promise<StoredFile>;
  createText(input: { parentId: string; name: string; mimeType: string; text: string }, context?: StorageOperationContext): Promise<StoredFile>;
  createBytes(input: { parentId: string; name: string; mimeType: string; bytes: Uint8Array }, context?: StorageOperationContext): Promise<StoredFile>;
  updateText(input: { fileId: string; expectedVersion: string; mimeType: string; text: string }, context?: StorageOperationContext): Promise<StoredFile>;
  move(input: { fileId: string; fromParentId: string; toParentId: string; expectedVersion: string; newName?: string }, context?: StorageOperationContext): Promise<StoredFile>;
  trash(fileId: string, context?: StorageOperationContext): Promise<StoredFile>;
  listRevisions(fileId: string, context?: StorageOperationContext): Promise<Array<{ id: string; modifiedTime: string }>>;
}
