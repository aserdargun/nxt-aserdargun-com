import { z } from "zod";
/** Attachment names are measured in Unicode code points after NFC normalization. */
export declare const MAX_ATTACHMENT_NAME_CODE_POINTS = 180;
export declare const attachmentNameLength: (value: string) => number;
export declare const MAX_FOLDER_NAME_CODE_POINTS = 255;
export declare const AttachmentNameSchema: z.ZodString;
/** Task 7 folder names share the NFC/code-point metric with attachments. */
export declare const FolderNameSchema: z.ZodString;
//# sourceMappingURL=attachment.d.ts.map