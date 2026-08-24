/**
 * Extracts canonical local attachment targets from the Markdown dialect this
 * application accepts.  The projection deliberately excludes network URLs,
 * queries, fragments and malformed encodings so it can be used as a safe
 * deletion fence without rereading unrelated notes.
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
//# sourceMappingURL=attachment-references.d.ts.map