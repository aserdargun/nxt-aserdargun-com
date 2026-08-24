export interface StoredFile {
    id: string;
    name: string;
    mimeType: string;
    parentIds: string[];
    version: string;
    modifiedTime: string;
    size: number;
    trashed: boolean;
    /** Internal app-owned metadata. Never cross an API response boundary. */
    appProperties?: Readonly<Record<string, string>>;
}
export declare class StorageVersionConflictError extends Error {
    constructor();
}
export declare class StorageOperationBudgetExceededError extends Error {
    constructor();
}
export declare class StorageOperationBudget {
    readonly limit: number;
    private consumed;
    constructor(limit: number);
    consume(): void;
    get remaining(): number;
    get used(): number;
}
export interface StorageOperationContext {
    operationBudget?: StorageOperationBudget;
    /** Recovery-only metadata reconciliation may inspect, but never expose, trashed files. */
    allowTrashed?: boolean;
}
export declare const assertStorageVersion: (value: unknown) => asserts value is string;
/** A storage mutation was rejected before it could reach the backing store. */
export declare class StorageMutationNotAppliedError extends Error {
    constructor();
}
/** A backing store may have applied a mutation even though acknowledgement failed. */
export declare class StorageMutationOutcomeUnknownError extends Error {
    readonly fileId?: string | undefined;
    constructor(fileId?: string | undefined, message?: string);
}
export interface StoragePort {
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
    trash(fileId: string, context?: StorageOperationContext, expectedVersion?: string): Promise<StoredFile>;
    listRevisions(fileId: string, context?: StorageOperationContext): Promise<Array<{
        id: string;
        modifiedTime: string;
    }>>;
}
//# sourceMappingURL=storage-port.d.ts.map