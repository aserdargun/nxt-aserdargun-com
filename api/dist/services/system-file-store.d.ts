import { ApiResponseError } from "../http/api-response.js";
import { type StoragePort, type StoredFile } from "../storage/storage-port.js";
export interface RuntimeSchema<T> {
    parse(value: unknown): T;
}
export interface SystemFileSnapshot<T> {
    value: T;
    file: StoredFile;
    source: string;
    checksum: string;
}
export declare class SystemFileStore<T> {
    private readonly options;
    constructor(options: {
        storage: StoragePort;
        fileId: string;
        parentId: string;
        name: string;
        schema: RuntimeSchema<T>;
    });
    read(): Promise<SystemFileSnapshot<T>>;
    update(value: T, expectedVersion?: string): Promise<SystemFileSnapshot<T>>;
    compareAndSet(transform: (current: T) => T, options?: {
        attempts?: number;
    }): Promise<SystemFileSnapshot<T>>;
    private assertPinnedFile;
    private assertChecksum;
}
export declare const preserveApiError: (error: unknown, fallback: ConstructorParameters<typeof ApiResponseError>[0]) => ApiResponseError;
//# sourceMappingURL=system-file-store.d.ts.map