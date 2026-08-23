export const TRASH_TRANSACTION_SCHEMA_VERSION = 2;
const allowedTransitions = {
    prepared: ["metadata-staged", "rolled-back"],
    "metadata-staged": ["artifact-verified", "rolled-back"],
    "artifact-verified": ["finalized", "rolled-back"],
    finalized: ["rolled-back"],
    "rolled-back": []
};
const successfulRecoveryTransitions = {
    prepared: ["metadata-staged", "artifact-verified", "finalized"],
    "metadata-staged": ["artifact-verified", "finalized"],
    "artifact-verified": ["finalized"],
    finalized: [],
    "rolled-back": []
};
export const isTrashTransactionState = (value) => typeof value === "string" && Object.prototype.hasOwnProperty.call(allowedTransitions, value);
export const transitionTrashTransaction = (transaction, nextState) => {
    if (transaction.state === nextState) {
        return transaction;
    }
    if (!allowedTransitions[transaction.state].includes(nextState)) {
        throw new Error(`invalid Trash transaction transition: ${transaction.state} -> ${nextState}`);
    }
    return { ...transaction, state: nextState };
};
export const planTrashRecovery = (state, successProven) => {
    if (state === "rolled-back") {
        return { outcome: "restore", transitions: [] };
    }
    if (!successProven) {
        return { outcome: "rollback", transitions: ["rolled-back"] };
    }
    return { outcome: "success", transitions: successfulRecoveryTransitions[state] };
};
//# sourceMappingURL=trash-transaction.js.map