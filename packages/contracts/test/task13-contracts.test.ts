import * as contracts from "../src/index.js";
import { describe, expect, it } from "vitest";

const PUBLIC_ID = "A".repeat(22);
const ASSET_ID = "B".repeat(22);
const NOTE_ID = "018f47d2-6a34-7b2a-9f21-8a7034963aef";
const OPAQUE_ID = `v1.${"c".repeat(16)}.${"d".repeat(8)}.${"e".repeat(22)}`;

const schema = (name: string): { parse(value: unknown): unknown; safeParse(value: unknown): { success: boolean } } => {
  const candidate = (contracts as Record<string, unknown>)[name];
  expect(candidate, `${name} must be exported`).toBeDefined();
  return candidate as { parse(value: unknown): unknown; safeParse(value: unknown): { success: boolean } };
};

describe("Task 13 browser-safe contracts", () => {
  it("accepts only the closed nullable owner publication projection", () => {
    const publicationStatus = schema("PublicationStatusResponseSchema");
    const value = {
      publicId: PUBLIC_ID,
      publishedAt: "2026-08-26T12:00:00.000Z",
      sourceVersion: "7",
      attachmentCount: 2
    };

    expect(publicationStatus.parse(null)).toBeNull();
    expect(publicationStatus.parse(value)).toEqual(value);
    for (const forbidden of ["driveId", "snapshotFolderId", "activeRevisionId", "sourceNoteId"] as const) {
      expect(publicationStatus.safeParse({ ...value, [forbidden]: "private" }).success).toBe(false);
    }
  });

  it("requires the public source-version boundary and rejects arbitrary asset URLs", () => {
    const publicNote = schema("PublicNoteResponseSchema");
    const value = {
      title: "Published plan",
      html: "<h1>Published plan</h1>",
      publishedAt: "2026-08-26T12:00:00.000Z",
      sourceVersion: "7",
      assets: [{
        assetId: ASSET_ID,
        url: `/api/public/assets/${PUBLIC_ID}/${ASSET_ID}`,
        name: "diagram.png",
        mimeType: "image/png",
        disposition: "inline"
      }]
    };

    expect(publicNote.parse(value)).toEqual(value);
    expect(publicNote.safeParse({ ...value, sourceVersion: undefined }).success).toBe(false);
    expect(publicNote.safeParse({
      ...value,
      assets: [{ ...value.assets[0], url: `/api/public/assets/${"C".repeat(22)}/${ASSET_ID}` }]
    }).success).toBe(true);
    expect(publicNote.safeParse({
      ...value,
      assets: [{ ...value.assets[0], url: `https://drive.example/${ASSET_ID}` }]
    }).success).toBe(false);
  });

  it("accepts only the exact upload payload and opaque safe upload response", () => {
    const uploadRequest = schema("UploadAttachmentRequestSchema");
    const uploadResponse = schema("UploadAttachmentResponseSchema");
    const request = {
      noteId: NOTE_ID,
      name: "diagram.png",
      declaredMime: "image/png",
      bytesBase64: "iVBORw=="
    };
    const response = {
      asset: {
        assetId: OPAQUE_ID,
        name: "diagram.png",
        mimeType: "image/png",
        size: 4,
        disposition: "inline"
      }
    };

    expect(uploadRequest.parse(request)).toEqual(request);
    expect(uploadRequest.safeParse({ ...request, driveId: "raw" }).success).toBe(false);
    expect(uploadResponse.parse(response)).toEqual(response);
    expect(uploadResponse.safeParse({ asset: { ...response.asset, assetId: "raw-drive-id" } }).success).toBe(false);
    expect(uploadResponse.safeParse({ asset: { ...response.asset, driveId: "raw" } }).success).toBe(false);
  });
});
