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
export declare const VaultIndexSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
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