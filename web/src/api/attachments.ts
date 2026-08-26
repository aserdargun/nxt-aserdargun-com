import {
  OpaqueIdSchema,
  TrashResponseSchema,
  UploadAttachmentRequestSchema,
  UploadAttachmentResponseSchema,
  type UploadAttachmentRequest,
  type UploadAttachmentResponse
} from "@nxt/contracts";
import { requestJson } from "./client";

export type UploadedAttachment = UploadAttachmentResponse["asset"];

export interface AttachmentClient {
  upload(input: UploadAttachmentRequest): Promise<UploadAttachmentResponse>;
  trash(assetId: string): Promise<void>;
}

const attachmentPath = (assetId: string): `/api/private/attachments/${string}` =>
  `/api/private/attachments/${OpaqueIdSchema.parse(assetId)}`;

export const attachmentClient: AttachmentClient = {
  upload: (input) => requestJson("/api/private/attachments", UploadAttachmentResponseSchema, undefined, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(UploadAttachmentRequestSchema.parse(input))
  }),
  trash: async (assetId) => {
    await requestJson(attachmentPath(assetId), TrashResponseSchema, undefined, { method: "DELETE" });
  }
};
