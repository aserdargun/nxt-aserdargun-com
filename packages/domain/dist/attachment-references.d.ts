export declare const createPortableAttachmentMarkdown: (input: {
    notePath: string;
    noteId: string;
    name: string;
    inlineImage: boolean;
}) => string;
/**
 * Derives the deletion fence from the exact same remark parser/plugins used
 * for rendering. The small wiki pass is the existing Obsidian dialect used by
 * the renderer/indexer; ordinary Markdown is never regex-scanned here.
 */
export declare const attachmentReferenceProjection: (source: string, notePath: string) => string[];
export declare const attachmentIsReferenced: (input: {
    source: string;
    notePath: string;
    noteId: string;
    name: string;
    opaqueId?: string;
}) => boolean;
export declare const projectionReferencesAttachment: (projection: readonly string[], input: {
    noteId: string;
    name: string;
    opaqueId?: string;
}) => boolean;
export declare const canonicalAttachmentReference: (raw: string, notePath: string) => string | undefined;
//# sourceMappingURL=attachment-references.d.ts.map