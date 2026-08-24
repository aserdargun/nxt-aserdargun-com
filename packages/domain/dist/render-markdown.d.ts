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
export interface RenderMarkdownOptions {
    /** Rewrites already parsed link/image destinations before sanitization. */
    rewriteUrl?: (value: string) => string | undefined;
}
/** Source AST shared by rendering and attachment-reference projection. */
export declare function parseMarkdownAst(source: string): unknown;
/** Derives visible text using the same Markdown and HAST pipeline as rendering. */
export declare function deriveMarkdownPlainText(source: string): string;
/** Renders GFM and strips every raw HTML node before serializing sanitized HTML. */
export declare function renderMarkdown(source: string, options?: RenderMarkdownOptions): Promise<RenderedMarkdown>;
//# sourceMappingURL=render-markdown.d.ts.map