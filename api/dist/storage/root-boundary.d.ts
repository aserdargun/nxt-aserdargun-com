import { type StorageOperationContext, type StoragePort, type StoredFile } from "./storage-port.js";
type TestGraphInput = {
    allowedRootId: string;
    graph: Record<string, string[]>;
    trashed?: readonly string[];
    shortcuts?: readonly string[];
};
export declare class RootBoundaryStorage implements StoragePort {
    private readonly storage;
    private readonly allowedRootId;
    constructor(storage: StoragePort, allowedRootId: string);
    static forTest(input: TestGraphInput): RootBoundaryStorage;
    assertInside(fileId: string, context?: StorageOperationContext): Promise<void>;
    get(fileId: string, context?: StorageOperationContext): Promise<StoredFile>;
    listChildren(input: {
        parentId: string;
        pageToken?: string;
        pageSize: number;
    }, context?: StorageOperationContext): Promise<{
        files: StoredFile[];
        nextPageToken?: string;
    }>;
    readText(fileId: string, context?: StorageOperationContext): Promise<{
        file: StoredFile;
        text: string;
        checksum: string;
    }>;
    readBytes(fileId: string, context?: StorageOperationContext): Promise<{
        file: StoredFile;
        bytes: Uint8Array;
        checksum: string;
    }>;
    createFolder(input: {
        parentId: string;
        name: string;
    }, context?: StorageOperationContext): Promise<StoredFile>;
    createText(input: {
        parentId: string;
        name: string;
        mimeType: string;
        text: string;
    }, context?: StorageOperationContext): Promise<StoredFile>;
    createBytes(input: {
        parentId: string;
        name: string;
        mimeType: string;
        bytes: Uint8Array;
        appProperties?: Record<string, string>;
    }, context?: StorageOperationContext): Promise<StoredFile>;
    updateText(input: {
        fileId: string;
        expectedVersion: string;
        mimeType: string;
        text: string;
    }, context?: StorageOperationContext): Promise<StoredFile>;
    move(input: {
        fileId: string;
        fromParentId: string;
        toParentId: string;
        expectedVersion: string;
        newName?: string;
    }, context?: StorageOperationContext): Promise<StoredFile>;
    trash(input: {
        fileId: string;
        expectedVersion: string;
    }, context?: StorageOperationContext): Promise<StoredFile>;
    listRevisions(fileId: string, context?: StorageOperationContext): Promise<Array<{
        id: string;
        modifiedTime: string;
    }>>;
    private assertReturnedInside;
}
export {};
//# sourceMappingURL=root-boundary.d.ts.map