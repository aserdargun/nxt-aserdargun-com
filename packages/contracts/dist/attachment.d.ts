import { z } from "zod";
/** Attachment names are measured in Unicode code points after NFC normalization. */
export declare const MAX_ATTACHMENT_NAME_CODE_POINTS = 180;
export declare const attachmentNameLength: (value: string) => number;
export declare const AttachmentNameSchema: z.ZodString;
//# sourceMappingURL=attachment.d.ts.map