export declare const MAX_ATTACHMENT_BYTES: number;
export type AttachmentDisposition = "inline" | "download";
export type DetectedAttachment = {
    mimeType: string;
    disposition: AttachmentDisposition;
};
export declare const classifyAttachment: (mimeType: string) => AttachmentDisposition;
export declare const normalizeAttachmentName: (value: string) => string;
export declare const resolveAttachmentName: (requestedName: string, existingNames: readonly string[]) => string;
export declare const detectAttachment: (input: {
    name: string;
    declaredMime: string;
    bytes: Uint8Array;
}) => Promise<DetectedAttachment>;
export declare const isInlineExtensionCoherent: (mimeType: string, name: string) => boolean;
//# sourceMappingURL=attachment-policy.d.ts.map