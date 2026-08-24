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
        while (offset < bytes.length - 2) {
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
    let offset = 12;
    let sawImage = false;
    while (offset + 8 <= bytes.length) {
        const type = ascii(bytes, offset, 4);
        const length = u32le(bytes, offset + 4);
        if (type === undefined || length === undefined || length > bytes.length - offset - 8)
            return false;
        if (type === "VP8 " || type === "VP8L" || type === "VP8X")
            sawImage = true;
        offset += 8 + length + (length % 2);
    }
    return sawImage && offset === bytes.length;
};
const validGif = (bytes) => {
    if (bytes.length < 14 || (ascii(bytes, 0, 6) !== "GIF87a" && ascii(bytes, 0, 6) !== "GIF89a"))
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
            const packed = bytes[offset + 8];
            offset += 9;
            if ((packed & 0x80) !== 0) {
                const tableLength = 3 * (1 << ((packed & 0x07) + 1));
                if (offset + tableLength > bytes.length)
                    return false;
                offset += tableLength;
            }
            if (offset >= bytes.length || bytes[offset++] < 2)
                return false;
            const end = skipGifSubBlocks(bytes, offset);
            if (end === false)
                return false;
            offset = end;
            sawImage = true;
            continue;
        }
        if (token !== 0x21 || offset >= bytes.length)
            return false;
        offset += 1; // extension label
        const end = skipGifSubBlocks(bytes, offset);
        if (end === false)
            return false;
        offset = end;
    }
    return false;
};
const skipGifSubBlocks = (bytes, initial) => {
    let offset = initial;
    while (offset < bytes.length) {
        const length = bytes[offset++];
        if (length === 0)
            return offset;
        if (length === undefined || offset + length > bytes.length)
            return false;
        offset += length;
    }
    return false;
};
const validPdf = (bytes) => {
    if (bytes.length < 32 || ascii(bytes, 0, 5) !== "%PDF-")
        return false;
    const text = new TextDecoder("latin1").decode(bytes);
    if (!/^%PDF-[12]\.[0-9]/u.test(text) || !/\b(?:xref|\/Type\s*\/XRef)\b/u.test(text) || !/\btrailer\b/u.test(text) || !/\bstartxref\s+\d+\s+%%EOF\s*$/u.test(text))
        return false;
    const start = /\bstartxref\s+(\d+)\s+%%EOF\s*$/u.exec(text);
    return start !== null && Number(start[1]) >= 0 && Number(start[1]) < bytes.length;
};
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