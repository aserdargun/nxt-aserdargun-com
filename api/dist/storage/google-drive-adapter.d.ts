import type { GoogleDriveClient } from "./google-drive-client.js";
import type { StoragePort, StoredFile } from "./storage-port.js";
export interface GoogleDriveAdapterOptions {
    sleep?: (milliseconds: number) => Promise<void>;
    random?: () => number;
    rootId?: string;
}
export declare class GoogleDriveAdapter implements StoragePort {
    private readonly client;
    private readonly sleep;
    private readonly random;
    private readonly rootId;
    constructor(client: GoogleDriveClient, options?: GoogleDriveAdapterOptions);
    get(fileId: string): Promise<StoredFile>;
    listChildren(input: {
        parentId: string;
        pageToken?: string;
        pageSize: number;
    }): Promise<{
        files: StoredFile[];
        nextPageToken?: string;
    }>;
    readText(fileId: string): Promise<{
        file: StoredFile;
        text: string;
        checksum: string;
    }>;
    readBytes(fileId: string): Promise<{
        file: StoredFile;
        bytes: Uint8Array;
        checksum: string;
    }>;
    createFolder(input: {
        parentId: string;
        name: string;
    }): Promise<StoredFile>;
    createText(input: {
        parentId: string;
        name: string;
        mimeType: string;
        text: string;
    }): Promise<StoredFile>;
    createBytes(input: {
        parentId: string;
        name: string;
        mimeType: string;
        bytes: Uint8Array;
    }): Promise<StoredFile>;
    updateText(input: {
        fileId: string;
        expectedVersion: string;
        mimeType: string;
        text: string;
    }): Promise<StoredFile>;
    move(input: {
        fileId: string;
        fromParentId: string;
        toParentId: string;
        newName?: string;
    }): Promise<StoredFile>;
    trash(fileId: string): Promise<StoredFile>;
    listRevisions(fileId: string): Promise<Array<{
        id: string;
        modifiedTime: string;
    }>>;
    private create;
    private verifyUpload;
    private readBackAfterWrite;
    private readMetadataAfterWrite;
    private readMetadata;
    private readWithRetry;
}
export declare const escapeDriveQueryLiteral: (value: string) => string;
//# sourceMappingURL=google-drive-adapter.d.ts.map