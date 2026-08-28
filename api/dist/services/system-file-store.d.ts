import { ApiResponseError } from "../http/api-response.js";
import { type StorageOperationContext, type StoragePort, type StoredFile } from "../storage/storage-port.js";
export interface RuntimeSchema<T> {
    parse(value: unknown): T;
}
export interface SystemFileSnapshot<T> {
    value: T;
    file: StoredFile;
    source: string;
    checksum: string;
}
export interface PreparedSystemFile<T> {
    value: T;
    source: string;
    checksum: string;
}
export declare class SystemFileStore<T> {
    private readonly options;
    private cachedSnapshot;
    private cachedRead;
    constructor(options: {
        storage: StoragePort;
        fileId: string;
        parentId: string;
        name: string;
        schema: RuntimeSchema<T>;
        maxBytes?: number;
    });
    readVersionCached(context?: StorageOperationContext): Promise<SystemFileSnapshot<T>>;
    read(context?: StorageOperationContext): Promise<SystemFileSnapshot<T>>;
    private readVersionCachedFresh;
    private readBody;
    update(value: T, expectedVersion?: string, context?: StorageOperationContext): Promise<SystemFileSnapshot<T>>;
    prepare(value: T): PreparedSystemFile<T>;
    compareAndSet(transform: (current: T) => T, options?: {
        attempts?: number;
        context?: StorageOperationContext;
    }): Promise<SystemFileSnapshot<T>>;
    private assertPinnedFile;
    private assertChecksum;
    private assertWithinByteLimit;
    private assertSourceWithinByteLimit;
    private sourceIsWithinByteLimit;
}
export declare const preserveApiError: (error: unknown, fallback: ConstructorParameters<typeof ApiResponseError>[0]) => Error;
//# sourceMappingURL=system-file-store.d.ts.map