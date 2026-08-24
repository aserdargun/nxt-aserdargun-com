import { z } from "zod";
import { NoteIdSchema, NoteTitleSchema, TimestampSchema } from "./note.js";
import { AttachmentNameSchema } from "./attachment.js";

export const DriveIdSchema = z.string().min(1).max(512);
/** Internal, random, non-user-controlled proof that an artifact came from one attachment intent. */
export const AttachmentMutationMarkerSchema = z.string().regex(/^am1\.[A-Za-z0-9_-]{22}$/u);

export const VaultAttachmentSchema = z
  .object({
    driveId: DriveIdSchema,
    name: AttachmentNameSchema,
    mimeType: z.string().trim().min(1).max(256),
    size: z.number().int().nonnegative(),
    checksum: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    disposition: z.enum(["inline", "download"]).optional(),
    version: z.string().min(1).max(512).optional(),
    marker: AttachmentMutationMarkerSchema.optional()
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
    /** Canonical local attachment targets, maintained from the note source. */
    attachmentReferences: z.array(z.string().trim().min(1).max(4096)).max(10_000).default([]),
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
  "update-folder",
  "trash-folder",
  "create-attachment",
  "trash-attachment"
]);

export const VaultMutationPhaseSchema = z.enum([
  "reserved",
  "drive-inflight",
  "outcome-unknown",
  "drive-applied",
  "index-applied",
  "conflicted"
]);

export const VaultMutationDestinationAncestorSchema = z.object({
  id: DriveIdSchema,
  name: z.string().trim().min(1).max(255),
  parentId: DriveIdSchema,
  version: z.string().min(1).max(512)
}).strict();

export const VaultPendingMutationSchema = z
  .object({
    id: NoteIdSchema,
    operation: VaultMutationOperationSchema,
    noteId: NoteIdSchema.optional(),
    driveId: DriveIdSchema.optional(),
    folderId: DriveIdSchema.optional(),
    parentId: DriveIdSchema.optional(),
    targetParentId: DriveIdSchema.optional(),
    // Folder operations retain the Drive-compatible 255-character request
    // limit. Attachment operations apply their stricter Unicode-safe bound
    // below, rather than accidentally tightening every Task 7 mutation.
    targetName: z.string().trim().min(1).max(255).optional(),
    oldPath: z.string().trim().min(1).max(4096).optional(),
    newPath: z.string().trim().min(1).max(4096).optional(),
    preflightGeneration: z.number().int().nonnegative().optional(),
    destinationAncestry: z.array(VaultMutationDestinationAncestorSchema).min(1).max(21).optional(),
    expectedVersion: z.string().min(1).max(512).optional(),
    moveExpectedVersion: z.string().min(1).max(512).optional(),
    originalChecksum: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    expectedChecksum: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    attachmentMimeType: z.string().trim().min(1).max(256).optional(),
    attachmentSize: z.number().int().nonnegative().max(20 * 1024 * 1024).optional(),
    attachmentDisposition: z.enum(["inline", "download"]).optional(),
    attachmentReferenceId: z.string().max(512).optional(),
    attachmentMarker: AttachmentMutationMarkerSchema.optional(),
    recoveryAttempts: z.number().int().min(0).max(8).optional(),
    source: z.string().max(100_000).optional(),
    ownerId: NoteIdSchema.optional(),
    fence: z.number().int().positive().default(1),
    phase: VaultMutationPhaseSchema.default("reserved"),
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema,
    reconcileAfter: TimestampSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.operation === "create-attachment" || value.operation === "trash-attachment") &&
      value.targetName !== undefined
    ) {
      const result = AttachmentNameSchema.safeParse(value.targetName);
      if (!result.success) context.addIssue({ code: "custom", path: ["targetName"], message: "attachment name is too long" });
    }
  });

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

export const RescanRecoveryErrorSchema = z.enum([
  "Invalid Markdown frontmatter.",
  "External change detected. Rescan is reconciling the index."
]);

export const RescanRecoveryStateSchema = z.object({
  path: z.string().trim().min(1).max(4096),
  rawSource: z.string().max(100_000),
  error: RescanRecoveryErrorSchema
}).strict();

export const RescanResponseRecordStateSchema = z.object({
  noteId: NoteIdSchema,
  title: NoteTitleSchema,
  path: z.string().trim().min(1).max(4096),
  version: z.string().min(1).max(512)
}).strict();

export const VaultRescanTransitionSchema = z.object({
  fromPosition: z.number().int().nonnegative(),
  fromNonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
  fromExpiresAt: TimestampSchema,
  recoveryExpiresAt: TimestampSchema.nullable().default(null),
  receiptMac: z.string().regex(/^[A-Za-z0-9_-]{43}$/u).nullable().default(null),
  processed: z.number().int().min(0).max(100),
  records: z.array(RescanResponseRecordStateSchema).max(100),
  recoveries: z.array(RescanRecoveryStateSchema).max(100)
}).strict().refine(
  (value) => value.records.length + value.recoveries.length <= 100,
  { message: "rescan transition response exceeds 100 items" }
).refine(
  (value) => (value.recoveryExpiresAt === null) === (value.receiptMac === null),
  { message: "rescan transition receipt is incomplete" }
);

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
  deliveredRecoveryCount: z.number().int().nonnegative(),
  conflictMutationIds: z.array(NoteIdSchema).max(256).default([]),
  lastTransition: VaultRescanTransitionSchema.nullable().default(null)
}).strict();

export type VaultRescanState = z.infer<typeof VaultRescanStateSchema>;

export const VaultCompletedRescanSchema = VaultRescanTransitionSchema.safeExtend({
  scanId: NoteIdSchema,
  baseGeneration: z.number().int().nonnegative()
}).strict();

export const VaultIndexSchema = z
  .object({
    schemaVersion: z.literal(1),
    generation: z.number().int().nonnegative().default(0),
    entries: z.array(VaultIndexEntrySchema).max(100_000),
    pendingMutations: z.array(VaultPendingMutationSchema).max(256).default([]),
    rescanState: VaultRescanStateSchema.nullable().default(null),
    lastCompletedRescan: VaultCompletedRescanSchema.nullable().default(null)
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
