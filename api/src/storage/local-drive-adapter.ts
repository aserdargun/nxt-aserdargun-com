import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, realpath, rename, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assertStorageVersion, StorageVersionConflictError, type StorageOperationContext, type StoragePort, type StoredFile } from "./storage-port.js";
import {
  TRASH_TRANSACTION_SCHEMA_VERSION,
  isTrashTransactionState,
  planTrashRecovery,
  transitionTrashTransaction,
  type LegacyTrashJournal,
  type TrashContentDescriptor,
  type TrashTransaction,
  type TrashTransactionState
} from "./trash-transaction.js";

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const MAX_FILE_ID_LENGTH = 512;
const MAX_NAME_LENGTH = 255;
const MAX_PAGE_SIZE = 1000;
const GENERATED_ID = /^file_[0-9a-z]+$/;

type LocalFile = StoredFile & { kind: "root" | "folder" | "file"; contentRevision?: string };
type LocalRevision = { id: string; modifiedTime: string };
type LocalMetadata = {
  schemaVersion: 1;
  sequence: number;
  generation: number;
  files: Record<string, LocalFile>;
  revisions: Record<string, LocalRevision[]>;
};
type PageCursor = { parentId: string; offset: number; fingerprint: string };
type LoadedTrashJournal =
  | { format: "legacy"; journal: LegacyTrashJournal<LocalMetadata> }
  | { format: "current"; journal: TrashTransaction<LocalMetadata> };

export type LocalDriveAdapterOptions = {
  beforeMetadataWrite?: () => void | Promise<void>;
  beforeMetadataRollbackWrite?: () => void | Promise<void>;
  beforeMutationLoad?: () => void | Promise<void>;
  beforeLockRelease?: () => void | Promise<void>;
  afterLockOwnershipCheck?: () => void | Promise<void>;
  onLockExists?: () => void | Promise<void>;
  beforeJournalOpen?: () => void | Promise<void>;
  lockTimeoutMs?: number;
};

export class LocalDriveAdapter implements StoragePort {
  private operation = Promise.resolve();

  private constructor(
    private readonly root: string,
    private readonly beforeMetadataWrite?: () => void | Promise<void>,
    private readonly beforeMetadataRollbackWrite?: () => void | Promise<void>,
    private readonly beforeMutationLoad?: () => void | Promise<void>,
    private readonly beforeLockRelease?: () => void | Promise<void>,
    private readonly afterLockOwnershipCheck?: () => void | Promise<void>,
    private readonly onLockExists?: () => void | Promise<void>,
    private readonly beforeJournalOpen?: () => void | Promise<void>,
    private readonly lockTimeoutMs?: number
  ) {}

  public static async create(root: string, options: LocalDriveAdapterOptions = {}): Promise<LocalDriveAdapter> {
    assertLockTimeout(options.lockTimeoutMs);
    const safeRoot = await canonicalizeTemporaryPath(root);
    await ensureDirectory(safeRoot);
    const adapter = new LocalDriveAdapter(
      await realpath(safeRoot),
      options.beforeMetadataWrite,
      options.beforeMetadataRollbackWrite,
      options.beforeMutationLoad,
      options.beforeLockRelease,
      options.afterLockOwnershipCheck,
      options.onLockExists,
      options.beforeJournalOpen,
      options.lockTimeoutMs
    );
    await adapter.initialize();
    return adapter;
  }

  public get(fileId: string, context?: StorageOperationContext): Promise<StoredFile> {
    context?.operationBudget?.consume();
    return this.read((metadata) => this.toStoredFile(this.getFile(metadata, fileId)));
  }

  public listChildren(input: { parentId: string; pageToken?: string; pageSize: number }, context?: StorageOperationContext): Promise<{ files: StoredFile[]; nextPageToken?: string }> {
    context?.operationBudget?.consume();
    return this.read((metadata) => {
      assertPageSize(input.pageSize);
      const parent = this.getActiveFolder(metadata, input.parentId);
      const cursor = input.pageToken === undefined ? undefined : decodeCursor(input.pageToken);
      const children = Object.values(metadata.files)
        .filter((file) => !file.trashed && file.parentIds.length === 1 && file.parentIds[0] === parent.id)
        .sort(compareFiles);
      const fingerprint = createHash("sha256").update(children.map((file) => `${file.id}\0${file.name}\0${file.version}`).join("\n")).digest("base64url");
      if (cursor !== undefined && (cursor.parentId !== parent.id || cursor.fingerprint !== fingerprint)) {
        throw new Error("stale page token");
      }
      const offset = cursor?.offset ?? 0;
      const files = children
        .slice(offset, offset + input.pageSize)
        .map((file) => this.toStoredFile(file));
      const total = children.length;
      const nextOffset = offset + files.length;
      if (nextOffset >= total) {
        return { files };
      }
      return { files, nextPageToken: encodeCursor({ parentId: parent.id, offset: nextOffset, fingerprint }) };
    });
  }

  public readText(fileId: string, context?: StorageOperationContext): Promise<{ file: StoredFile; text: string; checksum: string }> {
    context?.operationBudget?.consume();
    return this.read(async (metadata) => {
      const file = this.getActiveContentFile(metadata, fileId);
      const bytes = await this.readRevision(file.id, this.getContentRevision(file));
      return { file: this.toStoredFile(file), text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), checksum: checksum(bytes) };
    });
  }

  public readBytes(fileId: string, context?: StorageOperationContext): Promise<{ file: StoredFile; bytes: Uint8Array; checksum: string }> {
    context?.operationBudget?.consume();
    return this.read(async (metadata) => {
      const file = this.getActiveContentFile(metadata, fileId);
      const bytes = await this.readRevision(file.id, this.getContentRevision(file));
      return { file: this.toStoredFile(file), bytes, checksum: checksum(bytes) };
    });
  }

  public createFolder(input: { parentId: string; name: string; appProperties?: Record<string, string> }, context?: StorageOperationContext): Promise<StoredFile> {
    context?.operationBudget?.consume();
    return this.mutate(async (metadata) => {
      assertName(input.name);
      assertAppProperties(input.appProperties);
      this.getActiveFolder(metadata, input.parentId);
      const file = this.newFile(metadata, input.parentId, input.name, FOLDER_MIME_TYPE, "folder", 0);
      if (input.appProperties !== undefined) file.appProperties = { ...input.appProperties };
      await this.saveMetadata(metadata);
      return this.toStoredFile(file);
    });
  }

  public createText(input: { parentId: string; name: string; mimeType: string; text: string }, context?: StorageOperationContext): Promise<StoredFile> {
    return this.createBytes({ ...input, bytes: new TextEncoder().encode(input.text) }, context);
  }

  public createBytes(input: { parentId: string; name: string; mimeType: string; bytes: Uint8Array; appProperties?: Record<string, string> }, context?: StorageOperationContext): Promise<StoredFile> {
    context?.operationBudget?.consume();
    return this.mutate(async (metadata) => {
      assertName(input.name);
      assertMimeType(input.mimeType);
      assertAppProperties(input.appProperties);
      this.getActiveFolder(metadata, input.parentId);
      await this.reconcileUncommittedCreate(metadata, this.nextFileId(metadata));
      const file = this.newFile(metadata, input.parentId, input.name, input.mimeType, "file", input.bytes.byteLength);
      if (input.appProperties !== undefined) file.appProperties = { ...input.appProperties };
      await this.writeRevision(metadata, file.id, file.version, input.bytes);
      await this.saveMetadata(metadata);
      await this.writeContent(file.id, input.bytes).catch(() => undefined);
      return this.toStoredFile(file);
    });
  }

  public async updateText(input: { fileId: string; expectedVersion: string; mimeType: string; text: string }, context?: StorageOperationContext): Promise<StoredFile> {
    assertStorageVersion(input.expectedVersion);
    context?.operationBudget?.consume();
    return this.mutate(async (metadata) => {
      assertMimeType(input.mimeType);
      const file = this.getActiveContentFile(metadata, input.fileId);
      if (file.version !== input.expectedVersion) {
        throw new StorageVersionConflictError();
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

  public async move(input: { fileId: string; fromParentId: string; toParentId: string; expectedVersion: string; newName?: string }, context?: StorageOperationContext): Promise<StoredFile> {
    assertStorageVersion(input.expectedVersion);
    context?.operationBudget?.consume();
    return this.mutate(async (metadata) => {
      if (input.newName !== undefined) {
        assertName(input.newName);
      }
      const file = this.getActiveFile(metadata, input.fileId);
      if (file.version !== input.expectedVersion) {
        throw new StorageVersionConflictError();
      }
      if (file.kind === "root") {
        throw new Error("cannot move configured root");
      }
      if (file.parentIds.length !== 1 || file.parentIds[0] !== input.fromParentId) {
        throw new Error("from parent does not match file parent");
      }
      if (input.fromParentId === input.toParentId && input.newName === undefined) {
        throw new Error("same-parent move requires a rename");
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

  public trash(input: { fileId: string; expectedVersion: string }, context?: StorageOperationContext): Promise<StoredFile> {
    assertOpaqueFileId(input.fileId);
    assertStorageVersion(input.expectedVersion);
    context?.operationBudget?.consume();
    return this.mutate(async (metadata) => {
      const file = this.getActiveFile(metadata, input.fileId);
      if (file.version !== input.expectedVersion) throw new StorageVersionConflictError();
      if (file.kind === "root") {
        throw new Error("cannot trash configured root");
      }
      const originalMetadata = cloneMetadata(metadata);
      const authoritativeBytes = file.kind === "file" ? await this.readRevision(file.id, this.getContentRevision(file)) : undefined;
      const expectedContent = authoritativeBytes === undefined ? undefined : contentDescriptor(authoritativeBytes);
      let transaction: TrashTransaction<LocalMetadata> =
        file.kind === "file"
          ? {
              schemaVersion: TRASH_TRANSACTION_SCHEMA_VERSION,
              operation: "trash",
              itemKind: "file",
              state: "prepared",
              fileId: file.id,
              originalMetadata,
              content: expectedContent as TrashContentDescriptor
            }
          : {
              schemaVersion: TRASH_TRANSACTION_SCHEMA_VERSION,
              operation: "trash",
              itemKind: "folder",
              state: "prepared",
              fileId: file.id,
              originalMetadata
            };
      await this.saveTrashTransaction(transaction);
      try {
        this.bumpFile(metadata, file, { trashed: true });
        await this.saveMetadata(metadata, "normal");
        transaction = await this.advanceTrashTransaction(transaction, "metadata-staged");
        if (transaction.itemKind === "file") {
          await this.writeVerifiedTrashArtifact(transaction.fileId, authoritativeBytes as Uint8Array, transaction.content);
        }
        if (!(await this.isSuccessfulTrash(transaction, metadata))) {
          throw new Error("Trash transaction could not be verified");
        }
        transaction = await this.advanceTrashTransaction(transaction, "artifact-verified");
      } catch (error) {
        await this.rollbackTrashTransaction(transaction, "rollback");
        throw error;
      }
      if (transaction.itemKind === "file") {
        await this.archiveActiveCache(this.contentPath(file.id), file.id).catch(() => undefined);
      }
      transaction = await this.advanceTrashTransaction(transaction, "finalized");
      await this.archiveTrashTransaction(transaction.fileId, false);
      return this.toStoredFile(file);
    });
  }

  public listRevisions(fileId: string, context?: StorageOperationContext): Promise<Array<{ id: string; modifiedTime: string }>> {
    context?.operationBudget?.consume();
    return this.read((metadata) => {
      this.getFile(metadata, fileId);
      return [...(metadata.revisions[fileId] ?? [])];
    });
  }

  private async initialize(): Promise<void> {
    await this.withRootLock(async () => {
      await ensureDirectory(this.root);
      await ensureDirectory(this.contentDirectory());
      await ensureDirectory(this.revisionsDirectory());
      await ensureDirectory(this.trashDirectory());
      try {
        await lstat(this.metadataPath());
      } catch (error) {
        if (isNotFound(error)) {
          if (await this.hasTrashRollbackJournal()) {
            throw new Error("pending Trash journal without metadata", { cause: error });
          }
          await this.saveMetadata(initialMetadata(), "normal");
          return;
        }
        throw error;
      }
      const metadataStat = await lstat(this.metadataPath());
      if (metadataStat.isSymbolicLink() || !metadataStat.isFile()) {
        throw new Error("unsafe metadata path");
      }
      await this.loadMetadata();
      await this.recoverTrashTransaction();
    });
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private read<T>(operation: (metadata: LocalMetadata) => Promise<T> | T): Promise<T> {
    return this.run(() =>
      this.withRootLock(async () => {
        await this.recoverTrashTransaction();
        return operation(await this.loadMetadata());
      })
    );
  }

  private mutate<T>(operation: (metadata: LocalMetadata) => Promise<T> | T): Promise<T> {
    return this.run(() =>
      this.withRootLock(async () => {
        await this.beforeMutationLoad?.();
        await this.recoverTrashTransaction();
        return operation(await this.loadMetadata());
      })
    );
  }

  private async withRootLock<T>(operation: () => Promise<T>): Promise<T> {
    const lock = await acquireRootLock(this.root, this.lockTimeoutMs, this.onLockExists);
    try {
      return await operation();
    } finally {
      await this.beforeLockRelease?.();
      await releaseRootLock(lock, this.afterLockOwnershipCheck);
    }
  }

  private async loadMetadata(): Promise<LocalMetadata> {
    await ensureDirectory(this.root);
    const metadataStat = await lstat(this.metadataPath());
    if (metadataStat.isSymbolicLink() || !metadataStat.isFile()) {
      throw new Error("unsafe metadata path");
    }
    const parsed: unknown = JSON.parse(await readFile(this.metadataPath(), "utf8"));
    return assertMetadata(parsed);
  }

  private async saveMetadata(metadata: LocalMetadata, mode: "normal" | "rollback" | "recovery" = "normal"): Promise<void> {
    if (mode === "normal") {
      await this.beforeMetadataWrite?.();
    }
    if (mode === "rollback") {
      await this.beforeMetadataRollbackWrite?.();
    }
    await this.atomicWrite(this.metadataPath(), new TextEncoder().encode(`${JSON.stringify(metadata, null, 2)}\n`));
  }

  private newFile(metadata: LocalMetadata, parentId: string, name: string, mimeType: string, kind: "folder" | "file", size: number): LocalFile {
    const id = this.nextFileId(metadata);
    if (metadata.files[id] !== undefined) {
      throw new Error("duplicate deterministic file ID");
    }
    const modifiedTime = nextTime(metadata);
    const file: LocalFile = {
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

  private nextFileId(metadata: LocalMetadata): string {
    return `file_${(metadata.sequence + 1).toString(36)}`;
  }

  private bumpFile(metadata: LocalMetadata, file: LocalFile, changes: Partial<Pick<LocalFile, "name" | "mimeType" | "parentIds" | "size" | "trashed">>): void {
    Object.assign(file, changes);
    file.version = (BigInt(file.version) + 1n).toString();
    file.modifiedTime = nextTime(metadata);
    metadata.generation += 1;
  }

  private getFile(metadata: LocalMetadata, fileId: string): LocalFile {
    assertOpaqueFileId(fileId);
    const file = metadata.files[fileId];
    if (file === undefined) {
      throw new Error("file not found");
    }
    return file;
  }

  private getActiveFile(metadata: LocalMetadata, fileId: string): LocalFile {
    const file = this.getFile(metadata, fileId);
    if (file.trashed) {
      throw new Error("file is trashed");
    }
    return file;
  }

  private getActiveFolder(metadata: LocalMetadata, fileId: string): LocalFile {
    const file = this.getActiveFile(metadata, fileId);
    if (file.kind !== "root" && file.kind !== "folder") {
      throw new Error("parent is not a folder");
    }
    return file;
  }

  private getActiveContentFile(metadata: LocalMetadata, fileId: string): LocalFile {
    const file = this.getActiveFile(metadata, fileId);
    if (file.kind !== "file") {
      throw new Error("file has no content");
    }
    return file;
  }

  private getContentRevision(file: LocalFile): string {
    if (file.contentRevision === undefined) {
      throw new Error("content file is missing its revision");
    }
    return file.contentRevision;
  }

  private assertMoveDoesNotCycle(metadata: LocalMetadata, fileId: string, destinationId: string): void {
    let currentId = destinationId;
    const visited = new Set<string>();
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
      currentId = current.parentIds[0] as string;
    }
    throw new Error("ancestry limit exceeded");
  }

  private async writeContent(fileId: string, bytes: Uint8Array): Promise<void> {
    await this.atomicWrite(this.contentPath(fileId), bytes);
  }

  private async reconcileUncommittedCreate(metadata: LocalMetadata, fileId: string): Promise<void> {
    if (metadata.files[fileId] !== undefined) {
      return;
    }
    const revisionDirectory = join(this.revisionsDirectory(), fileId);
    try {
      const revisionStat = await lstat(revisionDirectory);
      if (revisionStat.isSymbolicLink() || !revisionStat.isDirectory()) {
        throw new Error("unsafe orphan revision path");
      }
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw error;
    }

    const archiveDirectory = join(this.root, ".orphaned-revisions");
    await ensureDirectory(archiveDirectory);
    let archiveIndex = 1;
    for (;;) {
      const archivePath = join(archiveDirectory, `${fileId}-${archiveIndex}`);
      try {
        await lstat(archivePath);
        archiveIndex += 1;
      } catch (error) {
        if (!isNotFound(error)) {
          throw error;
        }
        await rename(revisionDirectory, archivePath);
        return;
      }
    }
  }

  private async recoverTrashTransaction(): Promise<void> {
    const loaded = await this.loadTrashJournal();
    if (loaded === undefined) {
      return;
    }
    if (loaded.format === "legacy") {
      await this.assertRestorableOriginalMetadata(loaded.journal);
      await this.saveMetadata(loaded.journal.originalMetadata, "recovery");
      await this.archiveTrashTransaction(loaded.journal.fileId, true);
      return;
    }

    let transaction = loaded.journal;
    const recoveryPlan =
      transaction.state === "rolled-back"
        ? planTrashRecovery(transaction.state, false)
        : planTrashRecovery(transaction.state, await this.isSuccessfulTrash(transaction, await this.loadMetadata()));
    if (recoveryPlan.outcome === "restore") {
      await this.assertRestorableOriginalMetadata(transaction);
      await this.saveMetadata(transaction.originalMetadata, "recovery");
      await this.archiveTrashTransaction(transaction.fileId, true);
      return;
    }
    if (recoveryPlan.outcome === "rollback") {
      await this.rollbackTrashTransaction(transaction, "recovery");
      return;
    }
    for (const nextState of recoveryPlan.transitions) {
      transaction = await this.advanceTrashTransaction(transaction, nextState);
    }
    await this.archiveTrashTransaction(transaction.fileId, false);
  }

  private async saveTrashTransaction(transaction: TrashTransaction<LocalMetadata>): Promise<void> {
    await this.preserveCurrentTrashJournalState();
    await this.atomicWrite(this.trashRollbackJournalPath(), new TextEncoder().encode(`${JSON.stringify(transaction, null, 2)}\n`));
  }

  private async preserveCurrentTrashJournalState(): Promise<void> {
    const journalPath = this.trashRollbackJournalPath();
    try {
      const stat = await lstat(journalPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error("unsafe Trash rollback journal path");
      }
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw error;
    }
    const historyRoot = join(this.root, ".transaction-state-history");
    await ensureDirectory(historyRoot);
    for (let index = 1; ; index += 1) {
      const container = join(historyRoot, `state-${index}`);
      try {
        await mkdir(container, { mode: 0o700 });
      } catch (error) {
        if (isAlreadyExists(error)) {
          continue;
        }
        throw error;
      }
      await link(journalPath, join(container, "journal.json"));
      return;
    }
  }

  private async advanceTrashTransaction(
    transaction: TrashTransaction<LocalMetadata>,
    nextState: TrashTransactionState
  ): Promise<TrashTransaction<LocalMetadata>> {
    const advanced = transitionTrashTransaction(transaction, nextState);
    await this.saveTrashTransaction(advanced);
    return advanced;
  }

  private async rollbackTrashTransaction(
    transaction: TrashTransaction<LocalMetadata>,
    mode: "rollback" | "recovery"
  ): Promise<void> {
    await this.assertRestorableOriginalMetadata(transaction);
    await this.saveMetadata(transaction.originalMetadata, mode);
    const rolledBack = await this.advanceTrashTransaction(transaction, "rolled-back");
    await this.archiveTrashTransaction(rolledBack.fileId, true);
  }

  private async assertRestorableOriginalMetadata(
    journal: LegacyTrashJournal<LocalMetadata> | TrashTransaction<LocalMetadata>
  ): Promise<void> {
    const originalFile = journal.originalMetadata.files[journal.fileId];
    if (originalFile === undefined || originalFile.trashed || originalFile.kind === "root") {
      throw new Error("invalid Trash rollback journal");
    }
    if (originalFile.kind === "file") {
      await this.readRevision(originalFile.id, this.getContentRevision(originalFile));
    }
  }

  private async isSuccessfulTrash(transaction: TrashTransaction<LocalMetadata>, metadata: LocalMetadata): Promise<boolean> {
    const expectedMetadata = cloneMetadata(transaction.originalMetadata);
    const expectedFile = expectedMetadata.files[transaction.fileId];
    if (expectedFile === undefined || expectedFile.kind !== transaction.itemKind || expectedFile.trashed) {
      return false;
    }
    this.bumpFile(expectedMetadata, expectedFile, { trashed: true });
    if (!isDeepStrictEqual(metadata, expectedMetadata)) {
      return false;
    }
    const currentFile = metadata.files[transaction.fileId];
    if (currentFile === undefined || !currentFile.trashed || currentFile.kind !== transaction.itemKind) {
      return false;
    }
    if (transaction.itemKind === "folder") {
      return true;
    }
    let revisionBytes: Uint8Array;
    try {
      revisionBytes = await this.readRevision(currentFile.id, this.getContentRevision(currentFile));
    } catch {
      return false;
    }
    if (!sameContentDescriptor(contentDescriptor(revisionBytes), transaction.content)) {
      return false;
    }
    try {
      return await matchesContentDescriptor(this.trashContentPath(transaction.fileId), transaction.content);
    } catch {
      return false;
    }
  }

  private async loadTrashJournal(): Promise<LoadedTrashJournal | undefined> {
    const path = this.trashRollbackJournalPath();
    let text: string | undefined;
    try {
      await this.beforeJournalOpen?.();
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const journalStat = await handle.stat();
        if (!journalStat.isFile()) {
          throw new Error("unsafe Trash rollback journal path");
        }
        text = await handle.readFile({ encoding: "utf8" });
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      if (isNoFollowViolation(error)) {
        throw new Error("unsafe Trash rollback journal path", { cause: error });
      }
      throw error;
    }
    if (text === undefined) {
      throw new Error("invalid Trash rollback journal");
    }
    return parseTrashJournal(JSON.parse(text));
  }

  private async archiveTrashTransaction(fileId: string, archiveArtifact: boolean): Promise<void> {
    assertOpaqueFileId(fileId);
    const journalPath = this.trashRollbackJournalPath();
    try {
      const journalStat = await lstat(journalPath);
      if (journalStat.isSymbolicLink() || !journalStat.isFile()) {
        throw new Error("unsafe Trash rollback journal path");
      }
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw error;
    }
    const archiveDirectory = join(this.root, ".transaction-history");
    await ensureDirectory(archiveDirectory);
    let archiveIndex = 1;
    for (;;) {
      const archivePath = join(archiveDirectory, `trash-${archiveIndex}`);
      try {
        await mkdir(archivePath, { mode: 0o700 });
      } catch (error) {
        if (isAlreadyExists(error)) {
          archiveIndex += 1;
          continue;
        }
        throw error;
      }
      if (archiveArtifact) {
        await ensureDirectory(this.trashDirectory());
        try {
          await rename(this.trashContentPath(fileId), join(archivePath, "artifact"));
        } catch (error) {
          if (!isNotFound(error)) {
            throw error;
          }
        }
      }
      await rename(journalPath, join(archivePath, "journal.json"));
      return;
    }
  }

  private async writeRevision(metadata: LocalMetadata, fileId: string, revisionId: string, bytes: Uint8Array): Promise<void> {
    const revisionDirectory = join(this.revisionsDirectory(), fileId);
    await ensureDirectory(revisionDirectory);
    const revisionPath = join(revisionDirectory, revisionId);
    try {
      await writeFile(revisionPath, bytes, { flag: "wx" });
    } catch (error) {
      if (!isLockCollision(error)) {
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

  private async writeVerifiedTrashArtifact(fileId: string, authoritativeBytes: Uint8Array, expected: TrashContentDescriptor): Promise<void> {
    const destination = this.trashContentPath(fileId);
    await ensureDirectory(dirname(destination));
    try {
      const handle = await open(
        destination,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      try {
        await handle.writeFile(authoritativeBytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isAlreadyExists(error)) {
        if (await matchesContentDescriptor(destination, expected)) {
          return;
        }
        throw new Error("trash destination already exists", { cause: error });
      }
      throw error;
    }
    if (!(await matchesContentDescriptor(destination, expected))) {
      throw new Error("trash destination content verification failed");
    }
  }

  private async archiveActiveCache(source: string, fileId: string): Promise<void> {
    await ensureDirectory(dirname(source));
    try {
      await lstat(source);
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw error;
    }
    const archiveRoot = join(this.root, ".trashed-caches");
    await ensureDirectory(archiveRoot);
    for (let index = 1; ; index += 1) {
      const container = join(archiveRoot, `${fileId}-${index}`);
      try {
        await mkdir(container, { mode: 0o700 });
      } catch (error) {
        if (isAlreadyExists(error)) {
          continue;
        }
        throw error;
      }
      try {
        await rename(source, join(container, "content"));
        return;
      } catch (error) {
        if (isNotFound(error)) {
          return;
        }
        throw error;
      }
    }
  }

  private async readRevision(fileId: string, revisionId: string): Promise<Uint8Array> {
    const revisionDirectory = join(this.revisionsDirectory(), fileId);
    await ensureDirectory(revisionDirectory);
    const revisionPath = join(revisionDirectory, revisionId);
    try {
      const handle = await open(revisionPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const revisionStat = await handle.stat();
        if (!revisionStat.isFile()) {
          throw new Error("unsafe revision path");
        }
        return await handle.readFile();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isNoFollowViolation(error)) {
        throw new Error("unsafe revision path", { cause: error });
      }
      throw error;
    }
  }

  private async atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
    await ensureDirectory(dirname(path));
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, bytes, { flag: "wx" });
    await rename(temporaryPath, path);
  }

  private async hasTrashRollbackJournal(): Promise<boolean> {
    try {
      const handle = await open(this.trashRollbackJournalPath(), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) {
          throw new Error("unsafe Trash rollback journal path");
        }
        return true;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isNotFound(error)) {
        return false;
      }
      if (isNoFollowViolation(error)) {
        throw new Error("unsafe Trash rollback journal path", { cause: error });
      }
      throw error;
    }
  }

  private contentDirectory(): string {
    return join(this.root, ".content");
  }

  private revisionsDirectory(): string {
    return join(this.root, ".revisions");
  }

  private trashDirectory(): string {
    return join(this.root, ".trash");
  }

  private trashContentPath(fileId: string): string {
    assertOpaqueFileId(fileId);
    return join(this.trashDirectory(), fileId);
  }

  private trashRollbackJournalPath(): string {
    return join(this.root, ".trash-rollback.json");
  }

  private metadataPath(): string {
    return join(this.root, ".metadata.json");
  }

  private contentPath(fileId: string): string {
    assertOpaqueFileId(fileId);
    return join(this.contentDirectory(), fileId);
  }

  private toStoredFile(file: LocalFile): StoredFile {
    return {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      parentIds: [...file.parentIds],
      version: file.version,
      modifiedTime: file.modifiedTime,
      size: file.size,
      trashed: file.trashed,
      ...(file.appProperties === undefined ? {} : { appProperties: { ...file.appProperties } })
    };
  }
}

const initialMetadata = (): LocalMetadata => ({
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

const rootFile = (id: "vault" | "private"): LocalFile => ({
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

const nextTime = (metadata: LocalMetadata): string => {
  metadata.sequence += 1;
  return new Date(metadata.sequence).toISOString();
};

const cloneMetadata = (metadata: LocalMetadata): LocalMetadata => JSON.parse(JSON.stringify(metadata)) as LocalMetadata;

const assertAppProperties = (value: Record<string, string> | undefined): void => {
  if (value === undefined) return;
  const entries = Object.entries(value);
  if (entries.length > 16 || entries.some(([key, item]) => !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(key) || typeof item !== "string" || item.length > 128 || /[\r\n\0]/u.test(item))) throw new Error("invalid app properties");
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const assertMetadata = (value: unknown): LocalMetadata => {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isNonNegativeInteger(value.sequence) || !isNonNegativeInteger(value.generation) || !isRecord(value.files) || !isRecord(value.revisions)) {
    throw new Error("invalid local metadata");
  }
  const files = value.files;
  const revisions = value.revisions;
  if (!isExactRoot(files.vault, "vault") || !isExactRoot(files.private, "private")) {
    throw new Error("invalid local metadata");
  }
  for (const [id, rawFile] of Object.entries(files)) {
    if (!isValidPersistedFile(rawFile, id)) {
      throw new Error("invalid local metadata");
    }
    const file = rawFile;
    if (file.kind === "root") {
      if ((file.id !== "vault" && file.id !== "private") || file.parentIds.length !== 0 || file.trashed || file.contentRevision !== undefined) {
        throw new Error("invalid local metadata");
      }
    } else {
      const parent = files[file.parentIds[0] as string];
      if (parent === undefined || !isRecord(parent) || (parent.kind !== "root" && parent.kind !== "folder")) {
        throw new Error("invalid local metadata");
      }
    }
    const fileRevisions = revisions[id];
    if (!Array.isArray(fileRevisions) || !fileRevisions.every(isValidPersistedRevision)) {
      throw new Error("invalid local metadata");
    }
    if (file.kind === "file") {
      assertFileRevisionCoherence(file, fileRevisions);
    } else if (file.contentRevision !== undefined || fileRevisions.length !== 0) {
      throw new Error("invalid local metadata");
    }
  }
  if (Object.keys(revisions).some((id) => !Object.prototype.hasOwnProperty.call(files, id))) {
    throw new Error("invalid local metadata");
  }
  assertPersistedParentGraphs(files as Record<string, LocalFile>);
  return value as LocalMetadata;
};

const assertFileRevisionCoherence = (file: LocalFile, revisions: LocalRevision[]): void => {
  if (file.contentRevision === undefined || revisions.length === 0) {
    throw new Error("invalid local metadata");
  }
  const fileVersion = BigInt(file.version);
  let previousRevision = 0n;
  let activeRevisionCount = 0;
  for (const revision of revisions) {
    const revisionNumber = BigInt(revision.id);
    if (revisionNumber <= previousRevision || revisionNumber > fileVersion) {
      throw new Error("invalid local metadata");
    }
    previousRevision = revisionNumber;
    if (revision.id === file.contentRevision) {
      activeRevisionCount += 1;
    }
  }
  if (activeRevisionCount !== 1 || revisions.at(-1)?.id !== file.contentRevision || BigInt(file.contentRevision) > fileVersion) {
    throw new Error("invalid local metadata");
  }
};

const assertPersistedParentGraphs = (files: Record<string, LocalFile>): void => {
  for (const startId of Object.keys(files)) {
    let currentId = startId;
    const visited = new Set<string>();
    let terminatedAtRoot = false;
    for (let nodes = 0; nodes < 100; nodes += 1) {
      if (visited.has(currentId)) {
        throw new Error("invalid local metadata");
      }
      visited.add(currentId);
      const current = files[currentId];
      if (current === undefined) {
        throw new Error("invalid local metadata");
      }
      if (current.kind === "root") {
        if (current.id !== "vault" && current.id !== "private") {
          throw new Error("invalid local metadata");
        }
        terminatedAtRoot = true;
        break;
      }
      if (current.parentIds.length !== 1) {
        throw new Error("invalid local metadata");
      }
      currentId = current.parentIds[0] as string;
    }
    if (!terminatedAtRoot) {
      throw new Error("invalid local metadata");
    }
  }
};

const parseTrashJournal = (value: unknown): LoadedTrashJournal => {
  if (!isRecord(value) || typeof value.fileId !== "string" || value.originalMetadata === undefined) {
    throw new Error("invalid Trash rollback journal");
  }
  assertOpaqueFileId(value.fileId);
  const originalMetadata = assertMetadata(value.originalMetadata);
  const originalFile = originalMetadata.files[value.fileId];
  if (originalFile === undefined || originalFile.trashed || originalFile.kind === "root") {
    throw new Error("invalid Trash rollback journal");
  }

  if (value.schemaVersion === 1) {
    if (!hasOnlyKeys(value, ["schemaVersion", "fileId", "originalMetadata", "expectedContent"])) {
      throw new Error("invalid Trash rollback journal");
    }
    const expectedContent = value.expectedContent;
    if (expectedContent !== undefined && !isContentDescriptor(expectedContent)) {
      throw new Error("invalid Trash rollback journal");
    }
    if (originalFile.kind !== "file" && expectedContent !== undefined) {
      throw new Error("invalid Trash rollback journal");
    }
    return {
      format: "legacy",
      journal: {
        schemaVersion: 1,
        fileId: value.fileId,
        originalMetadata,
        ...(expectedContent === undefined ? {} : { expectedContent })
      }
    };
  }

  if (
    value.schemaVersion !== TRASH_TRANSACTION_SCHEMA_VERSION ||
    value.operation !== "trash" ||
    (value.itemKind !== "file" && value.itemKind !== "folder") ||
    !isTrashTransactionState(value.state) ||
    originalFile.kind !== value.itemKind
  ) {
    throw new Error("invalid Trash rollback journal");
  }
  if (value.itemKind === "file") {
    if (!hasOnlyKeys(value, ["schemaVersion", "operation", "itemKind", "state", "fileId", "originalMetadata", "content"]) || !isContentDescriptor(value.content)) {
      throw new Error("invalid Trash rollback journal");
    }
    return {
      format: "current",
      journal: {
        schemaVersion: TRASH_TRANSACTION_SCHEMA_VERSION,
        operation: "trash",
        itemKind: "file",
        state: value.state,
        fileId: value.fileId,
        originalMetadata,
        content: value.content
      }
    };
  }
  if (!hasOnlyKeys(value, ["schemaVersion", "operation", "itemKind", "state", "fileId", "originalMetadata"]) || value.content !== undefined) {
    throw new Error("invalid Trash rollback journal");
  }
  return {
    format: "current",
    journal: {
      schemaVersion: TRASH_TRANSACTION_SCHEMA_VERSION,
      operation: "trash",
      itemKind: "folder",
      state: value.state,
      fileId: value.fileId,
      originalMetadata
    }
  };
};

const hasOnlyKeys = (value: Record<string, unknown>, allowedKeys: readonly string[]): boolean => {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
};

const isNonNegativeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isContentDescriptor = (value: unknown): value is TrashContentDescriptor =>
  isRecord(value) &&
  Number.isSafeInteger(value.size) &&
  (value.size as number) >= 0 &&
  typeof value.checksum === "string" &&
  /^[a-f0-9]{64}$/u.test(value.checksum);

const isValidPersistedRevision = (value: unknown): value is LocalRevision => isRecord(value) && isPositiveDecimal(value.id) && isValidTimestamp(value.modifiedTime);

const isValidPersistedFile = (value: unknown, id: string): value is LocalFile => {
  if (!isRecord(value) || value.id !== id || !isSafeFileId(id) || !isSafeName(value.name) || !isSafeMimeType(value.mimeType) || !Array.isArray(value.parentIds) || !value.parentIds.every((parent) => typeof parent === "string" && isSafeFileId(parent)) || !isPositiveDecimal(value.version) || !isValidTimestamp(value.modifiedTime) || !isNonNegativeInteger(value.size) || typeof value.trashed !== "boolean" || !isValidAppProperties(value.appProperties) || (value.kind !== "root" && value.kind !== "folder" && value.kind !== "file")) {
    return false;
  }
  if (value.kind === "root") {
    return value.parentIds.length === 0;
  }
  return value.parentIds.length === 1 && (value.kind === "file" ? isPositiveDecimal(value.contentRevision) : value.contentRevision === undefined);
};

const isValidAppProperties = (value: unknown): boolean => {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  try { assertAppProperties(value as Record<string, string>); return true; } catch { return false; }
};

const isExactRoot = (value: unknown, id: "vault" | "private"): boolean => isRecord(value) && value.id === id && value.name === id && value.mimeType === FOLDER_MIME_TYPE && Array.isArray(value.parentIds) && value.parentIds.length === 0 && value.version === "1" && value.modifiedTime === "1970-01-01T00:00:00.000Z" && value.size === 0 && value.trashed === false && value.kind === "root" && value.contentRevision === undefined;

const isSafeFileId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_FILE_ID_LENGTH && (value === "vault" || value === "private" || GENERATED_ID.test(value));

const isSafeName = (value: unknown): value is string => typeof value === "string" && [...value.normalize("NFC")].length > 0 && [...value.normalize("NFC")].length <= MAX_NAME_LENGTH && value !== "." && value !== ".." && !/[\\/\0]/u.test(value);

const isSafeMimeType = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 255 && !/[\0\r\n]/u.test(value);

const isPositiveDecimal = (value: unknown): value is string => typeof value === "string" && /^(?:[1-9][0-9]*)$/u.test(value);

const isValidTimestamp = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value));

const assertOpaqueFileId = (fileId: string): void => {
  if (typeof fileId !== "string" || fileId.length === 0 || fileId.length > MAX_FILE_ID_LENGTH || (fileId !== "vault" && fileId !== "private" && !GENERATED_ID.test(fileId))) {
    throw new Error("invalid file ID");
  }
};

const assertName = (name: string): void => {
  if (typeof name !== "string" || [...name.normalize("NFC")].length === 0 || [...name.normalize("NFC")].length > MAX_NAME_LENGTH || name === "." || name === ".." || /[\\/\0]/u.test(name)) {
    throw new Error("invalid name");
  }
};

const assertMimeType = (mimeType: string): void => {
  if (typeof mimeType !== "string" || mimeType.length === 0 || mimeType.length > 255 || /[\0\r\n]/u.test(mimeType)) {
    throw new Error("invalid MIME type");
  }
};

const assertPageSize = (pageSize: number): void => {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new Error("invalid page size");
  }
};

const compareFiles = (left: LocalFile, right: LocalFile): number => left.name === right.name ? left.id.localeCompare(right.id, "en") : left.name.localeCompare(right.name, "en");

const checksum = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const contentDescriptor = (bytes: Uint8Array): { size: number; checksum: string } => ({ size: bytes.byteLength, checksum: checksum(bytes) });

const sameContentDescriptor = (left: TrashContentDescriptor, right: TrashContentDescriptor): boolean =>
  left.size === right.size && left.checksum === right.checksum;

const encodeCursor = (cursor: PageCursor): string => Buffer.from(JSON.stringify(cursor)).toString("base64url");

const decodeCursor = (token: string): PageCursor => {
  if (typeof token !== "string" || token.length === 0 || token.length > 4096 || !/^[A-Za-z0-9_-]+$/u.test(token)) {
    throw new Error("invalid page token");
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("invalid page token");
    }
    const cursor = value as Partial<PageCursor>;
    if (
      typeof cursor.parentId !== "string" ||
      !Number.isInteger(cursor.offset) ||
      (cursor.offset as number) < 0 ||
      typeof cursor.fingerprint !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(cursor.fingerprint)
    ) {
      throw new Error("invalid page token");
    }
    assertOpaqueFileId(cursor.parentId);
    return cursor as PageCursor;
  } catch (error) {
    if (error instanceof Error && error.message === "invalid file ID") {
      throw error;
    }
    throw new Error("invalid page token", { cause: error });
  }
};

const ensureDirectory = async (path: string): Promise<void> => {
  const absolutePath = resolve(path);
  const root = parse(absolutePath).root;
  let currentPath = root;
  await assertDirectory(currentPath);
  for (const component of relative(root, absolutePath).split(sep).filter(Boolean)) {
    currentPath = join(currentPath, component);
    try {
      await assertDirectory(currentPath);
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
      try {
        await mkdir(currentPath);
      } catch (mkdirError) {
        if (!isAlreadyExists(mkdirError)) {
          throw mkdirError;
        }
      }
      await assertDirectory(currentPath);
    }
  }
};

const canonicalizeTemporaryPath = async (path: string): Promise<string> => {
  const absolutePath = resolve(path);
  const logicalTemporaryRoot = resolve(tmpdir());
  const relativePath = relative(logicalTemporaryRoot, absolutePath);
  if (relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))) {
    return join(await realpath(logicalTemporaryRoot), relativePath);
  }
  return absolutePath;
};

const assertDirectory = async (path: string): Promise<void> => {
  const directoryStat = await lstat(path);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error("unsafe storage directory");
  }
};

const matchesContentDescriptor = async (path: string, expected: { size: number; checksum: string }): Promise<boolean> => {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const fileStat = await handle.stat();
      if (!fileStat.isFile() || fileStat.size !== expected.size) {
        return false;
      }
      return checksum(await handle.readFile()) === expected.checksum;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isNotFound(error) || isNoFollowViolation(error)) {
      return false;
    }
    throw error;
  }
};

const isNotFound = (error: unknown): error is NodeJS.ErrnoException => typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";

const isAlreadyExists = (error: unknown): error is NodeJS.ErrnoException => typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";

const isNoFollowViolation = (error: unknown): error is NodeJS.ErrnoException => typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ELOOP";

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);

const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 2_000;
const MIN_LOCK_TIMEOUT_MS = 1;
const MAX_LOCK_TIMEOUT_MS = 60_000;

type RootLock = { path: string; ownerPath: string; token: string };

const acquireRootLock = async (root: string, timeoutMs = LOCK_TIMEOUT_MS, onLockExists?: () => void | Promise<void>): Promise<RootLock> => {
  const path = join(root, ".mutation.lock");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await assertCanonicalStorageRoot(root);
    const token = randomUUID();
    const prepared = await prepareRootLock(root, token);
    try {
      await rename(prepared.path, path);
      return { path, ownerPath: join(path, prepared.ownerName), token };
    } catch (error) {
      if (!isLockCollision(error)) {
        await archiveDirectoryArtifact(prepared.path, root, token, "abandoned");
        throw error;
      }
      await archiveDirectoryArtifact(prepared.path, root, token, "contended");
      await onLockExists?.();
      try {
        await assertLockDirectory(path);
      } catch (lockError) {
        if (isNotFound(lockError)) {
          continue;
        }
        throw lockError;
      }
      try {
        await rmdir(path);
        continue;
      } catch (removeError) {
        if (isNotFound(removeError)) {
          continue;
        }
        if (!isDirectoryNotEmpty(removeError)) {
          throw removeError;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for storage mutation lock", { cause: error });
      }
      await delay(LOCK_WAIT_MS);
    }
  }
};

const releaseRootLock = async (lock: RootLock, afterOwnershipCheck?: () => void | Promise<void>): Promise<void> => {
  try {
    if ((await readLockOwnerToken(lock.ownerPath)) === lock.token) {
      await afterOwnershipCheck?.();
      await archiveLockOwner(lock);
      try {
        await rmdir(lock.path);
      } catch (removeError) {
        if (!isNotFound(removeError) && !isDirectoryNotEmpty(removeError)) {
          throw removeError;
        }
      }
    }
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
};

const assertLockDirectory = async (path: string): Promise<void> => {
  const lockStat = await lstat(path);
  if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) {
    throw new Error("unsafe storage mutation lock");
  }
};

const assertCanonicalStorageRoot = async (root: string): Promise<void> => {
  await ensureDirectory(root);
  if ((await realpath(root)) !== root) {
    throw new Error("unsafe storage directory");
  }
};

const prepareRootLock = async (root: string, token: string): Promise<{ path: string; ownerName: string }> => {
  const stagingRoot = join(root, ".lock-staging");
  await ensureDirectory(stagingRoot);
  const path = join(stagingRoot, `${token}.lock`);
  await mkdir(path, { mode: 0o700 });
  const ownerName = `owner-${token}.json`;
  await writeFile(join(path, ownerName), JSON.stringify({ token, createdAt: Date.now() }), { flag: "wx", mode: 0o600 });
  return { path, ownerName };
};

const readLockOwnerToken = async (path: string): Promise<string | undefined> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error("unsafe storage mutation lock");
    }
    const value: unknown = JSON.parse(await handle.readFile({ encoding: "utf8" }));
    return isRecord(value) && typeof value.token === "string" ? value.token : undefined;
  } finally {
    await handle.close();
  }
};

const archiveLockOwner = async (lock: RootLock): Promise<void> => {
  const archiveDirectory = join(dirname(lock.path), ".lock-history");
  await ensureDirectory(archiveDirectory);
  for (let archiveIndex = 1; ; archiveIndex += 1) {
    const container = join(archiveDirectory, `${lock.token}-${archiveIndex}.lock`);
    try {
      await mkdir(container, { mode: 0o700 });
    } catch (error) {
      if (isAlreadyExists(error)) {
        continue;
      }
      throw error;
    }
    try {
      await rename(lock.ownerPath, join(container, "owner.json"));
      return;
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw error;
    }
  }
};

const archiveDirectoryArtifact = async (source: string, root: string, token: string, kind: string): Promise<void> => {
  const archiveDirectory = join(root, ".lock-history");
  await ensureDirectory(archiveDirectory);
  for (let index = 1; ; index += 1) {
    const container = join(archiveDirectory, `${token}-${kind}-${index}.lock`);
    try {
      await mkdir(container, { mode: 0o700 });
    } catch (error) {
      if (isAlreadyExists(error)) {
        continue;
      }
      throw error;
    }
    try {
      await rename(source, join(container, "lock"));
      return;
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw error;
    }
  }
};

const assertLockTimeout = (timeoutMs: number | undefined): void => {
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs < MIN_LOCK_TIMEOUT_MS || timeoutMs > MAX_LOCK_TIMEOUT_MS)) {
    throw new Error("invalid lock timeout");
  }
};

const isDirectoryNotEmpty = (error: unknown): error is NodeJS.ErrnoException => typeof error === "object" && error !== null && "code" in error && ((error as NodeJS.ErrnoException).code === "ENOTEMPTY" || (error as NodeJS.ErrnoException).code === "EEXIST");

const isLockCollision = (error: unknown): error is NodeJS.ErrnoException => isAlreadyExists(error) || isDirectoryNotEmpty(error);

const delay = async (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
