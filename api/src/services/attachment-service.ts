import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { NoteIdSchema, type VaultAttachment, type VaultIndex, type VaultPendingMutation } from "@nxt/contracts";
import { ApiResponseError } from "../http/api-response.js";
import {
  StorageMutationNotAppliedError,
  StorageMutationOutcomeUnknownError,
  StorageOperationBudget,
  StorageOperationBudgetExceededError,
  StorageVersionConflictError,
  type StorageOperationContext,
  type StoragePort,
  type StoredFile
} from "../storage/storage-port.js";
import { preserveApiError, type SystemFileStore } from "./system-file-store.js";
import type { VaultNoteResult, VaultService } from "./vault-service.js";
import {
  MAX_ATTACHMENT_BYTES,
  detectAttachment,
  normalizeAttachmentName,
  resolveAttachmentName,
  type AttachmentDisposition
} from "./attachment-policy.js";

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const SHORTCUT_MIME_TYPE = "application/vnd.google-apps.shortcut";
const MAX_LIST_PAGES = 20;
const MAX_DRIVE_OPERATIONS = 80;
const MUTATION_TTL_MS = 15 * 60 * 1_000;

export interface AttachmentRecord {
  driveId: string;
  name: string;
  mimeType: string;
  size: number;
  checksum: string;
  disposition: AttachmentDisposition;
}

export interface AttachmentDelivery {
  bytes: Uint8Array;
  name: string;
  mimeType: string;
  disposition: AttachmentDisposition;
}

type AttachmentOwner = Pick<VaultService, "getNote">;
type IndexedAttachment = { noteId: string; attachment: VaultAttachment };

export class AttachmentService {
  private readonly ownerId = randomUUID();
  private readonly noteOperations = new Map<string, Promise<void>>();

  public constructor(private readonly options: {
    storage: StoragePort;
    indexStore: SystemFileStore<VaultIndex>;
    vault: AttachmentOwner;
    assetsRootId: string;
    now?: () => Date;
    createId?: () => string;
  }) {}

  public upload(input: { noteId: string; name: string; declaredMime: string; bytes: Uint8Array }): Promise<AttachmentRecord> {
    return this.serialize(input.noteId, () => this.uploadUnserialized(input));
  }

  public async read(assetId: string): Promise<AttachmentDelivery> {
    return this.readInternal(assetId);
  }

  public async readForNote(input: { noteId: string; assetId: string }): Promise<AttachmentDelivery> {
    const indexed = await this.findAttachment(input.assetId);
    if (indexed.noteId !== input.noteId) throw new ApiResponseError("NOT_FOUND");
    return this.readInternal(input.assetId, indexed);
  }

  public trash(input: { assetId: string; referenceId?: string }): Promise<{ trashed: true }> {
    return this.trashUnserialized(input);
  }

  private async uploadUnserialized(input: { noteId: string; name: string; declaredMime: string; bytes: Uint8Array }): Promise<AttachmentRecord> {
    this.assertNoteId(input.noteId);
    if (!(input.bytes instanceof Uint8Array)) throw new ApiResponseError("INVALID_INPUT");
    if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new ApiResponseError("TOO_LARGE");
    await this.reconcileRecoverableMutations();
    const context = this.context();
    const owner = await this.getOwnedNote(input.noteId);
    const folder = await this.assetFolder(input.noteId, context);
    const name = resolveAttachmentName(normalizeAttachmentName(input.name), (await this.listAll(folder.id, context)).map((file) => file.name));
    const detected = await detectAttachment({ name, declaredMime: input.declaredMime, bytes: input.bytes });
    const mutation = this.newMutation({
      operation: "create-attachment",
      noteId: input.noteId,
      parentId: folder.id,
      targetName: name,
      expectedChecksum: checksum(input.bytes)
    });
    await this.reserve(mutation);
    let createdId: string | undefined;
    try {
      await this.beginDriveMutation(mutation.id);
      const created = await this.options.storage.createBytes({ parentId: folder.id, name, mimeType: detected.mimeType, bytes: input.bytes }, context);
      createdId = created.id;
      await this.markDriveApplied(mutation.id, created.id);
      const verified = await this.verifyReadback({
        driveId: created.id,
        noteId: input.noteId,
        folderId: folder.id,
        attachment: { driveId: created.id, name, mimeType: detected.mimeType, size: input.bytes.byteLength, checksum: checksum(input.bytes), disposition: detected.disposition },
        context
      });
      const result: AttachmentRecord = {
        driveId: verified.file.id,
        name,
        mimeType: verified.mimeType,
        size: verified.file.size,
        checksum: verified.checksum,
        disposition: detected.disposition
      };
      await this.finalizeUpload(mutation.id, input.noteId, result, owner.driveId);
      return result;
    } catch (error) {
      await this.handleFailure(mutation.id, error, createdId);
      throw toApiError(error);
    }
  }

  private async readInternal(assetId: string, indexed?: IndexedAttachment): Promise<AttachmentDelivery> {
    await this.reconcileRecoverableMutations();
    const target = indexed ?? await this.findAttachment(assetId);
    const owner = await this.getOwnedNote(target.noteId);
    const context = this.context();
    const folder = await this.assetFolder(target.noteId, context);
    const record = this.toRecord(target.attachment);
    const verified = await this.verifyReadback({
      driveId: assetId,
      noteId: target.noteId,
      folderId: folder.id,
      attachment: record,
      context
    });
    if (owner.driveId.length === 0) throw new ApiResponseError("DRIVE_UNAVAILABLE");
    return {
      bytes: verified.bytes,
      name: record.name,
      mimeType: verified.mimeType,
      disposition: record.disposition
    };
  }

  private async trashUnserialized(input: { assetId: string; referenceId?: string }): Promise<{ trashed: true }> {
    await this.reconcileRecoverableMutations();
    const indexed = await this.findAttachment(input.assetId);
    return this.serialize(indexed.noteId, async () => {
      const current = await this.findAttachment(input.assetId);
      const owner = await this.getOwnedNote(current.noteId);
      const record = this.toRecord(current.attachment);
      if (isAttachmentReferenced(owner, record.name, input.referenceId)) throw new ApiResponseError("CONFLICT");
      const context = this.context();
      const folder = await this.assetFolder(current.noteId, context);
      await this.verifyReadback({ driveId: input.assetId, noteId: current.noteId, folderId: folder.id, attachment: record, context });
      const mutation = this.newMutation({
        operation: "trash-attachment",
        noteId: current.noteId,
        driveId: input.assetId,
        parentId: folder.id,
        targetName: record.name,
        expectedChecksum: record.checksum,
        originalChecksum: owner.checksum
      });
      await this.reserve(mutation);
      try {
        const recheckedOwner = await this.getOwnedNote(current.noteId);
        if (recheckedOwner.checksum !== owner.checksum || isAttachmentReferenced(recheckedOwner, record.name, input.referenceId)) {
          throw new ApiResponseError("CONFLICT");
        }
        await this.beginDriveMutation(mutation.id);
        const trashed = await this.options.storage.trash(input.assetId, context);
        if (
          trashed.id !== input.assetId || !trashed.trashed || trashed.name !== record.name ||
          trashed.parentIds.length !== 1 || trashed.parentIds[0] !== folder.id
        ) throw new ApiResponseError("DRIVE_UNAVAILABLE");
        await this.markDriveApplied(mutation.id, input.assetId);
        await this.applyTrashProjection(mutation.id, current.noteId, input.assetId);
        await this.clearMutation(mutation.id);
        return { trashed: true };
      } catch (error) {
        await this.handleFailure(mutation.id, error, input.assetId);
        throw toApiError(error);
      }
    });
  }

  private async findAttachment(assetId: string): Promise<IndexedAttachment> {
    if (typeof assetId !== "string" || assetId.length === 0 || assetId.length > 512) throw new ApiResponseError("INVALID_INPUT");
    const index = await this.options.indexStore.read();
    const found = index.value.entries.flatMap((entry) => entry.attachments
      .filter((attachment) => attachment.driveId === assetId)
      .map((attachment) => ({ noteId: entry.id, attachment })));
    if (found.length === 0) throw new ApiResponseError("NOT_FOUND");
    if (found.length !== 1) throw new ApiResponseError("DRIVE_UNAVAILABLE");
    return found[0] as IndexedAttachment;
  }

  private async getOwnedNote(noteId: string): Promise<VaultNoteResult> {
    this.assertNoteId(noteId);
    try {
      const result = await this.options.vault.getNote(noteId);
      if (result.note.frontmatter.id !== noteId || result.driveId.length === 0 || result.checksum !== checksum(new TextEncoder().encode(result.source))) {
        throw new ApiResponseError("DRIVE_UNAVAILABLE");
      }
      return result;
    } catch (error) {
      throw preserveApiError(error, "DRIVE_UNAVAILABLE");
    }
  }

  private async assetFolder(noteId: string, context: StorageOperationContext): Promise<StoredFile> {
    const root = await this.getActiveFolder(this.options.assetsRootId, context);
    if (root.name !== "_assets" || root.parentIds.length !== 1) throw new ApiResponseError("DRIVE_UNAVAILABLE");
    const matching = (await this.listAll(root.id, context)).filter((file) => sameName(file.name, noteId) && !file.trashed);
    if (matching.length > 1) throw new ApiResponseError("DRIVE_UNAVAILABLE");
    if (matching.length === 1) {
      const folder = matching[0] as StoredFile;
      this.assertExactChildFolder(folder, root.id, noteId);
      return folder;
    }
    let created: StoredFile;
    try {
      created = await this.options.storage.createFolder({ parentId: root.id, name: noteId }, context);
    } catch (error) {
      throw preserveApiError(error, "DRIVE_UNAVAILABLE");
    }
    try {
      const readback = await this.options.storage.get(created.id, context);
      this.assertExactChildFolder(readback, root.id, noteId);
      return readback;
    } catch (error) {
      throw preserveApiError(error, "DRIVE_UNAVAILABLE");
    }
  }

  private async getActiveFolder(fileId: string, context: StorageOperationContext): Promise<StoredFile> {
    try {
      const file = await this.options.storage.get(fileId, context);
      if (file.trashed || file.mimeType !== FOLDER_MIME_TYPE || file.parentIds.length > 1) throw new ApiResponseError("DRIVE_UNAVAILABLE");
      return file;
    } catch (error) {
      throw preserveApiError(error, "DRIVE_UNAVAILABLE");
    }
  }

  private assertExactChildFolder(file: StoredFile, parentId: string, name: string): void {
    if (file.trashed || file.mimeType !== FOLDER_MIME_TYPE || file.name !== name || file.parentIds.length !== 1 || file.parentIds[0] !== parentId) {
      throw new ApiResponseError("DRIVE_UNAVAILABLE");
    }
  }

  private async verifyReadback(input: {
    driveId: string;
    noteId: string;
    folderId: string;
    attachment: AttachmentRecord;
    context: StorageOperationContext;
  }): Promise<{ file: StoredFile; bytes: Uint8Array; checksum: string; mimeType: string }> {
    let readback: Awaited<ReturnType<StoragePort["readBytes"]>>;
    try {
      const metadata = await this.options.storage.get(input.driveId, input.context);
      if (metadata.size > MAX_ATTACHMENT_BYTES) throw new ApiResponseError("TOO_LARGE");
      readback = await this.options.storage.readBytes(input.driveId, input.context);
      if (metadata.id !== readback.file.id || metadata.version !== readback.file.version) throw new ApiResponseError("DRIVE_UNAVAILABLE");
    } catch (error) {
      throw preserveApiError(error, "DRIVE_UNAVAILABLE");
    }
    const { file, bytes, checksum: readbackChecksum } = readback;
    if (
      file.trashed || file.mimeType === FOLDER_MIME_TYPE || file.mimeType === SHORTCUT_MIME_TYPE ||
      file.parentIds.length !== 1 || file.parentIds[0] !== input.folderId || file.name !== input.attachment.name ||
      file.size !== input.attachment.size || file.size !== bytes.byteLength || bytes.byteLength > MAX_ATTACHMENT_BYTES ||
      readbackChecksum !== checksum(bytes) || readbackChecksum !== input.attachment.checksum
    ) throw new ApiResponseError("DRIVE_UNAVAILABLE");
    const detected = await detectAttachment({ name: file.name, declaredMime: file.mimeType, bytes });
    if (detected.mimeType !== input.attachment.mimeType || file.mimeType !== input.attachment.mimeType) {
      throw new ApiResponseError("DRIVE_UNAVAILABLE");
    }
    if (input.attachment.disposition === "inline" && detected.disposition !== "inline") throw new ApiResponseError("DRIVE_UNAVAILABLE");
    return { file, bytes, checksum: readbackChecksum, mimeType: detected.mimeType };
  }

  private toRecord(attachment: VaultAttachment): AttachmentRecord {
    if (attachment.checksum === undefined || attachment.disposition === undefined) throw new ApiResponseError("DRIVE_UNAVAILABLE");
    if (attachment.size > MAX_ATTACHMENT_BYTES) throw new ApiResponseError("TOO_LARGE");
    return { ...attachment, checksum: attachment.checksum, disposition: attachment.disposition };
  }

  private newMutation(changes: Pick<VaultPendingMutation, "operation" | "noteId" | "driveId" | "parentId" | "targetName" | "expectedChecksum" | "originalChecksum">): VaultPendingMutation {
    const now = this.now();
    return {
      id: this.options.createId?.() ?? randomUUID(),
      ...changes,
      ownerId: this.ownerId,
      fence: 1,
      phase: "reserved",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + MUTATION_TTL_MS).toISOString()
    };
  }

  private async reserve(mutation: VaultPendingMutation): Promise<void> {
    await this.options.indexStore.compareAndSet((index) => {
      if (!index.entries.some((entry) => entry.id === mutation.noteId)) throw new ApiResponseError("NOT_FOUND");
      if (index.pendingMutations.some((candidate) => candidate.noteId === mutation.noteId || (candidate.parentId === mutation.parentId && candidate.targetName === mutation.targetName))) {
        throw new ApiResponseError("CONFLICT");
      }
      if (mutation.operation === "create-attachment" && index.entries.some((entry) => entry.id === mutation.noteId && entry.attachments.some((attachment) => sameName(attachment.name, mutation.targetName as string)))) {
        throw new ApiResponseError("CONFLICT");
      }
      return bump(index, { pendingMutations: [...index.pendingMutations, mutation] });
    });
  }

  private async beginDriveMutation(mutationId: string): Promise<void> {
    await this.updateMutation(mutationId, (mutation) => ({
      ...mutation,
      phase: "drive-inflight",
      expiresAt: new Date(this.now().getTime() + MUTATION_TTL_MS).toISOString(),
      reconcileAfter: new Date(this.now().getTime() + MUTATION_TTL_MS).toISOString()
    }));
  }

  private async markDriveApplied(mutationId: string, driveId: string): Promise<void> {
    await this.updateMutation(mutationId, (mutation) => ({ ...mutation, driveId, phase: "drive-applied", reconcileAfter: this.now().toISOString() }));
  }

  private async updateMutation(mutationId: string, update: (mutation: VaultPendingMutation) => VaultPendingMutation): Promise<void> {
    await this.options.indexStore.compareAndSet((index) => {
      const found = index.pendingMutations.find((mutation) => mutation.id === mutationId && mutation.ownerId === this.ownerId);
      if (found === undefined) throw new ApiResponseError("CONFLICT");
      return bump(index, { pendingMutations: index.pendingMutations.map((mutation) => mutation.id === mutationId ? update(found) : mutation) });
    });
  }

  private async finalizeUpload(mutationId: string, noteId: string, record: AttachmentRecord, expectedNoteDriveId: string): Promise<void> {
    await this.options.indexStore.compareAndSet((index) => {
      const mutation = index.pendingMutations.find((candidate) => candidate.id === mutationId && candidate.ownerId === this.ownerId);
      const entry = index.entries.find((candidate) => candidate.id === noteId);
      if (mutation === undefined || entry === undefined || entry.driveId !== expectedNoteDriveId || entry.attachments.some((attachment) => attachment.driveId === record.driveId || sameName(attachment.name, record.name))) {
        throw new ApiResponseError("CONFLICT");
      }
      const attachment: VaultAttachment = { ...record };
      return bump(index, {
        entries: index.entries.map((candidate) => candidate.id === noteId ? { ...candidate, attachments: [...candidate.attachments, attachment] } : candidate),
        pendingMutations: index.pendingMutations.filter((candidate) => candidate.id !== mutationId)
      });
    });
  }

  private async applyTrashProjection(mutationId: string, noteId: string, assetId: string): Promise<void> {
    await this.options.indexStore.compareAndSet((index) => {
      const mutation = index.pendingMutations.find((candidate) => candidate.id === mutationId && candidate.ownerId === this.ownerId);
      if (mutation === undefined) throw new ApiResponseError("CONFLICT");
      return bump(index, {
        entries: index.entries.map((entry) => entry.id === noteId ? { ...entry, attachments: entry.attachments.filter((attachment) => attachment.driveId !== assetId) } : entry),
        pendingMutations: index.pendingMutations.map((candidate) => candidate.id === mutationId ? { ...candidate, phase: "index-applied" } : candidate)
      });
    });
  }

  private async clearMutation(mutationId: string): Promise<void> {
    await this.options.indexStore.compareAndSet((index) => bump(index, {
      pendingMutations: index.pendingMutations.filter((candidate) => candidate.id !== mutationId)
    }));
  }

  private async handleFailure(mutationId: string, error: unknown, knownDriveId?: string): Promise<void> {
    if (error instanceof StorageMutationNotAppliedError) {
      await this.clearMutation(mutationId).catch(() => undefined);
      return;
    }
    const driveId = error instanceof StorageMutationOutcomeUnknownError ? error.fileId ?? knownDriveId : knownDriveId;
    await this.options.indexStore.compareAndSet((index) => {
      const current = index.pendingMutations.find((mutation) => mutation.id === mutationId);
      if (current === undefined) return index;
      return bump(index, {
        pendingMutations: index.pendingMutations.map((mutation) => mutation.id === mutationId ? {
          ...mutation,
          ...(driveId === undefined ? {} : { driveId }),
          phase: mutation.phase === "drive-applied" || mutation.phase === "index-applied" ? mutation.phase : "outcome-unknown",
          expiresAt: new Date(this.now().getTime() + MUTATION_TTL_MS).toISOString(),
          reconcileAfter: this.now().toISOString()
        } : mutation)
      });
    }).catch(() => undefined);
  }

  private async reconcileRecoverableMutations(): Promise<void> {
    const snapshot = await this.options.indexStore.read();
    const mutations = snapshot.value.pendingMutations.filter((mutation) => mutation.operation === "create-attachment" || mutation.operation === "trash-attachment");
    for (const mutation of mutations) {
      if (mutation.operation === "create-attachment") await this.reconcileUpload(mutation);
      else await this.reconcileTrash(mutation);
    }
  }

  private async reconcileUpload(mutation: VaultPendingMutation): Promise<void> {
    if (mutation.noteId === undefined || mutation.parentId === undefined || mutation.targetName === undefined || mutation.expectedChecksum === undefined) return;
    let driveId = mutation.driveId;
    const context = this.context();
    if (driveId === undefined) {
      const matches = (await this.listAll(mutation.parentId, context)).filter((file) => sameName(file.name, mutation.targetName as string));
      if (matches.length !== 1) return;
      driveId = (matches[0] as StoredFile).id;
    }
    try {
      const folder = await this.assetFolder(mutation.noteId, context);
      if (folder.id !== mutation.parentId) return;
      const metadata = await this.options.storage.get(driveId, context);
      const preliminary: AttachmentRecord = {
        driveId,
        name: mutation.targetName,
        mimeType: metadata.mimeType,
        size: metadata.size,
        checksum: mutation.expectedChecksum,
        disposition: "download"
      };
      const verified = await this.verifyReadback({ driveId, noteId: mutation.noteId, folderId: mutation.parentId, attachment: preliminary, context });
      const recovered: AttachmentRecord = {
        driveId,
        name: verified.file.name,
        mimeType: verified.mimeType,
        size: verified.file.size,
        checksum: verified.checksum,
        disposition: "download"
      };
      await this.finalizeRecoveredUpload(mutation.id, mutation.noteId, recovered);
    } catch {
      // An unknown mutation remains reserved and is never exposed until an exact readback proves it safe.
    }
  }

  private async finalizeRecoveredUpload(mutationId: string, noteId: string, record: AttachmentRecord): Promise<void> {
    await this.options.indexStore.compareAndSet((index) => {
      const mutation = index.pendingMutations.find((candidate) => candidate.id === mutationId);
      const entry = index.entries.find((candidate) => candidate.id === noteId);
      if (mutation === undefined || entry === undefined) return index;
      if (entry.attachments.some((attachment) => attachment.driveId === record.driveId || sameName(attachment.name, record.name))) {
        return bump(index, { pendingMutations: index.pendingMutations.filter((candidate) => candidate.id !== mutationId) });
      }
      return bump(index, {
        entries: index.entries.map((candidate) => candidate.id === noteId ? { ...candidate, attachments: [...candidate.attachments, record] } : candidate),
        pendingMutations: index.pendingMutations.filter((candidate) => candidate.id !== mutationId)
      });
    });
  }

  private async reconcileTrash(mutation: VaultPendingMutation): Promise<void> {
    if (mutation.phase !== "index-applied") return;
    await this.clearMutation(mutation.id).catch(() => undefined);
  }

  private async listAll(parentId: string, context: StorageOperationContext): Promise<StoredFile[]> {
    const files: StoredFile[] = [];
    const seen = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      let result: { files: StoredFile[]; nextPageToken?: string };
      try {
        result = await this.options.storage.listChildren({
          parentId,
          pageSize: 100,
          ...(pageToken === undefined ? {} : { pageToken })
        }, context);
      }
      catch (error) { throw preserveApiError(error, "DRIVE_UNAVAILABLE"); }
      files.push(...result.files);
      if (result.nextPageToken === undefined) return files;
      if (seen.has(result.nextPageToken)) throw new ApiResponseError("DRIVE_UNAVAILABLE");
      seen.add(result.nextPageToken);
      pageToken = result.nextPageToken;
    }
    throw new ApiResponseError("DRIVE_UNAVAILABLE");
  }

  private context(): StorageOperationContext {
    return { operationBudget: new StorageOperationBudget(MAX_DRIVE_OPERATIONS) };
  }

  private serialize<T>(noteId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.noteOperations.get(noteId) ?? Promise.resolve();
    const result = prior.catch(() => undefined).then(operation);
    const settled = result.then(() => undefined, () => undefined);
    this.noteOperations.set(noteId, settled);
    return result.finally(() => { if (this.noteOperations.get(noteId) === settled) this.noteOperations.delete(noteId); });
  }

  private assertNoteId(noteId: string): void {
    try { NoteIdSchema.parse(noteId); } catch { throw new ApiResponseError("INVALID_INPUT"); }
  }

  private now(): Date { return this.options.now?.() ?? new Date(); }
}

const checksum = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const bump = (index: VaultIndex, changes: Partial<VaultIndex>): VaultIndex => ({ ...index, ...changes, generation: index.generation + 1 });
const sameName = (first: string, second: string): boolean => first.normalize("NFC").toLocaleLowerCase("en-US") === second.normalize("NFC").toLocaleLowerCase("en-US");

const toApiError = (error: unknown): Error => {
  if (error instanceof ApiResponseError || error instanceof StorageOperationBudgetExceededError) return error;
  if (error instanceof StorageVersionConflictError) return new ApiResponseError("CONFLICT");
  return new ApiResponseError("DRIVE_UNAVAILABLE");
};

const isAttachmentReferenced = (note: VaultNoteResult, name: string, referenceId?: string): boolean => {
  const assetPath = `_assets/${note.note.frontmatter.id}/${name}`;
  const urls: string[] = [];
  const collect = (_full: string, _prefix: string, destination: string): string => {
    urls.push(destination);
    return _full;
  };
  note.source.replace(/(\]\(\s*)(<[^>\r\n]+>|[^\s)\r\n]+)(?=(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^)\r\n]*\)))?\s*\))/gu, collect);
  note.source.replace(/^(\s{0,3}\[[^\]\r\n]+\]:\s*)(<[^>\r\n]+>|[^\s\r\n]+)/gmu, collect);
  return urls.some((raw) => {
    const url = raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
    if (referenceId !== undefined && url === `/api/private/attachments/${referenceId}`) return true;
    if (url.startsWith("/") || /^[a-z][a-z0-9+.-]*:/iu.test(url)) return false;
    return posix.normalize(posix.join(posix.dirname(note.path), url)) === assetPath;
  });
};
