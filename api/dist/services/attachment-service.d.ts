import { type VaultIndex } from "@nxt/contracts";
import { type StoragePort } from "../storage/storage-port.js";
import { type SystemFileStore } from "./system-file-store.js";
import type { VaultService } from "./vault-service.js";
import { type AttachmentDisposition } from "./attachment-policy.js";
export interface AttachmentRecord {
    driveId: string;
    name: string;
    mimeType: string;
    size: number;
    checksum: string;
    disposition: AttachmentDisposition;
    version?: string | undefined;
    marker?: string | undefined;
}
export interface AttachmentDelivery {
    bytes: Uint8Array;
    name: string;
    mimeType: string;
    disposition: AttachmentDisposition;
}
type AttachmentOwner = Pick<VaultService, "getNote">;
export declare class AttachmentService {
    private readonly options;
    private readonly ownerId;
    private readonly noteOperations;
    constructor(options: {
        storage: StoragePort;
        indexStore: SystemFileStore<VaultIndex>;
        vault: AttachmentOwner;
        assetsRootId: string;
        now?: () => Date;
        createId?: () => string;
    });
    upload(input: {
        noteId: string;
        name: string;
        declaredMime: string;
        bytes: Uint8Array;
    }): Promise<AttachmentRecord>;
    read(assetId: string): Promise<AttachmentDelivery>;
    readForNote(input: {
        noteId: string;
        assetId: string;
    }): Promise<AttachmentDelivery>;
    trash(input: {
        assetId: string;
        referenceId?: string;
    }): Promise<{
        trashed: true;
    }>;
    private uploadUnserialized;
    private readInternal;
    private trashUnserialized;
    private findAttachment;
    private getOwnedNote;
    private assertAttachmentUnreferenced;
    private indexReferencesAttachment;
    private assertTrashReservationCurrent;
    private assetFolder;
    /** Recovery must never recreate a parent while deciding an old mutation. */
    private existingAssetFolder;
    private getActiveFolder;
    private assertExactChildFolder;
    private verifyReadback;
    private toRecord;
    private newMutation;
    private reserve;
    private beginDriveMutation;
    private markDriveApplied;
    private updateMutation;
    private assertOwnedMutation;
    private finalizeUpload;
    private applyTrashProjection;
    private clearMutation;
    private handleFailure;
    private reconcileRecoverableMutations;
    private claimRecovery;
    private reconcileUpload;
    private finalizeRecoveredUpload;
    private reconcileTrash;
    private hasUploadIdentity;
    private hasTrashIdentity;
    private recordFromMutation;
    private recoverExactUploadRecord;
    private areUnindexedArtifacts;
    private uploadProjectionState;
    private restoreActiveProjection;
    private verifyTrashReadback;
    private matchesTrashMetadata;
    private clearOwnedMutation;
    private markAttachmentConflict;
    private rescheduleUnknownUpload;
    private listAll;
    private context;
    private serialize;
    private assertNoteId;
    private now;
}
export {};
//# sourceMappingURL=attachment-service.d.ts.map