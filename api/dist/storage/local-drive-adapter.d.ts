import { type StorageOperationContext, type StoragePort, type StoredFile } from "./storage-port.js";
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
        appProperties?: Record<string, string>;
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