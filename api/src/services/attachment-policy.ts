import { fileTypeFromBuffer } from "file-type";
import { MAX_ATTACHMENT_NAME_CODE_POINTS, attachmentNameLength as contractAttachmentNameLength } from "@nxt/contracts";
import { ApiResponseError } from "../http/api-response.js";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const attachmentNameLength = contractAttachmentNameLength;

export type AttachmentDisposition = "inline" | "download";
export type DetectedAttachment = {
  mimeType: string;
  disposition: AttachmentDisposition;
};

const INLINE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf"
]);
const INLINE_EXTENSIONS: Record<string, ReadonlySet<string>> = {
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

export const classifyAttachment = (mimeType: string): AttachmentDisposition =>
  INLINE_MIME_TYPES.has(mimeType.toLocaleLowerCase("en-US")) ? "inline" : "download";

/** Reject Drive container declarations before any storage operation can occur. */
export const assertAttachmentDeclaration = (declaredMime: string): void => {
  if (FORBIDDEN_DRIVE_MIME_TYPES.has(normalizeMime(declaredMime))) throw new ApiResponseError("UNSAFE_FILE");
};

export const normalizeAttachmentName = (value: string): string => {
  if (typeof value !== "string") throw new ApiResponseError("INVALID_INPUT");
  const cleaned = removeC0C1(value.normalize("NFC")).replace(SEPARATOR, "").trim().replace(/[. ]+$/gu, "");
  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") throw new ApiResponseError("INVALID_INPUT");
  const { base, extension } = splitFinalSafeExtension(cleaned);
  const reserved = base.toLocaleLowerCase("en-US");
  if (base.length === 0 || base === "." || base === ".." || RESERVED_NAMES.has(reserved)) throw new ApiResponseError("INVALID_INPUT");
  const maximumBaseLength = MAX_ATTACHMENT_NAME_CODE_POINTS - attachmentNameLength(extension);
  const shortenedBase = [...base].slice(0, maximumBaseLength).join("").replace(/[. ]+$/gu, "");
  if (shortenedBase.length === 0) throw new ApiResponseError("INVALID_INPUT");
  return `${shortenedBase}${extension}`;
};

export const resolveAttachmentName = (requestedName: string, existingNames: readonly string[]): string => {
  const normalized = normalizeAttachmentName(requestedName);
  const existing = new Set(existingNames.map(nameKey));
  if (!existing.has(nameKey(normalized))) return normalized;
  const { base, extension } = splitFinalSafeExtension(normalized);
  for (let suffix = 2; suffix <= 10_000; suffix += 1) {
    const marker = `-${suffix}`;
    const candidateBase = [...base].slice(0, MAX_ATTACHMENT_NAME_CODE_POINTS - attachmentNameLength(extension) - attachmentNameLength(marker)).join("").replace(/[. ]+$/gu, "");
    if (candidateBase.length === 0) throw new ApiResponseError("CONFLICT");
    const candidate = `${candidateBase}${marker}${extension}`;
    if (!existing.has(nameKey(candidate))) return candidate;
  }
  throw new ApiResponseError("CONFLICT");
};

export const detectAttachment = async (input: {
  name: string;
  declaredMime: string;
  bytes: Uint8Array;
}): Promise<DetectedAttachment> => {
  if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new ApiResponseError("TOO_LARGE");
  const name = normalizeAttachmentName(input.name);
  const extension = finalExtension(name);
  const declaredMime = normalizeMime(input.declaredMime);
  assertAttachmentDeclaration(declaredMime);
  let sniffed: Awaited<ReturnType<typeof fileTypeFromBuffer>>;
  try {
    sniffed = await fileTypeFromBuffer(input.bytes);
  } catch {
    sniffed = undefined;
  }
  const detectedMime = sniffed?.mime ?? detectSafeTextMime(input.bytes, extension) ?? "application/octet-stream";
  const extensionCoherent = extension !== undefined && INLINE_EXTENSIONS[detectedMime]?.has(extension) === true;
  const disposition = classifyAttachment(detectedMime) === "inline" && extensionCoherent && declaredMime === detectedMime && structurallyValidInline(input.bytes, detectedMime)
    ? "inline"
    : "download";
  return { mimeType: detectedMime, disposition };
};

export const isInlineExtensionCoherent = (mimeType: string, name: string): boolean => {
  const extension = finalExtension(normalizeAttachmentName(name));
  return extension !== undefined && INLINE_EXTENSIONS[mimeType]?.has(extension) === true;
};

const detectSafeTextMime = (bytes: Uint8Array, extension: string | undefined): string | undefined => {
  if (bytes.some((byte) => byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13))) return undefined;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  if (extension === "txt") return "text/plain";
  if (extension === "md" || extension === "markdown") return "text/markdown";
  return undefined;
};

const normalizeMime = (value: string): string =>
  typeof value === "string" ? value.trim().toLocaleLowerCase("en-US") : "";

const splitFinalSafeExtension = (name: string): { base: string; extension: string } => {
  const index = name.lastIndexOf(".");
  if (index <= 0 || index === name.length - 1) return { base: name, extension: "" };
  const suffix = name.slice(index + 1).toLocaleLowerCase("en-US");
  if (!SAFE_EXTENSION.test(suffix)) return { base: name, extension: "" };
  return { base: name.slice(0, index), extension: `.${suffix}` };
};

const finalExtension = (name: string): string | undefined => {
  const extension = splitFinalSafeExtension(name).extension;
  return extension.length === 0 ? undefined : extension.slice(1);
};

const nameKey = (name: string): string => name.normalize("NFC").toLocaleLowerCase("en-US");

const structurallyValidInline = (bytes: Uint8Array, mimeType: string): boolean => {
  switch (mimeType) {
    case "image/png": return validPng(bytes);
    case "image/jpeg": return validJpeg(bytes);
    case "image/webp": return validWebp(bytes);
    case "image/gif": return validGif(bytes);
    case "application/pdf": return validPdf(bytes);
    default: return false;
  }
};

const validPng = (bytes: Uint8Array): boolean => {
  if (bytes.length < 45 || !equal(bytes, 0, [137, 80, 78, 71, 13, 10, 26, 10])) return false;
  let offset = 8;
  let sawIhdr = false;
  let sawIdat = false;
  while (offset + 12 <= bytes.length) {
    const length = u32be(bytes, offset);
    if (length === undefined || length > bytes.length - offset - 12) return false;
    const type = ascii(bytes, offset + 4, 4);
    if (type === undefined) return false;
    const dataEnd = offset + 8 + length;
    const expectedCrc = u32be(bytes, dataEnd);
    if (expectedCrc === undefined || crc32(bytes, offset + 4, dataEnd) !== expectedCrc) return false;
    if (!sawIhdr && (type !== "IHDR" || length !== 13)) return false;
    if (type === "IHDR") {
      if (sawIhdr || u32be(bytes, offset + 8) === 0 || u32be(bytes, offset + 12) === 0) return false;
      sawIhdr = true;
    }
    if (type === "IDAT") sawIdat = true;
    offset = dataEnd + 4;
    if (type === "IEND") return length === 0 && sawIhdr && sawIdat && offset === bytes.length;
  }
  return false;
};

const validJpeg = (bytes: Uint8Array): boolean => {
  if (bytes.length < 8 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return false;
  let offset = 2;
  let sawFrame = false;
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0x00 || marker === 0xd9 || marker === 0xd8) return false;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.length) return false;
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.length) return false;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) sawFrame = true;
    offset += length;
    if (marker !== 0xda) continue;
    // Leave room for the marker byte and its following marker code; the EOI
    // marker itself occupies the final two bytes and is a valid end point.
    while (offset < bytes.length - 1) {
      if (bytes[offset++] !== 0xff) continue;
      const next = bytes[offset++];
      if (next === 0x00 || (next !== undefined && next >= 0xd0 && next <= 0xd7)) continue;
      if (next === 0xd9) return sawFrame && offset === bytes.length;
      return false;
    }
  }
  return false;
};

const validWebp = (bytes: Uint8Array): boolean => {
  if (bytes.length < 20 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP" || u32le(bytes, 4) !== bytes.length - 8) return false;
  let offset = 12;
  let sawImage = false;
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4);
    const length = u32le(bytes, offset + 4);
    if (type === undefined || length === undefined || length > bytes.length - offset - 8) return false;
    // VP8X carries only extended metadata.  It cannot by itself prove that
    // this is an image, so require an actual bounded VP8/VP8L frame too.
    if (type === "VP8 " && validVp8(bytes.subarray(offset + 8, offset + 8 + length))) sawImage = true;
    if (type === "VP8L" && validVp8l(bytes.subarray(offset + 8, offset + 8 + length))) sawImage = true;
    offset += 8 + length + (length % 2);
  }
  return sawImage && offset === bytes.length;
};

const validVp8 = (bytes: Uint8Array): boolean => {
  if (bytes.length < 11 || (bytes[0]! & 1) !== 0 || !equal(bytes, 3, [0x9d, 0x01, 0x2a])) return false;
  const width = (bytes[6]! | ((bytes[7]! & 0x3f) << 8));
  const height = (bytes[8]! | ((bytes[9]! & 0x3f) << 8));
  return width > 0 && height > 0;
};

const validVp8l = (bytes: Uint8Array): boolean => {
  // A five-byte VP8L prefix contains dimensions but no decodable lossless
  // image stream. Until a bounded full VP8L parser exists, keep it download.
  void bytes;
  return false;
};

const validGif = (bytes: Uint8Array): boolean => {
  if (bytes.length < 14 || (ascii(bytes, 0, 6) !== "GIF87a" && ascii(bytes, 0, 6) !== "GIF89a")) return false;
  const canvasWidth = bytes[6]! | (bytes[7]! << 8);
  const canvasHeight = bytes[8]! | (bytes[9]! << 8);
  if (canvasWidth === 0 || canvasHeight === 0) return false;
  let offset = 13;
  if ((bytes[10]! & 0x80) !== 0) {
    const tableLength = 3 * (1 << ((bytes[10]! & 0x07) + 1));
    if (offset + tableLength > bytes.length) return false;
    offset += tableLength;
  }
  let sawImage = false;
  while (offset < bytes.length) {
    const token = bytes[offset++];
    if (token === 0x3b) return sawImage && offset === bytes.length;
    if (token === 0x2c) {
      if (offset + 9 > bytes.length) return false;
      const imageWidth = bytes[offset + 4]! | (bytes[offset + 5]! << 8);
      const imageHeight = bytes[offset + 6]! | (bytes[offset + 7]! << 8);
      if (imageWidth === 0 || imageHeight === 0 || imageWidth > canvasWidth || imageHeight > canvasHeight) return false;
      const packed = bytes[offset + 8]!;
      offset += 9;
      if ((packed & 0x80) !== 0) {
        const tableLength = 3 * (1 << ((packed & 0x07) + 1));
        if (offset + tableLength > bytes.length) return false;
        offset += tableLength;
      }
      if (offset >= bytes.length) return false;
      const minimumCodeSize = bytes[offset++] as number;
      if (minimumCodeSize < 2 || minimumCodeSize > 8) return false;
      const end = skipGifSubBlocks(bytes, offset, true);
      if (end === false) return false;
      offset = end;
      sawImage = true;
      continue;
    }
    if (token !== 0x21 || offset >= bytes.length) return false;
    offset += 1; // extension label
    const end = skipGifSubBlocks(bytes, offset, false);
    if (end === false) return false;
    offset = end;
  }
  return false;
};

const skipGifSubBlocks = (bytes: Uint8Array, initial: number, requirePayload: boolean): number | false => {
  let offset = initial;
  let sawPayload = false;
  while (offset < bytes.length) {
    const length = bytes[offset++];
    if (length === 0) return !requirePayload || sawPayload ? offset : false;
    if (length === undefined || offset + length > bytes.length) return false;
    sawPayload = true;
    offset += length;
  }
  return false;
};

const validPdf = (bytes: Uint8Array): boolean => {
  if (bytes.length < 64 || ascii(bytes, 0, 5) !== "%PDF-") return false;
  const text = new TextDecoder("latin1").decode(bytes);
  if (!/^%PDF-[12]\.[0-9](?:\r?\n|\r)/u.test(text)) return false;
  const terminal = /(?:\r?\n)startxref\r?\n(\d+)\r?\n%%EOF[\t \r\n]*$/u.exec(text);
  if (terminal === null) return false;
  const xrefOffset = Number(terminal[1]);
  if (!Number.isSafeInteger(xrefOffset) || xrefOffset < 0 || xrefOffset >= bytes.length || text.slice(xrefOffset, xrefOffset + 4) !== "xref") return false;
  const section = /^xref\r?\n(\d+)\s+(\d+)\r?\n/u.exec(text.slice(xrefOffset));
  if (section === null) return false;
  const first = Number(section[1]);
  const count = Number(section[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(count) || count < 2 || count > 100_000) return false;
  let cursor = xrefOffset + section[0].length;
  const entries: Array<{ offset: number; generation: number; active: boolean }> = [];
  for (let index = 0; index < count; index += 1) {
    const line = /^(\d{10}) (\d{5}) ([nf]) \r?\n/u.exec(text.slice(cursor));
    if (line === null) return false;
    entries.push({ offset: Number(line[1]), generation: Number(line[2]), active: line[3] === "n" });
    cursor += line[0].length;
  }
  if (!text.startsWith("trailer", cursor)) return false;
  const trailerEnd = text.indexOf(">>", cursor + 7);
  if (trailerEnd === -1) return false;
  const beforeStartXref = text.slice(trailerEnd + 2, terminal.index);
  if (!/^(?:[\t \r\n]|%[^\r\n]*(?:\r?\n|\r))*$/u.test(beforeStartXref)) return false;
  const root = /\/Root\s+(\d+)\s+(\d+)\s+R/u.exec(text.slice(cursor, trailerEnd + 2));
  if (root === null) return false;
  const objectNumber = Number(root[1]);
  const generation = Number(root[2]);
  const entry = entries[objectNumber - first];
  if (entry === undefined || !entry.active || entry.generation !== generation || entry.offset < 0 || entry.offset >= xrefOffset) return false;
  const objectStart = `${objectNumber} ${generation} obj`;
  if (!text.startsWith(objectStart, entry.offset)) return false;
  const objectEnd = text.indexOf("endobj", entry.offset + objectStart.length);
  return objectEnd !== -1 && /\/Type\s*\/Catalog\b/u.test(text.slice(entry.offset, objectEnd));
};

const equal = (bytes: Uint8Array, offset: number, expected: readonly number[]): boolean => expected.every((value, index) => bytes[offset + index] === value);
const ascii = (bytes: Uint8Array, offset: number, length: number): string | undefined => offset + length <= bytes.length ? String.fromCharCode(...bytes.slice(offset, offset + length)) : undefined;
const u32be = (bytes: Uint8Array, offset: number): number | undefined => offset + 4 <= bytes.length ? (((bytes[offset]! * 0x1000000) + ((bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!)) >>> 0) : undefined;
const u32le = (bytes: Uint8Array, offset: number): number | undefined => offset + 4 <= bytes.length ? (((bytes[offset + 3]! * 0x1000000) + ((bytes[offset + 2]! << 16) | (bytes[offset + 1]! << 8) | bytes[offset]!)) >>> 0) : undefined;
const crc32 = (bytes: Uint8Array, start: number, end: number): number => {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc ^= bytes[index]!;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const removeC0C1 = (value: string): string => [...value].filter((character) => {
  const code = character.codePointAt(0) as number;
  return code > 31 && (code < 127 || code > 159);
}).join("");
