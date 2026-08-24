import { z } from "zod";
import { AttachmentNameSchema } from "./attachment.js";
import { NoteIdSchema, TimestampSchema } from "./note.js";
import { DriveIdSchema } from "./vault.js";
const ChecksumSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const VersionSchema = z.string().min(1).max(512);
const MarkerSchema = z.string().regex(/^pm1\.[A-Za-z0-9_.-]{1,120}$/u).max(128);
const DispositionSchema = z.enum(["inline", "download"]);
const EpochSchema = z.number().int().positive();
export const MAX_PUBLICATION_ASSETS = 40;
export const MAX_PUBLICATION_TOTAL_ASSET_BYTES = 64 * 1024 * 1024;
export const PublishedAssetNameSchema = AttachmentNameSchema.refine((value) => value === value.normalize("NFC") && [...value].every((character) => {
    const code = character.codePointAt(0);
    return code > 31 && code !== 127 && character !== "/" && character !== "\\";
}), { message: "published asset name must be canonical and header-safe" });
/** Exactly 16 random bytes encoded without Base64 padding. */
export const PublicIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/u, "publicId must encode exactly 128 random bits");
export const PublicationAssetSchema = z.object({
    assetId: PublicIdSchema,
    snapshotDriveId: DriveIdSchema,
    mimeType: z.string().trim().min(1).max(256),
    fileName: PublishedAssetNameSchema,
    size: z.number().int().nonnegative().max(20 * 1024 * 1024),
    checksum: ChecksumSchema,
    disposition: DispositionSchema,
    marker: MarkerSchema,
    version: VersionSchema
}).strict();
export const PublicationRevisionSchema = z.object({
    revisionId: z.string().regex(/^[A-Za-z0-9_-]{3,64}$/u),
    operationId: PublicIdSchema,
    snapshotFolderId: DriveIdSchema,
    snapshotFolderVersion: VersionSchema,
    snapshotMarker: MarkerSchema,
    assetsFolderId: DriveIdSchema,
    assetsFolderVersion: VersionSchema,
    assetsMarker: MarkerSchema,
    noteSnapshotDriveId: DriveIdSchema,
    noteVersion: VersionSchema,
    noteChecksum: ChecksumSchema,
    noteSize: z.number().int().nonnegative().max(2 * 1024 * 1024),
    noteMarker: MarkerSchema,
    sourceVersion: VersionSchema,
    sourceChecksum: ChecksumSchema,
    sourcePath: z.string().trim().min(1).max(4096),
    publishedAt: TimestampSchema,
    assets: z.array(PublicationAssetSchema).max(MAX_PUBLICATION_ASSETS)
}).strict().superRefine((value, context) => {
    const ids = new Set();
    value.assets.forEach((asset, index) => {
        if (ids.has(asset.assetId))
            context.addIssue({ code: "custom", path: ["assets", index, "assetId"], message: "assetId must be unique" });
        ids.add(asset.assetId);
    });
    if (value.assets.reduce((total, asset) => total + asset.size, 0) > MAX_PUBLICATION_TOTAL_ASSET_BYTES) {
        context.addIssue({ code: "custom", path: ["assets"], message: "publication asset bytes exceed the bounded snapshot limit" });
    }
});
export const PublicationEntrySchema = z.object({
    publicId: PublicIdSchema,
    sourceNoteId: NoteIdSchema,
    epoch: EpochSchema,
    publicFolderId: DriveIdSchema,
    publicFolderVersion: VersionSchema,
    activeRevisionId: z.string().regex(/^[A-Za-z0-9_-]{3,64}$/u),
    revisions: z.array(PublicationRevisionSchema).min(1).max(32)
}).strict().superRefine((value, context) => {
    const ids = new Set(value.revisions.map((revision) => revision.revisionId));
    if (ids.size !== value.revisions.length)
        context.addIssue({ code: "custom", path: ["revisions"], message: "revisionId must be unique" });
    if (!ids.has(value.activeRevisionId))
        context.addIssue({ code: "custom", path: ["activeRevisionId"], message: "active revision is missing" });
});
export const PublicationTombstoneSchema = z.object({
    publicId: PublicIdSchema,
    sourceNoteId: NoteIdSchema,
    epoch: EpochSchema,
    publicFolderId: DriveIdSchema,
    publicFolderVersion: VersionSchema,
    revokedAt: TimestampSchema
}).strict();
export const PublicationOperationSchema = z.object({
    operationId: PublicIdSchema,
    publicId: PublicIdSchema,
    sourceNoteId: NoteIdSchema,
    epoch: EpochSchema,
    startedAt: TimestampSchema,
    sourceVersion: VersionSchema,
    sourceChecksum: ChecksumSchema,
    sourcePath: z.string().trim().min(1).max(4096),
    publicFolderId: DriveIdSchema.nullable().default(null),
    publicFolderVersion: VersionSchema.nullable().default(null),
    revisionFolderId: DriveIdSchema.nullable().default(null),
    revisionFolderVersion: VersionSchema.nullable().default(null),
    revisionId: z.string().regex(/^[A-Za-z0-9_-]{3,64}$/u).nullable().default(null),
    revisionMarker: MarkerSchema.nullable().default(null)
}).strict();
export const PublicationCleanupSchema = z.object({
    cleanupId: PublicIdSchema,
    publicId: PublicIdSchema,
    folderId: DriveIdSchema,
    expectedVersion: VersionSchema,
    marker: MarkerSchema,
    kind: z.enum(["public-root", "revision"]),
    queuedAt: TimestampSchema
}).strict();
export const PublicationManifestSchema = z.object({
    schemaVersion: z.literal(1),
    generation: z.number().int().nonnegative().default(0),
    entries: z.array(PublicationEntrySchema).max(10_000),
    tombstones: z.array(PublicationTombstoneSchema).max(10_000).default([]),
    operations: z.array(PublicationOperationSchema).max(64).default([]),
    cleanup: z.array(PublicationCleanupSchema).max(64).default([])
}).strict().superRefine((value, context) => {
    const publicIds = new Set();
    const noteIds = new Set();
    value.entries.forEach((entry, index) => {
        if (publicIds.has(entry.publicId) || noteIds.has(entry.sourceNoteId))
            context.addIssue({ code: "custom", path: ["entries", index], message: "active publications must be unique" });
        publicIds.add(entry.publicId);
        noteIds.add(entry.sourceNoteId);
    });
    value.tombstones.forEach((entry, index) => {
        if (publicIds.has(entry.publicId) || noteIds.has(entry.sourceNoteId))
            context.addIssue({ code: "custom", path: ["tombstones", index], message: "tombstones must not overlap active entries" });
        publicIds.add(entry.publicId);
        noteIds.add(entry.sourceNoteId);
    });
    if (new Set(value.operations.map((operation) => operation.operationId)).size !== value.operations.length)
        context.addIssue({ code: "custom", path: ["operations"], message: "operationId must be unique" });
    if (new Set(value.cleanup.map((cleanup) => cleanup.cleanupId)).size !== value.cleanup.length)
        context.addIssue({ code: "custom", path: ["cleanup"], message: "cleanupId must be unique" });
});
//# sourceMappingURL=publication.js.map