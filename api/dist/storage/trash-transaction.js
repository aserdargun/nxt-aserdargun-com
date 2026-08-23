export const TRASH_TRANSACTION_SCHEMA_VERSION = 2;
const allowedTransitions = {
    prepared: ["metadata-staged", "rolled-back"],
    "metadata-staged": ["artifact-verified", "rolled-back"],
    "artifact-verified": ["finalized", "rolled-back"],
    finalized: ["rolled-back"],
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
//# sourceMappingURL=trash-transaction.js.map