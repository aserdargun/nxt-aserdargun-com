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

export type ApiError = z.infer<typeof ApiErrorSchema>;

export const SessionResponseSchema = z
  .object({
    user: z.object({ userDetails: z.string().trim().min(1) }).strict()
  })
  .strict();

export type SessionResponse = z.infer<typeof SessionResponseSchema>;

export const VaultResponseSchema = z
  .object({
    index: VaultIndexSchema,
    preferences: PreferencesSchema
  })
  .strict();

export type VaultResponse = z.infer<typeof VaultResponseSchema>;

export const CreateNoteRequestSchema = z
  .object({
    title: NoteTitleSchema,
    body: z.string(),
    folderId: DriveIdSchema
  })
  .strict();

export type CreateNoteRequest = z.infer<typeof CreateNoteRequestSchema>;

export const UpdateNoteRequestSchema = z
  .object({
    expectedVersion: z.string().min(1).max(512),
    source: z.string()
  })
  .strict();

export type UpdateNoteRequest = z.infer<typeof UpdateNoteRequestSchema>;

export const MoveNoteRequestSchema = z
  .object({
    expectedVersion: z.string().min(1).max(512),
    folderId: DriveIdSchema
  })
  .strict();

export type MoveNoteRequest = z.infer<typeof MoveNoteRequestSchema>;

export const ArchiveNoteRequestSchema = z
  .object({
    expectedVersion: z.string().min(1).max(512)
  })
  .strict();

export type ArchiveNoteRequest = z.infer<typeof ArchiveNoteRequestSchema>;

export const CreateFolderRequestSchema = z
  .object({
    parentId: DriveIdSchema,
    name: z.string().trim().min(1).max(255)
  })
  .strict();

export type CreateFolderRequest = z.infer<typeof CreateFolderRequestSchema>;

export const UpdateFolderRequestSchema = z
  .object({
    expectedVersion: z.string().min(1).max(512),
    name: z.string().trim().min(1).max(255)
  })
  .strict();

export type UpdateFolderRequest = z.infer<typeof UpdateFolderRequestSchema>;

export const DeleteFolderRequestSchema = z
  .object({
    expectedTreeVersion: z.string().min(1).max(512),
    confirmationToken: z.string().min(1).max(512).optional()
  })
  .strict();

export type DeleteFolderRequest = z.infer<typeof DeleteFolderRequestSchema>;

export const RescanVaultRequestSchema = z
  .object({
    cursor: z.string().min(1).max(512).nullable(),
    limit: z.number().int().min(1).max(100)
  })
  .strict();

export type RescanVaultRequest = z.infer<typeof RescanVaultRequestSchema>;

export const RescanVaultResponseSchema = z
  .object({
    cursor: z.string().min(1).max(512).nullable(),
    processed: z.number().int().nonnegative(),
    complete: z.boolean()
  })
  .strict();

export type RescanVaultResponse = z.infer<typeof RescanVaultResponseSchema>;

export const UpdatePreferencesRequestSchema = z
  .object({
    favorites: z.array(NoteIdSchema).max(10_000),
    recent: z.array(NoteIdSchema).max(10_000),
    theme: z.enum(["dark", "light", "system"]),
    panelState: PreferencesPanelStateSchema.optional()
  })
  .strict();

export type UpdatePreferencesRequest = z.infer<typeof UpdatePreferencesRequestSchema>;

export const PublishNoteRequestSchema = z
  .object({
    expectedVersion: z.string().min(1).max(512)
  })
  .strict();

export type PublishNoteRequest = z.infer<typeof PublishNoteRequestSchema>;

export const RevokePublicationRequestSchema = z
  .object({
    publicId: PublicIdSchema
  })
  .strict();

export type RevokePublicationRequest = z.infer<typeof RevokePublicationRequestSchema>;

export const NoteResponseSchema = z
  .object({
    note: NoteDocumentSchema,
    driveId: DriveIdSchema,
    version: z.string().min(1).max(512),
    path: z.string().trim().min(1).max(4096)
  })
  .strict();

export type NoteResponse = z.infer<typeof NoteResponseSchema>;

export const PublicationResponseSchema = z
  .object({
    publicId: PublicIdSchema,
    publishedAt: TimestampSchema
  })
  .strict();

export type PublicationResponse = z.infer<typeof PublicationResponseSchema>;

export const PublicNoteResponseSchema = z
  .object({
    title: NoteTitleSchema,
    html: z.string(),
    publishedAt: TimestampSchema
  })
  .strict();

export type PublicNoteResponse = z.infer<typeof PublicNoteResponseSchema>;
