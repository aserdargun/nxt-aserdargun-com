import { type PublicationManifest, type PublicNoteResponse, type VaultIndex } from "@nxt/contracts";
import { type StoragePort } from "../storage/storage-port.js";
import type { AttachmentDelivery, AttachmentService } from "./attachment-service.js";
import { type SystemFileStore } from "./system-file-store.js";
import type { VaultService } from "./vault-service.js";
export interface PublicationResult {
    publicId: string;
    publishedAt: string;
}
export type PublicAssetDelivery = AttachmentDelivery;
type PublicationOwner = Pick<VaultService, "getNote">;
type PublicationAttachments = Pick<AttachmentService, "readForNote">;
export declare class PublicationService {
    private readonly options;
    private readonly reader;
    constructor(options: {
        storage: StoragePort;
        manifestStore: SystemFileStore<PublicationManifest>;
        indexStore: SystemFileStore<VaultIndex>;
        vault: PublicationOwner;
        attachments: PublicationAttachments;
        privateRootId: string;
        publishedRootId: string;
        decodeAttachmentId?: (opaqueId: string) => string;
        now?: () => Date;
        createId?: () => string;
    });
    publish(input: {
        noteId: string;
        expectedVersion: string;
    }): Promise<PublicationResult>;
    revoke(input: {
        publicId: string;
    }): Promise<{
        revoked: true;
    }>;
    private observePublicationCausality;
    private reservePublish;
    private ensurePublicFolder;
    private ensureOperationFolder;
    private ensureOwnedFolder;
    private chooseRevisionId;
    private prepareAssets;
    private resolveIndexedAsset;
    private writeSnapshot;
    private createVerifiedBytes;
    private readAndVerifyBytes;
    private commitPublication;
    private recordRecoverableCreate;
    private cancelCreateIntent;
    private completeCreateIntent;
    private persistOperationRevisionName;
    private updateOperation;
    private abandonOperation;
    private recoverCreateIntents;
    private recoverCreateIntent;
    private queueRecoveredCreate;
    private processCleanup;
    private verifyCleanupTarget;
    private assertUniqueCleanupChild;
    private clearCleanupRecord;
    private exactChildren;
    private verifyPublishedRoot;
    private assertFolder;
    private assertSourceStillCurrent;
    private assertExpectedSource;
    private assertNoteId;
    private assertPublicId;
    private assertVersion;
    private id;
    private context;
    private now;
}
export declare class PublicPublicationReader {
    private readonly options;
    constructor(options: {
        storage: StoragePort;
        manifestStore: SystemFileStore<PublicationManifest>;
        privateRootId: string;
        publishedRootId: string;
    });
    getNote(publicId: string): Promise<PublicNoteResponse | null>;
    getAsset(publicId: string, assetId: string): Promise<PublicAssetDelivery>;
    private readVerifiedAsset;
    private resolve;
    private verifySnapshotFolders;
    private assertId;
    private context;
}
export {};
//# sourceMappingURL=publication-service.d.ts.map