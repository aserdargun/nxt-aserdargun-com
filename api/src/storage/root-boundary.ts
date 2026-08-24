import { assertStorageVersion, StorageOperationBudgetExceededError, type StorageOperationContext, type StoragePort, type StoredFile } from "./storage-port.js";

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const SHORTCUT_MIME_TYPE = "application/vnd.google-apps.shortcut";
const MAX_FILE_ID_LENGTH = 512;
const MAX_ANCESTRY_NODES = 100;

type TestGraphInput = {
  allowedRootId: string;
  graph: Record<string, string[]>;
  trashed?: readonly string[];
  shortcuts?: readonly string[];
};

const unsupported = (): Promise<never> => Promise.reject(new Error("unsupported in root-boundary test storage"));

const createTestStorage = (input: TestGraphInput): StoragePort => {
  const trashed = new Set(input.trashed);
  const shortcuts = new Set(input.shortcuts);
  return {
    get: (fileId) => {
      const parentIds = input.graph[fileId];
      if (parentIds === undefined) {
        return Promise.reject(new Error("missing file"));
      }
      return Promise.resolve({
        id: fileId,
        name: fileId,
        mimeType: shortcuts.has(fileId) ? SHORTCUT_MIME_TYPE : parentIds.length === 0 ? FOLDER_MIME_TYPE : "text/plain",
        parentIds: [...parentIds],
        version: "1",
        modifiedTime: "1970-01-01T00:00:00.000Z",
        size: 0,
        trashed: trashed.has(fileId)
      });
    },
    listChildren: unsupported,
    readText: unsupported,
    readBytes: unsupported,
    createFolder: unsupported,
    createText: unsupported,
    createBytes: unsupported,
    updateText: unsupported,
    move: unsupported,
    trash: unsupported,
    listRevisions: unsupported
  };
};

export class RootBoundaryStorage implements StoragePort {
  public constructor(
    private readonly storage: StoragePort,
    private readonly allowedRootId: string
  ) {
    assertFileId(allowedRootId);
  }

  public static forTest(input: TestGraphInput): RootBoundaryStorage {
    return new RootBoundaryStorage(createTestStorage(input), input.allowedRootId);
  }

  public async assertInside(fileId: string, context?: StorageOperationContext): Promise<void> {
    let currentId = fileId;
    const visited = new Set<string>();

    for (let nodes = 0; nodes < MAX_ANCESTRY_NODES; nodes += 1) {
      assertFileId(currentId);
      if (visited.has(currentId)) {
        throw new Error("cycle in file ancestry");
      }
      visited.add(currentId);

      let file: StoredFile;
      try {
        file = await this.storage.get(currentId, context);
      } catch (error) {
        if (error instanceof StorageOperationBudgetExceededError) throw error;
        throw new Error("missing parent in file ancestry", { cause: error });
      }
      if (file.id !== currentId) {
        throw new Error("file identity does not match ancestry request");
      }
      if (file.trashed && context?.allowTrashed !== true) {
        throw new Error("trashed file is outside configured root");
      }
      if (file.mimeType === SHORTCUT_MIME_TYPE) {
        throw new Error("shortcut is not allowed in configured root");
      }
      if (currentId === this.allowedRootId) {
        if (file.parentIds.length !== 0) {
          throw new Error("configured root has parent ancestry");
        }
        return;
      }
      if (file.parentIds.length === 0) {
        throw new Error("file is outside configured root");
      }
      if (file.parentIds.length !== 1) {
        throw new Error("ambiguous ancestry");
      }
      currentId = file.parentIds[0] as string;
    }

    throw new Error("ancestry limit exceeded");
  }

  public async get(fileId: string, context?: StorageOperationContext): Promise<StoredFile> {
    await this.assertInside(fileId, context);
    return this.storage.get(fileId, context);
  }

  public async listChildren(input: { parentId: string; pageToken?: string; pageSize: number }, context?: StorageOperationContext): Promise<{ files: StoredFile[]; nextPageToken?: string }> {
    await this.assertInside(input.parentId, context);
    const page = await this.storage.listChildren(input, context);
    for (const file of page.files) {
      await this.assertInside(file.id, context);
    }
    return page;
  }

  public async readText(fileId: string, context?: StorageOperationContext): Promise<{ file: StoredFile; text: string; checksum: string }> {
    await this.assertInside(fileId, context);
    return this.storage.readText(fileId, context);
  }

  public async readBytes(fileId: string, context?: StorageOperationContext): Promise<{ file: StoredFile; bytes: Uint8Array; checksum: string }> {
    await this.assertInside(fileId, context);
    return this.storage.readBytes(fileId, context);
  }

  public async createFolder(input: { parentId: string; name: string }, context?: StorageOperationContext): Promise<StoredFile> {
    await this.assertInside(input.parentId, context);
    const file = await this.storage.createFolder(input, context);
    await this.assertInside(file.id, context);
    return file;
  }

  public async createText(input: { parentId: string; name: string; mimeType: string; text: string }, context?: StorageOperationContext): Promise<StoredFile> {
    await this.assertInside(input.parentId, context);
    const file = await this.storage.createText(input, context);
    await this.assertInside(file.id, context);
    return file;
  }

  public async createBytes(input: { parentId: string; name: string; mimeType: string; bytes: Uint8Array; appProperties?: Record<string, string> }, context?: StorageOperationContext): Promise<StoredFile> {
    await this.assertInside(input.parentId, context);
    const file = await this.storage.createBytes(input, context);
    await this.assertInside(file.id, context);
    return file;
  }

  public async updateText(input: { fileId: string; expectedVersion: string; mimeType: string; text: string }, context?: StorageOperationContext): Promise<StoredFile> {
    assertStorageVersion(input.expectedVersion);
    await this.assertInside(input.fileId, context);
    const file = await this.storage.updateText(input, context);
    if (file.id !== input.fileId) {
      throw new Error("updated file identity changed");
    }
    await this.assertReturnedInside(file, context);
    await this.assertInside(file.id, context);
    return file;
  }

  public async move(input: { fileId: string; fromParentId: string; toParentId: string; expectedVersion: string; newName?: string }, context?: StorageOperationContext): Promise<StoredFile> {
    assertStorageVersion(input.expectedVersion);
    await this.assertInside(input.fileId, context);
    await this.assertInside(input.fromParentId, context);
    await this.assertInside(input.toParentId, context);
    const file = await this.storage.move(input, context);
    await this.assertInside(file.id, context);
    return file;
  }

  public async trash(input: { fileId: string; expectedVersion: string }, context?: StorageOperationContext): Promise<StoredFile> {
    assertStorageVersion(input.expectedVersion);
    await this.assertInside(input.fileId, context);
    const file = await this.storage.trash(input, context);
    if (file.id !== input.fileId || !file.trashed) throw new Error("Trash return does not match request");
    await this.assertReturnedInside(file, { ...context, allowTrashed: true });
    return file;
  }

  public async listRevisions(fileId: string, context?: StorageOperationContext): Promise<Array<{ id: string; modifiedTime: string }>> {
    await this.assertInside(fileId, context);
    return this.storage.listRevisions(fileId, context);
  }

  private async assertReturnedInside(file: StoredFile, context?: StorageOperationContext): Promise<void> {
    assertFileId(file.id);
    if (file.trashed && context?.allowTrashed !== true) {
      throw new Error("trashed file is outside configured root");
    }
    if (file.mimeType === SHORTCUT_MIME_TYPE) {
      throw new Error("shortcut is not allowed in configured root");
    }
    if (file.id === this.allowedRootId) {
      if (file.parentIds.length !== 0) {
        throw new Error("configured root has parent ancestry");
      }
      return;
    }
    if (file.parentIds.length !== 1) {
      throw new Error("ambiguous ancestry");
    }
    await this.assertInside(file.parentIds[0] as string, context);
  }
}

const assertFileId = (fileId: string): void => {
  if (typeof fileId !== "string" || fileId.length === 0 || fileId.length > MAX_FILE_ID_LENGTH) {
    throw new Error("invalid file ID");
  }
};
