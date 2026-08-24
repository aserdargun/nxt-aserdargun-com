import { z } from "zod";
/** Attachment names are measured in Unicode code points after NFC normalization. */
export const MAX_ATTACHMENT_NAME_CODE_POINTS = 180;
export const attachmentNameLength = (value) => [...value.normalize("NFC")].length;
export const MAX_FOLDER_NAME_CODE_POINTS = 255;
export const AttachmentNameSchema = z.string().trim().min(1).refine((value) => attachmentNameLength(value) <= MAX_ATTACHMENT_NAME_CODE_POINTS, { message: "attachment name is too long" });
/** Task 7 folder names share the NFC/code-point metric with attachments. */
export const FolderNameSchema = z.string().trim().min(1).refine((value) => attachmentNameLength(value) <= MAX_FOLDER_NAME_CODE_POINTS, { message: "folder name is too long" });
//# sourceMappingURL=attachment.js.map