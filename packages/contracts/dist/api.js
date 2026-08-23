import { z } from "zod";
import { NoteDocumentSchema, NoteIdSchema, NoteTitleSchema, TimestampSchema } from "./note.js";
import { PublicIdSchema } from "./publication.js";
import { DriveIdSchema, PreferencesPanelStateSchema, PreferencesSchema, VaultIndexSchema } from "./vault.js";
export const ApiErrorCodeSchema = z.enum([
    "UNAUTHORIZED",
    "FORBIDDEN",
    "NOT_FOUND",
    "CONFLICT",
    "INVALID_INPUT",
    "DRIVE_UNAVAILABLE",
    "UNSAFE_FILE",
    "TOO_LARGE"
]);
export const ApiErrorSchema = z
    .object({
    error: z
        .object({
        code: ApiErrorCodeSchema,
        message: z.string(),
        requestId: z.string()
    })
        .strict()
})
    .strict();
export const SessionResponseSchema = z
    .object({
    user: z.object({ userDetails: z.string().trim().min(1) }).strict()
})
    .strict();
export const VaultResponseSchema = z
    .object({
    index: VaultIndexSchema,
    preferences: PreferencesSchema
})
    .strict();
export const CreateNoteRequestSchema = z
    .object({
    title: NoteTitleSchema,
    body: z.string(),
    folderId: DriveIdSchema
})
    .strict();
export const UpdateNoteRequestSchema = z
    .object({
    expectedVersion: z.string().min(1).max(512),
    source: z.string()
})
    .strict();
export const MoveNoteRequestSchema = z
    .object({
    expectedVersion: z.string().min(1).max(512),
    folderId: DriveIdSchema
})
    .strict();
export const ArchiveNoteRequestSchema = z
    .object({
    expectedVersion: z.string().min(1).max(512)
})
    .strict();
export const CreateFolderRequestSchema = z
    .object({
    parentId: DriveIdSchema,
    name: z.string().trim().min(1).max(255)
})
    .strict();
export const UpdateFolderRequestSchema = z
    .object({
    expectedVersion: z.string().min(1).max(512),
    name: z.string().trim().min(1).max(255)
})
    .strict();
export const DeleteFolderRequestSchema = z
    .object({
    expectedTreeVersion: z.string().min(1).max(512),
    confirmationToken: z.string().min(1).max(512).optional()
})
    .strict();
export const RescanVaultRequestSchema = z
    .object({
    cursor: z.string().min(1).max(512).nullable(),
    limit: z.number().int().min(1).max(100)
})
    .strict();
export const RescanVaultResponseSchema = z
    .object({
    cursor: z.string().min(1).max(512).nullable(),
    processed: z.number().int().nonnegative(),
    complete: z.boolean()
})
    .strict();
export const UpdatePreferencesRequestSchema = z
    .object({
    favorites: z.array(NoteIdSchema).max(10_000),
    recent: z.array(NoteIdSchema).max(10_000),
    theme: z.enum(["dark", "light", "system"]),
    panelState: PreferencesPanelStateSchema.optional()
})
    .strict();
export const PublishNoteRequestSchema = z
    .object({
    expectedVersion: z.string().min(1).max(512)
})
    .strict();
export const RevokePublicationRequestSchema = z
    .object({
    publicId: PublicIdSchema
})
    .strict();
export const NoteResponseSchema = z
    .object({
    note: NoteDocumentSchema,
    driveId: DriveIdSchema,
    version: z.string().min(1).max(512),
    path: z.string().trim().min(1).max(4096)
})
    .strict();
export const PublicationResponseSchema = z
    .object({
    publicId: PublicIdSchema,
    publishedAt: TimestampSchema
})
    .strict();
export const PublicNoteResponseSchema = z
    .object({
    title: NoteTitleSchema,
    html: z.string(),
    publishedAt: TimestampSchema
})
    .strict();
//# sourceMappingURL=api.js.map