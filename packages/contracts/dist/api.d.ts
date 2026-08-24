import { z } from "zod";
export declare const MAX_NOTE_SOURCE_BYTES = 100000;
export declare const OpaqueIdSchema: z.ZodString;
export declare const ConfirmationTokenSchema: z.ZodString;
export declare const ScanCursorSchema: z.ZodString;
export declare const SafeVaultAttachmentSchema: z.ZodObject<{
    name: z.ZodString;
    mimeType: z.ZodString;
    size: z.ZodNumber;
}, z.core.$strict>;
export declare const SafeVaultIndexEntrySchema: z.ZodObject<{
    id: z.ZodUUID;
    title: z.ZodString;
    path: z.ZodString;
    created: z.ZodISODateTime;
    updated: z.ZodISODateTime;
    tags: z.ZodArray<z.ZodString>;
    aliases: z.ZodArray<z.ZodString>;
    driveVersion: z.ZodString;
    searchText: z.ZodString;
    excerpt: z.ZodString;
    outboundNoteIds: z.ZodArray<z.ZodUUID>;
    unresolvedWikiTargets: z.ZodArray<z.ZodString>;
    attachments: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        mimeType: z.ZodString;
        size: z.ZodNumber;
    }, z.core.$strict>>;
    backlinks: z.ZodArray<z.ZodUUID>;
}, z.core.$strict>;
export declare const FolderDeleteConfirmationSchema: z.ZodObject<{
    descendantCount: z.ZodNumber;
    treeVersion: z.ZodString;
    expiresAt: z.ZodISODateTime;
    confirmationToken: z.ZodString;
}, z.core.$strict>;
export declare const FolderResponseSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    path: z.ZodString;
    version: z.ZodString;
    protected: z.ZodBoolean;
    deleteConfirmation: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        descendantCount: z.ZodNumber;
        treeVersion: z.ZodString;
        expiresAt: z.ZodISODateTime;
        confirmationToken: z.ZodString;
    }, z.core.$strict>>>;
}, z.core.$strict>;
export declare const PreferencesResponseSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
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
    favorites: z.ZodArray<z.ZodUUID>;
    recent: z.ZodArray<z.ZodUUID>;
}, z.core.$strict>;
export declare const ApiErrorCodeSchema: z.ZodEnum<{
    UNAUTHORIZED: "UNAUTHORIZED";
    FORBIDDEN: "FORBIDDEN";
    NOT_FOUND: "NOT_FOUND";
    CONFLICT: "CONFLICT";
    INVALID_INPUT: "INVALID_INPUT";
    DRIVE_UNAVAILABLE: "DRIVE_UNAVAILABLE";
    UNSAFE_FILE: "UNSAFE_FILE";
    TOO_LARGE: "TOO_LARGE";
}>;
export declare const ApiErrorSchema: z.ZodObject<{
    error: z.ZodObject<{
        code: z.ZodEnum<{
            UNAUTHORIZED: "UNAUTHORIZED";
            FORBIDDEN: "FORBIDDEN";
            NOT_FOUND: "NOT_FOUND";
            CONFLICT: "CONFLICT";
            INVALID_INPUT: "INVALID_INPUT";
            DRIVE_UNAVAILABLE: "DRIVE_UNAVAILABLE";
            UNSAFE_FILE: "UNSAFE_FILE";
            TOO_LARGE: "TOO_LARGE";
        }>;
        message: z.ZodString;
        requestId: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
export declare const SessionResponseSchema: z.ZodObject<{
    user: z.ZodObject<{
        userDetails: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>;
export type SessionResponse = z.infer<typeof SessionResponseSchema>;
export declare const VaultResponseSchema: z.ZodObject<{
    entries: z.ZodArray<z.ZodObject<{
        id: z.ZodUUID;
        title: z.ZodString;
        path: z.ZodString;
        created: z.ZodISODateTime;
        updated: z.ZodISODateTime;
        tags: z.ZodArray<z.ZodString>;
        aliases: z.ZodArray<z.ZodString>;
        driveVersion: z.ZodString;
        searchText: z.ZodString;
        excerpt: z.ZodString;
        outboundNoteIds: z.ZodArray<z.ZodUUID>;
        unresolvedWikiTargets: z.ZodArray<z.ZodString>;
        attachments: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            mimeType: z.ZodString;
            size: z.ZodNumber;
        }, z.core.$strict>>;
        backlinks: z.ZodArray<z.ZodUUID>;
    }, z.core.$strict>>;
    preferences: z.ZodObject<{
        schemaVersion: z.ZodLiteral<1>;
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
        favorites: z.ZodArray<z.ZodUUID>;
        recent: z.ZodArray<z.ZodUUID>;
    }, z.core.$strict>;
    folders: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        path: z.ZodString;
        version: z.ZodString;
        protected: z.ZodBoolean;
        deleteConfirmation: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            descendantCount: z.ZodNumber;
            treeVersion: z.ZodString;
            expiresAt: z.ZodISODateTime;
            confirmationToken: z.ZodString;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
    treeVersion: z.ZodString;
    cursor: z.ZodNullable<z.ZodString>;
    complete: z.ZodBoolean;
}, z.core.$strict>;
export type VaultResponse = z.infer<typeof VaultResponseSchema>;
export declare const CreateNoteRequestSchema: z.ZodObject<{
    title: z.ZodString;
    body: z.ZodString;
    folderId: z.ZodString;
}, z.core.$strict>;
export type CreateNoteRequest = z.infer<typeof CreateNoteRequestSchema>;
export declare const UpdateNoteRequestSchema: z.ZodObject<{
    expectedVersion: z.ZodString;
    source: z.ZodString;
}, z.core.$strict>;
export type UpdateNoteRequest = z.infer<typeof UpdateNoteRequestSchema>;
export declare const MoveNoteRequestSchema: z.ZodObject<{
    expectedVersion: z.ZodString;
    folderId: z.ZodString;
}, z.core.$strict>;
export type MoveNoteRequest = z.infer<typeof MoveNoteRequestSchema>;
export declare const ArchiveNoteRequestSchema: z.ZodObject<{
    expectedVersion: z.ZodString;
}, z.core.$strict>;
export type ArchiveNoteRequest = z.infer<typeof ArchiveNoteRequestSchema>;
export declare const CreateFolderRequestSchema: z.ZodObject<{
    parentId: z.ZodString;
    name: z.ZodString;
}, z.core.$strict>;
export type CreateFolderRequest = z.infer<typeof CreateFolderRequestSchema>;
export declare const UpdateFolderRequestSchema: z.ZodObject<{
    expectedVersion: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
    parentId: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type UpdateFolderRequest = z.infer<typeof UpdateFolderRequestSchema>;
export declare const DeleteFolderRequestSchema: z.ZodObject<{
    expectedTreeVersion: z.ZodString;
    confirmationToken: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type DeleteFolderRequest = z.infer<typeof DeleteFolderRequestSchema>;
export declare const RescanVaultRequestSchema: z.ZodObject<{
    cursor: z.ZodNullable<z.ZodString>;
    limit: z.ZodNumber;
}, z.core.$strict>;
export type RescanVaultRequest = z.infer<typeof RescanVaultRequestSchema>;
export declare const RescanVaultResponseSchema: z.ZodObject<{
    cursor: z.ZodNullable<z.ZodString>;
    processed: z.ZodNumber;
    complete: z.ZodBoolean;
    records: z.ZodArray<z.ZodObject<{
        noteId: z.ZodUUID;
        title: z.ZodString;
        path: z.ZodString;
        version: z.ZodString;
    }, z.core.$strict>>;
    recoveries: z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        rawSource: z.ZodString;
        error: z.ZodEnum<{
            "Invalid Markdown frontmatter.": "Invalid Markdown frontmatter.";
            "External change detected. Rescan is reconciling the index.": "External change detected. Rescan is reconciling the index.";
        }>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type RescanVaultResponse = z.infer<typeof RescanVaultResponseSchema>;
export declare const TrashResponseSchema: z.ZodObject<{
    trashed: z.ZodLiteral<true>;
}, z.core.$strict>;
export declare const UpdatePreferencesRequestSchema: z.ZodObject<{
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
export type UpdatePreferencesRequest = z.infer<typeof UpdatePreferencesRequestSchema>;
export declare const PublishNoteRequestSchema: z.ZodObject<{
    expectedVersion: z.ZodString;
}, z.core.$strict>;
export type PublishNoteRequest = z.infer<typeof PublishNoteRequestSchema>;
export declare const RevokePublicationRequestSchema: z.ZodObject<{
    publicId: z.ZodString;
}, z.core.$strict>;
export type RevokePublicationRequest = z.infer<typeof RevokePublicationRequestSchema>;
export declare const NoteResponseSchema: z.ZodObject<{
    note: z.ZodObject<{
        frontmatter: z.ZodObject<{
            id: z.ZodUUID;
            title: z.ZodString;
            created: z.ZodISODateTime;
            updated: z.ZodISODateTime;
            tags: z.ZodArray<z.ZodString>;
            aliases: z.ZodArray<z.ZodString>;
        }, z.core.$strict>;
        body: z.ZodString;
    }, z.core.$strict>;
    source: z.ZodString;
    version: z.ZodString;
    path: z.ZodString;
    checksum: z.ZodString;
}, z.core.$strict>;
export type NoteResponse = z.infer<typeof NoteResponseSchema>;
export declare const PublicationResponseSchema: z.ZodObject<{
    publicId: z.ZodString;
    publishedAt: z.ZodISODateTime;
}, z.core.$strict>;
export type PublicationResponse = z.infer<typeof PublicationResponseSchema>;
export declare const PublicNoteResponseSchema: z.ZodObject<{
    title: z.ZodString;
    html: z.ZodString;
    publishedAt: z.ZodISODateTime;
}, z.core.$strict>;
export type PublicNoteResponse = z.infer<typeof PublicNoteResponseSchema>;
//# sourceMappingURL=api.d.ts.map