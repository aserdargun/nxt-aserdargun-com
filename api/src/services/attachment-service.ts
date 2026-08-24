import { createHash, randomBytes, randomUUID } from "node:crypto";
import { NoteIdSchema, type VaultAttachment, type VaultIndex, type VaultPendingMutation } from "@nxt/contracts";
import { attachmentIsReferenced, projectionReferencesAttachment } from "@nxt/domain";
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
  assertAttachmentDeclaration,
  detectAttachment,
  normalizeAttachmentName,
  resolveAttachmentName,
  type AttachmentDisposition
} from "./attachment-policy.js";

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const SHORTCUT_MIME_TYPE = "application/vnd.google-apps.shortcut";
const MAX_LIST_PAGES = 20;
const MAX_DRIVE_OPERATIONS = 80;
const MAX_RECOVERY_MUTATIONS = 8;
const MUTATION_TTL_MS = 15 * 60 * 1_000;

export interface AttachmentRecord {
  driveId: string;
  name: string;
  mimeType: string;
  size: number;
  checksum: string;
  disposition: AttachmentDisposition;
  version?: string | undefined;
  marker?: string | undefined;
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
    assertAttachmentDeclaration(input.declaredMime);
    await this.reconcileRecoverableMutations();
    const context = this.context();
    const owner = await this.getOwnedNote(input.noteId);
    const folder = await this.assetFolder(input.noteId, context);
    const name = resolveAttachmentName(normalizeAttachmentName(input.name), (await this.listAll(folder.id, context)).map((file) => file.name));
    const detected = await detectAttachment({ name, declaredMime: input.declaredMime, bytes: input.bytes });
    const marker = `am1.${randomBytes(16).toString("base64url")}`;
    const mutation = this.newMutation({
      operation: "create-attachment",
      noteId: input.noteId,
      parentId: folder.id,
      targetName: name,
      expectedChecksum: checksum(input.bytes),
      attachmentMimeType: detected.mimeType,
      attachmentSize: input.bytes.byteLength,
      attachmentDisposition: detected.disposition,
      attachmentMarker: marker
    });
    await this.reserve(mutation);
    let createdId: string | undefined;
    let activeFence = mutation.fence;
    try {
      const inflight = await this.beginDriveMutation(mutation.id, activeFence);
      activeFence = inflight.fence;
      await this.assertOwnedMutation(inflight, "drive-inflight");
      const created = await this.options.storage.createBytes({ parentId: folder.id, name, mimeType: detected.mimeType, bytes: input.bytes, appProperties: { nxtAttachmentMutation: marker } }, context);
      createdId = created.id;
      const applied = await this.markDriveApplied(mutation.id, inflight.fence, created.id);
      const verified = await this.verifyReadback({
        driveId: created.id,
        noteId: input.noteId,
        folderId: folder.id,
        attachment: { driveId: created.id, name, mimeType: detected.mimeType, size: input.bytes.byteLength, checksum: checksum(input.bytes), disposition: detected.disposition, version: created.version, marker },
        context
      });
      const result: AttachmentRecord = {
        driveId: verified.file.id,
        name,
        mimeType: verified.mimeType,
        size: verified.file.size,
        checksum: verified.checksum,
        disposition: detected.disposition,
        version: verified.file.version,
        marker
      };
      await this.finalizeUpload(mutation.id, applied.fence, input.noteId, result, owner.driveId);
      return result;
    } catch (error) {
      await this.handleFailure(mutation.id, activeFence, error, createdId, createdId === undefined);
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
      const preflight = await this.assertAttachmentUnreferenced({
        noteId: current.noteId,
        name: record.name,
        ...(input.referenceId === undefined ? {} : { opaqueId: input.referenceId }),
        owner
      });
      const context = this.context();
      const folder = await this.assetFolder(current.noteId, context);
      const readback = await this.verifyReadback({ driveId: input.assetId, noteId: current.noteId, folderId: folder.id, attachment: record, context });
      const mutation = this.newMutation({
        operation: "trash-attachment",
        noteId: current.noteId,
        driveId: input.assetId,
        parentId: folder.id,
        targetName: record.name,
        expectedChecksum: record.checksum,
        originalChecksum: owner.checksum,
        oldPath: owner.path,
        expectedVersion: readback.file.version,
        preflightGeneration: preflight.generation,
        attachmentMimeType: record.mimeType,
        attachmentSize: record.size,
        attachmentDisposition: record.disposition,
        attachmentReferenceId: input.referenceId,
        attachmentMarker: record.marker
      });
      await this.reserve(mutation);
      let driveStarted = false;
      let activeFence = mutation.fence;
      try {
        const reserved = await this.assertTrashReservationCurrent(mutation, record, input.referenceId);
        const inflight = await this.beginDriveMutation(mutation.id, reserved.fence);
        activeFence = inflight.fence;
        await this.assertOwnedMutation(inflight, "drive-inflight");
        driveStarted = true;
        const trashed = await this.options.storage.trash({ fileId: input.assetId, expectedVersion: record.version as string }, context);
        if (
          trashed.id !== input.assetId || !trashed.trashed || trashed.name !== record.name ||
          trashed.parentIds.length !== 1 || trashed.parentIds[0] !== folder.id || trashed.mimeType !== record.mimeType ||
          trashed.size !== record.size || trashed.appProperties?.nxtAttachmentMutation !== record.marker || trashed.version === record.version
        ) throw new ApiResponseError("DRIVE_UNAVAILABLE");
        const applied = await this.markDriveApplied(mutation.id, inflight.fence, input.assetId);
        await this.applyTrashProjection(mutation.id, applied.fence, current.noteId, input.assetId);
        await this.clearMutation(mutation.id, applied.fence);
        return { trashed: true };
      } catch (error) {
        await this.handleFailure(mutation.id, activeFence, error, input.assetId, !driveStarted);
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

  private async assertAttachmentUnreferenced(input: {
    noteId: string;
    name: string;
    opaqueId?: string;
    owner: VaultNoteResult;
  }): Promise<{ generation: number }> {
    const index = await this.options.indexStore.read();
    if (this.indexReferencesAttachment(index.value, input.noteId, input.name, input.opaqueId) || attachmentIsReferenced({
      source: input.owner.source,
      notePath: input.owner.path,
      noteId: input.noteId,
      name: input.name,
      ...(input.opaqueId === undefined ? {} : { opaqueId: input.opaqueId })
    })) throw new ApiResponseError("CONFLICT");
    return { generation: index.value.generation };
  }

  private indexReferencesAttachment(index: VaultIndex, noteId: string, name: string, opaqueId?: string): boolean {
    return index.entries.some((entry) => entry.id !== noteId && projectionReferencesAttachment(entry.attachmentReferences, { noteId, name, ...(opaqueId === undefined ? {} : { opaqueId }) }));
  }

  private async assertTrashReservationCurrent(mutation: VaultPendingMutation, record: AttachmentRecord, opaqueId?: string): Promise<VaultPendingMutation> {
    const owner = await this.getOwnedNote(mutation.noteId as string);
    if (owner.checksum !== mutation.originalChecksum || owner.path !== mutation.oldPath) throw new ApiResponseError("CONFLICT");
    const index = await this.options.indexStore.read();
    const reservation = index.value.pendingMutations.find((candidate) => candidate.id === mutation.id);
    if (
      reservation === undefined || reservation.ownerId !== this.ownerId || reservation.fence !== mutation.fence || !this.hasLiveLease(reservation) ||
      reservation.phase !== "reserved" || this.indexReferencesAttachment(index.value, mutation.noteId as string, record.name, opaqueId) ||
      attachmentIsReferenced({ source: owner.source, notePath: owner.path, noteId: mutation.noteId as string, name: record.name, ...(opaqueId === undefined ? {} : { opaqueId }) })
    ) throw new ApiResponseError("CONFLICT");
    return reservation;
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

  /** Recovery must never recreate a parent while deciding an old mutation. */
  private async existingAssetFolder(noteId: string, context: StorageOperationContext): Promise<StoredFile> {
    const root = await this.getActiveFolder(this.options.assetsRootId, context);
    if (root.name !== "_assets" || root.parentIds.length !== 1) throw new ApiResponseError("DRIVE_UNAVAILABLE");
    const matching = (await this.listAll(root.id, context)).filter((file) => !file.trashed && sameName(file.name, noteId));
    if (matching.length !== 1) throw new ApiResponseError("DRIVE_UNAVAILABLE");
    const folder = matching[0] as StoredFile;
    this.assertExactChildFolder(folder, root.id, noteId);
    return folder;
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
      readbackChecksum !== checksum(bytes) || readbackChecksum !== input.attachment.checksum ||
      (input.attachment.version !== undefined && file.version !== input.attachment.version) ||
      (input.attachment.marker !== undefined && file.appProperties?.nxtAttachmentMutation !== input.attachment.marker)
    ) throw new ApiResponseError("DRIVE_UNAVAILABLE");
    const detected = await detectAttachment({ name: file.name, declaredMime: file.mimeType, bytes });
    if (detected.mimeType !== input.attachment.mimeType || file.mimeType !== input.attachment.mimeType) {
      throw new ApiResponseError("DRIVE_UNAVAILABLE");
    }
    if (input.attachment.disposition === "inline" && detected.disposition !== "inline") throw new ApiResponseError("DRIVE_UNAVAILABLE");
    return { file, bytes, checksum: readbackChecksum, mimeType: detected.mimeType };
  }

  private toRecord(attachment: VaultAttachment): AttachmentRecord {
    if (attachment.checksum === undefined || attachment.disposition === undefined || attachment.version === undefined || attachment.marker === undefined) throw new ApiResponseError("DRIVE_UNAVAILABLE");
    if (attachment.size > MAX_ATTACHMENT_BYTES) throw new ApiResponseError("TOO_LARGE");
    return { driveId: attachment.driveId, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size, checksum: attachment.checksum, disposition: attachment.disposition, version: attachment.version, marker: attachment.marker };
  }

  private newMutation(changes: Pick<VaultPendingMutation, "operation" | "noteId" | "driveId" | "parentId" | "targetName" | "expectedChecksum" | "originalChecksum" | "oldPath" | "expectedVersion" | "preflightGeneration" | "attachmentMimeType" | "attachmentSize" | "attachmentDisposition" | "attachmentReferenceId" | "attachmentMarker">): VaultPendingMutation {
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
      if (mutation.operation === "trash-attachment") {
        if (
          mutation.preflightGeneration !== index.generation ||
          this.indexReferencesAttachment(index, mutation.noteId as string, mutation.targetName as string, mutation.attachmentReferenceId) ||
          index.pendingMutations.some((candidate) => isNoteOrFolderPathMutation(candidate))
        ) {
          throw new ApiResponseError("CONFLICT");
        }
      }
      if (index.pendingMutations.some((candidate) => candidate.noteId === mutation.noteId || (candidate.parentId === mutation.parentId && candidate.targetName === mutation.targetName))) {
        throw new ApiResponseError("CONFLICT");
      }
      if (mutation.operation === "create-attachment" && index.entries.some((entry) => entry.id === mutation.noteId && entry.attachments.some((attachment) => sameName(attachment.name, mutation.targetName as string)))) {
        throw new ApiResponseError("CONFLICT");
      }
      return bump(index, { pendingMutations: [...index.pendingMutations, mutation] });
    });
  }

  private async beginDriveMutation(mutationId: string, expectedFence?: number): Promise<VaultPendingMutation> {
    return this.updateMutation(mutationId, expectedFence, (mutation) => ({
      ...mutation,
      fence: mutation.fence + 1,
      phase: "drive-inflight",
      expiresAt: new Date(this.now().getTime() + MUTATION_TTL_MS).toISOString(),
      reconcileAfter: new Date(this.now().getTime() + MUTATION_TTL_MS).toISOString()
    }));
  }

  private async markDriveApplied(mutationId: string, expectedFence: number | undefined, driveId: string): Promise<VaultPendingMutation> {
    return this.updateMutation(mutationId, expectedFence, (mutation) => ({ ...mutation, driveId, phase: "drive-applied", reconcileAfter: new Date(this.now().getTime() + MUTATION_TTL_MS).toISOString() }));
  }

  private async updateMutation(mutationId: string, expectedFence: number | undefined, update: (mutation: VaultPendingMutation) => VaultPendingMutation): Promise<VaultPendingMutation> {
    await this.options.indexStore.compareAndSet((index) => {
      const found = index.pendingMutations.find((mutation) => mutation.id === mutationId && mutation.ownerId === this.ownerId && (expectedFence === undefined || mutation.fence === expectedFence));
      if (found === undefined || !this.hasLiveLease(found)) throw new ApiResponseError("CONFLICT");
      return bump(index, { pendingMutations: index.pendingMutations.map((mutation) => mutation.id === mutationId ? update(found) : mutation) });
    });
    const current = await this.options.indexStore.read();
    // Never reuse a callback-local value after CAS.  A phase transition may
    // deliberately renew its fence, so the committed re-read is authoritative.
    const committed = current.value.pendingMutations.find((mutation) => mutation.id === mutationId && mutation.ownerId === this.ownerId);
    if (committed === undefined) throw new ApiResponseError("CONFLICT");
    return committed;
  }

  private async assertOwnedMutation(mutation: VaultPendingMutation, phase?: VaultPendingMutation["phase"]): Promise<VaultPendingMutation> {
    const index = await this.options.indexStore.read();
    const current = index.value.pendingMutations.find((candidate) => candidate.id === mutation.id && candidate.ownerId === this.ownerId && candidate.fence === mutation.fence);
    if (current === undefined || !this.hasLiveLease(current) || (phase !== undefined && current.phase !== phase)) throw new ApiResponseError("CONFLICT");
    return current;
  }

  private async finalizeUpload(mutationId: string, expectedFence: number, noteId: string, record: AttachmentRecord, expectedNoteDriveId: string): Promise<void> {
    await this.options.indexStore.compareAndSet((index) => {
      const mutation = index.pendingMutations.find((candidate) => candidate.id === mutationId && candidate.ownerId === this.ownerId && candidate.fence === expectedFence && candidate.phase === "drive-applied");
      const entry = index.entries.find((candidate) => candidate.id === noteId);
      if (mutation === undefined || !this.hasLiveLease(mutation) || entry === undefined || entry.driveId !== expectedNoteDriveId || entry.attachments.some((attachment) => attachment.driveId === record.driveId || sameName(attachment.name, record.name))) {
        throw new ApiResponseError("CONFLICT");
      }
      const attachment: VaultAttachment = { ...record };
      return bump(index, {
        entries: index.entries.map((candidate) => candidate.id === noteId ? { ...candidate, attachments: [...candidate.attachments, attachment] } : candidate),
        pendingMutations: index.pendingMutations.filter((candidate) => candidate.id !== mutationId)
      });
    });
  }

  private async applyTrashProjection(mutationId: string, expectedFence: number, noteId: string, assetId: string): Promise<void> {
    await this.options.indexStore.compareAndSet((index) => {
      const mutation = index.pendingMutations.find((candidate) => candidate.id === mutationId && candidate.ownerId === this.ownerId && candidate.fence === expectedFence && candidate.phase === "drive-applied");
      if (mutation === undefined || !this.hasLiveLease(mutation)) throw new ApiResponseError("CONFLICT");
      return bump(index, {
        entries: index.entries.map((entry) => entry.id === noteId ? { ...entry, attachments: entry.attachments.filter((attachment) => attachment.driveId !== assetId) } : entry),
        pendingMutations: index.pendingMutations.map((candidate) => candidate.id === mutationId ? { ...candidate, phase: "index-applied" } : candidate)
      });
    });
  }

  private async clearMutation(mutationId: string, expectedFence?: number): Promise<void> {
    await this.options.indexStore.compareAndSet((index) => {
      const current = index.pendingMutations.find((candidate) => candidate.id === mutationId);
      if (current === undefined) return index;
      if (current.ownerId !== this.ownerId || !this.hasLiveLease(current) || (expectedFence !== undefined && current.fence !== expectedFence)) throw new ApiResponseError("CONFLICT");
      return bump(index, { pendingMutations: index.pendingMutations.filter((candidate) => candidate.id !== mutationId) });
    });
  }

  private async handleFailure(mutationId: string, expectedFence: number, error: unknown, knownDriveId?: string, knownNotApplied = false): Promise<void> {
    if (knownNotApplied && error instanceof ApiResponseError) {
      await this.clearMutation(mutationId, expectedFence).catch(() => undefined);
      return;
    }
    if (error instanceof StorageMutationNotAppliedError) {
      await this.clearMutation(mutationId, expectedFence).catch(() => undefined);
      return;
    }
    const driveId = error instanceof StorageMutationOutcomeUnknownError ? error.fileId ?? knownDriveId : knownDriveId;
    await this.options.indexStore.compareAndSet((index) => {
      const current = index.pendingMutations.find((mutation) => mutation.id === mutationId && mutation.ownerId === this.ownerId && mutation.fence === expectedFence);
      if (current === undefined || !this.hasLiveLease(current)) return index;
      return bump(index, {
        pendingMutations: index.pendingMutations.map((mutation) => mutation.id === mutationId ? {
          ...mutation,
          fence: mutation.fence + 1,
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
    const now = this.now().getTime();
    const malformed = snapshot.value.pendingMutations.filter((mutation) =>
      (mutation.operation === "create-attachment" || mutation.operation === "trash-attachment") &&
      mutation.phase !== "conflicted" && !this.hasValidRecoveryTimes(mutation)
    );
    for (const mutation of malformed) await this.terminalizeMalformedRecovery(mutation);
    const mutations = snapshot.value.pendingMutations.filter((mutation) => {
      if (mutation.operation !== "create-attachment" && mutation.operation !== "trash-attachment") return false;
      if (mutation.phase === "conflicted") return false;
      const due = this.recoveryDueAt(mutation);
      return due !== undefined && due <= now;
    }).sort((left, right) => (this.recoveryDueAt(left) as number) - (this.recoveryDueAt(right) as number)).slice(0, MAX_RECOVERY_MUTATIONS);
    for (const candidate of mutations) {
      const mutation = await this.claimRecovery(candidate);
      if (mutation === undefined) continue;
      if (mutation.operation === "create-attachment") await this.reconcileUpload(mutation);
      else await this.reconcileTrash(mutation);
    }
  }

  private async claimRecovery(candidate: VaultPendingMutation): Promise<VaultPendingMutation | undefined> {
    const now = this.now().getTime();
    const lease = new Date(now + MUTATION_TTL_MS).toISOString();
    await this.options.indexStore.compareAndSet((index) => {
      const current = index.pendingMutations.find((mutation) => mutation.id === candidate.id);
      if (current === undefined) return index;
      if (!this.hasValidRecoveryTimes(current)) {
        return bump(index, { pendingMutations: index.pendingMutations.map((mutation) => mutation.id === candidate.id ? { ...mutation, phase: "conflicted", reconcileAfter: lease, expiresAt: lease } : mutation) });
      }
      if (
        current.fence !== candidate.fence || current.ownerId !== candidate.ownerId || current.phase !== candidate.phase ||
        current.reconcileAfter !== candidate.reconcileAfter || current.expiresAt !== candidate.expiresAt ||
        current.phase === "conflicted" || (this.recoveryDueAt(current) as number) > now
      ) return index;
      const claimed: VaultPendingMutation = {
        ...current,
        ownerId: this.ownerId,
        fence: current.fence + 1,
        phase: current.phase === "drive-inflight" ? "outcome-unknown" : current.phase,
        expiresAt: lease,
        reconcileAfter: lease
      };
      return bump(index, { pendingMutations: index.pendingMutations.map((mutation) => mutation.id === candidate.id ? claimed : mutation) });
    }).catch(() => undefined);
    const committed = await this.options.indexStore.read();
    const claimed = committed.value.pendingMutations.find((mutation) => mutation.id === candidate.id && mutation.ownerId === this.ownerId && mutation.fence === candidate.fence + 1);
    return claimed !== undefined && this.hasLiveLease(claimed) ? claimed : undefined;
  }

  private async reconcileUpload(mutation: VaultPendingMutation): Promise<void> {
    if (!this.hasUploadIdentity(mutation)) {
      await this.markAttachmentConflict(mutation).catch(() => undefined);
      return;
    }
    if (mutation.phase === "reserved") {
      // No phase boundary reached Drive: never inspect/adopt an identically
      // named file that appeared while this reservation expired.
      await this.clearOwnedMutation(mutation);
      return;
    }
    const context = this.context();
    try {
      await this.assertOwnedMutation(mutation);
      const folder = await this.existingAssetFolder(mutation.noteId, context);
      if (folder.id !== mutation.parentId) throw new ApiResponseError("DRIVE_UNAVAILABLE");
      const candidates = (await this.listAll(folder.id, context)).filter((file) => !file.trashed && sameName(file.name, mutation.targetName));
      if (candidates.length === 0) {
        await this.rescheduleUnknownUpload(mutation);
        return;
      }
      if (mutation.driveId !== undefined && !candidates.some((candidate) => candidate.id === mutation.driveId)) throw new ApiResponseError("DRIVE_UNAVAILABLE");
      const exact: AttachmentRecord[] = [];
      for (const candidate of candidates) {
        const record = await this.recoverExactUploadRecord(mutation, candidate.id, folder.id, context);
        if (record !== undefined) exact.push(record);
      }
      if (exact.length === 1 && candidates.length === 1) {
        const record = exact[0] as AttachmentRecord;
        const projection = await this.uploadProjectionState(mutation, record);
        if (projection === "already-applied") {
          await this.clearOwnedMutation(mutation);
          return;
        }
        if (projection === "name-conflict") {
          await this.assertOwnedMutation(mutation);
          const trashed = await this.options.storage.trash({ fileId: record.driveId, expectedVersion: record.version as string }, context);
          if (trashed.id === record.driveId && trashed.trashed) await this.clearOwnedMutation(mutation);
          return;
        }
        await this.finalizeRecoveredUpload(mutation, record);
        return;
      }
      // Duplicate matching artifacts are never exposed.  They can only be
      // quarantined after every candidate proves it is this mutation's exact,
      // unindexed artifact; unrelated or ambiguous files retain the fence.
      if (exact.length === candidates.length && exact.length > 1 && await this.areUnindexedArtifacts(mutation, exact)) {
        for (const record of exact) {
          await this.assertOwnedMutation(mutation);
          const trashed = await this.options.storage.trash({ fileId: record.driveId, expectedVersion: record.version as string }, context);
          if (!trashed.trashed || trashed.id !== record.driveId) throw new ApiResponseError("DRIVE_UNAVAILABLE");
        }
        await this.clearOwnedMutation(mutation);
      } else if (candidates.length > 0) {
        // Identical names and bytes are not ownership. A markerless matching
        // file remains user data and the intent is delegated to rescan.
        await this.markAttachmentConflict(mutation);
      }
    } catch {
      // A missing parent, marker mismatch, version drift, or unavailable
      // readback is never replayed blindly. It becomes a terminal rescan item.
      await this.markAttachmentConflict(mutation).catch(() => undefined);
    }
  }

  private async finalizeRecoveredUpload(mutation: VaultPendingMutation & { noteId: string }, record: AttachmentRecord): Promise<void> {
    await this.options.indexStore.compareAndSet((index) => {
      const current = index.pendingMutations.find((candidate) => candidate.id === mutation.id && candidate.ownerId === this.ownerId && candidate.fence === mutation.fence && candidate.phase !== "conflicted");
      const entry = index.entries.find((candidate) => candidate.id === mutation.noteId);
      if (current === undefined || !this.hasLiveLease(current) || entry === undefined) throw new ApiResponseError("CONFLICT");
      const existing = entry.attachments.find((attachment) => attachment.driveId === record.driveId);
      if (existing !== undefined) {
        if (!sameAttachment(existing, record)) throw new ApiResponseError("CONFLICT");
        return bump(index, { pendingMutations: index.pendingMutations.filter((candidate) => candidate.id !== mutation.id) });
      }
      if (entry.attachments.some((attachment) => sameName(attachment.name, record.name))) throw new ApiResponseError("CONFLICT");
      return bump(index, {
        entries: index.entries.map((candidate) => candidate.id === mutation.noteId ? { ...candidate, attachments: [...candidate.attachments, record] } : candidate),
        pendingMutations: index.pendingMutations.filter((candidate) => candidate.id !== mutation.id)
      });
    });
  }

  private async reconcileTrash(mutation: VaultPendingMutation): Promise<void> {
    if (!this.hasTrashIdentity(mutation)) {
      await this.markAttachmentConflict(mutation).catch(() => undefined);
      return;
    }
    // The projection was already committed under this fence. Replaying Drive
    // I/O here can only create a duplicate side effect; the terminal cleanup
    // is the bounded removal of this exact owned intent.
    if (mutation.phase === "index-applied") {
      await this.clearOwnedMutation(mutation);
      return;
    }
    const context = { ...this.context(), allowTrashed: true };
    try {
      const attachment = this.recordFromMutation(mutation);
      const file = await this.verifyTrashReadback(mutation, attachment, context);
      if (file.trashed) {
        const applied = await this.markDriveApplied(mutation.id, mutation.fence, mutation.driveId);
        await this.applyTrashProjection(mutation.id, applied.fence, mutation.noteId, mutation.driveId);
        await this.clearMutation(mutation.id, applied.fence);
        return;
      }
      // The trash did not apply.  Preserve (or restore) the projection and
      // release the expired reservation so retries cannot exhaust capacity.
      await this.restoreActiveProjection(mutation, attachment);
      await this.clearOwnedMutation(mutation);
    } catch {
      await this.markAttachmentConflict(mutation).catch(() => undefined);
    }
  }

  private hasUploadIdentity(mutation: VaultPendingMutation): mutation is VaultPendingMutation & { noteId: string; parentId: string; targetName: string; expectedChecksum: string; attachmentMimeType: string; attachmentSize: number; attachmentDisposition: AttachmentDisposition; attachmentMarker: string } {
    return mutation.noteId !== undefined && mutation.parentId !== undefined && mutation.targetName !== undefined && mutation.expectedChecksum !== undefined && mutation.attachmentMimeType !== undefined && mutation.attachmentSize !== undefined && mutation.attachmentDisposition !== undefined && mutation.attachmentMarker !== undefined;
  }

  private hasTrashIdentity(mutation: VaultPendingMutation): mutation is VaultPendingMutation & { noteId: string; driveId: string; parentId: string; targetName: string; expectedChecksum: string; attachmentMimeType: string; attachmentSize: number; attachmentDisposition: AttachmentDisposition; attachmentMarker: string; expectedVersion: string } {
    return mutation.noteId !== undefined && mutation.driveId !== undefined && mutation.parentId !== undefined && mutation.targetName !== undefined && mutation.expectedChecksum !== undefined && mutation.attachmentMimeType !== undefined && mutation.attachmentSize !== undefined && mutation.attachmentDisposition !== undefined && mutation.attachmentMarker !== undefined && mutation.expectedVersion !== undefined;
  }

  private recordFromMutation(mutation: VaultPendingMutation & { driveId: string; targetName: string; expectedChecksum: string; attachmentMimeType: string; attachmentSize: number; attachmentDisposition: AttachmentDisposition; attachmentMarker: string; expectedVersion: string }): AttachmentRecord {
    return { driveId: mutation.driveId, name: mutation.targetName, checksum: mutation.expectedChecksum, mimeType: mutation.attachmentMimeType, size: mutation.attachmentSize, disposition: mutation.attachmentDisposition, marker: mutation.attachmentMarker, version: mutation.expectedVersion };
  }

  private async recoverExactUploadRecord(mutation: VaultPendingMutation & { noteId: string; parentId: string; targetName: string; expectedChecksum: string; attachmentMimeType: string; attachmentSize: number; attachmentDisposition: AttachmentDisposition; attachmentMarker: string }, driveId: string, folderId: string, context: StorageOperationContext): Promise<AttachmentRecord | undefined> {
    const record: AttachmentRecord = {
      driveId,
      name: mutation.targetName,
      checksum: mutation.expectedChecksum,
      mimeType: mutation.attachmentMimeType,
      size: mutation.attachmentSize,
      disposition: mutation.attachmentDisposition,
      marker: mutation.attachmentMarker
    };
    try {
      const verified = await this.verifyReadback({ driveId, noteId: mutation.noteId, folderId, attachment: record, context });
      return { ...record, version: verified.file.version };
    } catch { return undefined; }
  }

  private async areUnindexedArtifacts(mutation: VaultPendingMutation, records: readonly AttachmentRecord[]): Promise<boolean> {
    const index = await this.options.indexStore.read();
    const owner = index.value.entries.find((entry) => entry.id === mutation.noteId);
    return owner !== undefined && records.every((record) => !owner.attachments.some((attachment) => attachment.driveId === record.driveId || sameName(attachment.name, record.name)));
  }

  private async uploadProjectionState(mutation: VaultPendingMutation & { noteId: string }, record: AttachmentRecord): Promise<"absent" | "already-applied" | "name-conflict"> {
    const index = await this.options.indexStore.read();
    const entry = index.value.entries.find((candidate) => candidate.id === mutation.noteId);
    if (entry === undefined) return "name-conflict";
    if (entry.attachments.some((attachment) => attachment.driveId === record.driveId)) return "already-applied";
    return entry.attachments.some((attachment) => sameName(attachment.name, record.name)) ? "name-conflict" : "absent";
  }

  private async restoreActiveProjection(mutation: VaultPendingMutation & { noteId: string }, attachment: AttachmentRecord): Promise<void> {
    await this.options.indexStore.compareAndSet((index) => {
      const current = index.pendingMutations.find((candidate) => candidate.id === mutation.id && candidate.ownerId === this.ownerId && candidate.fence === mutation.fence);
      const entry = index.entries.find((candidate) => candidate.id === mutation.noteId);
      if (current === undefined || !this.hasLiveLease(current) || entry === undefined) throw new ApiResponseError("CONFLICT");
      const byId = entry.attachments.find((candidate) => candidate.driveId === attachment.driveId);
      const sameNameDifferentId = entry.attachments.some((candidate) => candidate.driveId !== attachment.driveId && sameName(candidate.name, attachment.name));
      if (sameNameDifferentId) throw new ApiResponseError("CONFLICT");
      if (byId !== undefined) {
        if (!sameAttachment(byId, attachment)) throw new ApiResponseError("CONFLICT");
        return index;
      }
      return bump(index, { entries: index.entries.map((candidate) => candidate.id === mutation.noteId ? { ...candidate, attachments: [...candidate.attachments, attachment] } : candidate) });
    });
  }

  private async verifyTrashReadback(mutation: VaultPendingMutation & { driveId: string; parentId: string; targetName: string; expectedChecksum: string; attachmentMimeType: string; attachmentSize: number; attachmentDisposition: AttachmentDisposition; attachmentMarker: string; expectedVersion: string }, attachment: AttachmentRecord, context: StorageOperationContext): Promise<StoredFile> {
    const metadata = await this.options.storage.get(mutation.driveId, context);
    if (!this.matchesTrashMetadata(mutation, metadata)) throw new ApiResponseError("DRIVE_UNAVAILABLE");
    let readback: Awaited<ReturnType<StoragePort["readBytes"]>>;
    try { readback = await this.options.storage.readBytes(mutation.driveId, context); }
    catch (error) {
      // Drive can make a confirmed trashed object non-downloadable. Its
      // returned metadata is still the bounded authoritative readback; the
      // checksum was fenced by the active pre-Drive verification.
      if (metadata.trashed) return metadata;
      throw error;
    }
    const file = readback.file;
    if (
      metadata.id !== file.id || metadata.version !== file.version || file.id !== mutation.driveId ||
      file.parentIds.length !== 1 || file.parentIds[0] !== mutation.parentId || file.name !== mutation.targetName ||
      file.mimeType !== mutation.attachmentMimeType || file.size !== mutation.attachmentSize || readback.bytes.byteLength !== mutation.attachmentSize ||
      readback.checksum !== mutation.expectedChecksum || checksum(readback.bytes) !== mutation.expectedChecksum ||
      file.appProperties?.nxtAttachmentMutation !== mutation.attachmentMarker || (!file.trashed && file.version !== mutation.expectedVersion)
    ) throw new ApiResponseError("DRIVE_UNAVAILABLE");
    const detected = await detectAttachment({ name: file.name, declaredMime: file.mimeType, bytes: readback.bytes });
    if (detected.mimeType !== attachment.mimeType || (attachment.disposition === "inline" && detected.disposition !== "inline")) throw new ApiResponseError("DRIVE_UNAVAILABLE");
    return file;
  }

  private matchesTrashMetadata(mutation: VaultPendingMutation & { driveId: string; parentId: string; targetName: string; attachmentMimeType: string; attachmentSize: number; attachmentMarker: string; expectedVersion: string }, metadata: StoredFile): boolean {
    return metadata.id === mutation.driveId && metadata.parentIds.length === 1 && metadata.parentIds[0] === mutation.parentId && metadata.name === mutation.targetName && metadata.mimeType === mutation.attachmentMimeType && metadata.size === mutation.attachmentSize && metadata.appProperties?.nxtAttachmentMutation === mutation.attachmentMarker && (metadata.trashed || metadata.version === mutation.expectedVersion);
  }

  private async clearOwnedMutation(mutation: VaultPendingMutation): Promise<void> {
    await this.options.indexStore.compareAndSet((index) => {
      const current = index.pendingMutations.find((candidate) => candidate.id === mutation.id);
      if (current === undefined || current.ownerId !== this.ownerId || current.fence !== mutation.fence || !this.hasLiveLease(current)) return index;
      return bump(index, { pendingMutations: index.pendingMutations.filter((candidate) => candidate.id !== mutation.id) });
    });
  }

  private async markAttachmentConflict(mutation: VaultPendingMutation): Promise<void> {
    await this.options.indexStore.compareAndSet((index) => {
      const current = index.pendingMutations.find((candidate) => candidate.id === mutation.id && candidate.ownerId === this.ownerId && candidate.fence === mutation.fence);
      if (current === undefined || !this.hasLiveLease(current)) return index;
      return bump(index, { pendingMutations: index.pendingMutations.map((candidate) => candidate.id === mutation.id ? { ...candidate, phase: "conflicted", reconcileAfter: new Date(this.now().getTime() + MUTATION_TTL_MS).toISOString() } : candidate) });
    });
  }

  private async rescheduleUnknownUpload(mutation: VaultPendingMutation): Promise<void> {
    await this.options.indexStore.compareAndSet((index) => {
      const current = index.pendingMutations.find((candidate) => candidate.id === mutation.id && candidate.ownerId === this.ownerId && candidate.fence === mutation.fence);
      if (current === undefined || !this.hasLiveLease(current)) return index;
      const attempts = (current.recoveryAttempts ?? 0) + 1;
      const next = attempts >= 3
        ? { ...current, fence: current.fence + 1, phase: "conflicted" as const, recoveryAttempts: attempts, reconcileAfter: new Date(this.now().getTime() + MUTATION_TTL_MS).toISOString() }
        : { ...current, fence: current.fence + 1, phase: "outcome-unknown" as const, recoveryAttempts: attempts, expiresAt: new Date(this.now().getTime() + MUTATION_TTL_MS).toISOString(), reconcileAfter: new Date(this.now().getTime() + MUTATION_TTL_MS).toISOString() };
      return bump(index, { pendingMutations: index.pendingMutations.map((candidate) => candidate.id === mutation.id ? next : candidate) });
    });
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

  /** A recovery record with malformed timestamps is terminal, never hot-looped. */
  private hasValidRecoveryTimes(mutation: VaultPendingMutation): boolean {
    return this.recoveryDueAt(mutation) !== undefined && Number.isFinite(Date.parse(mutation.expiresAt));
  }

  private recoveryDueAt(mutation: VaultPendingMutation): number | undefined {
    const value = Date.parse(mutation.reconcileAfter ?? mutation.expiresAt);
    return Number.isFinite(value) ? value : undefined;
  }

  private hasLiveLease(mutation: VaultPendingMutation): boolean {
    const expiry = Date.parse(mutation.expiresAt);
    return Number.isFinite(expiry) && expiry > this.now().getTime();
  }

  private async terminalizeMalformedRecovery(candidate: VaultPendingMutation): Promise<void> {
    const horizon = new Date(this.now().getTime() + MUTATION_TTL_MS).toISOString();
    await this.options.indexStore.compareAndSet((index) => {
      const current = index.pendingMutations.find((mutation) => mutation.id === candidate.id);
      if (current === undefined || current.fence !== candidate.fence || current.ownerId !== candidate.ownerId || current.phase !== candidate.phase) return index;
      return bump(index, { pendingMutations: index.pendingMutations.map((mutation) => mutation.id === candidate.id ? {
        ...mutation,
        phase: "conflicted",
        expiresAt: horizon,
        reconcileAfter: horizon
      } : mutation) });
    }).catch(() => undefined);
  }
}

const checksum = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const bump = (index: VaultIndex, changes: Partial<VaultIndex>): VaultIndex => ({ ...index, ...changes, generation: index.generation + 1 });
const sameName = (first: string, second: string): boolean => first.normalize("NFC").toLocaleLowerCase("en-US") === second.normalize("NFC").toLocaleLowerCase("en-US");
const sameAttachment = (stored: VaultAttachment, expected: AttachmentRecord): boolean =>
  stored.driveId === expected.driveId && stored.name === expected.name && stored.mimeType === expected.mimeType &&
  stored.size === expected.size && stored.checksum === expected.checksum && stored.disposition === expected.disposition &&
  stored.version === expected.version && stored.marker === expected.marker;
const isNoteOrFolderPathMutation = (mutation: VaultPendingMutation): boolean =>
  mutation.operation === "create-note" || mutation.operation === "update-note" || mutation.operation === "move-note" || mutation.operation === "trash-note" ||
  mutation.operation === "create-folder" || mutation.operation === "rename-folder" || mutation.operation === "move-folder" || mutation.operation === "update-folder" || mutation.operation === "trash-folder";

const toApiError = (error: unknown): Error => {
  if (error instanceof ApiResponseError || error instanceof StorageOperationBudgetExceededError) return error;
  if (error instanceof StorageVersionConflictError) return new ApiResponseError("CONFLICT");
  return new ApiResponseError("DRIVE_UNAVAILABLE");
};
