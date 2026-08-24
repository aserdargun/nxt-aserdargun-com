import { defaultSchema, type Options } from "rehype-sanitize";
import { isOpaqueId } from "@nxt/contracts";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { extractWikiLinks, type WikiLink } from "./wiki-links.js";

interface MarkdownNode {
  type: string;
  value?: unknown;
  depth?: number;
  children?: MarkdownNode[];
  data?: { hProperties?: Record<string, unknown> };
}

interface MarkdownRoot extends MarkdownNode {
  children: MarkdownNode[];
}

interface HtmlNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HtmlNode[];
}

export interface RenderedMarkdown {
  html: string;
  outline: Array<{ depth: number; id: string; text: string }>;
  wikiLinks: WikiLink[];
  plainText: string;
}

function textFromNode(node: { value?: unknown; children?: unknown[] }): string {
  if (typeof node.value === "string") return node.value;
  if (!Array.isArray(node.children)) return "";
  return node.children.map((child) => textFromNode(child as { value?: unknown; children?: unknown[] })).join("");
}

function headingId(text: string, ids: Map<string, number>): string {
  const base = text
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}_ -]/gu, "")
    .trim()
    .replace(/[ ]+/gu, "-") || "section";
  const count = (ids.get(base) ?? 0) + 1;
  ids.set(base, count);
  const suffixed = count === 1 ? base : `${base}-${count}`;
  return `nxt-heading-${suffixed}`;
}

function collectOutline(tree: MarkdownRoot): Array<{ depth: number; id: string; text: string }> {
  const outline: Array<{ depth: number; id: string; text: string }> = [];
  const ids = new Map<string, number>();
  for (const child of tree.children) {
    if (child.type !== "heading") continue;
    const text = textFromNode(child);
    const id = headingId(text, ids);
    child.data = { ...child.data, hProperties: { ...(child.data?.hProperties ?? {}), id } };
    outline.push({ depth: child.depth!, id, text });
  }
  return outline;
}

function textFromHast(tree: HtmlNode): string {
  const parts: string[] = [];
  const visit = (node: HtmlNode): void => {
    if (node.type === "text" && typeof node.value === "string") parts.push(node.value);
    if (Array.isArray(node.children)) node.children.forEach(visit);
  };
  visit(tree);
  return parts.join(" ").replace(/\s+/gu, " ").trim();
}

const PUBLIC_ATTACHMENT_PATH = /^\/api\/public\/assets\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/u;
const APPLICATION_ORIGIN = "https://nxt.invalid";

function isApplicationAttachmentUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.startsWith("/")) return false;
  try {
    const url = new URL(value, APPLICATION_ORIGIN);
    if (url.origin !== APPLICATION_ORIGIN || url.search.length > 0 || url.hash.length > 0 || url.pathname !== value) return false;
    const privatePrefix = "/api/private/attachments/";
    return (url.pathname.startsWith(privatePrefix) && isOpaqueId(url.pathname.slice(privatePrefix.length))) || PUBLIC_ATTACHMENT_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

function restrictAttachmentUrls() {
  return (tree: unknown): void => {
    const visit = (node: unknown): void => {
      if (typeof node !== "object" || node === null) return;
      const html = node as HtmlNode;
      if (html.type === "element" && html.tagName === "img" && !isApplicationAttachmentUrl(html.properties?.src)) {
        delete html.properties?.src;
      }
      html.children?.forEach(visit);
    };
    visit(tree);
  };
}

const sanitizerSchema: Options = {
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

function createMarkdownProcessor() {
  return unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ["yaml"])
    .use(remarkGfm)
    // Deliberately omit rehype-raw: raw HTML is discarded instead of interpreted.
    .use(remarkRehype)
    .use(restrictAttachmentUrls)
    .use(rehypeHighlight)
    .use(rehypeSanitize, sanitizerSchema)
    .use(rehypeStringify);
}

function deriveMarkdown(source: string) {
  const processor = createMarkdownProcessor();
  const markdownTree = processor.parse(source);
  const outline = collectOutline(markdownTree as unknown as MarkdownRoot);
  return { processor, outline, hastTree: processor.runSync(markdownTree) };
}

/** Derives visible text using the same Markdown and HAST pipeline as rendering. */
export function deriveMarkdownPlainText(source: string): string {
  return textFromHast(deriveMarkdown(source).hastTree);
}

/** Renders GFM and strips every raw HTML node before serializing sanitized HTML. */
export function renderMarkdown(source: string): Promise<RenderedMarkdown> {
  const { hastTree, outline, processor } = deriveMarkdown(source);
  const html = processor.stringify(hastTree);

  return Promise.resolve({
    html,
    outline,
    wikiLinks: extractWikiLinks(source),
    plainText: textFromHast(hastTree)
  });
}
