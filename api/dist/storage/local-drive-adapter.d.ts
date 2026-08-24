import { type StoragePort, type StoredFile } from "./storage-port.js";
export type LocalDriveAdapterOptions = {
    beforeMetadataWrite?: () => void | Promise<void>;
    beforeMetadataRollbackWrite?: () => void | Promise<void>;
    beforeMutationLoad?: () => void | Promise<void>;
    beforeLockRelease?: () => void | Promise<void>;
    afterLockOwnershipCheck?: () => void | Promise<void>;
    onLockExists?: () => void | Promise<void>;
    beforeJournalOpen?: () => void | Promise<void>;
    lockTimeoutMs?: number;
};
export declare class LocalDriveAdapter implements StoragePort {
    private readonly root;
    private readonly beforeMetadataWrite?;
    private readonly beforeMetadataRollbackWrite?;
    private readonly beforeMutationLoad?;
    private readonly beforeLockRelease?;
    private readonly afterLockOwnershipCheck?;
    private readonly onLockExists?;
    private readonly beforeJournalOpen?;
    private readonly lockTimeoutMs?;
    private operation;
    private constructor();
    static create(root: string, options?: LocalDriveAdapterOptions): Promise<LocalDriveAdapter>;
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
    private read;
    private mutate;
    private withRootLock;
    private loadMetadata;
    private saveMetadata;
    private newFile;
    private nextFileId;
    private bumpFile;
    private getFile;
    private getActiveFile;
    private getActiveFolder;
    private getActiveContentFile;
    private getContentRevision;
    private assertMoveDoesNotCycle;
    private writeContent;
    private reconcileUncommittedCreate;
    private recoverTrashTransaction;
    private saveTrashTransaction;
    private preserveCurrentTrashJournalState;
    private advanceTrashTransaction;
    private rollbackTrashTransaction;
    private assertRestorableOriginalMetadata;
    private isSuccessfulTrash;
    private loadTrashJournal;
    private archiveTrashTransaction;
    private writeRevision;
    private writeVerifiedTrashArtifact;
    private archiveActiveCache;
    private readRevision;
    private atomicWrite;
    private hasTrashRollbackJournal;
    private contentDirectory;
    private revisionsDirectory;
    private trashDirectory;
    private trashContentPath;
    private trashRollbackJournalPath;
    private metadataPath;
    private contentPath;
    private toStoredFile;
}
//# sourceMappingURL=local-drive-adapter.d.ts.map