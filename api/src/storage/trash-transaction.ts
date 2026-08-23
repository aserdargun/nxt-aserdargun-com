export const TRASH_TRANSACTION_SCHEMA_VERSION = 2 as const;

export type TrashTransactionState =
  | "prepared"
  | "metadata-staged"
  | "artifact-verified"
  | "finalized"
  | "rolled-back";

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

export type TrashRecoveryPlan =
  | { outcome: "success"; transitions: readonly TrashTransactionState[] }
  | { outcome: "rollback"; transitions: readonly ["rolled-back"] }
  | { outcome: "restore"; transitions: readonly [] };

const allowedTransitions: Record<TrashTransactionState, readonly TrashTransactionState[]> = {
  prepared: ["metadata-staged", "rolled-back"],
  "metadata-staged": ["artifact-verified", "rolled-back"],
  "artifact-verified": ["finalized", "rolled-back"],
  finalized: ["rolled-back"],
  "rolled-back": []
};

const successfulRecoveryTransitions: Record<TrashTransactionState, readonly TrashTransactionState[]> = {
  prepared: ["metadata-staged", "artifact-verified", "finalized"],
  "metadata-staged": ["artifact-verified", "finalized"],
  "artifact-verified": ["finalized"],
  finalized: [],
  "rolled-back": []
};

export const isTrashTransactionState = (value: unknown): value is TrashTransactionState =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(allowedTransitions, value);

export const transitionTrashTransaction = <Metadata>(
  transaction: TrashTransaction<Metadata>,
  nextState: TrashTransactionState
): TrashTransaction<Metadata> => {
  if (transaction.state === nextState) {
    return transaction;
  }
  if (!allowedTransitions[transaction.state].includes(nextState)) {
    throw new Error(`invalid Trash transaction transition: ${transaction.state} -> ${nextState}`);
  }
  return { ...transaction, state: nextState };
};

export const planTrashRecovery = (state: TrashTransactionState, successProven: boolean): TrashRecoveryPlan => {
  if (state === "rolled-back") {
    return { outcome: "restore", transitions: [] };
  }
  if (!successProven) {
    return { outcome: "rollback", transitions: ["rolled-back"] };
  }
  return { outcome: "success", transitions: successfulRecoveryTransitions[state] };
};
