import { z } from "zod";
import { NoteIdSchema, TimestampSchema } from "./note.js";
import { DriveIdSchema } from "./vault.js";

export const PublicIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22,}$/u, "publicId must be base64url with at least 128 bits");

export const PublicationAssetSchema = z
  .object({
    assetId: PublicIdSchema,
    snapshotDriveId: DriveIdSchema,
    mimeType: z.string().trim().min(1).max(256),
    fileName: z.string().trim().min(1).max(512)
  })
  .strict();

export type PublicationAsset = z.infer<typeof PublicationAssetSchema>;

const assertUniqueAssetIds = (value: { assets: PublicationAsset[] }, context: z.RefinementCtx): void => {
  const assetIds = new Set<string>();
  value.assets.forEach((asset, index) => {
    if (assetIds.has(asset.assetId)) {
      context.addIssue({ code: "custom", path: ["assets", index, "assetId"], message: "assetId must be unique" });
    }
    assetIds.add(asset.assetId);
  });
};

export const PublicationEntrySchema = z
  .object({
    publicId: PublicIdSchema,
    snapshotDriveId: DriveIdSchema,
    sourceNoteId: NoteIdSchema,
    publishedAt: TimestampSchema,
    revision: z.string().min(1).max(512),
    assets: z.array(PublicationAssetSchema).max(10_000)
  })
  .strict()
  .superRefine(assertUniqueAssetIds);

export type PublicationEntry = z.infer<typeof PublicationEntrySchema>;

export const PublicationManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    entries: z.array(PublicationEntrySchema).max(100_000)
  })
  .strict()
  .superRefine((value, context) => {
    const publicIds = new Set<string>();
    value.entries.forEach((entry, index) => {
      if (publicIds.has(entry.publicId)) {
        context.addIssue({ code: "custom", path: ["entries", index, "publicId"], message: "publicId must be unique" });
      }
      publicIds.add(entry.publicId);
    });
  });

export type PublicationManifest = z.infer<typeof PublicationManifestSchema>;
