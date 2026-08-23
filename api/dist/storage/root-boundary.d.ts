import type { StoragePort, StoredFile } from "./storage-port.js";
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
    assertInside(fileId: string): Promise<void>;
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
    private assertReturnedInside;
}
export {};
//# sourceMappingURL=root-boundary.d.ts.map