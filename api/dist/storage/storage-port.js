export class StorageVersionConflictError extends Error {
    constructor() {
        super("storage version conflict");
        this.name = "StorageVersionConflictError";
    }
}
export class StorageOperationBudgetExceededError extends Error {
    constructor() {
        super("storage operation budget exhausted");
        this.name = "StorageOperationBudgetExceededError";
    }
}
export class StorageOperationBudget {
    limit;
    consumed = 0;
    constructor(limit) {
        this.limit = limit;
        if (!Number.isSafeInteger(limit) || limit < 1)
            throw new Error("invalid storage operation budget");
    }
    consume() {
        if (this.consumed >= this.limit)
            throw new StorageOperationBudgetExceededError();
        this.consumed += 1;
    }
    get remaining() { return this.limit - this.consumed; }
    get used() { return this.consumed; }
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