import { describe, expect, it } from "vitest";
import {
  TRASH_TRANSACTION_SCHEMA_VERSION,
  planTrashRecovery,
  transitionTrashTransaction,
  type TrashTransaction,
  type TrashTransactionState
} from "../src/storage/trash-transaction.js";

const transactionAt = (state: TrashTransactionState): TrashTransaction<{ fixture: true }> => ({
  schemaVersion: TRASH_TRANSACTION_SCHEMA_VERSION,
  operation: "trash",
  itemKind: "folder",
  state,
  fileId: "file_1",
  originalMetadata: { fixture: true }
});

describe("Trash transaction state model", () => {
  it.each([
    ["prepared", "artifact-verified"],
    ["metadata-staged", "finalized"],
    ["finalized", "metadata-staged"],
    ["rolled-back", "prepared"]
  ] as const)("rejects invalid transition %s -> %s", (from, to) => {
    expect(() => transitionTrashTransaction(transactionAt(from), to)).toThrow("invalid Trash transaction transition");
  });

  it.each(["prepared", "metadata-staged", "artifact-verified", "finalized", "rolled-back"] as const)(
    "replays state %s idempotently",
    (state) => {
      const transaction = transactionAt(state);
      expect(transitionTrashTransaction(transaction, state)).toBe(transaction);
    }
  );

  it("plans explicit restart outcomes for prepared, verified, and terminal states", () => {
    expect(planTrashRecovery("prepared", true)).toEqual({
      outcome: "success",
      transitions: ["metadata-staged", "artifact-verified", "finalized"]
    });
    expect(planTrashRecovery("artifact-verified", true)).toEqual({ outcome: "success", transitions: ["finalized"] });
    expect(planTrashRecovery("finalized", true)).toEqual({ outcome: "success", transitions: [] });
    expect(planTrashRecovery("finalized", false)).toEqual({ outcome: "rollback", transitions: ["rolled-back"] });
    expect(planTrashRecovery("rolled-back", false)).toEqual({ outcome: "restore", transitions: [] });
    expect(planTrashRecovery("prepared", false)).toEqual({ outcome: "rollback", transitions: ["rolled-back"] });
  });
});
