import { isOpaqueId } from "@nxt/contracts";
import { parseMarkdownAst } from "./render-markdown.js";
import { extractWikiLinks } from "./wiki-links.js";
const resolveRelativePosixPath = (notePath, segments) => {
    const resolved = [];
    const noteSegments = notePath.split("/").slice(0, -1);
    for (const segment of [...noteSegments, ...segments]) {
        if (segment.length === 0 || segment === ".")
            continue;
        if (segment === "..") {
            if (resolved.at(-1) === undefined || resolved.at(-1) === "..")
                resolved.push(segment);
            else
                resolved.pop();
            continue;
        }
        resolved.push(segment);
    }
    return resolved.join("/");
};
const markdownPathSegment = (value) => encodeURIComponent(value)
    .replace(/[!'()*]/gu, (character) => `%${character.codePointAt(0).toString(16).toUpperCase()}`);
const markdownLabel = (value) => [...value]
    .map((character) => character === "\\" || character === "[" || character === "]" ? `\\${character}` : character)
    .join("");
const noteDirectoryDepth = (notePath) => {
    const resolved = [];
    for (const segment of notePath.split("/").slice(0, -1)) {
        if (segment.length === 0 || segment === ".")
            continue;
        if (segment === "..")
            resolved.pop();
        else
            resolved.push(segment);
    }
    return resolved.length;
};
export const createPortableAttachmentMarkdown = (input) => {
    const name = input.name.normalize("NFC");
    const relativeRoot = "../".repeat(noteDirectoryDepth(input.notePath));
    const destination = `${relativeRoot}_assets/${input.noteId}/${markdownPathSegment(name)}`;
    return `${input.inlineImage ? "!" : ""}[${markdownLabel(name)}](<${destination}>)`;
};
/**
 * Derives the deletion fence from the exact same remark parser/plugins used
 * for rendering. The small wiki pass is the existing Obsidian dialect used by
 * the renderer/indexer; ordinary Markdown is never regex-scanned here.
 */
export const attachmentReferenceProjection = (source, notePath) => {
    const values = markdownDestinations(source);
    // The existing wiki dialect treats `#heading` as an Obsidian target suffix,
    // distinct from URL syntax, and `extractWikiLinks` already strips labels.
    values.push(...extractWikiLinks(source).map((link) => link.target.split("#")[0] ?? ""));
    return [...new Set(values.flatMap((value) => canonicalAttachmentReference(value, notePath) ?? []))];
};
export const attachmentIsReferenced = (input) => {
    const expectedPath = `_assets/${input.noteId}/${input.name}`.normalize("NFC");
    const expectedOpaque = input.opaqueId === undefined ? undefined : `/api/private/attachments/${input.opaqueId}`;
    return attachmentReferenceProjection(input.source, input.notePath).some((reference) => reference === expectedPath || reference === expectedOpaque);
};
export const projectionReferencesAttachment = (projection, input) => {
    const expectedPath = `_assets/${input.noteId}/${input.name}`.normalize("NFC");
    const expectedOpaque = input.opaqueId === undefined ? undefined : `/api/private/attachments/${input.opaqueId}`;
    return projection.some((reference) => reference === expectedPath || reference === expectedOpaque);
};
const markdownDestinations = (source) => {
    const definitions = new Map();
    const destinations = [];
    const references = [];
    const visit = (node) => {
        if (typeof node !== "object" || node === null)
            return;
        const record = node;
        if (record.type === "definition" && typeof record.identifier === "string" && typeof record.url === "string")
            definitions.set(referenceKey(record.identifier), record.url);
        if ((record.type === "link" || record.type === "image") && typeof record.url === "string")
            destinations.push(record.url);
        if ((record.type === "linkReference" || record.type === "imageReference") && typeof record.identifier === "string")
            references.push(record.identifier);
        record.children?.forEach(visit);
    };
    visit(parseMarkdownAst(source));
    for (const reference of references) {
        const destination = definitions.get(referenceKey(reference));
        if (destination !== undefined)
            destinations.push(destination);
    }
    return destinations;
};
export const canonicalAttachmentReference = (raw, notePath) => {
    const value = raw.trim();
    // Reject actual URL query/fragment syntax before percent decoding. This
    // permits literal `%23`/`%3F` filename characters without accepting a URL
    // fragment or query.
    if (value.length === 0 || value.includes("\u0000") || value.includes("?") || value.includes("#"))
        return undefined;
    if (value.startsWith("/api/private/attachments/")) {
        const token = value.slice("/api/private/attachments/".length);
        return isOpaqueId(token) && value === `/api/private/attachments/${token}` ? value : undefined;
    }
    if (value.startsWith("/") || value.startsWith("//") || /^[a-z][a-z0-9+.-]*:/iu.test(value))
        return undefined;
    const segments = [];
    for (const rawSegment of value.split("/")) {
        let segment;
        try {
            segment = decodeURIComponent(rawSegment);
        }
        catch {
            return undefined;
        }
        if (segment.includes("/") || segment.includes("\\") || segment.includes("\u0000"))
            return undefined;
        segments.push(segment);
    }
    const resolved = resolveRelativePosixPath(notePath, segments).normalize("NFC");
    return resolved.startsWith("_assets/") ? resolved : undefined;
};
const referenceKey = (value) => value.replace(/\s+/gu, " ").trim().normalize("NFC").toLocaleLowerCase("en-US");
//# sourceMappingURL=attachment-references.js.map