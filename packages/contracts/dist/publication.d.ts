import { z } from "zod";
export declare const PublicIdSchema: z.ZodString;
export declare const PublicationAssetSchema: z.ZodObject<{
    assetId: z.ZodString;
    snapshotDriveId: z.ZodString;
    mimeType: z.ZodString;
    fileName: z.ZodString;
}, z.core.$strict>;
export type PublicationAsset = z.infer<typeof PublicationAssetSchema>;
export declare const PublicationEntrySchema: z.ZodObject<{
    publicId: z.ZodString;
    snapshotDriveId: z.ZodString;
    sourceNoteId: z.ZodUUID;
    publishedAt: z.ZodISODateTime;
    revision: z.ZodString;
    assets: z.ZodArray<z.ZodObject<{
        assetId: z.ZodString;
        snapshotDriveId: z.ZodString;
        mimeType: z.ZodString;
        fileName: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type PublicationEntry = z.infer<typeof PublicationEntrySchema>;
export declare const PublicationManifestSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    entries: z.ZodArray<z.ZodObject<{
        publicId: z.ZodString;
        snapshotDriveId: z.ZodString;
        sourceNoteId: z.ZodUUID;
        publishedAt: z.ZodISODateTime;
        revision: z.ZodString;
        assets: z.ZodArray<z.ZodObject<{
            assetId: z.ZodString;
            snapshotDriveId: z.ZodString;
            mimeType: z.ZodString;
            fileName: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type PublicationManifest = z.infer<typeof PublicationManifestSchema>;
//# sourceMappingURL=publication.d.ts.map