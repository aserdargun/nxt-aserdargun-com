import { z } from "zod";
export declare const DriveIdSchema: z.ZodString;
export declare const VaultAttachmentSchema: z.ZodObject<{
    driveId: z.ZodString;
    name: z.ZodString;
    mimeType: z.ZodString;
    size: z.ZodNumber;
}, z.core.$strict>;
export type VaultAttachment = z.infer<typeof VaultAttachmentSchema>;
export declare const VaultIndexEntrySchema: z.ZodObject<{
    id: z.ZodUUID;
    title: z.ZodString;
    aliases: z.ZodArray<z.ZodString>;
    driveId: z.ZodString;
    path: z.ZodString;
    created: z.ZodISODateTime;
    updated: z.ZodISODateTime;
    driveVersion: z.ZodString;
    tags: z.ZodArray<z.ZodString>;
    searchText: z.ZodString;
    excerpt: z.ZodString;
    outboundNoteIds: z.ZodArray<z.ZodUUID>;
    unresolvedWikiTargets: z.ZodArray<z.ZodString>;
    attachments: z.ZodArray<z.ZodObject<{
        driveId: z.ZodString;
        name: z.ZodString;
        mimeType: z.ZodString;
        size: z.ZodNumber;
    }, z.core.$strict>>;
    backlinks: z.ZodArray<z.ZodUUID>;
}, z.core.$strict>;
export type VaultIndexEntry = z.infer<typeof VaultIndexEntrySchema>;
export declare const VaultMutationOperationSchema: z.ZodEnum<{
    "create-note": "create-note";
    "update-note": "update-note";
    "move-note": "move-note";
    "trash-note": "trash-note";
    "create-folder": "create-folder";
    "rename-folder": "rename-folder";
    "move-folder": "move-folder";
    "update-folder": "update-folder";
    "trash-folder": "trash-folder";
}>;
export declare const VaultMutationPhaseSchema: z.ZodEnum<{
    reserved: "reserved";
    "drive-inflight": "drive-inflight";
    "outcome-unknown": "outcome-unknown";
    "drive-applied": "drive-applied";
    "index-applied": "index-applied";
    conflicted: "conflicted";
}>;
export declare const VaultPendingMutationSchema: z.ZodObject<{
    id: z.ZodUUID;
    operation: z.ZodEnum<{
        "create-note": "create-note";
        "update-note": "update-note";
        "move-note": "move-note";
        "trash-note": "trash-note";
        "create-folder": "create-folder";
        "rename-folder": "rename-folder";
        "move-folder": "move-folder";
        "update-folder": "update-folder";
        "trash-folder": "trash-folder";
    }>;
    noteId: z.ZodOptional<z.ZodUUID>;
    driveId: z.ZodOptional<z.ZodString>;
    folderId: z.ZodOptional<z.ZodString>;
    parentId: z.ZodOptional<z.ZodString>;
    targetParentId: z.ZodOptional<z.ZodString>;
    targetName: z.ZodOptional<z.ZodString>;
    oldPath: z.ZodOptional<z.ZodString>;
    newPath: z.ZodOptional<z.ZodString>;
    expectedVersion: z.ZodOptional<z.ZodString>;
    moveExpectedVersion: z.ZodOptional<z.ZodString>;
    originalChecksum: z.ZodOptional<z.ZodString>;
    expectedChecksum: z.ZodOptional<z.ZodString>;
    source: z.ZodOptional<z.ZodString>;
    ownerId: z.ZodOptional<z.ZodUUID>;
    fence: z.ZodDefault<z.ZodNumber>;
    phase: z.ZodDefault<z.ZodEnum<{
        reserved: "reserved";
        "drive-inflight": "drive-inflight";
        "outcome-unknown": "outcome-unknown";
        "drive-applied": "drive-applied";
        "index-applied": "index-applied";
        conflicted: "conflicted";
    }>>;
    createdAt: z.ZodISODateTime;
    expiresAt: z.ZodISODateTime;
    reconcileAfter: z.ZodOptional<z.ZodISODateTime>;
}, z.core.$strict>;
export type VaultPendingMutation = z.infer<typeof VaultPendingMutationSchema>;
export declare const RescanStagedRecordSchema: z.ZodObject<{
    source: z.ZodString;
    driveId: z.ZodString;
    path: z.ZodString;
    driveVersion: z.ZodString;
    attachments: z.ZodArray<z.ZodObject<{
        driveId: z.ZodString;
        name: z.ZodString;
        mimeType: z.ZodString;
        size: z.ZodNumber;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const RescanRecoveryStateSchema: z.ZodObject<{
    path: z.ZodString;
    rawSource: z.ZodString;
    error: z.ZodLiteral<"Invalid Markdown frontmatter.">;
}, z.core.$strict>;
export declare const VaultRescanStateSchema: z.ZodObject<{
    scanId: z.ZodUUID;
    baseGeneration: z.ZodNumber;
    position: z.ZodNumber;
    nonce: z.ZodString;
    startedAt: z.ZodISODateTime;
    expiresAt: z.ZodISODateTime;
    queue: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"list">;
        folderId: z.ZodString;
        path: z.ZodString;
        depth: z.ZodNumber;
        pageToken: z.ZodOptional<z.ZodString>;
        seenPageTokens: z.ZodArray<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"read">;
        driveId: z.ZodString;
        path: z.ZodString;
        driveVersion: z.ZodString;
    }, z.core.$strict>], "kind">>;
    records: z.ZodArray<z.ZodObject<{
        source: z.ZodString;
        driveId: z.ZodString;
        path: z.ZodString;
        driveVersion: z.ZodString;
        attachments: z.ZodArray<z.ZodObject<{
            driveId: z.ZodString;
            name: z.ZodString;
            mimeType: z.ZodString;
            size: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    seenDriveIds: z.ZodArray<z.ZodString>;
    seenNoteIds: z.ZodArray<z.ZodUUID>;
    recoveries: z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        rawSource: z.ZodString;
        error: z.ZodLiteral<"Invalid Markdown frontmatter.">;
    }, z.core.$strict>>;
    deliveredRecoveryCount: z.ZodNumber;
}, z.core.$strict>;
export type VaultRescanState = z.infer<typeof VaultRescanStateSchema>;
export declare const VaultIndexSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    generation: z.ZodDefault<z.ZodNumber>;
    entries: z.ZodArray<z.ZodObject<{
        id: z.ZodUUID;
        title: z.ZodString;
        aliases: z.ZodArray<z.ZodString>;
        driveId: z.ZodString;
        path: z.ZodString;
        created: z.ZodISODateTime;
        updated: z.ZodISODateTime;
        driveVersion: z.ZodString;
        tags: z.ZodArray<z.ZodString>;
        searchText: z.ZodString;
        excerpt: z.ZodString;
        outboundNoteIds: z.ZodArray<z.ZodUUID>;
        unresolvedWikiTargets: z.ZodArray<z.ZodString>;
        attachments: z.ZodArray<z.ZodObject<{
            driveId: z.ZodString;
            name: z.ZodString;
            mimeType: z.ZodString;
            size: z.ZodNumber;
        }, z.core.$strict>>;
        backlinks: z.ZodArray<z.ZodUUID>;
    }, z.core.$strict>>;
    pendingMutations: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodUUID;
        operation: z.ZodEnum<{
            "create-note": "create-note";
            "update-note": "update-note";
            "move-note": "move-note";
            "trash-note": "trash-note";
            "create-folder": "create-folder";
            "rename-folder": "rename-folder";
            "move-folder": "move-folder";
            "update-folder": "update-folder";
            "trash-folder": "trash-folder";
        }>;
        noteId: z.ZodOptional<z.ZodUUID>;
        driveId: z.ZodOptional<z.ZodString>;
        folderId: z.ZodOptional<z.ZodString>;
        parentId: z.ZodOptional<z.ZodString>;
        targetParentId: z.ZodOptional<z.ZodString>;
        targetName: z.ZodOptional<z.ZodString>;
        oldPath: z.ZodOptional<z.ZodString>;
        newPath: z.ZodOptional<z.ZodString>;
        expectedVersion: z.ZodOptional<z.ZodString>;
        moveExpectedVersion: z.ZodOptional<z.ZodString>;
        originalChecksum: z.ZodOptional<z.ZodString>;
        expectedChecksum: z.ZodOptional<z.ZodString>;
        source: z.ZodOptional<z.ZodString>;
        ownerId: z.ZodOptional<z.ZodUUID>;
        fence: z.ZodDefault<z.ZodNumber>;
        phase: z.ZodDefault<z.ZodEnum<{
            reserved: "reserved";
            "drive-inflight": "drive-inflight";
            "outcome-unknown": "outcome-unknown";
            "drive-applied": "drive-applied";
            "index-applied": "index-applied";
            conflicted: "conflicted";
        }>>;
        createdAt: z.ZodISODateTime;
        expiresAt: z.ZodISODateTime;
        reconcileAfter: z.ZodOptional<z.ZodISODateTime>;
    }, z.core.$strict>>>;
    rescanState: z.ZodDefault<z.ZodNullable<z.ZodObject<{
        scanId: z.ZodUUID;
        baseGeneration: z.ZodNumber;
        position: z.ZodNumber;
        nonce: z.ZodString;
        startedAt: z.ZodISODateTime;
        expiresAt: z.ZodISODateTime;
        queue: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"list">;
            folderId: z.ZodString;
            path: z.ZodString;
            depth: z.ZodNumber;
            pageToken: z.ZodOptional<z.ZodString>;
            seenPageTokens: z.ZodArray<z.ZodString>;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"read">;
            driveId: z.ZodString;
            path: z.ZodString;
            driveVersion: z.ZodString;
        }, z.core.$strict>], "kind">>;
        records: z.ZodArray<z.ZodObject<{
            source: z.ZodString;
            driveId: z.ZodString;
            path: z.ZodString;
            driveVersion: z.ZodString;
            attachments: z.ZodArray<z.ZodObject<{
                driveId: z.ZodString;
                name: z.ZodString;
                mimeType: z.ZodString;
                size: z.ZodNumber;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        seenDriveIds: z.ZodArray<z.ZodString>;
        seenNoteIds: z.ZodArray<z.ZodUUID>;
        recoveries: z.ZodArray<z.ZodObject<{
            path: z.ZodString;
            rawSource: z.ZodString;
            error: z.ZodLiteral<"Invalid Markdown frontmatter.">;
        }, z.core.$strict>>;
        deliveredRecoveryCount: z.ZodNumber;
    }, z.core.$strict>>>;
}, z.core.$strict>;
export type VaultIndex = z.infer<typeof VaultIndexSchema>;
export declare const PreferencesPanelStateSchema: z.ZodObject<{
    activeContext: z.ZodOptional<z.ZodEnum<{
        outline: "outline";
        backlinks: "backlinks";
        preview: "preview";
    }>>;
    explorerOpen: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
export declare const PreferencesSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    favorites: z.ZodArray<z.ZodUUID>;
    recent: z.ZodArray<z.ZodUUID>;
    theme: z.ZodEnum<{
        dark: "dark";
        light: "light";
        system: "system";
    }>;
    panelState: z.ZodOptional<z.ZodObject<{
        activeContext: z.ZodOptional<z.ZodEnum<{
            outline: "outline";
            backlinks: "backlinks";
            preview: "preview";
        }>>;
        explorerOpen: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type Preferences = z.infer<typeof PreferencesSchema>;
//# sourceMappingURL=vault.d.ts.map