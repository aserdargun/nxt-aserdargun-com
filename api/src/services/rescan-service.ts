import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  MAX_NOTE_SOURCE_BYTES,
  type VaultAttachment,
  type VaultIndex,
  type VaultRescanState
} from "@nxt/contracts";
import { deriveIndex, parseNote } from "@nxt/domain";
import { ApiResponseError } from "../http/api-response.js";
import {
  StorageOperationBudget,
  StorageOperationBudgetExceededError,
  type StorageOperationContext,
  type StoragePort
} from "../storage/storage-port.js";
import { preserveApiError, type SystemFileSnapshot, type SystemFileStore } from "./system-file-store.js";

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const MAX_ENTRIES_PER_PAGE = 100;
const MAX_OPERATIONS_PER_PAGE = 20;
const MAX_DRIVE_OPERATIONS_PER_REQUEST = 100;
const MAX_INDEX_CAS_ATTEMPTS = 3;
const SCAN_TTL_MS = 10 * 60 * 1_000;
const MAX_FOLDER_DEPTH = 20;
const MAX_RECORD_RESPONSE_BYTES = 100_000;
const MAX_TOTAL_RESPONSE_BYTES = 220_000;
const CURSOR = /^s1\.([A-Za-z0-9_-]{16,430})\.([A-Za-z0-9_-]{43})$/u;

export interface RescanRecord { noteId: string; title: string; path: string; version: string }
export interface RescanRecovery {
  path: string;
  rawSource: string;
  error: "Invalid Markdown frontmatter." | "External change detected. Rescan is reconciling the index.";
}
export interface RescanPage {
  cursor: string | null;
  processed: number;
  complete: boolean;
  records: RescanRecord[];
  recoveries: RescanRecovery[];
}

type CursorPayload = { scanId: string; generation: number; position: number; nonce: string; expiresAt: string };
type RescanTransition = NonNullable<VaultRescanState["lastTransition"]>;
type PendingRescanTransition = Omit<RescanTransition, "receiptMac" | "recoveryExpiresAt">;
type ResumeResult = { kind: "current"; state: VaultRescanState } | { kind: "replay"; page: RescanPage };

export class RescanService {
  public constructor(
    private readonly options: {
      storage: StoragePort;
      indexStore: SystemFileStore<VaultIndex>;
      notesFolderId: string;
      cursorSecret: string;
      now?: () => Date;
    }
  ) {
    if (options.cursorSecret.length < 32) throw new Error("rescan cursor secret is too short");
  }

  public readIndex(): Promise<SystemFileSnapshot<VaultIndex>> { return this.options.indexStore.read(); }

  public async scanPage(input: { cursor: string | null; limit: number }): Promise<RescanPage> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_ENTRIES_PER_PAGE) throw new ApiResponseError("INVALID_INPUT");
    const operationBudget = new StorageOperationBudget(MAX_DRIVE_OPERATIONS_PER_REQUEST);
    const context: StorageOperationContext = { operationBudget };
    let state: VaultRescanState;
    let priorCursor: string;
    if (input.cursor === null) {
      state = await this.startScan(context);
      return { cursor: this.signCursor(state), processed: 0, complete: false, records: [], recoveries: [] };
    } else {
      priorCursor = input.cursor;
      const resumed = await this.resumeScan(input.cursor, context);
      if (resumed.kind === "replay") return resumed.page;
      state = resumed.state;
    }

    const priorPosition = state.position;
    const priorNonce = state.nonce;
    const priorExpiresAt = state.expiresAt;
    const priorDeliveredRecoveryCount = state.deliveredRecoveryCount;
    const committedIndex = (await this.options.indexStore.read(context)).value;
    const pageRecords: RescanRecord[] = [];
    let responseBytes = 0;
    let operations = 0;
    let listedEntries = 0;
    let processed = 0;
    const traversalStart = operationBudget.used;
    const traversalAllowance = Math.max(1, Math.floor(operationBudget.remaining / 4));

    while (
      state.queue.length > 0 && operations < MAX_OPERATIONS_PER_PAGE &&
      operationBudget.used - traversalStart < traversalAllowance
    ) {
      const current = state.queue[0];
      if (current === undefined) break;
      if (current.kind === "read") {
        if (pageRecords.length >= MAX_ENTRIES_PER_PAGE) break;
        let readback: Awaited<ReturnType<StoragePort["readText"]>>;
        try { readback = await this.options.storage.readText(current.driveId, context); }
        catch (error) {
          if (error instanceof StorageOperationBudgetExceededError) break;
          throw preserveApiError(error, "DRIVE_UNAVAILABLE");
        }
        state.queue.shift();
        operations += 1;
        if (readback.file.trashed || !readback.file.name.toLocaleLowerCase("en-US").endsWith(".md")) throw new ApiResponseError("DRIVE_UNAVAILABLE");
        if (new TextEncoder().encode(readback.text).byteLength > MAX_NOTE_SOURCE_BYTES) throw new ApiResponseError("TOO_LARGE");
        try {
          const note = parseNote(readback.text);
          if (state.seenNoteIds.includes(note.frontmatter.id)) throw new ApiResponseError("CONFLICT");
          state.seenNoteIds.push(note.frontmatter.id);
          state.records.push({
            source: readback.text,
            driveId: readback.file.id,
            path: current.path,
            driveVersion: readback.file.version,
            attachments: attachmentsFor(committedIndex, note.frontmatter.id)
          });
          const responseRecord = { noteId: note.frontmatter.id, title: note.frontmatter.title, path: current.path, version: readback.file.version };
          const recordBytes = new TextEncoder().encode(JSON.stringify(responseRecord)).byteLength;
          if (responseBytes + recordBytes <= MAX_RECORD_RESPONSE_BYTES) {
            pageRecords.push(responseRecord);
            responseBytes += recordBytes;
          }
        } catch (error) {
          if (error instanceof ApiResponseError) throw error;
          state.recoveries.push({ path: current.path, rawSource: readback.text, error: "Invalid Markdown frontmatter." });
        }
        continue;
      }

      const remaining = Math.min(input.limit - listedEntries, MAX_ENTRIES_PER_PAGE - listedEntries, 1);
      if (remaining <= 0) break;
      operations += 1;
      let page: Awaited<ReturnType<StoragePort["listChildren"]>>;
      try {
        page = await this.options.storage.listChildren({
          parentId: current.folderId,
          pageSize: remaining,
          ...(current.pageToken === undefined ? {} : { pageToken: current.pageToken })
        }, context);
      } catch (error) {
        if (error instanceof StorageOperationBudgetExceededError) break;
        throw preserveApiError(error, "DRIVE_UNAVAILABLE");
      }
      listedEntries += page.files.length;
      processed += page.files.length;
      state.queue.shift();
      let continuation: typeof current | undefined;
      if (page.nextPageToken !== undefined) {
        if (current.seenPageTokens.includes(page.nextPageToken)) throw new ApiResponseError("DRIVE_UNAVAILABLE");
        continuation = {
          ...current,
          pageToken: page.nextPageToken,
          seenPageTokens: [...current.seenPageTokens, page.nextPageToken]
        };
      }
      for (const file of page.files) {
        if (state.seenDriveIds.includes(file.id)) throw new ApiResponseError("DRIVE_UNAVAILABLE");
        state.seenDriveIds.push(file.id);
        const path = `${current.path}/${file.name}`;
        if (file.mimeType === FOLDER_MIME_TYPE) {
          if (file.name === "_assets") continue;
          if (current.depth + 1 > MAX_FOLDER_DEPTH) throw new ApiResponseError("DRIVE_UNAVAILABLE");
          state.queue.push({ kind: "list", folderId: file.id, path, depth: current.depth + 1, seenPageTokens: [] });
        } else if (file.name.toLocaleLowerCase("en-US").endsWith(".md")) {
          state.queue.push({ kind: "read", driveId: file.id, path, driveVersion: file.version });
        }
      }
      if (continuation !== undefined) state.queue.push(continuation);
      if (page.files.length === 0 && page.nextPageToken !== undefined) throw new ApiResponseError("DRIVE_UNAVAILABLE");
    }

    const recoveries: RescanRecovery[] = [];
    let recoveryBytes = 0;
    while (
      state.deliveredRecoveryCount < state.recoveries.length &&
      pageRecords.length + recoveries.length < MAX_ENTRIES_PER_PAGE
    ) {
      const recovery = state.recoveries[state.deliveredRecoveryCount];
      if (recovery === undefined) break;
      const bytes = new TextEncoder().encode(JSON.stringify(recovery)).byteLength;
      if (recoveries.length > 0 && responseBytes + recoveryBytes + bytes > MAX_TOTAL_RESPONSE_BYTES) break;
      recoveries.push(recovery);
      recoveryBytes += bytes;
      state.deliveredRecoveryCount += 1;
    }

    const complete = state.queue.length === 0 && state.deliveredRecoveryCount === state.recoveries.length;
    const transition: PendingRescanTransition = {
      fromPosition: priorPosition,
      fromNonce: priorNonce,
      fromExpiresAt: priorExpiresAt,
      processed,
      records: pageRecords.map((record) => ({ ...record })),
      recoveries: recoveries.map((recovery) => ({ ...recovery }))
    };
    if (complete) {
      await this.completeScan(state, transition, priorCursor, context);
      return { cursor: null, processed, complete: true, records: pageRecords, recoveries };
    }
    if (operations === 0 && state.deliveredRecoveryCount === priorDeliveredRecoveryCount) {
      return { cursor: this.signCursor(state), processed, complete: false, records: pageRecords, recoveries };
    }
    state = await this.persistProgress(state, transition, priorCursor, context);
    return { cursor: this.signCursor(state), processed, complete: false, records: pageRecords, recoveries };
  }

  private async startScan(context: StorageOperationContext): Promise<VaultRescanState> {
    const now = this.now();
    let created!: VaultRescanState;
    await this.options.indexStore.compareAndSet((index) => {
      if (
        index.rescanState !== null && Date.parse(index.rescanState.expiresAt) > now.getTime() &&
        index.rescanState.baseGeneration === index.generation
      ) throw new ApiResponseError("CONFLICT");
      if (index.pendingMutations.some((mutation) => mutation.phase !== "conflicted")) throw new ApiResponseError("CONFLICT");
      const conflicts = index.pendingMutations.map((mutation) => ({
        id: mutation.id,
        path: mutation.oldPath ?? mutation.newPath ?? "Notes",
        fingerprint: mutationFingerprint(mutation)
      }));
      created = {
        scanId: randomUUID(),
        baseGeneration: index.generation,
        position: 0,
        nonce: randomBytes(16).toString("base64url"),
        startedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + SCAN_TTL_MS).toISOString(),
        queue: [{ kind: "list", folderId: this.options.notesFolderId, path: "Notes", depth: 0, seenPageTokens: [] }],
        records: [],
        seenDriveIds: [],
        seenNoteIds: [],
        recoveries: conflicts.map((conflict) => ({
          path: conflict.path,
          rawSource: "",
          error: "External change detected. Rescan is reconciling the index."
        })),
        deliveredRecoveryCount: 0,
        conflictMutationIds: conflicts.map((conflict) => conflict.id),
        conflictMutationFingerprints: conflicts.map((conflict) => ({ id: conflict.id, fingerprint: conflict.fingerprint })),
        lastTransition: null
      };
      return { ...index, rescanState: created };
    }, { attempts: MAX_INDEX_CAS_ATTEMPTS, context });
    return structuredClone(created);
  }

  private async resumeScan(cursor: string, context: StorageOperationContext): Promise<ResumeResult> {
    const payload = this.verifyCursor(cursor);
    const snapshot = await this.options.indexStore.read(context);
    const state = snapshot.value.rescanState;
    if (state === null) {
      const completed = snapshot.value.lastCompletedRescan;
      const matchesCompletion = completed !== null && completed.scanId === payload.scanId &&
        completed.baseGeneration === payload.generation && transitionMatches(completed, payload);
      if (
        matchesCompletion &&
        this.isLiveReceipt(completed, cursor, payload, completed.scanId, completed.baseGeneration, null, true)
      ) {
        return { kind: "replay", page: transitionPage(completed, null, true) };
      }
      if (Date.parse(payload.expiresAt) <= this.now().getTime()) throw new ApiResponseError("CONFLICT");
      if (matchesCompletion && isLegacyReceipt(completed) && cursor === this.canonicalCursor(payload)) {
        return { kind: "replay", page: transitionPage(completed, null, true) };
      }
      throw new ApiResponseError("CONFLICT");
    }
    const lastTransition = state.lastTransition;
    const matchesTransition = payload.scanId === state.scanId && payload.generation === state.baseGeneration &&
      lastTransition !== null && transitionMatches(lastTransition, payload);
    if (
      matchesTransition && lastTransition !== null &&
      this.isLiveReceipt(
        lastTransition,
        cursor,
        payload,
        state.scanId,
        state.baseGeneration,
        this.signCursor(state),
        false,
        state.expiresAt
      )
    ) return { kind: "replay", page: transitionPage(lastTransition, this.signCursor(state), false) };
    if (Date.parse(payload.expiresAt) <= this.now().getTime()) throw new ApiResponseError("CONFLICT");
    if (Date.parse(state.expiresAt) <= this.now().getTime()) throw new ApiResponseError("CONFLICT");
    if (
      payload.scanId === state.scanId && payload.generation === state.baseGeneration && payload.position === state.position &&
      payload.nonce === state.nonce && payload.expiresAt === state.expiresAt
    ) return { kind: "current", state: structuredClone(state) };
    if (
      matchesTransition && lastTransition !== null && isLegacyReceipt(lastTransition) &&
      cursor === this.canonicalCursor(payload)
    ) {
      return { kind: "replay", page: transitionPage(lastTransition, this.signCursor(state), false) };
    }
    throw new ApiResponseError("CONFLICT");
  }

  private async persistProgress(
    state: VaultRescanState,
    transition: PendingRescanTransition,
    priorCursor: string,
    context: StorageOperationContext
  ): Promise<VaultRescanState> {
    const recoveryExpiresAt = new Date(this.now().getTime() + SCAN_TTL_MS).toISOString();
    state.position += 1;
    state.nonce = randomBytes(16).toString("base64url");
    state.expiresAt = recoveryExpiresAt;
    const receipt = this.bindReceipt(
      transition,
      priorCursor,
      state.scanId,
      state.baseGeneration,
      recoveryExpiresAt,
      this.signCursor(state),
      false
    );
    state.lastTransition = receipt;
    await this.options.indexStore.compareAndSet((index) => {
      const current = index.rescanState;
      if (
        current === null || current.scanId !== state.scanId || current.position !== receipt.fromPosition ||
        current.nonce !== receipt.fromNonce || current.expiresAt !== receipt.fromExpiresAt
      ) throw new ApiResponseError("CONFLICT");
      return { ...index, rescanState: state };
    }, { attempts: MAX_INDEX_CAS_ATTEMPTS, context });
    return state;
  }

  private async completeScan(
    state: VaultRescanState,
    transition: PendingRescanTransition,
    priorCursor: string,
    context: StorageOperationContext
  ): Promise<void> {
    let entries: VaultIndex["entries"];
    try { entries = deriveIndex(state.records).entries; } catch { throw new ApiResponseError("CONFLICT"); }
    const recoveryExpiresAt = new Date(this.now().getTime() + SCAN_TTL_MS).toISOString();
    const receipt = this.bindReceipt(
      transition,
      priorCursor,
      state.scanId,
      state.baseGeneration,
      recoveryExpiresAt,
      null,
      true
    );
    let priorIndex: VaultIndex | undefined;
    let completedIndex: VaultIndex | undefined;
    try {
      await this.options.indexStore.compareAndSet((index) => {
        const current = index.rescanState;
        if (
          current === null || current.scanId !== state.scanId || current.position !== receipt.fromPosition ||
          current.nonce !== receipt.fromNonce || current.expiresAt !== receipt.fromExpiresAt
        ) throw new ApiResponseError("CONFLICT");
        const captured = new Set(state.conflictMutationIds);
        const fingerprints = new Map(state.conflictMutationFingerprints.map((conflict) => [conflict.id, conflict.fingerprint] as const));
        if (
          index.generation !== state.baseGeneration ||
          captured.size !== state.conflictMutationIds.length || fingerprints.size !== state.conflictMutationFingerprints.length ||
          fingerprints.size !== captured.size || index.pendingMutations.length !== captured.size ||
          state.conflictMutationIds.some((id) => !fingerprints.has(id)) ||
          index.pendingMutations.some((mutation) =>
            mutation.phase !== "conflicted" || fingerprints.get(mutation.id) !== mutationFingerprint(mutation)
          )
        ) throw new ApiResponseError("CONFLICT");
        priorIndex = structuredClone(index);
        completedIndex = {
          ...index,
          generation: index.generation + 1,
          entries,
          pendingMutations: [],
          rescanState: null,
          lastCompletedRescan: { scanId: state.scanId, baseGeneration: state.baseGeneration, ...receipt }
        };
        return completedIndex;
      }, { attempts: MAX_INDEX_CAS_ATTEMPTS, context });
    } catch (error) {
      // A conditional update can be accepted while its mandatory readback is
      // lost. Restore only if Drive now contains the exact completion this
      // caller proposed; never overwrite a later mutation or unknown state.
      if (priorIndex !== undefined && completedIndex !== undefined) {
        await this.rollbackAmbiguousCompletion(priorIndex, completedIndex, context).catch(() => undefined);
      }
      throw error;
    }
  }

  private async rollbackAmbiguousCompletion(
    priorIndex: VaultIndex,
    completedIndex: VaultIndex,
    context: StorageOperationContext
  ): Promise<void> {
    const snapshot = await this.options.indexStore.read(context);
    if (indexFingerprint(snapshot.value) === indexFingerprint(priorIndex)) return;
    if (indexFingerprint(snapshot.value) !== indexFingerprint(completedIndex)) throw new ApiResponseError("CONFLICT");
    const restored = await this.options.indexStore.update(priorIndex, snapshot.file.version, context);
    if (indexFingerprint(restored.value) !== indexFingerprint(priorIndex)) throw new ApiResponseError("DRIVE_UNAVAILABLE");
  }

  private bindReceipt(
    transition: PendingRescanTransition,
    cursor: string,
    scanId: string,
    generation: number,
    recoveryExpiresAt: string,
    successorCursor: string | null,
    complete: boolean
  ): RescanTransition {
    return {
      ...transition,
      recoveryExpiresAt,
      receiptMac: this.createReceiptMac(
        cursor,
        scanId,
        generation,
        transition,
        recoveryExpiresAt,
        successorCursor,
        complete
      )
    };
  }

  private isLiveReceipt(
    receipt: RescanTransition,
    cursor: string,
    payload: CursorPayload,
    scanId: string,
    generation: number,
    successorCursor: string | null,
    complete: boolean,
    successorExpiresAt?: string
  ): boolean {
    if (receipt.recoveryExpiresAt === null || receipt.receiptMac === null) return false;
    if (payload.scanId !== scanId || payload.generation !== generation || !transitionMatches(receipt, payload)) return false;
    const recoveryExpiry = Date.parse(receipt.recoveryExpiresAt);
    if (
      recoveryExpiry <= this.now().getTime() ||
      (successorExpiresAt !== undefined && recoveryExpiry > Date.parse(successorExpiresAt))
    ) return false;
    const expected = this.createReceiptMac(
      cursor,
      scanId,
      generation,
      receipt,
      receipt.recoveryExpiresAt,
      successorCursor,
      complete
    );
    return timingSafeEqual(Buffer.from(receipt.receiptMac), Buffer.from(expected));
  }

  private createReceiptMac(
    cursor: string,
    scanId: string,
    generation: number,
    transition: Pick<
      RescanTransition,
      "fromPosition" | "fromNonce" | "fromExpiresAt" | "processed" | "records" | "recoveries"
    >,
    recoveryExpiresAt: string,
    successorCursor: string | null,
    complete: boolean
  ): string {
    const binding = JSON.stringify({
      cursor,
      scanId,
      generation,
      position: transition.fromPosition,
      nonce: transition.fromNonce,
      expiresAt: transition.fromExpiresAt,
      recoveryExpiresAt,
      successor: {
        cursor: successorCursor,
        processed: transition.processed,
        complete,
        records: transition.records,
        recoveries: transition.recoveries
      }
    });
    return createHmac("sha256", this.options.cursorSecret)
      .update("nxt-rescan-receipt-v1\0", "utf8")
      .update(binding, "utf8")
      .digest("base64url");
  }

  private signCursor(state: VaultRescanState): string {
    return this.canonicalCursor({
      scanId: state.scanId,
      generation: state.baseGeneration,
      position: state.position,
      nonce: state.nonce,
      expiresAt: state.expiresAt
    });
  }

  private canonicalCursor(payload: CursorPayload): string {
    const canonical: CursorPayload = {
      scanId: payload.scanId,
      generation: payload.generation,
      position: payload.position,
      nonce: payload.nonce,
      expiresAt: payload.expiresAt
    };
    const encoded = Buffer.from(JSON.stringify(canonical), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.options.cursorSecret).update(encoded).digest("base64url");
    return `s1.${encoded}.${signature}`;
  }

  private verifyCursor(cursor: string): CursorPayload {
    const match = CURSOR.exec(cursor);
    if (match === null) throw new ApiResponseError("INVALID_INPUT");
    const encoded = match[1] as string;
    const signature = match[2] as string;
    const expected = createHmac("sha256", this.options.cursorSecret).update(encoded).digest("base64url");
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new ApiResponseError("INVALID_INPUT");
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown; } catch { throw new ApiResponseError("INVALID_INPUT"); }
    if (!isCursorPayload(parsed)) throw new ApiResponseError("INVALID_INPUT");
    return parsed;
  }

  private now(): Date { return this.options.now?.() ?? new Date(); }
}

const attachmentsFor = (index: VaultIndex, noteId: string): VaultAttachment[] =>
  index.entries.find((entry) => entry.id === noteId)?.attachments.map((attachment) => ({ ...attachment })) ?? [];

const mutationFingerprint = (mutation: VaultIndex["pendingMutations"][number]): string =>
  createHash("sha256").update(canonicalJson(mutation), "utf8").digest("hex");

const indexFingerprint = (index: VaultIndex): string =>
  createHash("sha256").update(canonicalJson(index), "utf8").digest("hex");

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en-US"))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

const isCursorPayload = (value: unknown): value is CursorPayload => {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 5) return false;
  const record = value as Record<string, unknown>;
  return typeof record.scanId === "string" && typeof record.generation === "number" && Number.isSafeInteger(record.generation) && record.generation >= 0 &&
    typeof record.position === "number" && Number.isSafeInteger(record.position) && record.position >= 0 && typeof record.nonce === "string" &&
    /^[A-Za-z0-9_-]{22}$/u.test(record.nonce) && typeof record.expiresAt === "string" && Number.isFinite(Date.parse(record.expiresAt));
};

const transitionMatches = (transition: RescanTransition, payload: CursorPayload): boolean =>
  transition.fromPosition === payload.position && transition.fromNonce === payload.nonce &&
  transition.fromExpiresAt === payload.expiresAt;

const isLegacyReceipt = (transition: RescanTransition): boolean =>
  transition.recoveryExpiresAt === null && transition.receiptMac === null;

const transitionPage = (
  transition: RescanTransition,
  cursor: string | null,
  complete: boolean
): RescanPage => ({
  cursor,
  processed: transition.processed,
  complete,
  records: transition.records.map((record) => ({ ...record })),
  recoveries: transition.recoveries.map((recovery) => ({ ...recovery }))
});
