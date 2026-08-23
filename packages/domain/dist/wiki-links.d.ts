export interface WikiLink {
    target: string;
    label: string | null;
}
export interface WikiLinkTarget {
    id: string;
    title: string;
    aliases: readonly string[];
}
export type WikiTargetResolution = {
    kind: "resolved";
    noteId: string;
} | {
    kind: "unresolved";
} | {
    kind: "ambiguous";
    candidateIds: string[];
};
export interface ResolvedWikiLink extends WikiLink {
    resolution: WikiTargetResolution;
}
/** Extracts only unambiguous wiki syntax outside fenced and inline code. */
export declare function extractWikiLinks(source: string): WikiLink[];
/** Resolves an exact title before considering aliases, never choosing a tie. */
export declare function resolveWikiTarget(target: string, notes: readonly WikiLinkTarget[]): WikiTargetResolution;
export declare function resolveWikiLinks(source: string, notes: readonly WikiLinkTarget[]): ResolvedWikiLink[];
export declare function resolveWikiLinks(links: readonly WikiLink[], notes: readonly WikiLinkTarget[]): ResolvedWikiLink[];
//# sourceMappingURL=wiki-links.d.ts.map