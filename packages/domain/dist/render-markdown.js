import { defaultSchema } from "rehype-sanitize";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { extractWikiLinks } from "./wiki-links.js";
function textFromNode(node) {
    if (typeof node.value === "string")
        return node.value;
    if (!Array.isArray(node.children))
        return "";
    return node.children.map((child) => textFromNode(child)).join("");
}
function headingId(text, ids) {
    const base = text
        .normalize("NFKC")
        .toLocaleLowerCase("en-US")
        .replace(/[^\p{L}\p{N}_ -]/gu, "")
        .trim()
        .replace(/[ ]+/gu, "-") || "section";
    const count = (ids.get(base) ?? 0) + 1;
    ids.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
}
function collectOutline(tree) {
    const outline = [];
    const ids = new Map();
    for (const child of tree.children) {
        if (child.type !== "heading")
            continue;
        const text = textFromNode(child);
        const id = headingId(text, ids);
        child.data = { ...child.data, hProperties: { ...(child.data?.hProperties ?? {}), id } };
        outline.push({ depth: child.depth, id, text });
    }
    return outline;
}
function textFromHast(tree) {
    const parts = [];
    const visit = (node) => {
        if (node.type === "text" && typeof node.value === "string")
            parts.push(node.value);
        if (Array.isArray(node.children))
            node.children.forEach(visit);
    };
    visit(tree);
    return parts.join(" ").replace(/\s+/gu, " ").trim();
}
const sanitizerSchema = {
    ...defaultSchema,
    clobber: [],
    attributes: {
        ...defaultSchema.attributes,
        code: [...(defaultSchema.attributes?.code ?? []), ["className", /^language-[\w-]+$/u, /^hljs(?:-[\w-]+)?$/u]],
        span: [...(defaultSchema.attributes?.span ?? []), ["className", /^hljs(?:-[\w-]+)?$/u]],
        input: ["type", "checked", "disabled"],
        h1: [...(defaultSchema.attributes?.h1 ?? []), "id"],
        h2: [...(defaultSchema.attributes?.h2 ?? []), "id"],
        h3: [...(defaultSchema.attributes?.h3 ?? []), "id"],
        h4: [...(defaultSchema.attributes?.h4 ?? []), "id"],
        h5: [...(defaultSchema.attributes?.h5 ?? []), "id"],
        h6: [...(defaultSchema.attributes?.h6 ?? []), "id"]
    }
};
/** Renders GFM and strips every raw HTML node before serializing sanitized HTML. */
export async function renderMarkdown(source) {
    const processor = unified()
        .use(remarkParse)
        .use(remarkFrontmatter, ["yaml"])
        .use(remarkGfm)
        // Deliberately omit rehype-raw: raw HTML is discarded instead of interpreted.
        .use(remarkRehype)
        .use(rehypeHighlight)
        .use(rehypeSanitize, sanitizerSchema)
        .use(rehypeStringify);
    const markdownTree = processor.parse(source);
    const outline = collectOutline(markdownTree);
    const hastTree = await processor.run(markdownTree);
    const html = processor.stringify(hastTree);
    return {
        html,
        outline,
        wikiLinks: extractWikiLinks(source),
        plainText: textFromHast(hastTree)
    };
}
//# sourceMappingURL=render-markdown.js.map