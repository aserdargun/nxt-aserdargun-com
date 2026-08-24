export class StorageVersionConflictError extends Error {
    constructor() {
        super("storage version conflict");
        this.name = "StorageVersionConflictError";
    }
}
/** A storage mutation was rejected before it could reach the backing store. */
export class StorageMutationNotAppliedError extends Error {
    constructor() {
        super("storage mutation was not applied");
        this.name = "StorageMutationNotAppliedError";
    }
}
/** A backing store may have applied a mutation even though acknowledgement failed. */
export class StorageMutationOutcomeUnknownError extends Error {
    fileId;
    constructor(fileId, message = "storage mutation outcome is unknown") {
        super(message);
        this.fileId = fileId;
        this.name = "StorageMutationOutcomeUnknownError";
    }
}
//# sourceMappingURL=storage-port.js.map