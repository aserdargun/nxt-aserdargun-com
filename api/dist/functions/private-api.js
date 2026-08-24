import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { ownerFromRequest } from "./session.js";
import { ApiResponseError, errorResponse } from "../http/api-response.js";
import { resolveTask7Services } from "../services/runtime-services.js";
const OPAQUE_ID_PATTERN = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/u;
export const defaultPrivateHandlerDependencies = () => ({
    authorize: ownerFromRequest,
    resolveServices: resolveTask7Services,
    idCodec: runtimeIdCodec()
});
export class OpaqueIdCodec {
    key;
    constructor(secret) {
        if (secret.length < 32)
            throw new Error("opaque ID secret is too short");
        this.key = createHash("sha256").update("nxt:opaque-drive-id:v1\0").update(secret).digest();
    }
    encode(value) {
        if (value.length === 0 || value.length > 512)
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", this.key, iv);
        const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
        const token = `v1.${iv.toString("base64url")}.${encrypted.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
        if (token.length > 512)
            throw new ApiResponseError("DRIVE_UNAVAILABLE");
        return token;
    }
    decode(token) {
        if (token.length === 0 || token.length > 512)
            throw new ApiResponseError("INVALID_INPUT");
        const match = OPAQUE_ID_PATTERN.exec(token);
        if (match === null)
            throw new ApiResponseError("INVALID_INPUT");
        try {
            const iv = Buffer.from(match[1], "base64url");
            const encrypted = Buffer.from(match[2], "base64url");
            const tag = Buffer.from(match[3], "base64url");
            if (iv.length !== 12 || tag.length !== 16 || encrypted.length === 0)
                throw new Error("invalid token");
            const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
            decipher.setAuthTag(tag);
            const value = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
            if (value.length === 0 || value.length > 512)
                throw new Error("invalid value");
            return value;
        }
        catch {
            throw new ApiResponseError("INVALID_INPUT");
        }
    }
}
export const handlePrivate = async (request, dependencies, action) => {
    try {
        dependencies.authorize(request);
        return await action(dependencies.resolveServices());
    }
    catch (error) {
        return errorResponse(error);
    }
};
export const assertNoQuery = (request) => {
    let url;
    try {
        url = new URL(request.url);
    }
    catch {
        throw new ApiResponseError("INVALID_INPUT");
    }
    if ([...url.searchParams].length !== 0)
        throw new ApiResponseError("INVALID_INPUT");
};
export const parseBody = async (request, schema) => {
    let value;
    try {
        value = await request.json();
        return schema.parse(value);
    }
    catch {
        throw new ApiResponseError("INVALID_INPUT");
    }
};
export const pathValue = (request, key, schema) => {
    try {
        return schema.parse(request.params[key]);
    }
    catch {
        throw new ApiResponseError("INVALID_INPUT");
    }
};
let cachedCodec;
const runtimeIdCodec = () => {
    if (cachedCodec !== undefined)
        return cachedCodec;
    const secret = `${process.env.GOOGLE_CLIENT_SECRET ?? ""}\0${process.env.GOOGLE_REFRESH_TOKEN ?? ""}`;
    if (secret.replace("\0", "").length < 32) {
        // Construction remains lazy enough for registration tests, but production fails closed.
        return new OpaqueIdCodec("unconfigured-runtime-id-codec-fails-before-storage");
    }
    cachedCodec = new OpaqueIdCodec(secret);
    return cachedCodec;
};
//# sourceMappingURL=private-api.js.map