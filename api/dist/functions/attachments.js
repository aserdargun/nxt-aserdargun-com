import { NoteIdSchema, OpaqueIdSchema, TrashResponseSchema } from "@nxt/contracts";
import { ApiResponseError, typedJson } from "../http/api-response.js";
import { MAX_ATTACHMENT_BYTES } from "../services/attachment-policy.js";
import { assertNoQuery, defaultPrivateHandlerDependencies, handlePrivate, pathValue } from "./private-api.js";
const MAX_ENCODED_BYTES = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4;
const MAX_UPLOAD_REQUEST_BYTES = MAX_ENCODED_BYTES + 16 * 1024;
const uploadResponseSchema = {
    parse(value) {
        if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 1)
            throw new Error("invalid attachment response");
        const asset = value.asset;
        if (typeof asset !== "object" || asset === null || Array.isArray(asset) || Object.keys(asset).length !== 5)
            throw new Error("invalid attachment response");
        const valueAsset = asset;
        if (!isOpaqueId(valueAsset.assetId) || typeof valueAsset.name !== "string" || valueAsset.name.length === 0 || valueAsset.name.length > 180 ||
            typeof valueAsset.mimeType !== "string" || valueAsset.mimeType.length === 0 || valueAsset.mimeType.length > 256 ||
            !Number.isSafeInteger(valueAsset.size) || valueAsset.size < 0 || valueAsset.size > MAX_ATTACHMENT_BYTES ||
            (valueAsset.disposition !== "inline" && valueAsset.disposition !== "download"))
            throw new Error("invalid attachment response");
        return value;
    }
};
export const createAttachmentHandlers = (dependencies = defaultPrivateHandlerDependencies()) => ({
    create: (request) => handlePrivate(request, dependencies, async (services) => {
        assertNoQuery(request);
        const body = await parseUploadBody(request);
        const uploaded = await services.attachments.upload(body);
        return typedJson({
            asset: {
                assetId: dependencies.idCodec.encode(uploaded.driveId),
                name: uploaded.name,
                mimeType: uploaded.mimeType,
                size: uploaded.size,
                disposition: uploaded.disposition
            }
        }, uploadResponseSchema, 201);
    }),
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
    let body;
    try {
        body = await request.json();
    }
    catch {
        throw new ApiResponseError("INVALID_INPUT");
    }
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
    if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
        throw new ApiResponseError("INVALID_INPUT");
    }
    try {
        return new Uint8Array(Buffer.from(value, "base64"));
    }
    catch {
        throw new ApiResponseError("INVALID_INPUT");
    }
};
const rfc5987Filename = (value) => {
    let safe;
    try {
        safe = stripC0C1(value.normalize("NFC")).replace(/[\\/]/gu, "").trim();
    }
    catch {
        safe = "download";
    }
    if (safe.length === 0)
        safe = "download";
    return encodeURIComponent(safe).replace(/[!'()*]/gu, (character) => `%${character.codePointAt(0)?.toString(16).toUpperCase()}`);
};
const isOpaqueId = (value) => {
    try {
        OpaqueIdSchema.parse(value);
        return true;
    }
    catch {
        return false;
    }
};
const stripC0C1 = (value) => [...value].filter((character) => {
    const code = character.codePointAt(0);
    return code > 31 && (code < 127 || code > 159);
}).join("");
//# sourceMappingURL=attachments.js.map