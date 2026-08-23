export declare const TRASH_TRANSACTION_SCHEMA_VERSION: 2;
export type TrashTransactionState = "prepared" | "metadata-staged" | "artifact-verified" | "finalized" | "rolled-back";
export type TrashContentDescriptor = {
    size: number;
    checksum: string;
};
type TrashTransactionBase<Metadata> = {
    schemaVersion: typeof TRASH_TRANSACTION_SCHEMA_VERSION;
    operation: "trash";
    state: TrashTransactionState;
    fileId: string;
    originalMetadata: Metadata;
};
export type FileTrashTransaction<Metadata> = TrashTransactionBase<Metadata> & {
    itemKind: "file";
    content: TrashContentDescriptor;
};
export type FolderTrashTransaction<Metadata> = TrashTransactionBase<Metadata> & {
    itemKind: "folder";
    content?: never;
};
export type TrashTransaction<Metadata> = FileTrashTransaction<Metadata> | FolderTrashTransaction<Metadata>;
export type LegacyTrashJournal<Metadata> = {
    schemaVersion: 1;
    fileId: string;
    originalMetadata: Metadata;
    expectedContent?: TrashContentDescriptor;
};
export declare const isTrashTransactionState: (value: unknown) => value is TrashTransactionState;
export declare const transitionTrashTransaction: <Metadata>(transaction: TrashTransaction<Metadata>, nextState: TrashTransactionState) => TrashTransaction<Metadata>;
export {};
//# sourceMappingURL=trash-transaction.d.ts.map