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

export type VaultAttachment = z.infer<typeof VaultAttachmentSchema>;

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

export type VaultIndexEntry = z.infer<typeof VaultIndexEntrySchema>;

export const VaultMutationOperationSchema = z.enum([
  "create-note",
  "update-note",
  "move-note",
  "trash-note",
  "create-folder",
  "rename-folder",
  "move-folder",
  "trash-folder"
]);

export const VaultPendingMutationSchema = z
  .object({
    id: NoteIdSchema,
    operation: VaultMutationOperationSchema,
    noteId: NoteIdSchema.optional(),
    driveId: DriveIdSchema.optional(),
    folderId: DriveIdSchema.optional(),
    parentId: DriveIdSchema.optional(),
    targetParentId: DriveIdSchema.optional(),
    targetName: z.string().trim().min(1).max(255).optional(),
    oldPath: z.string().trim().min(1).max(4096).optional(),
    newPath: z.string().trim().min(1).max(4096).optional(),
    expectedVersion: z.string().min(1).max(512).optional(),
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema
  })
  .strict();

export type VaultPendingMutation = z.infer<typeof VaultPendingMutationSchema>;

const RescanQueueItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("list"),
    folderId: DriveIdSchema,
    path: z.string().trim().min(1).max(4096),
    depth: z.number().int().min(0).max(20),
    pageToken: z.string().min(1).max(512).optional(),
    seenPageTokens: z.array(z.string().min(1).max(512)).max(1_000)
  }).strict(),
  z.object({
    kind: z.literal("read"),
    driveId: DriveIdSchema,
    path: z.string().trim().min(1).max(4096),
    driveVersion: z.string().min(1).max(512)
  }).strict()
]);

export const RescanStagedRecordSchema = z.object({
  source: z.string().max(100_000),
  driveId: DriveIdSchema,
  path: z.string().trim().min(1).max(4096),
  driveVersion: z.string().min(1).max(512),
  attachments: z.array(VaultAttachmentSchema).max(10_000)
}).strict();

export const RescanRecoveryStateSchema = z.object({
  path: z.string().trim().min(1).max(4096),
  rawSource: z.string().max(100_000),
  error: z.literal("Invalid Markdown frontmatter.")
}).strict();

export const VaultRescanStateSchema = z.object({
  scanId: NoteIdSchema,
  baseGeneration: z.number().int().nonnegative(),
  position: z.number().int().nonnegative(),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
  startedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  queue: z.array(RescanQueueItemSchema).max(100_000),
  records: z.array(RescanStagedRecordSchema).max(100_000),
  seenDriveIds: z.array(DriveIdSchema).max(100_000),
  seenNoteIds: z.array(NoteIdSchema).max(100_000),
  recoveries: z.array(RescanRecoveryStateSchema).max(1_000),
  deliveredRecoveryCount: z.number().int().nonnegative()
}).strict();

export type VaultRescanState = z.infer<typeof VaultRescanStateSchema>;

export const VaultIndexSchema = z
  .object({
    schemaVersion: z.literal(1),
    generation: z.number().int().nonnegative().default(0),
    entries: z.array(VaultIndexEntrySchema).max(100_000),
    pendingMutations: z.array(VaultPendingMutationSchema).max(256).default([]),
    rescanState: VaultRescanStateSchema.nullable().default(null)
  })
  .strict();

export type VaultIndex = z.infer<typeof VaultIndexSchema>;

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

export type Preferences = z.infer<typeof PreferencesSchema>;
