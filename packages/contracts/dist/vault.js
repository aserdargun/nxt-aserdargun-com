import { z } from "zod";
import { NoteIdSchema, NoteTitleSchema, TimestampSchema } from "./note.js";
export const DriveIdSchema = z.string().min(1).max(512);
export const VaultAttachmentSchema = z
    .object({
    driveId: DriveIdSchema,
    name: z.string().trim().min(1).max(512),
    mimeType: z.string().trim().min(1).max(256),
    size: z.number().int().nonnegative()
})
    .strict();
export const VaultIndexEntrySchema = z
    .object({
    id: NoteIdSchema,
    title: NoteTitleSchema,
    aliases: z.array(z.string().trim().min(1).max(160)).max(64),
    driveId: DriveIdSchema,
    path: z.string().trim().min(1).max(4096),
    created: TimestampSchema,
    updated: TimestampSchema,
    driveVersion: z.string().min(1).max(512),
    tags: z.array(z.string().trim().min(1).max(64)).max(64),
    searchText: z.string().max(100_000),
    excerpt: z.string().max(4_000),
    outboundNoteIds: z.array(NoteIdSchema).max(10_000),
    unresolvedWikiTargets: z.array(z.string().trim().min(1).max(160)).max(10_000),
    attachments: z.array(VaultAttachmentSchema).max(10_000),
    backlinks: z.array(NoteIdSchema).max(10_000)
})
    .strict();
export const VaultIndexSchema = z
    .object({
    schemaVersion: z.literal(1),
    entries: z.array(VaultIndexEntrySchema).max(100_000)
})
    .strict();
export const PreferencesPanelStateSchema = z
    .object({
    activeContext: z.enum(["preview", "outline", "backlinks"]).optional(),
    explorerOpen: z.boolean().optional()
})
    .strict();
export const PreferencesSchema = z
    .object({
    schemaVersion: z.literal(1),
    favorites: z.array(NoteIdSchema).max(10_000),
    recent: z.array(NoteIdSchema).max(10_000),
    theme: z.enum(["dark", "light", "system"]),
    panelState: PreferencesPanelStateSchema.optional()
})
    .strict();
//# sourceMappingURL=vault.js.map