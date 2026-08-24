import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { MAX_NOTE_SOURCE_BYTES } from "@nxt/contracts";
import { deriveIndex, parseNote } from "@nxt/domain";
import { ApiResponseError } from "../http/api-response.js";
import { StorageOperationBudget, StorageOperationBudgetExceededError } from "../storage/storage-port.js";
import { preserveApiError } from "./system-file-store.js";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const MAX_ENTRIES_PER_PAGE = 100;
const MAX_OPERATIONS_PER_PAGE = 20;
const MAX_DRIVE_OPERATIONS_PER_REQUEST = 100;
const PERSISTENCE_OPERATION_RESERVE = 70;
const MAX_INDEX_CAS_ATTEMPTS = 3;
const SCAN_TTL_MS = 10 * 60 * 1_000;
const MAX_FOLDER_DEPTH = 20;
const MAX_RECORD_RESPONSE_BYTES = 100_000;
const MAX_TOTAL_RESPONSE_BYTES = 220_000;
const CURSOR = /^s1\.([A-Za-z0-9_-]{16,430})\.([A-Za-z0-9_-]{43})$/u;
export class RescanService {
    options;
    constructor(options) {
        this.options = options;
        if (options.cursorSecret.length < 32)
            throw new Error("rescan cursor secret is too short");
    }
    readIndex() { return this.options.indexStore.read(); }
    async scanPage(input) {
        if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_ENTRIES_PER_PAGE)
            throw new ApiResponseError("INVALID_INPUT");
        const operationBudget = new StorageOperationBudget(MAX_DRIVE_OPERATIONS_PER_REQUEST);
        const context = { operationBudget };
        let state;
        if (input.cursor === null) {
            state = await this.startScan(context);
        }
        else {
            state = await this.resumeScan(input.cursor, context);
        }
        const priorPosition = state.position;
        const priorNonce = state.nonce;
        const priorDeliveredRecoveryCount = state.deliveredRecoveryCount;
        const committedIndex = (await this.options.indexStore.read(context)).value;
        const pageRecords = [];
        let responseBytes = 0;
        let operations = 0;
        let listedEntries = 0;
        let processed = 0;
        while (state.queue.length > 0 && operations < MAX_OPERATIONS_PER_PAGE &&
            operationBudget.remaining > PERSISTENCE_OPERATION_RESERVE) {
            const current = state.queue[0];
            if (current === undefined)
                break;
            if (current.kind === "read") {
                if (pageRecords.length >= MAX_ENTRIES_PER_PAGE)
                    break;
                let readback;
                try {
                    readback = await this.options.storage.readText(current.driveId, context);
                }
                catch (error) {
                    if (error instanceof StorageOperationBudgetExceededError)
                        break;
                    throw preserveApiError(error, "DRIVE_UNAVAILABLE");
                }
                state.queue.shift();
                operations += 1;
                if (readback.file.trashed || !readback.file.name.toLocaleLowerCase("en-US").endsWith(".md"))
                    throw new ApiResponseError("DRIVE_UNAVAILABLE");
                if (new TextEncoder().encode(readback.text).byteLength > MAX_NOTE_SOURCE_BYTES)
                    throw new ApiResponseError("TOO_LARGE");
                try {
                    const note = parseNote(readback.text);
                    if (state.seenNoteIds.includes(note.frontmatter.id))
                        throw new ApiResponseError("CONFLICT");
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
                }
                catch (error) {
                    if (error instanceof ApiResponseError)
                        throw error;
                    state.recoveries.push({ path: current.path, rawSource: readback.text, error: "Invalid Markdown frontmatter." });
                }
                continue;
            }
            const remaining = Math.min(input.limit - listedEntries, MAX_ENTRIES_PER_PAGE - listedEntries, 1);
            if (remaining <= 0)
                break;
            operations += 1;
            let page;
            try {
                page = await this.options.storage.listChildren({
                    parentId: current.folderId,
                    pageSize: remaining,
                    ...(current.pageToken === undefined ? {} : { pageToken: current.pageToken })
                }, context);
            }
            catch (error) {
                if (error instanceof StorageOperationBudgetExceededError)
                    break;
                throw preserveApiError(error, "DRIVE_UNAVAILABLE");
            }
            listedEntries += page.files.length;
            processed += page.files.length;
            state.queue.shift();
            let continuation;
            if (page.nextPageToken !== undefined) {
                if (current.seenPageTokens.includes(page.nextPageToken))
                    throw new ApiResponseError("DRIVE_UNAVAILABLE");
                continuation = {
                    ...current,
                    pageToken: page.nextPageToken,
                    seenPageTokens: [...current.seenPageTokens, page.nextPageToken]
                };
            }
            for (const file of page.files) {
                if (state.seenDriveIds.includes(file.id))
                    throw new ApiResponseError("DRIVE_UNAVAILABLE");
                state.seenDriveIds.push(file.id);
                const path = `${current.path}/${file.name}`;
                if (file.mimeType === FOLDER_MIME_TYPE) {
                    if (file.name === "_assets")
                        continue;
                    if (current.depth + 1 > MAX_FOLDER_DEPTH)
                        throw new ApiResponseError("DRIVE_UNAVAILABLE");
                    state.queue.push({ kind: "list", folderId: file.id, path, depth: current.depth + 1, seenPageTokens: [] });
                }
                else if (file.name.toLocaleLowerCase("en-US").endsWith(".md")) {
                    state.queue.push({ kind: "read", driveId: file.id, path, driveVersion: file.version });
                }
            }
            if (continuation !== undefined)
                state.queue.push(continuation);
            if (page.files.length === 0 && page.nextPageToken !== undefined)
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
        }
        const recoveries = [];
        let recoveryBytes = 0;
        while (state.deliveredRecoveryCount < state.recoveries.length &&
            pageRecords.length + recoveries.length < MAX_ENTRIES_PER_PAGE) {
            const recovery = state.recoveries[state.deliveredRecoveryCount];
            if (recovery === undefined)
                break;
            const bytes = new TextEncoder().encode(JSON.stringify(recovery)).byteLength;
            if (recoveries.length > 0 && responseBytes + recoveryBytes + bytes > MAX_TOTAL_RESPONSE_BYTES)
                break;
            recoveries.push(recovery);
            recoveryBytes += bytes;
            state.deliveredRecoveryCount += 1;
        }
        const complete = state.queue.length === 0 && state.deliveredRecoveryCount === state.recoveries.length;
        if (complete) {
            await this.completeScan(state, priorPosition, priorNonce, context);
            return { cursor: null, processed, complete: true, records: pageRecords, recoveries };
        }
        if (operations === 0 && state.deliveredRecoveryCount === priorDeliveredRecoveryCount) {
            return { cursor: this.signCursor(state), processed, complete: false, records: pageRecords, recoveries };
        }
        state = await this.persistProgress(state, priorPosition, priorNonce, context);
        return { cursor: this.signCursor(state), processed, complete: false, records: pageRecords, recoveries };
    }
    async startScan(context) {
        const now = this.now();
        let created;
        await this.options.indexStore.compareAndSet((index) => {
            if (index.pendingMutations.length > 0)
                throw new ApiResponseError("CONFLICT");
            if (index.rescanState !== null && Date.parse(index.rescanState.expiresAt) > now.getTime())
                throw new ApiResponseError("CONFLICT");
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
                recoveries: [],
                deliveredRecoveryCount: 0
            };
            return { ...index, rescanState: created };
        }, { attempts: MAX_INDEX_CAS_ATTEMPTS, context });
        return structuredClone(created);
    }
    async resumeScan(cursor, context) {
        const payload = this.verifyCursor(cursor);
        const snapshot = await this.options.indexStore.read(context);
        const state = snapshot.value.rescanState;
        if (state === null || Date.parse(state.expiresAt) <= this.now().getTime())
            throw new ApiResponseError("CONFLICT");
        if (payload.scanId !== state.scanId || payload.generation !== state.baseGeneration || payload.position !== state.position ||
            payload.nonce !== state.nonce || payload.expiresAt !== state.expiresAt)
            throw new ApiResponseError("CONFLICT");
        return structuredClone(state);
    }
    async persistProgress(state, priorPosition, priorNonce, context) {
        state.position += 1;
        state.nonce = randomBytes(16).toString("base64url");
        state.expiresAt = new Date(this.now().getTime() + SCAN_TTL_MS).toISOString();
        await this.options.indexStore.compareAndSet((index) => {
            const current = index.rescanState;
            if (current === null || current.scanId !== state.scanId || current.position !== priorPosition || current.nonce !== priorNonce)
                throw new ApiResponseError("CONFLICT");
            return { ...index, rescanState: state };
        }, { attempts: MAX_INDEX_CAS_ATTEMPTS, context });
        return state;
    }
    async completeScan(state, priorPosition, priorNonce, context) {
        let entries;
        try {
            entries = deriveIndex(state.records).entries;
        }
        catch {
            throw new ApiResponseError("CONFLICT");
        }
        await this.options.indexStore.compareAndSet((index) => {
            const current = index.rescanState;
            if (current === null || current.scanId !== state.scanId || current.position !== priorPosition || current.nonce !== priorNonce)
                throw new ApiResponseError("CONFLICT");
            return { ...index, generation: index.generation + 1, entries, rescanState: null };
        }, { attempts: MAX_INDEX_CAS_ATTEMPTS, context });
    }
    signCursor(state) {
        const payload = {
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
    verifyCursor(cursor) {
        const match = CURSOR.exec(cursor);
        if (match === null)
            throw new ApiResponseError("INVALID_INPUT");
        const encoded = match[1];
        const signature = match[2];
        const expected = createHmac("sha256", this.options.cursorSecret).update(encoded).digest("base64url");
        if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected)))
            throw new ApiResponseError("INVALID_INPUT");
        let parsed;
        try {
            parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
        }
        catch {
            throw new ApiResponseError("INVALID_INPUT");
        }
        if (!isCursorPayload(parsed))
            throw new ApiResponseError("INVALID_INPUT");
        return parsed;
    }
    now() { return this.options.now?.() ?? new Date(); }
}
const attachmentsFor = (index, noteId) => index.entries.find((entry) => entry.id === noteId)?.attachments.map((attachment) => ({ ...attachment })) ?? [];
const isCursorPayload = (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 5)
        return false;
    const record = value;
    return typeof record.scanId === "string" && typeof record.generation === "number" && Number.isSafeInteger(record.generation) &&
        typeof record.position === "number" && Number.isSafeInteger(record.position) && typeof record.nonce === "string" &&
        /^[A-Za-z0-9_-]{22}$/u.test(record.nonce) && typeof record.expiresAt === "string" && Number.isFinite(Date.parse(record.expiresAt));
};
//# sourceMappingURL=rescan-service.js.map