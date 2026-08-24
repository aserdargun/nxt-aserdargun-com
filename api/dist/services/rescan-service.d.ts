import type { VaultIndex } from "@nxt/contracts";
import type { StoragePort } from "../storage/storage-port.js";
import { type SystemFileSnapshot, type SystemFileStore } from "./system-file-store.js";
export interface RescanRecord {
    noteId: string;
    title: string;
    path: string;
    version: string;
}
export interface RescanRecovery {
    path: string;
    rawSource: string;
    error: "Invalid Markdown frontmatter.";
}
export interface RescanPage {
    cursor: string | null;
    processed: number;
    complete: boolean;
    records: RescanRecord[];
    recoveries: RescanRecovery[];
}
export declare class RescanService {
    private readonly options;
    private readonly sessions;
    constructor(options: {
        storage: StoragePort;
        indexStore: SystemFileStore<VaultIndex>;
        notesFolderId: string;
        cursorSecret: string;
        now?: () => Date;
    });
    readIndex(): Promise<SystemFileSnapshot<VaultIndex>>;
    scanPage(input: {
        cursor: string | null;
        limit: number;
    }): Promise<RescanPage>;
    private createCursor;
    private pruneExpiredSessions;
    private now;
}
//# sourceMappingURL=rescan-service.d.ts.map