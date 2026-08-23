import type { StoragePort, StoredFile } from "./storage-port.js";
export declare class LocalDriveAdapter implements StoragePort {
    private readonly root;
    private operation;
    private constructor();
    static create(root: string): Promise<LocalDriveAdapter>;
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
    private initialize;
    private run;
    private loadMetadata;
    private saveMetadata;
    private newFile;
    private bumpFile;
    private getFile;
    private getActiveFile;
    private getActiveFolder;
    private getActiveContentFile;
    private assertMoveDoesNotCycle;
    private writeContent;
    private writeRevision;
    private moveContentToTrash;
    private readContent;
    private atomicWrite;
    private contentDirectory;
    private revisionsDirectory;
    private trashDirectory;
    private metadataPath;
    private contentPath;
    private toStoredFile;
}
//# sourceMappingURL=local-drive-adapter.d.ts.map