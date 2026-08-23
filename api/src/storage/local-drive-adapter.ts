import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { StoragePort, StoredFile } from "./storage-port.js";

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
type PageCursor = { parentId: string; offset: number; generation: number };

export type LocalDriveAdapterOptions = {
  beforeMetadataWrite?: () => void | Promise<void>;
};

export class LocalDriveAdapter implements StoragePort {
  private operation = Promise.resolve();

  private constructor(
    private readonly root: string,
    private readonly beforeMetadataWrite?: () => void | Promise<void>
  ) {}

  public static async create(root: string, options: LocalDriveAdapterOptions = {}): Promise<LocalDriveAdapter> {
    const safeRoot = await canonicalizeTemporaryPath(root);
    await ensureDirectory(safeRoot);
    const adapter = new LocalDriveAdapter(await realpath(safeRoot), options.beforeMetadataWrite);
    await adapter.initialize();
    return adapter;
  }

  public get(fileId: string): Promise<StoredFile> {
    return this.run(async () => this.toStoredFile(this.getFile(await this.loadMetadata(), fileId)));
  }

  public listChildren(input: { parentId: string; pageToken?: string; pageSize: number }): Promise<{ files: StoredFile[]; nextPageToken?: string }> {
    return this.run(async () => {
      assertPageSize(input.pageSize);
      const metadata = await this.loadMetadata();
      const parent = this.getActiveFolder(metadata, input.parentId);
      const cursor = input.pageToken === undefined ? undefined : decodeCursor(input.pageToken);
      if (cursor !== undefined && (cursor.parentId !== parent.id || cursor.generation !== metadata.generation)) {
        throw new Error("stale page token");
      }
      const offset = cursor?.offset ?? 0;
      const files = Object.values(metadata.files)
        .filter((file) => !file.trashed && file.parentIds.length === 1 && file.parentIds[0] === parent.id)
        .sort(compareFiles)
        .slice(offset, offset + input.pageSize)
        .map((file) => this.toStoredFile(file));
      const total = Object.values(metadata.files).filter(
        (file) => !file.trashed && file.parentIds.length === 1 && file.parentIds[0] === parent.id
      ).length;
      const nextOffset = offset + files.length;
      if (nextOffset >= total) {
        return { files };
      }
      return { files, nextPageToken: encodeCursor({ parentId: parent.id, offset: nextOffset, generation: metadata.generation }) };
    });
  }

  public readText(fileId: string): Promise<{ file: StoredFile; text: string; checksum: string }> {
    return this.run(async () => {
      const metadata = await this.loadMetadata();
      const file = this.getActiveContentFile(metadata, fileId);
      const bytes = await this.readRevision(file.id, this.getContentRevision(file));
      return { file: this.toStoredFile(file), text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), checksum: checksum(bytes) };
    });
  }

  public readBytes(fileId: string): Promise<{ file: StoredFile; bytes: Uint8Array; checksum: string }> {
    return this.run(async () => {
      const metadata = await this.loadMetadata();
      const file = this.getActiveContentFile(metadata, fileId);
      const bytes = await this.readRevision(file.id, this.getContentRevision(file));
      return { file: this.toStoredFile(file), bytes, checksum: checksum(bytes) };
    });
  }

  public createFolder(input: { parentId: string; name: string }): Promise<StoredFile> {
    return this.run(async () => {
      assertName(input.name);
      const metadata = await this.loadMetadata();
      this.getActiveFolder(metadata, input.parentId);
      const file = this.newFile(metadata, input.parentId, input.name, FOLDER_MIME_TYPE, "folder", 0);
      await this.saveMetadata(metadata);
      return this.toStoredFile(file);
    });
  }

  public createText(input: { parentId: string; name: string; mimeType: string; text: string }): Promise<StoredFile> {
    return this.createBytes({ ...input, bytes: new TextEncoder().encode(input.text) });
  }

  public createBytes(input: { parentId: string; name: string; mimeType: string; bytes: Uint8Array }): Promise<StoredFile> {
    return this.run(async () => {
      assertName(input.name);
      assertMimeType(input.mimeType);
      const metadata = await this.loadMetadata();
      this.getActiveFolder(metadata, input.parentId);
      await this.reconcileUncommittedCreate(metadata, this.nextFileId(metadata));
      const file = this.newFile(metadata, input.parentId, input.name, input.mimeType, "file", input.bytes.byteLength);
      await this.writeRevision(metadata, file.id, file.version, input.bytes);
      await this.saveMetadata(metadata);
      await this.writeContent(file.id, input.bytes).catch(() => undefined);
      return this.toStoredFile(file);
    });
  }

  public updateText(input: { fileId: string; expectedVersion: string; mimeType: string; text: string }): Promise<StoredFile> {
    return this.run(async () => {
      assertMimeType(input.mimeType);
      const metadata = await this.loadMetadata();
      const file = this.getActiveContentFile(metadata, input.fileId);
      if (file.version !== input.expectedVersion) {
        throw new Error("version conflict");
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

  public move(input: { fileId: string; fromParentId: string; toParentId: string; newName?: string }): Promise<StoredFile> {
    return this.run(async () => {
      if (input.newName !== undefined) {
        assertName(input.newName);
      }
      const metadata = await this.loadMetadata();
      const file = this.getActiveFile(metadata, input.fileId);
      if (file.kind === "root") {
        throw new Error("cannot move configured root");
      }
      if (file.parentIds.length !== 1 || file.parentIds[0] !== input.fromParentId) {
        throw new Error("from parent does not match file parent");
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

  public trash(fileId: string): Promise<StoredFile> {
    return this.run(async () => {
      const metadata = await this.loadMetadata();
      const file = this.getActiveFile(metadata, fileId);
      if (file.kind === "root") {
        throw new Error("cannot trash configured root");
      }
      const originalMetadata = cloneMetadata(metadata);
      this.bumpFile(metadata, file, { trashed: true });
      await this.saveMetadata(metadata);
      try {
        if (file.kind === "file") {
          await this.moveContentToTrash(file.id);
        }
      } catch (error) {
        await this.saveMetadata(originalMetadata, false);
        throw error;
      }
      return this.toStoredFile(file);
    });
  }

  public listRevisions(fileId: string): Promise<Array<{ id: string; modifiedTime: string }>> {
    return this.run(async () => {
      const metadata = await this.loadMetadata();
      this.getFile(metadata, fileId);
      return [...(metadata.revisions[fileId] ?? [])];
    });
  }

  private async initialize(): Promise<void> {
    await ensureDirectory(this.root);
    await ensureDirectory(this.contentDirectory());
    await ensureDirectory(this.revisionsDirectory());
    await ensureDirectory(this.trashDirectory());
    try {
      await lstat(this.metadataPath());
    } catch (error) {
      if (isNotFound(error)) {
        await this.saveMetadata(initialMetadata());
        return;
      }
      throw error;
    }
    const metadataStat = await lstat(this.metadataPath());
    if (metadataStat.isSymbolicLink() || !metadataStat.isFile()) {
      throw new Error("unsafe metadata path");
    }
    await this.loadMetadata();
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
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

  private async saveMetadata(metadata: LocalMetadata, invokeHook = true): Promise<void> {
    if (invokeHook) {
      await this.beforeMetadataWrite?.();
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

  private async writeRevision(metadata: LocalMetadata, fileId: string, revisionId: string, bytes: Uint8Array): Promise<void> {
    const revisionDirectory = join(this.revisionsDirectory(), fileId);
    await ensureDirectory(revisionDirectory);
    const revisionPath = join(revisionDirectory, revisionId);
    try {
      await writeFile(revisionPath, bytes, { flag: "wx" });
    } catch (error) {
      if (!isAlreadyExists(error)) {
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

  private async moveContentToTrash(fileId: string): Promise<void> {
    const source = this.contentPath(fileId);
    await ensureDirectory(dirname(source));
    const sourceStat = await lstat(source);
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
      throw new Error("unsafe content path");
    }
    const destination = join(this.trashDirectory(), fileId);
    await ensureDirectory(dirname(destination));
    try {
      await lstat(destination);
      throw new Error("trash destination already exists");
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
    await rename(source, destination);
  }

  private async readRevision(fileId: string, revisionId: string): Promise<Uint8Array> {
    const revisionDirectory = join(this.revisionsDirectory(), fileId);
    await ensureDirectory(revisionDirectory);
    const revisionPath = join(revisionDirectory, revisionId);
    const revisionStat = await lstat(revisionPath);
    if (revisionStat.isSymbolicLink() || !revisionStat.isFile()) {
      throw new Error("unsafe revision path");
    }
    return readFile(revisionPath);
  }

  private async atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
    await ensureDirectory(dirname(path));
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, bytes, { flag: "wx" });
    await rename(temporaryPath, path);
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
      trashed: file.trashed
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

const assertMetadata = (value: unknown): LocalMetadata => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid local metadata");
  }
  const metadata = value as Partial<LocalMetadata>;
  if (metadata.schemaVersion !== 1 || !Number.isInteger(metadata.sequence) || !Number.isInteger(metadata.generation) || metadata.files === undefined || metadata.revisions === undefined) {
    throw new Error("invalid local metadata");
  }
  return metadata as LocalMetadata;
};

const assertOpaqueFileId = (fileId: string): void => {
  if (typeof fileId !== "string" || fileId.length === 0 || fileId.length > MAX_FILE_ID_LENGTH || (fileId !== "vault" && fileId !== "private" && !GENERATED_ID.test(fileId))) {
    throw new Error("invalid file ID");
  }
};

const assertName = (name: string): void => {
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_NAME_LENGTH || name === "." || name === ".." || /[\\/\0]/u.test(name)) {
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
    if (typeof cursor.parentId !== "string" || !Number.isInteger(cursor.offset) || (cursor.offset as number) < 0 || !Number.isInteger(cursor.generation)) {
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

const isNotFound = (error: unknown): error is NodeJS.ErrnoException => typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";

const isAlreadyExists = (error: unknown): error is NodeJS.ErrnoException => typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
