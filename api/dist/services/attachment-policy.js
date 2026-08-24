import { fileTypeFromBuffer } from "file-type";
import { MAX_ATTACHMENT_NAME_CODE_POINTS, attachmentNameLength as contractAttachmentNameLength } from "@nxt/contracts";
import { ApiResponseError } from "../http/api-response.js";
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const attachmentNameLength = contractAttachmentNameLength;
const INLINE_MIME_TYPES = new Set([
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "application/pdf"
]);
const INLINE_EXTENSIONS = {
    "image/png": new Set(["png"]),
    "image/jpeg": new Set(["jpg", "jpeg"]),
    "image/webp": new Set(["webp"]),
    "image/gif": new Set(["gif"]),
    "application/pdf": new Set(["pdf"])
};
const RESERVED_NAMES = new Set([
    "con", "prn", "aux", "nul",
    "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
    "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"
]);
const SAFE_EXTENSION = /^[a-z0-9]{1,16}$/u;
const SEPARATOR = /[\\/]/gu;
const FORBIDDEN_DRIVE_MIME_TYPES = new Set([
    "application/vnd.google-apps.folder",
    "application/vnd.google-apps.shortcut"
]);
export const classifyAttachment = (mimeType) => INLINE_MIME_TYPES.has(mimeType.toLocaleLowerCase("en-US")) ? "inline" : "download";
/** Reject Drive container declarations before any storage operation can occur. */
export const assertAttachmentDeclaration = (declaredMime) => {
    if (FORBIDDEN_DRIVE_MIME_TYPES.has(normalizeMime(declaredMime)))
        throw new ApiResponseError("UNSAFE_FILE");
};
export const normalizeAttachmentName = (value) => {
    if (typeof value !== "string")
        throw new ApiResponseError("INVALID_INPUT");
    const cleaned = removeC0C1(value.normalize("NFC")).replace(SEPARATOR, "").trim().replace(/[. ]+$/gu, "");
    if (cleaned.length === 0 || cleaned === "." || cleaned === "..")
        throw new ApiResponseError("INVALID_INPUT");
    const { base, extension } = splitFinalSafeExtension(cleaned);
    const reserved = base.toLocaleLowerCase("en-US");
    if (base.length === 0 || base === "." || base === ".." || RESERVED_NAMES.has(reserved))
        throw new ApiResponseError("INVALID_INPUT");
    const maximumBaseLength = MAX_ATTACHMENT_NAME_CODE_POINTS - attachmentNameLength(extension);
    const shortenedBase = [...base].slice(0, maximumBaseLength).join("").replace(/[. ]+$/gu, "");
    if (shortenedBase.length === 0)
        throw new ApiResponseError("INVALID_INPUT");
    return `${shortenedBase}${extension}`;
};
export const resolveAttachmentName = (requestedName, existingNames) => {
    const normalized = normalizeAttachmentName(requestedName);
    const existing = new Set(existingNames.map(nameKey));
    if (!existing.has(nameKey(normalized)))
        return normalized;
    const { base, extension } = splitFinalSafeExtension(normalized);
    for (let suffix = 2; suffix <= 10_000; suffix += 1) {
        const marker = `-${suffix}`;
        const candidateBase = [...base].slice(0, MAX_ATTACHMENT_NAME_CODE_POINTS - attachmentNameLength(extension) - attachmentNameLength(marker)).join("").replace(/[. ]+$/gu, "");
        if (candidateBase.length === 0)
            throw new ApiResponseError("CONFLICT");
        const candidate = `${candidateBase}${marker}${extension}`;
        if (!existing.has(nameKey(candidate)))
            return candidate;
    }
    throw new ApiResponseError("CONFLICT");
};
export const detectAttachment = async (input) => {
    if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES)
        throw new ApiResponseError("TOO_LARGE");
    const name = normalizeAttachmentName(input.name);
    const extension = finalExtension(name);
    const declaredMime = normalizeMime(input.declaredMime);
    assertAttachmentDeclaration(declaredMime);
    let sniffed;
    try {
        sniffed = await fileTypeFromBuffer(input.bytes);
    }
    catch {
        sniffed = undefined;
    }
    const detectedMime = sniffed?.mime ?? detectSafeTextMime(input.bytes, extension) ?? "application/octet-stream";
    const extensionCoherent = extension !== undefined && INLINE_EXTENSIONS[detectedMime]?.has(extension) === true;
    const disposition = classifyAttachment(detectedMime) === "inline" && extensionCoherent && declaredMime === detectedMime && structurallyValidInline(input.bytes, detectedMime)
        ? "inline"
        : "download";
    return { mimeType: detectedMime, disposition };
};
export const isInlineExtensionCoherent = (mimeType, name) => {
    const extension = finalExtension(normalizeAttachmentName(name));
    return extension !== undefined && INLINE_EXTENSIONS[mimeType]?.has(extension) === true;
};
const detectSafeTextMime = (bytes, extension) => {
    if (bytes.some((byte) => byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)))
        return undefined;
    try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    catch {
        return undefined;
    }
    if (extension === "txt")
        return "text/plain";
    if (extension === "md" || extension === "markdown")
        return "text/markdown";
    return undefined;
};
const normalizeMime = (value) => typeof value === "string" ? value.trim().toLocaleLowerCase("en-US") : "";
const splitFinalSafeExtension = (name) => {
    const index = name.lastIndexOf(".");
    if (index <= 0 || index === name.length - 1)
        return { base: name, extension: "" };
    const suffix = name.slice(index + 1).toLocaleLowerCase("en-US");
    if (!SAFE_EXTENSION.test(suffix))
        return { base: name, extension: "" };
    return { base: name.slice(0, index), extension: `.${suffix}` };
};
const finalExtension = (name) => {
    const extension = splitFinalSafeExtension(name).extension;
    return extension.length === 0 ? undefined : extension.slice(1);
};
const nameKey = (name) => name.normalize("NFC").toLocaleLowerCase("en-US");
const structurallyValidInline = (bytes, mimeType) => {
    switch (mimeType) {
        case "image/png": return validPng(bytes);
        case "image/jpeg": return validJpeg(bytes);
        case "image/webp": return validWebp(bytes);
        case "image/gif": return validGif(bytes);
        case "application/pdf": return validPdf(bytes);
        default: return false;
    }
};
const validPng = (bytes) => {
    if (bytes.length < 45 || !equal(bytes, 0, [137, 80, 78, 71, 13, 10, 26, 10]))
        return false;
    let offset = 8;
    let sawIhdr = false;
    let sawIdat = false;
    while (offset + 12 <= bytes.length) {
        const length = u32be(bytes, offset);
        if (length === undefined || length > bytes.length - offset - 12)
            return false;
        const type = ascii(bytes, offset + 4, 4);
        if (type === undefined)
            return false;
        const dataEnd = offset + 8 + length;
        const expectedCrc = u32be(bytes, dataEnd);
        if (expectedCrc === undefined || crc32(bytes, offset + 4, dataEnd) !== expectedCrc)
            return false;
        if (!sawIhdr && (type !== "IHDR" || length !== 13))
            return false;
        if (type === "IHDR") {
            if (sawIhdr || u32be(bytes, offset + 8) === 0 || u32be(bytes, offset + 12) === 0)
                return false;
            sawIhdr = true;
        }
        if (type === "IDAT")
            sawIdat = true;
        offset = dataEnd + 4;
        if (type === "IEND")
            return length === 0 && sawIhdr && sawIdat && offset === bytes.length;
    }
    return false;
};
const validJpeg = (bytes) => {
    if (bytes.length < 8 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9)
        return false;
    let offset = 2;
    let sawFrame = false;
    while (offset < bytes.length - 2) {
        if (bytes[offset] !== 0xff)
            return false;
        while (bytes[offset] === 0xff)
            offset += 1;
        const marker = bytes[offset++];
        if (marker === undefined || marker === 0x00 || marker === 0xd9 || marker === 0xd8)
            return false;
        if (marker >= 0xd0 && marker <= 0xd7)
            continue;
        if (offset + 2 > bytes.length)
            return false;
        const length = (bytes[offset] << 8) | bytes[offset + 1];
        if (length < 2 || offset + length > bytes.length)
            return false;
        if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf))
            sawFrame = true;
        offset += length;
        if (marker !== 0xda)
            continue;
        // Leave room for the marker byte and its following marker code; the EOI
        // marker itself occupies the final two bytes and is a valid end point.
        while (offset < bytes.length - 1) {
            if (bytes[offset++] !== 0xff)
                continue;
            const next = bytes[offset++];
            if (next === 0x00 || (next !== undefined && next >= 0xd0 && next <= 0xd7))
                continue;
            if (next === 0xd9)
                return sawFrame && offset === bytes.length;
            return false;
        }
    }
    return false;
};
const validWebp = (bytes) => {
    if (bytes.length < 20 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP" || u32le(bytes, 4) !== bytes.length - 8)
        return false;
    // Conservatively inline only one exact lossy VP8 image chunk. Extended and
    // lossless containers remain downloads until their complete bitstreams can
    // be proved with the same bounded parser.
    if (ascii(bytes, 12, 4) !== "VP8 ")
        return false;
    const length = u32le(bytes, 16);
    if (length === undefined)
        return false;
    const dataStart = 20;
    const dataEnd = dataStart + length;
    const paddedEnd = dataEnd + (length % 2);
    if (dataEnd > bytes.length || paddedEnd !== bytes.length)
        return false;
    if (length % 2 === 1 && bytes[dataEnd] !== 0)
        return false;
    return validVp8(bytes.subarray(dataStart, dataEnd));
};
const validVp8 = (bytes) => {
    if (bytes.length < 12)
        return false;
    const frameTag = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16);
    const keyFrame = (frameTag & 1) === 0;
    const version = (frameTag >>> 1) & 0x07;
    const showFrame = ((frameTag >>> 4) & 1) === 1;
    const firstPartitionSize = frameTag >>> 5;
    if (!keyFrame || version > 3 || !showFrame || firstPartitionSize === 0 || !equal(bytes, 3, [0x9d, 0x01, 0x2a]))
        return false;
    const width = (bytes[6] | ((bytes[7] & 0x3f) << 8));
    const height = (bytes[8] | ((bytes[9] & 0x3f) << 8));
    const firstPartitionEnd = 10 + firstPartitionSize;
    return width > 0 && height > 0 && firstPartitionEnd < bytes.length;
};
const validGif = (bytes) => {
    if (bytes.length < 14 || (ascii(bytes, 0, 6) !== "GIF87a" && ascii(bytes, 0, 6) !== "GIF89a"))
        return false;
    const canvasWidth = bytes[6] | (bytes[7] << 8);
    const canvasHeight = bytes[8] | (bytes[9] << 8);
    if (canvasWidth === 0 || canvasHeight === 0)
        return false;
    let offset = 13;
    if ((bytes[10] & 0x80) !== 0) {
        const tableLength = 3 * (1 << ((bytes[10] & 0x07) + 1));
        if (offset + tableLength > bytes.length)
            return false;
        offset += tableLength;
    }
    let sawImage = false;
    while (offset < bytes.length) {
        const token = bytes[offset++];
        if (token === 0x3b)
            return sawImage && offset === bytes.length;
        if (token === 0x2c) {
            if (offset + 9 > bytes.length)
                return false;
            const imageWidth = bytes[offset + 4] | (bytes[offset + 5] << 8);
            const imageHeight = bytes[offset + 6] | (bytes[offset + 7] << 8);
            if (imageWidth === 0 || imageHeight === 0 || imageWidth > canvasWidth || imageHeight > canvasHeight)
                return false;
            const packed = bytes[offset + 8];
            offset += 9;
            if ((packed & 0x80) !== 0) {
                const tableLength = 3 * (1 << ((packed & 0x07) + 1));
                if (offset + tableLength > bytes.length)
                    return false;
                offset += tableLength;
            }
            if (offset >= bytes.length)
                return false;
            const minimumCodeSize = bytes[offset++];
            if (minimumCodeSize < 2 || minimumCodeSize > 8)
                return false;
            const end = skipGifSubBlocks(bytes, offset, true);
            if (end === false)
                return false;
            offset = end;
            sawImage = true;
            continue;
        }
        if (token !== 0x21 || offset >= bytes.length)
            return false;
        offset += 1; // extension label
        const end = skipGifSubBlocks(bytes, offset, false);
        if (end === false)
            return false;
        offset = end;
    }
    return false;
};
const skipGifSubBlocks = (bytes, initial, requirePayload) => {
    let offset = initial;
    let sawPayload = false;
    while (offset < bytes.length) {
        const length = bytes[offset++];
        if (length === 0)
            return !requirePayload || sawPayload ? offset : false;
        if (length === undefined || offset + length > bytes.length)
            return false;
        sawPayload = true;
        offset += length;
    }
    return false;
};
const MAX_PDF_XREF_ENTRIES = 10_000;
const MAX_PDF_PARSE_DEPTH = 32;
const MAX_PDF_TOKENS = 100_000;
const validPdf = (bytes) => {
    if (bytes.length < 64 || bytes.length > MAX_ATTACHMENT_BYTES || ascii(bytes, 0, 5) !== "%PDF-")
        return false;
    const text = new TextDecoder("latin1").decode(bytes);
    const header = /^%PDF-[12]\.[0-9](?:\r\n|\n|\r)/u.exec(text);
    if (header === null)
        return false;
    const terminal = /startxref[\t\n\f\r ]+(\d+)[\t\n\f\r ]+%%EOF[\t\n\f\r ]*$/u.exec(text);
    if (terminal === null)
        return false;
    const xrefOffset = Number(terminal[1]);
    if (!Number.isSafeInteger(xrefOffset) || xrefOffset < header[0].length || xrefOffset >= text.length || text.slice(xrefOffset, xrefOffset + 4) !== "xref")
        return false;
    const parsedXref = parseClassicXref(text, xrefOffset);
    if (parsedXref === undefined || parsedXref.startxref !== xrefOffset || parsedXref.end !== text.length)
        return false;
    const { entries, trailer } = parsedXref;
    if (entries.size < 2 || entries.size > MAX_PDF_XREF_ENTRIES)
        return false;
    const size = trailer.entries.get("Size");
    const root = trailer.entries.get("Root");
    if (size?.kind !== "number" || !size.integer || size.value < 2 || size.value > MAX_PDF_XREF_ENTRIES ||
        root?.kind !== "reference" || trailer.entries.has("Prev") || trailer.entries.has("XRefStm"))
        return false;
    const highestObjectNumber = Math.max(...entries.keys());
    if (size.value !== highestObjectNumber + 1)
        return false;
    const zero = entries.get(0);
    if (zero === undefined || zero.active || zero.offset !== 0 || zero.generation !== 65_535)
        return false;
    for (const entry of entries.values()) {
        if (entry.objectNumber < 0 || entry.objectNumber >= size.value)
            return false;
        if (entry.active) {
            if (entry.objectNumber === 0 || entry.generation >= 65_535 || entry.offset < header[0].length || entry.offset >= xrefOffset)
                return false;
        }
        else if (entry.objectNumber !== 0 && (entry.offset < 0 || entry.offset >= size.value || entry.generation > 65_535)) {
            return false;
        }
    }
    const active = [...entries.values()].filter((entry) => entry.active).sort((left, right) => left.offset - right.offset);
    if (active.length === 0 || active.length > MAX_PDF_XREF_ENTRIES - 1)
        return false;
    const objects = new Map();
    let regionCursor = header[0].length;
    for (let index = 0; index < active.length; index += 1) {
        const entry = active[index];
        const limit = active[index + 1]?.offset ?? xrefOffset;
        if (entry.offset < regionCursor || limit <= entry.offset || !onlyPdfTrivia(text, regionCursor, entry.offset))
            return false;
        const parsed = parseIndirectObject(text, entry, limit);
        if (parsed === undefined || parsed.end > limit || objects.has(entry.objectNumber))
            return false;
        objects.set(entry.objectNumber, { generation: entry.generation, value: parsed.value });
        regionCursor = parsed.end;
    }
    if (!onlyPdfTrivia(text, regionCursor, xrefOffset) || objects.size !== active.length)
        return false;
    const rootObject = objects.get(root.objectNumber);
    if (rootObject === undefined || rootObject.generation !== root.generation || rootObject.value.kind !== "dictionary")
        return false;
    const rootType = rootObject.value.entries.get("Type");
    if (rootType?.kind !== "name" || rootType.value !== "Catalog")
        return false;
    return [...objects.values(), { generation: 0, value: trailer }].every(({ value }) => pdfReferences(value).every((reference) => {
        const target = objects.get(reference.objectNumber);
        return target !== undefined && target.generation === reference.generation;
    }));
};
const parseClassicXref = (text, xrefOffset) => {
    let cursor = xrefOffset + 4;
    cursor = consumePdfLineEnd(text, cursor);
    if (cursor < 0)
        return undefined;
    const entries = new Map();
    while (entries.size <= MAX_PDF_XREF_ENTRIES) {
        cursor = skipPdfTrivia(text, cursor, text.length);
        if (text.startsWith("trailer", cursor) && pdfDelimited(text, cursor + 7))
            break;
        const headerEnd = pdfLineEnd(text, cursor);
        if (headerEnd === undefined)
            return undefined;
        const subsection = /^(\d+)[\t ]+(\d+)[\t ]*$/u.exec(text.slice(cursor, headerEnd.contentEnd));
        if (subsection === null)
            return undefined;
        const first = Number(subsection[1]);
        const count = Number(subsection[2]);
        if (!Number.isSafeInteger(first) || !Number.isSafeInteger(count) || first < 0 || count < 1 || first + count > MAX_PDF_XREF_ENTRIES || entries.size + count > MAX_PDF_XREF_ENTRIES)
            return undefined;
        cursor = headerEnd.next;
        for (let index = 0; index < count; index += 1) {
            const entryEnd = pdfLineEnd(text, cursor);
            if (entryEnd === undefined)
                return undefined;
            const line = /^(\d{10}) (\d{5}) ([nf]) $/u.exec(text.slice(cursor, entryEnd.contentEnd));
            const objectNumber = first + index;
            if (line === null || entries.has(objectNumber))
                return undefined;
            entries.set(objectNumber, {
                objectNumber,
                offset: Number(line[1]),
                generation: Number(line[2]),
                active: line[3] === "n"
            });
            cursor = entryEnd.next;
        }
    }
    if (!text.startsWith("trailer", cursor) || !pdfDelimited(text, cursor + 7))
        return undefined;
    const parser = new PdfParser(text, cursor + 7, text.length);
    const trailer = parser.parseValue();
    if (trailer?.kind !== "dictionary")
        return undefined;
    parser.skipTrivia();
    if (!parser.consumeKeyword("startxref") || !isPdfWhitespace(text.charCodeAt(parser.position)))
        return undefined;
    parser.skipWhitespace();
    const start = parser.position;
    while (parser.position < text.length && isAsciiDigit(text.charCodeAt(parser.position)))
        parser.position += 1;
    if (parser.position === start)
        return undefined;
    const startxref = Number(text.slice(start, parser.position));
    if (!Number.isSafeInteger(startxref) || !isPdfWhitespace(text.charCodeAt(parser.position)))
        return undefined;
    parser.skipWhitespace();
    if (!text.startsWith("%%EOF", parser.position))
        return undefined;
    parser.position += 5;
    parser.skipWhitespace();
    return parser.position === text.length ? { entries, trailer, startxref, end: parser.position } : undefined;
};
const parseIndirectObject = (text, entry, limit) => {
    const header = new RegExp(`${entry.objectNumber}[\\x00\\t\\n\\f\\r ]+${entry.generation}[\\x00\\t\\n\\f\\r ]+obj(?=[\\x00\\t\\n\\f\\r %<\\[(/])`, "uy");
    header.lastIndex = entry.offset;
    const matched = header.exec(text);
    if (matched === null)
        return undefined;
    const parser = new PdfParser(text, header.lastIndex, limit);
    const value = parser.parseValue();
    if (value === undefined)
        return undefined;
    parser.skipTrivia();
    if (!parser.consumeKeyword("endobj"))
        return undefined;
    return { value, end: parser.position };
};
class PdfParser {
    text;
    position;
    limit;
    tokens = 0;
    constructor(text, position, limit) {
        this.text = text;
        this.position = position;
        this.limit = limit;
    }
    parseValue(depth = 0) {
        if (depth > MAX_PDF_PARSE_DEPTH || this.tokens >= MAX_PDF_TOKENS)
            return undefined;
        this.tokens += 1;
        this.skipTrivia();
        if (this.position >= this.limit)
            return undefined;
        if (this.text.startsWith("<<", this.position))
            return this.parseDictionary(depth + 1);
        const character = this.text[this.position];
        if (character === "[")
            return this.parseArray(depth + 1);
        if (character === "/")
            return this.parseName();
        if (character === "(")
            return this.parseLiteralString();
        if (character === "<")
            return this.parseHexString();
        if (this.consumeKeyword("true"))
            return { kind: "boolean", value: true };
        if (this.consumeKeyword("false"))
            return { kind: "boolean", value: false };
        if (this.consumeKeyword("null"))
            return { kind: "null" };
        return this.parseNumberOrReference();
    }
    skipTrivia() {
        this.position = skipPdfTrivia(this.text, this.position, this.limit);
    }
    skipWhitespace() {
        while (this.position < this.limit && isPdfWhitespace(this.text.charCodeAt(this.position)))
            this.position += 1;
    }
    consumeKeyword(keyword) {
        if (!this.text.startsWith(keyword, this.position) || !pdfDelimited(this.text, this.position + keyword.length))
            return false;
        this.position += keyword.length;
        return true;
    }
    parseDictionary(depth) {
        this.position += 2;
        const entries = new Map();
        for (;;) {
            this.skipTrivia();
            if (this.text.startsWith(">>", this.position)) {
                this.position += 2;
                return { kind: "dictionary", entries };
            }
            const key = this.parseName();
            if (key === undefined || entries.has(key.value))
                return undefined;
            const value = this.parseValue(depth);
            if (value === undefined)
                return undefined;
            entries.set(key.value, value);
        }
    }
    parseArray(depth) {
        this.position += 1;
        const items = [];
        while (items.length <= MAX_PDF_TOKENS) {
            this.skipTrivia();
            if (this.text[this.position] === "]") {
                this.position += 1;
                return { kind: "array", items };
            }
            const value = this.parseValue(depth);
            if (value === undefined)
                return undefined;
            items.push(value);
        }
        return undefined;
    }
    parseName() {
        if (this.text[this.position] !== "/")
            return undefined;
        this.position += 1;
        const start = this.position;
        while (this.position < this.limit && !isPdfWhitespace(this.text.charCodeAt(this.position)) && !isPdfDelimiter(this.text[this.position]))
            this.position += 1;
        const raw = this.text.slice(start, this.position);
        if (raw.length === 0 || /#(?![0-9A-Fa-f]{2})/u.test(raw))
            return undefined;
        return { kind: "name", value: raw.replace(/#([0-9A-Fa-f]{2})/gu, (_match, value) => String.fromCharCode(Number.parseInt(value, 16))) };
    }
    parseLiteralString() {
        this.position += 1;
        let depth = 1;
        while (this.position < this.limit) {
            const character = this.text[this.position++];
            if (character === "\\") {
                if (this.position >= this.limit)
                    return undefined;
                if (this.text[this.position] === "\r" && this.text[this.position + 1] === "\n")
                    this.position += 2;
                else
                    this.position += 1;
                continue;
            }
            if (character === "(")
                depth += 1;
            else if (character === ")") {
                depth -= 1;
                if (depth === 0)
                    return { kind: "string" };
            }
        }
        return undefined;
    }
    parseHexString() {
        this.position += 1;
        while (this.position < this.limit) {
            const character = this.text[this.position++];
            if (character === ">")
                return { kind: "string" };
            const code = character?.charCodeAt(0) ?? -1;
            const hexadecimal = (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
            if (!hexadecimal && !isPdfWhitespace(code))
                return undefined;
        }
        return undefined;
    }
    parseNumberOrReference() {
        const first = this.readRegularToken();
        if (first === undefined || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(first))
            return undefined;
        const value = Number(first);
        if (!Number.isFinite(value))
            return undefined;
        const integer = /^[+-]?\d+$/u.test(first);
        const afterFirst = this.position;
        if (integer && value >= 0 && Number.isSafeInteger(value)) {
            this.skipTrivia();
            const second = this.readRegularToken();
            if (second !== undefined && /^\d+$/u.test(second)) {
                const generation = Number(second);
                this.skipTrivia();
                if (generation <= 65_535 && this.consumeKeyword("R"))
                    return { kind: "reference", objectNumber: value, generation };
            }
            this.position = afterFirst;
        }
        return { kind: "number", value, integer };
    }
    readRegularToken() {
        const start = this.position;
        while (this.position < this.limit && !isPdfWhitespace(this.text.charCodeAt(this.position)) && !isPdfDelimiter(this.text[this.position]))
            this.position += 1;
        return this.position === start ? undefined : this.text.slice(start, this.position);
    }
}
const pdfReferences = (value) => {
    if (value.kind === "reference")
        return [{ objectNumber: value.objectNumber, generation: value.generation }];
    if (value.kind === "array")
        return value.items.flatMap(pdfReferences);
    if (value.kind === "dictionary")
        return [...value.entries.values()].flatMap(pdfReferences);
    return [];
};
const onlyPdfTrivia = (text, start, end) => start <= end && skipPdfTrivia(text, start, end) === end;
const skipPdfTrivia = (text, initial, limit) => {
    let cursor = initial;
    while (cursor < limit) {
        if (isPdfWhitespace(text.charCodeAt(cursor))) {
            cursor += 1;
            continue;
        }
        if (text[cursor] !== "%")
            break;
        cursor += 1;
        while (cursor < limit && text[cursor] !== "\r" && text[cursor] !== "\n")
            cursor += 1;
    }
    return cursor;
};
const pdfLineEnd = (text, start) => {
    for (let cursor = start; cursor < text.length; cursor += 1) {
        if (text[cursor] === "\n")
            return { contentEnd: cursor, next: cursor + 1 };
        if (text[cursor] === "\r")
            return { contentEnd: cursor, next: text[cursor + 1] === "\n" ? cursor + 2 : cursor + 1 };
    }
    return undefined;
};
const consumePdfLineEnd = (text, cursor) => {
    if (text[cursor] === "\n")
        return cursor + 1;
    if (text[cursor] === "\r")
        return text[cursor + 1] === "\n" ? cursor + 2 : cursor + 1;
    return -1;
};
const pdfDelimited = (text, cursor) => cursor >= text.length || isPdfWhitespace(text.charCodeAt(cursor)) || isPdfDelimiter(text[cursor]);
const isPdfWhitespace = (code) => code === 0 || code === 9 || code === 10 || code === 12 || code === 13 || code === 32;
const isPdfDelimiter = (character) => character !== undefined && "()<>[]{}/%".includes(character);
const isAsciiDigit = (code) => code >= 48 && code <= 57;
const equal = (bytes, offset, expected) => expected.every((value, index) => bytes[offset + index] === value);
const ascii = (bytes, offset, length) => offset + length <= bytes.length ? String.fromCharCode(...bytes.slice(offset, offset + length)) : undefined;
const u32be = (bytes, offset) => offset + 4 <= bytes.length ? (((bytes[offset] * 0x1000000) + ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])) >>> 0) : undefined;
const u32le = (bytes, offset) => offset + 4 <= bytes.length ? (((bytes[offset + 3] * 0x1000000) + ((bytes[offset + 2] << 16) | (bytes[offset + 1] << 8) | bytes[offset])) >>> 0) : undefined;
const crc32 = (bytes, start, end) => {
    let crc = 0xffffffff;
    for (let index = start; index < end; index += 1) {
        crc ^= bytes[index];
        for (let bit = 0; bit < 8; bit += 1)
            crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
};
const removeC0C1 = (value) => [...value].filter((character) => {
    const code = character.codePointAt(0);
    return code > 31 && (code < 127 || code > 159);
}).join("");
//# sourceMappingURL=attachment-policy.js.map