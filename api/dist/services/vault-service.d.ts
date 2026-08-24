import { type NoteDocument, type Preferences, type VaultIndex } from "@nxt/contracts";
import { type StoragePort, type StoredFile } from "../storage/storage-port.js";
import { type SystemFileSnapshot, type SystemFileStore } from "./system-file-store.js";
export type VaultNote = NoteDocument & {
    path: string;
};
export interface VaultNoteResult {
    note: VaultNote;
    source: string;
    driveId: string;
    version: string;
    path: string;
    checksum: string;
}
type Folders = {
    notesId: string;
    inboxId: string;
    plansId: string;
    archiveId: string;
    assetsId: string;
};
type Confirmation = {
    descendantCount: number;
    treeVersion: string;
    expiresAt: string;
    confirmationToken: string;
};
type FolderTreeRecord = {
    id: string;
    name: string;
    path: string;
    version: string;
    protected: boolean;
    deleteConfirmation?: Confirmation;
};
export declare class VaultService {
    private readonly options;
    private readonly noteOperations;
    private readonly protectedFolders;
    constructor(options: {
        storage: StoragePort;
        indexStore: SystemFileStore<VaultIndex>;
        folders: Folders;
        now?: () => Date;
        createId?: () => string;
        confirmationSecret: string;
        preferencesStore?: SystemFileStore<Preferences>;
    });
    readIndex(): Promise<SystemFileSnapshot<VaultIndex>>;
    createNote(input: {
        title: string;
        body: string;
        folderId: string;
    }): Promise<VaultNoteResult>;
    getNote(noteId: string): Promise<VaultNoteResult>;
    updateNote(input: {
        noteId: string;
        expectedVersion: string;
        source: string;
    }): Promise<VaultNoteResult>;
    renameNote(input: {
        noteId: string;
        expectedVersion: string;
        title: string;
    }): Promise<VaultNoteResult>;
    moveNote(input: {
        noteId: string;
        expectedVersion: string;
        folderId: string;
    }): Promise<VaultNoteResult>;
    archiveNote(input: {
        noteId: string;
        expectedVersion: string;
    }): Promise<VaultNoteResult>;
    trashNote(input: {
        noteId: string;
        expectedVersion: string;
    }): Promise<{
        trashed: true;
    }>;
    createFolder(input: {
        parentId: string;
        name: string;
    }): Promise<StoredFile>;
    renameFolder(input: {
        folderId: string;
        expectedVersion: string;
        name: string;
    }): Promise<StoredFile>;
    moveFolder(input: {
        folderId: string;
        expectedVersion: string;
        parentId: string;
    }): Promise<StoredFile>;
    issueFolderDeleteConfirmation(folderId: string): Promise<Confirmation>;
    trashFolder(input: {
        folderId: string;
        expectedTreeVersion: string;
        confirmationToken?: string;
    }): Promise<{
        trashed: true;
    }>;
    vaultTree(): Promise<{
        treeVersion: string;
        folders: FolderTreeRecord[];
    }>;
    private updateNoteUnserialized;
    private moveNoteUnserialized;
    private reserve;
    private finalizeEntry;
    private finalize;
    private cancel;
    private clearMutation;
    private expire;
    private reconcileExpiredMutations;
    private prunePreferences;
    private reconcile;
    private newMutation;
    private findEntry;
    private verifyNoteReadback;
    private readNote;
    private preflight;
    private parseOwnedNote;
    private result;
    private noteTitle;
    private assertSourceSize;
    private assertMarkdownFile;
    private assertFolder;
    private assertFolderDestination;
    private folderDepth;
    private folderPath;
    private notePath;
    private assertNameAvailable;
    private listAllChildren;
    private collectTree;
    private maximumSubtreeDepth;
    private signConfirmation;
    private verifyConfirmation;
    private serializeNoteOperation;
    private now;
    private timestamp;
}
export {};
//# sourceMappingURL=vault-service.d.ts.map