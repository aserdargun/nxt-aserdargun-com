import { type WikiLink } from "./wiki-links.js";
export interface RenderedMarkdown {
    html: string;
    outline: Array<{
        depth: number;
        id: string;
        text: string;
    }>;
    wikiLinks: WikiLink[];
    plainText: string;
}
/** Derives visible text using the same Markdown and HAST pipeline as rendering. */
export declare function deriveMarkdownPlainText(source: string): string;
/** Renders GFM and strips every raw HTML node before serializing sanitized HTML. */
export declare function renderMarkdown(source: string): Promise<RenderedMarkdown>;
//# sourceMappingURL=render-markdown.d.ts.map