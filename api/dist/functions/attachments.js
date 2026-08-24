import { NoteIdSchema, OpaqueIdSchema, TrashResponseSchema, attachmentNameLength, isOpaqueId } from "@nxt/contracts";
import { ApiResponseError, errorResponse, typedJson } from "../http/api-response.js";
import { MAX_ATTACHMENT_BYTES, normalizeAttachmentName } from "../services/attachment-policy.js";
import { assertNoQuery, defaultPrivateHandlerDependencies, handlePrivate, pathValue } from "./private-api.js";
const MAX_ENCODED_BYTES = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4;
const MAX_UPLOAD_REQUEST_BYTES = MAX_ENCODED_BYTES + 32 * 1024;
const uploadResponseSchema = {
    parse(value) {
        if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 1)
            throw new Error("invalid attachment response");
        const asset = value.asset;
        if (typeof asset !== "object" || asset === null || Array.isArray(asset) || Object.keys(asset).length !== 5)
            throw new Error("invalid attachment response");
        const valueAsset = asset;
        if (!isOpaqueId(valueAsset.assetId) || typeof valueAsset.name !== "string" || valueAsset.name.length === 0 || attachmentNameLength(valueAsset.name) > 180 ||
            typeof valueAsset.mimeType !== "string" || valueAsset.mimeType.length === 0 || valueAsset.mimeType.length > 256 ||
            !Number.isSafeInteger(valueAsset.size) || valueAsset.size < 0 || valueAsset.size > MAX_ATTACHMENT_BYTES ||
            (valueAsset.disposition !== "inline" && valueAsset.disposition !== "download"))
            throw new Error("invalid attachment response");
        return value;
    }
};
export const createAttachmentHandlers = (dependencies = defaultPrivateHandlerDependencies()) => ({
    create: async (request) => {
        try {
            // Exact owner verification is deliberately the first operation.  Parsing
            // precedes service construction so hostile bodies cannot create clients
            // or reach Drive adapters.
            dependencies.authorize(request);
            assertNoQuery(request);
            const body = await parseUploadBody(request);
            const uploaded = await dependencies.resolveServices().attachments.upload(body);
            return typedJson({
                asset: {
                    assetId: dependencies.idCodec.encode(uploaded.driveId),
                    name: uploaded.name,
                    mimeType: uploaded.mimeType,
                    size: uploaded.size,
                    disposition: uploaded.disposition
                }
            }, uploadResponseSchema, 201);
        }
        catch (error) {
            return errorResponse(error);
        }
    },
    get: (request) => handlePrivate(request, dependencies, async (services) => {
        assertNoQuery(request);
        const reference = pathValue(request, "assetId", OpaqueIdSchema);
        const delivery = await services.attachments.read(dependencies.idCodec.decode(reference));
        const headers = {
            "content-type": delivery.mimeType,
            "x-content-type-options": "nosniff",
            "cache-control": "private, no-store"
        };
        if (delivery.disposition === "download")
            headers["content-disposition"] = `attachment; filename*=UTF-8''${rfc5987Filename(delivery.name)}`;
        return { status: 200, headers, body: delivery.bytes };
    }),
    trash: (request) => handlePrivate(request, dependencies, async (services) => {
        assertNoQuery(request);
        const reference = pathValue(request, "assetId", OpaqueIdSchema);
        return typedJson(await services.attachments.trash({ assetId: dependencies.idCodec.decode(reference), referenceId: reference }), TrashResponseSchema);
    })
});
const defaults = createAttachmentHandlers();
export const createAttachmentHandler = defaults.create;
export const getAttachmentHandler = defaults.get;
export const trashAttachmentHandler = defaults.trash;
const parseUploadBody = async (request) => {
    const contentLength = request.headers.get("content-length");
    if (contentLength !== null) {
        if (!/^(?:0|[1-9]\d{0,9})$/u.test(contentLength))
            throw new ApiResponseError("INVALID_INPUT");
        const parsedLength = Number(contentLength);
        if (!Number.isSafeInteger(parsedLength))
            throw new ApiResponseError("INVALID_INPUT");
        if (parsedLength > MAX_UPLOAD_REQUEST_BYTES)
            throw new ApiResponseError("TOO_LARGE");
    }
    const body = await readBoundedJson(request);
    if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length !== 4)
        throw new ApiResponseError("INVALID_INPUT");
    const record = body;
    if (typeof record.noteId !== "string" || typeof record.name !== "string" || typeof record.declaredMime !== "string" ||
        typeof record.bytesBase64 !== "string" || record.name.length === 0 || record.name.length > 4096 ||
        record.declaredMime.length > 256 || record.bytesBase64.length > MAX_ENCODED_BYTES)
        throw new ApiResponseError("INVALID_INPUT");
    try {
        NoteIdSchema.parse(record.noteId);
    }
    catch {
        throw new ApiResponseError("INVALID_INPUT");
    }
    const bytes = decodeBase64(record.bytesBase64);
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES)
        throw new ApiResponseError("TOO_LARGE");
    return { noteId: record.noteId, name: record.name, declaredMime: record.declaredMime, bytes };
};
const decodeBase64 = (value) => {
    const decodedSize = canonicalBase64DecodedSize(value);
    if (decodedSize > MAX_ATTACHMENT_BYTES)
        throw new ApiResponseError("TOO_LARGE");
    let bytes;
    try {
        bytes = Buffer.from(value, "base64");
    }
    catch {
        throw new ApiResponseError("INVALID_INPUT");
    }
    // Node's decoder is deliberately checked by canonical re-encoding only after
    // the decoded allocation is proven to fit the hard byte ceiling.
    if (bytes.byteLength !== decodedSize || bytes.toString("base64") !== value)
        throw new ApiResponseError("INVALID_INPUT");
    return new Uint8Array(bytes);
};
const canonicalBase64DecodedSize = (value) => {
    if (value.length === 0 || value.length % 4 !== 0)
        throw new ApiResponseError("INVALID_INPUT");
    let padding = 0;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        const base64 = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47;
        if (base64) {
            if (padding !== 0)
                throw new ApiResponseError("INVALID_INPUT");
            continue;
        }
        if (code !== 61 || index < value.length - 2 || ++padding > 2)
            throw new ApiResponseError("INVALID_INPUT");
    }
    if (padding === 1 && value[value.length - 1] !== "=")
        throw new ApiResponseError("INVALID_INPUT");
    if (padding === 2 && (value[value.length - 1] !== "=" || value[value.length - 2] !== "="))
        throw new ApiResponseError("INVALID_INPUT");
    return (value.length / 4) * 3 - padding;
};
const readBoundedJson = async (request) => {
    const bytes = await readBoundedRequestBytes(request);
    let text;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    catch {
        throw new ApiResponseError("INVALID_INPUT");
    }
    try {
        return JSON.parse(text);
    }
    catch {
        throw new ApiResponseError("INVALID_INPUT");
    }
};
const readBoundedRequestBytes = async (request) => {
    const stream = request.body;
    if (stream !== null && stream !== undefined && typeof stream.getReader === "function") {
        const reader = stream.getReader();
        const chunks = [];
        let length = 0;
        try {
            while (true) {
                const next = await reader.read();
                if (next.done)
                    break;
                const chunk = toBytes(next.value);
                length += chunk.byteLength;
                if (length > MAX_UPLOAD_REQUEST_BYTES) {
                    await reader.cancel().catch(() => undefined);
                    throw new ApiResponseError("TOO_LARGE");
                }
                chunks.push(chunk);
            }
        }
        finally {
            reader.releaseLock();
        }
        const result = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return result;
    }
    // Test/local request shims may expose only arrayBuffer; parsing still cannot
    // begin until the same strict cap has been applied.
    const fallback = new Uint8Array(await request.arrayBuffer());
    if (fallback.byteLength > MAX_UPLOAD_REQUEST_BYTES)
        throw new ApiResponseError("TOO_LARGE");
    return fallback;
};
const toBytes = (value) => {
    if (value instanceof Uint8Array)
        return value;
    if (value instanceof ArrayBuffer)
        return new Uint8Array(value);
    if (ArrayBuffer.isView(value))
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new ApiResponseError("INVALID_INPUT");
};
const rfc5987Filename = (value) => {
    let safe;
    try {
        safe = normalizeAttachmentName(stripC0C1(value.normalize("NFC")).replace(/[\\/]/gu, "").trim());
    }
    catch {
        safe = "download";
    }
    if (safe.length === 0)
        safe = "download";
    return encodeURIComponent(safe).replace(/[!'()*]/gu, (character) => `%${character.codePointAt(0)?.toString(16).toUpperCase()}`);
};
const stripC0C1 = (value) => [...value].filter((character) => {
    const code = character.codePointAt(0);
    return code > 31 && (code < 127 || code > 159);
}).join("");
//# sourceMappingURL=attachments.js.map