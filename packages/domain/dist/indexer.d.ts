import { type VaultAttachment, type VaultIndex } from "@nxt/contracts";
export interface IndexedSourceNote {
    source: string;
    driveId: string;
    path: string;
    driveVersion: string;
    attachments: readonly VaultAttachment[];
}
/** Derives the stored index from source notes; backlinks are always recomputed. */
export declare function deriveIndex(records: readonly IndexedSourceNote[]): VaultIndex;
//# sourceMappingURL=indexer.d.ts.map