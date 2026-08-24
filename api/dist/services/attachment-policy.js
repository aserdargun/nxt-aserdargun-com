import { fileTypeFromBuffer } from "file-type";
import { ApiResponseError } from "../http/api-response.js";
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
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
    const maximumBaseLength = 180 - extension.length;
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
        const candidateBase = [...base].slice(0, 180 - extension.length - marker.length).join("").replace(/[. ]+$/gu, "");
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
    if (FORBIDDEN_DRIVE_MIME_TYPES.has(declaredMime))
        throw new ApiResponseError("UNSAFE_FILE");
    let sniffed;
    try {
        sniffed = await fileTypeFromBuffer(input.bytes);
    }
    catch {
        sniffed = undefined;
    }
    const detectedMime = sniffed?.mime ?? detectSafeTextMime(input.bytes, extension) ?? "application/octet-stream";
    const extensionCoherent = extension !== undefined && INLINE_EXTENSIONS[detectedMime]?.has(extension) === true;
    const disposition = classifyAttachment(detectedMime) === "inline" && extensionCoherent && declaredMime === detectedMime
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
const removeC0C1 = (value) => [...value].filter((character) => {
    const code = character.codePointAt(0);
    return code > 31 && (code < 127 || code > 159);
}).join("");
//# sourceMappingURL=attachment-policy.js.map