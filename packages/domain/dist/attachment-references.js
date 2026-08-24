import { isOpaqueId } from "@nxt/contracts";
import { posix } from "node:path";
/**
 * Extracts canonical local attachment targets from the Markdown dialect this
 * application accepts.  The projection deliberately excludes network URLs,
 * queries, fragments and malformed encodings so it can be used as a safe
 * deletion fence without rereading unrelated notes.
 */
export const attachmentReferenceProjection = (source, notePath) => {
    const definitions = new Map();
    for (const definition of markdownDefinitions(source))
        definitions.set(referenceKey(definition.label), definition.destination);
    const values = [...markdownDestinations(source), ...wikiDestinations(source)];
    for (const usage of markdownReferenceUsages(source)) {
        const destination = definitions.get(referenceKey(usage));
        if (destination !== undefined)
            values.push(destination);
    }
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
const canonicalAttachmentReference = (raw, notePath) => {
    let value = raw.trim();
    if (value.startsWith("<") && value.endsWith(">"))
        value = value.slice(1, -1);
    value = unescapeMarkdown(value);
    try {
        value = decodeURIComponent(value);
    }
    catch {
        return undefined;
    }
    if (value.length === 0 || value.includes("\u0000") || value.includes("?") || value.includes("#"))
        return undefined;
    if (value.startsWith("/api/private/attachments/")) {
        const token = value.slice("/api/private/attachments/".length);
        return isOpaqueId(token) && value === `/api/private/attachments/${token}` ? value : undefined;
    }
    if (value.startsWith("/") || /^[a-z][a-z0-9+.-]*:/iu.test(value) || value.startsWith("//"))
        return undefined;
    const resolved = posix.normalize(posix.join(posix.dirname(notePath), value)).normalize("NFC");
    return resolved.startsWith("_assets/") ? resolved : undefined;
};
const markdownDefinitions = (source) => {
    const definitions = [];
    const lines = source.split(/\r?\n/u);
    for (const line of lines) {
        const match = /^\s{0,3}\[([^\]\r\n]+)\]:\s*(.*)$/u.exec(line);
        if (match === null)
            continue;
        const destination = destinationFromTail(match[2] ?? "");
        if (destination !== undefined)
            definitions.push({ label: match[1], destination });
    }
    return definitions;
};
const markdownDestinations = (source) => {
    const destinations = [];
    for (let index = 0; index < source.length; index += 1) {
        if (source[index] !== "]" || source[index + 1] !== "(")
            continue;
        const parsed = balancedDestination(source, index + 2);
        if (parsed === undefined)
            continue;
        destinations.push(parsed.destination);
        index = parsed.end - 1;
    }
    return destinations;
};
const markdownReferenceUsages = (source) => {
    const uses = [];
    const expression = /!?\[([^\]\r\n]+)\](?:\[([^\]\r\n]*)\])?/gu;
    for (const match of source.matchAll(expression)) {
        const full = match[0] ?? "";
        if (source[(match.index ?? 0) + full.length] === "(")
            continue;
        const label = match[2] === undefined || match[2] === "" ? match[1] : match[2];
        if (label !== undefined)
            uses.push(label);
    }
    return uses;
};
const wikiDestinations = (source) => {
    const values = [];
    const expression = /!?\[\[([^\]\r\n]+)\]\]/gu;
    for (const match of source.matchAll(expression)) {
        const target = (match[1] ?? "").split("|")[0]?.split("#")[0]?.trim();
        if (target !== undefined && target.length > 0)
            values.push(target);
    }
    return values;
};
const balancedDestination = (source, initial) => {
    let index = initial;
    while (index < source.length && /\s/u.test(source[index]))
        index += 1;
    if (source[index] === "<") {
        const end = source.indexOf(">", index + 1);
        if (end < 0 || /[\r\n]/u.test(source.slice(index + 1, end)))
            return undefined;
        const close = closingParen(source, end + 1);
        return close === undefined ? undefined : { destination: source.slice(index + 1, end), end: close };
    }
    const start = index;
    let depth = 0;
    let escaped = false;
    while (index < source.length) {
        const character = source[index];
        if (escaped) {
            escaped = false;
            index += 1;
            continue;
        }
        if (character === "\\") {
            escaped = true;
            index += 1;
            continue;
        }
        if (character === "(") {
            depth += 1;
            index += 1;
            continue;
        }
        if (character === ")") {
            if (depth === 0)
                return { destination: source.slice(start, index), end: index + 1 };
            depth -= 1;
            index += 1;
            continue;
        }
        if (depth === 0 && /\s/u.test(character)) {
            const close = closingParen(source, index);
            return close === undefined ? undefined : { destination: source.slice(start, index), end: close };
        }
        index += 1;
    }
    return undefined;
};
const closingParen = (source, initial) => {
    let depth = 0;
    let escaped = false;
    for (let index = initial; index < source.length; index += 1) {
        const character = source[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (character === "\\") {
            escaped = true;
            continue;
        }
        if (character === "(") {
            depth += 1;
            continue;
        }
        if (character === ")") {
            if (depth === 0)
                return index + 1;
            depth -= 1;
        }
        if (/\r|\n/u.test(character))
            return undefined;
    }
    return undefined;
};
const destinationFromTail = (tail) => {
    const start = tail.trimStart();
    if (start.startsWith("<")) {
        const end = start.indexOf(">");
        return end < 0 ? undefined : start.slice(1, end);
    }
    return /^([^\s\r\n]+)/u.exec(start)?.[1];
};
const referenceKey = (value) => value.replace(/\s+/gu, " ").trim().normalize("NFC").toLocaleLowerCase("en-US");
const unescapeMarkdown = (value) => value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/gu, "$1");
//# sourceMappingURL=attachment-references.js.map