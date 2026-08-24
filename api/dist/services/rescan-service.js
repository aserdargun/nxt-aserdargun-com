import { createHmac, randomBytes } from "node:crypto";
import { deriveIndex, parseNote } from "@nxt/domain";
import { ApiResponseError } from "../http/api-response.js";
import { preserveApiError } from "./system-file-store.js";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const MAX_ENTRIES_PER_PAGE = 100;
const MAX_CURSOR_LENGTH = 512;
const MAX_ACTIVE_SCANS = 64;
const SCAN_TTL_MS = 10 * 60 * 1_000;
const MAX_FOLDER_DEPTH = 20;
export class RescanService {
    options;
    sessions = new Map();
    constructor(options) {
        this.options = options;
        if (options.cursorSecret.length < 32)
            throw new Error("rescan cursor secret is too short");
    }
    readIndex() {
        return this.options.indexStore.read();
    }
    async scanPage(input) {
        if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_ENTRIES_PER_PAGE) {
            throw new ApiResponseError("INVALID_INPUT");
        }
        this.pruneExpiredSessions();
        let session;
        const previousCursor = input.cursor;
        if (input.cursor === null) {
            if (this.sessions.size >= MAX_ACTIVE_SCANS)
                throw new ApiResponseError("DRIVE_UNAVAILABLE");
            const baseIndex = await this.options.indexStore.read();
            session = {
                expiresAt: this.now() + SCAN_TTL_MS,
                baseIndex,
                queue: [{
                        folderId: this.options.notesFolderId,
                        path: "Notes",
                        depth: 0,
                        seenPageTokens: new Set()
                    }],
                records: [],
                seenDriveIds: new Set(),
                seenNoteIds: new Set()
            };
        }
        else {
            if (input.cursor.length > MAX_CURSOR_LENGTH)
                throw new ApiResponseError("INVALID_INPUT");
            const found = this.sessions.get(input.cursor);
            if (found === undefined || found.expiresAt <= this.now())
                throw new ApiResponseError("INVALID_INPUT");
            session = found;
            this.sessions.delete(input.cursor);
            session.expiresAt = this.now() + SCAN_TTL_MS;
        }
        const pageRecords = [];
        const recoveries = [];
        let processed = 0;
        try {
            while (processed < input.limit && session.queue.length > 0) {
                const current = session.queue[0];
                const pageSize = input.limit - processed;
                const page = await this.options.storage.listChildren({
                    parentId: current.folderId,
                    pageSize,
                    ...(current.pageToken === undefined ? {} : { pageToken: current.pageToken })
                }).catch((error) => { throw preserveApiError(error, "DRIVE_UNAVAILABLE"); });
                processed += page.files.length;
                if (page.nextPageToken === undefined) {
                    session.queue.shift();
                }
                else {
                    if (current.seenPageTokens.has(page.nextPageToken))
                        throw new ApiResponseError("DRIVE_UNAVAILABLE");
                    current.seenPageTokens.add(page.nextPageToken);
                    current.pageToken = page.nextPageToken;
                }
                for (const file of page.files) {
                    if (session.seenDriveIds.has(file.id))
                        throw new ApiResponseError("DRIVE_UNAVAILABLE");
                    session.seenDriveIds.add(file.id);
                    const path = `${current.path}/${file.name}`;
                    if (file.mimeType === FOLDER_MIME_TYPE) {
                        if (file.name === "_assets")
                            continue;
                        if (current.depth + 1 > MAX_FOLDER_DEPTH)
                            throw new ApiResponseError("UNSAFE_FILE");
                        session.queue.push({
                            folderId: file.id,
                            path,
                            depth: current.depth + 1,
                            seenPageTokens: new Set()
                        });
                        continue;
                    }
                    if (!file.name.toLocaleLowerCase("en-US").endsWith(".md"))
                        continue;
                    let readback;
                    try {
                        readback = await this.options.storage.readText(file.id);
                    }
                    catch (error) {
                        throw preserveApiError(error, "DRIVE_UNAVAILABLE");
                    }
                    try {
                        const note = parseNote(readback.text);
                        if (session.seenNoteIds.has(note.frontmatter.id))
                            throw new ApiResponseError("CONFLICT");
                        session.seenNoteIds.add(note.frontmatter.id);
                        const attachments = attachmentsFor(session.baseIndex.value, note.frontmatter.id);
                        session.records.push({
                            source: readback.text,
                            driveId: readback.file.id,
                            path,
                            driveVersion: readback.file.version,
                            attachments
                        });
                        pageRecords.push({
                            noteId: note.frontmatter.id,
                            title: note.frontmatter.title,
                            path,
                            version: readback.file.version
                        });
                    }
                    catch (error) {
                        if (error instanceof ApiResponseError)
                            throw error;
                        recoveries.push({ path, rawSource: readback.text, error: "Invalid Markdown frontmatter." });
                    }
                }
                if (page.files.length === 0 && page.nextPageToken !== undefined) {
                    throw new ApiResponseError("DRIVE_UNAVAILABLE");
                }
            }
            if (session.queue.length === 0) {
                let index;
                try {
                    index = deriveIndex(session.records);
                }
                catch (error) {
                    throw error instanceof ApiResponseError ? error : new ApiResponseError("CONFLICT");
                }
                await this.options.indexStore.update(index, session.baseIndex.file.version);
                return { cursor: null, processed, complete: true, records: pageRecords, recoveries };
            }
            const cursor = this.createCursor();
            this.sessions.set(cursor, session);
            return { cursor, processed, complete: false, records: pageRecords, recoveries };
        }
        catch (error) {
            if (previousCursor !== null)
                this.sessions.delete(previousCursor);
            throw preserveApiError(error, "DRIVE_UNAVAILABLE");
        }
    }
    createCursor() {
        const nonce = randomBytes(18).toString("base64url");
        const signature = createHmac("sha256", this.options.cursorSecret).update(nonce).digest("base64url");
        return `${nonce}.${signature}`;
    }
    pruneExpiredSessions() {
        const now = this.now();
        for (const [cursor, session] of this.sessions) {
            if (session.expiresAt <= now)
                this.sessions.delete(cursor);
        }
    }
    now() {
        return (this.options.now?.() ?? new Date()).getTime();
    }
}
const attachmentsFor = (index, noteId) => index.entries.find((entry) => entry.id === noteId)?.attachments.map((attachment) => ({ ...attachment })) ?? [];
//# sourceMappingURL=rescan-service.js.map