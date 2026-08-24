import { z } from "zod";
import { AttachmentNameSchema, FolderNameSchema } from "./attachment.js";
import { NoteDocumentSchema, NoteIdSchema, NoteTitleSchema, TimestampSchema } from "./note.js";
import { MAX_PUBLICATION_ASSETS, PublicIdSchema, PublishedAssetNameSchema } from "./publication.js";
import { PreferencesPanelStateSchema, PreferencesSchema, RescanRecoveryErrorSchema, VaultIndexEntrySchema } from "./vault.js";

export const MAX_NOTE_SOURCE_BYTES = 100_000;
const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
const PathSchema = z.string().trim().min(1).max(4096);
const VersionSchema = z.string().min(1).max(512);
const ChecksumSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const TreeVersionSchema = ChecksumSchema;
export const OpaqueIdSchema = z.string().max(512).regex(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{1,450}\.[A-Za-z0-9_-]{22}$/u);
export const isOpaqueId = (value: unknown): value is string => OpaqueIdSchema.safeParse(value).success;
export const ConfirmationTokenSchema = z.string().max(512).regex(/^c1\.[A-Za-z0-9_-]{16,430}\.[A-Za-z0-9_-]{43}$/u);
export const ScanCursorSchema = z.string().max(512).regex(/^s1\.[A-Za-z0-9_-]{16,430}\.[A-Za-z0-9_-]{43}$/u);

export const SafeVaultAttachmentSchema = z.object({
  name: AttachmentNameSchema,
  mimeType: z.string().trim().min(1).max(256),
  size: z.number().int().nonnegative(),
  disposition: z.enum(["inline", "download"]).optional()
}).strict();

export const SafeVaultIndexEntrySchema = VaultIndexEntrySchema.omit({ driveId: true, attachments: true, attachmentReferences: true }).extend({
  outboundNoteIds: z.array(NoteIdSchema).max(100),
  unresolvedWikiTargets: z.array(z.string().trim().min(1).max(160)).max(100),
  attachments: z.array(SafeVaultAttachmentSchema).max(100),
  backlinks: z.array(NoteIdSchema).max(100)
}).strict();

export const FolderDeleteConfirmationSchema = z.object({
  descendantCount: z.number().int().nonnegative(),
  treeVersion: TreeVersionSchema,
  expiresAt: TimestampSchema,
  confirmationToken: ConfirmationTokenSchema
}).strict();

export const FolderResponseSchema = z.object({
  id: OpaqueIdSchema,
  name: FolderNameSchema,
  path: PathSchema,
  version: VersionSchema,
  protected: z.boolean(),
  deleteConfirmation: FolderDeleteConfirmationSchema.nullable().optional()
}).strict();

export const PreferencesResponseSchema = PreferencesSchema.extend({
  favorites: z.array(NoteIdSchema).max(100),
  recent: z.array(NoteIdSchema).max(100)
}).strict();

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
    entries: z.array(SafeVaultIndexEntrySchema).max(100),
    preferences: PreferencesResponseSchema,
    folders: z.array(FolderResponseSchema).max(100),
    treeVersion: TreeVersionSchema,
    cursor: OpaqueIdSchema.nullable(),
    complete: z.boolean()
  })
  .strict();

export type VaultResponse = z.infer<typeof VaultResponseSchema>;

export const CreateNoteRequestSchema = z
  .object({
    title: NoteTitleSchema,
    body: z.string().refine((value) => utf8Bytes(value) <= MAX_NOTE_SOURCE_BYTES),
    folderId: OpaqueIdSchema
  })
  .strict();

export type CreateNoteRequest = z.infer<typeof CreateNoteRequestSchema>;

export const UpdateNoteRequestSchema = z
  .object({
    expectedVersion: VersionSchema,
    source: z.string().refine((value) => utf8Bytes(value) <= MAX_NOTE_SOURCE_BYTES)
  })
  .strict();

export type UpdateNoteRequest = z.infer<typeof UpdateNoteRequestSchema>;

export const MoveNoteRequestSchema = z
  .object({
    expectedVersion: VersionSchema,
    folderId: OpaqueIdSchema
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
    parentId: OpaqueIdSchema,
    name: FolderNameSchema
  })
  .strict();

export type CreateFolderRequest = z.infer<typeof CreateFolderRequestSchema>;

export const UpdateFolderRequestSchema = z
  .object({
    expectedVersion: VersionSchema,
    name: FolderNameSchema.optional(),
    parentId: OpaqueIdSchema.optional()
  })
  .strict()
  .refine((value) => value.name !== undefined || value.parentId !== undefined, { message: "name or parentId is required" });

export type UpdateFolderRequest = z.infer<typeof UpdateFolderRequestSchema>;

export const DeleteFolderRequestSchema = z
  .object({
    expectedTreeVersion: TreeVersionSchema,
    confirmationToken: ConfirmationTokenSchema.optional()
  })
  .strict();

export type DeleteFolderRequest = z.infer<typeof DeleteFolderRequestSchema>;

export const RescanVaultRequestSchema = z
  .object({
    cursor: ScanCursorSchema.nullable(),
    limit: z.number().int().min(1).max(100)
  })
  .strict();

export type RescanVaultRequest = z.infer<typeof RescanVaultRequestSchema>;

export const RescanVaultResponseSchema = z
  .object({
    cursor: ScanCursorSchema.nullable(),
    processed: z.number().int().nonnegative(),
    complete: z.boolean(),
    records: z.array(z.object({
      noteId: NoteIdSchema,
      title: NoteTitleSchema,
      path: PathSchema,
      version: VersionSchema
    }).strict()).max(100),
    recoveries: z.array(z.object({
      path: PathSchema,
      rawSource: z.string().refine((value) => utf8Bytes(value) <= MAX_NOTE_SOURCE_BYTES),
      error: RescanRecoveryErrorSchema
    }).strict()).max(100)
  })
  .strict()
  .refine(
    (value) => value.records.length + value.recoveries.length <= 100,
    { message: "rescan response exceeds 100 items" }
  );

export type RescanVaultResponse = z.infer<typeof RescanVaultResponseSchema>;

export const TrashResponseSchema = z.object({ trashed: z.literal(true) }).strict();

export const UpdatePreferencesRequestSchema = z
  .object({
    favorites: z.array(NoteIdSchema).max(100),
    recent: z.array(NoteIdSchema).max(100),
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
    source: z.string().refine((value) => utf8Bytes(value) <= MAX_NOTE_SOURCE_BYTES),
    version: VersionSchema,
    path: PathSchema,
    checksum: ChecksumSchema
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
    html: z.string().refine((value) => utf8Bytes(value) <= 2 * 1024 * 1024),
    publishedAt: TimestampSchema,
    assets: z.array(z.object({
      assetId: PublicIdSchema,
      url: z.string().regex(/^\/api\/public\/assets\/[A-Za-z0-9_-]{22}\/[A-Za-z0-9_-]{22}$/u),
      name: PublishedAssetNameSchema,
      mimeType: z.string().trim().min(1).max(256),
      disposition: z.enum(["inline", "download"])
    }).strict()).max(MAX_PUBLICATION_ASSETS)
  })
  .strict();

export type PublicNoteResponse = z.infer<typeof PublicNoteResponseSchema>;
