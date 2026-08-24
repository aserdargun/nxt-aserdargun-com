import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
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
    if (input.cursor === null) {
      state = await this.startScan(context);
      return { cursor: this.signCursor(state), processed: 0, complete: false, records: [], recoveries: [] };
    } else {
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
    const transition: RescanTransition = {
      fromPosition: priorPosition,
      fromNonce: priorNonce,
      fromExpiresAt: priorExpiresAt,
      processed,
      records: pageRecords.map((record) => ({ ...record })),
      recoveries: recoveries.map((recovery) => ({ ...recovery }))
    };
    if (complete) {
      await this.completeScan(state, transition, context);
      return { cursor: null, processed, complete: true, records: pageRecords, recoveries };
    }
    if (operations === 0 && state.deliveredRecoveryCount === priorDeliveredRecoveryCount) {
      return { cursor: this.signCursor(state), processed, complete: false, records: pageRecords, recoveries };
    }
    state = await this.persistProgress(state, transition, context);
    return { cursor: this.signCursor(state), processed, complete: false, records: pageRecords, recoveries };
  }

  private async startScan(context: StorageOperationContext): Promise<VaultRescanState> {
    const now = this.now();
    let created!: VaultRescanState;
    await this.options.indexStore.compareAndSet((index) => {
      if (index.rescanState !== null && Date.parse(index.rescanState.expiresAt) > now.getTime()) throw new ApiResponseError("CONFLICT");
      if (index.pendingMutations.some((mutation) => mutation.phase !== "conflicted")) throw new ApiResponseError("CONFLICT");
      const conflicts = index.pendingMutations.map((mutation) => ({
        id: mutation.id,
        path: mutation.oldPath ?? mutation.newPath ?? "Notes"
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
    if (Date.parse(payload.expiresAt) <= this.now().getTime()) throw new ApiResponseError("CONFLICT");
    if (state === null) {
      const completed = snapshot.value.lastCompletedRescan;
      if (
        completed === null || completed.scanId !== payload.scanId || completed.baseGeneration !== payload.generation ||
        !transitionMatches(completed, payload)
      ) throw new ApiResponseError("CONFLICT");
      return { kind: "replay", page: transitionPage(completed, null, true) };
    }
    if (Date.parse(state.expiresAt) <= this.now().getTime()) throw new ApiResponseError("CONFLICT");
    if (
      payload.scanId === state.scanId && payload.generation === state.baseGeneration && payload.position === state.position &&
      payload.nonce === state.nonce && payload.expiresAt === state.expiresAt
    ) return { kind: "current", state: structuredClone(state) };
    if (
      payload.scanId === state.scanId && payload.generation === state.baseGeneration && state.lastTransition !== null &&
      transitionMatches(state.lastTransition, payload)
    ) return { kind: "replay", page: transitionPage(state.lastTransition, this.signCursor(state), false) };
    throw new ApiResponseError("CONFLICT");
  }

  private async persistProgress(state: VaultRescanState, transition: RescanTransition, context: StorageOperationContext): Promise<VaultRescanState> {
    state.position += 1;
    state.nonce = randomBytes(16).toString("base64url");
    state.expiresAt = new Date(this.now().getTime() + SCAN_TTL_MS).toISOString();
    state.lastTransition = transition;
    await this.options.indexStore.compareAndSet((index) => {
      const current = index.rescanState;
      if (
        current === null || current.scanId !== state.scanId || current.position !== transition.fromPosition ||
        current.nonce !== transition.fromNonce || current.expiresAt !== transition.fromExpiresAt
      ) throw new ApiResponseError("CONFLICT");
      return { ...index, rescanState: state };
    }, { attempts: MAX_INDEX_CAS_ATTEMPTS, context });
    return state;
  }

  private async completeScan(state: VaultRescanState, transition: RescanTransition, context: StorageOperationContext): Promise<void> {
    let entries: VaultIndex["entries"];
    try { entries = deriveIndex(state.records).entries; } catch { throw new ApiResponseError("CONFLICT"); }
    await this.options.indexStore.compareAndSet((index) => {
      const current = index.rescanState;
      if (
        current === null || current.scanId !== state.scanId || current.position !== transition.fromPosition ||
        current.nonce !== transition.fromNonce || current.expiresAt !== transition.fromExpiresAt
      ) throw new ApiResponseError("CONFLICT");
      const captured = new Set(state.conflictMutationIds);
      if (
        index.pendingMutations.some((mutation) => mutation.phase !== "conflicted" || !captured.has(mutation.id)) ||
        captured.size !== index.pendingMutations.length
      ) throw new ApiResponseError("CONFLICT");
      return {
        ...index,
        generation: index.generation + 1,
        entries,
        pendingMutations: index.pendingMutations.filter((mutation) => !captured.has(mutation.id)),
        rescanState: null,
        lastCompletedRescan: { scanId: state.scanId, baseGeneration: state.baseGeneration, ...transition }
      };
    }, { attempts: MAX_INDEX_CAS_ATTEMPTS, context });
  }

  private signCursor(state: VaultRescanState): string {
    const payload: CursorPayload = {
      scanId: state.scanId,
      generation: state.baseGeneration,
      position: state.position,
      nonce: state.nonce,
      expiresAt: state.expiresAt
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
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
