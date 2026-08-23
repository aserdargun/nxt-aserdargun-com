import { randomUUID } from "node:crypto";
const ERROR_DEFINITIONS = {
    UNAUTHORIZED: { status: 401, message: "Authentication is required." },
    FORBIDDEN: { status: 403, message: "This account cannot access the vault." },
    NOT_FOUND: { status: 404, message: "The requested resource was not found." },
    CONFLICT: { status: 409, message: "The resource changed. Refresh and try again." },
    INVALID_INPUT: { status: 400, message: "The request is invalid." },
    DRIVE_UNAVAILABLE: { status: 503, message: "The service is temporarily unavailable." },
    UNSAFE_FILE: { status: 400, message: "The file is not safe to use." },
    TOO_LARGE: { status: 413, message: "The file is too large." }
};
const ERROR_CODES = new Set(Object.keys(ERROR_DEFINITIONS));
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const MAX_SERIALIZATION_DEPTH = 32;
const MAX_CONTAINER_ENTRIES = 1_000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;
export class ApiResponseError extends Error {
    code;
    status;
    constructor(code) {
        const definition = ERROR_DEFINITIONS[code];
        super(definition.message);
        this.name = "ApiResponseError";
        this.code = code;
        this.status = definition.status;
    }
}
export const json = (value, status = 200) => ({
    status,
    headers: JSON_HEADERS,
    jsonBody: sanitize(value, new WeakSet(), 0)
});
export const errorResponse = (error, suppliedRequestId) => {
    const code = extractErrorCode(error) ?? "DRIVE_UNAVAILABLE";
    const definition = ERROR_DEFINITIONS[code];
    const requestId = isRequestId(suppliedRequestId) ? suppliedRequestId : randomUUID();
    const body = {
        error: {
            code,
            message: definition.message,
            requestId
        }
    };
    return json(body, definition.status);
};
const extractErrorCode = (error) => {
    try {
        if (error instanceof ApiResponseError) {
            return error.code;
        }
        if ((typeof error !== "object" && typeof error !== "function") || error === null) {
            return null;
        }
        const descriptor = Object.getOwnPropertyDescriptor(error, "code");
        return descriptor !== undefined && "value" in descriptor && isErrorCode(descriptor.value) ? descriptor.value : null;
    }
    catch {
        return null;
    }
};
const isErrorCode = (value) => typeof value === "string" && ERROR_CODES.has(value);
const isRequestId = (value) => typeof value === "string" && REQUEST_ID_PATTERN.test(value);
const sanitize = (value, seen, depth) => {
    if (depth > MAX_SERIALIZATION_DEPTH) {
        return "[Truncated]";
    }
    if (value === null || typeof value === "string" || typeof value === "boolean") {
        return value;
    }
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === "bigint") {
        return value.toString();
    }
    if (typeof value !== "object") {
        return null;
    }
    if (isNativeError(value)) {
        return "[Error]";
    }
    if (seen.has(value)) {
        return "[Circular]";
    }
    seen.add(value);
    if (Array.isArray(value)) {
        let lengthDescriptor;
        try {
            lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
        }
        catch {
            seen.delete(value);
            return "[Unserializable]";
        }
        const length = lengthDescriptor !== undefined &&
            "value" in lengthDescriptor &&
            typeof lengthDescriptor.value === "number" &&
            Number.isSafeInteger(lengthDescriptor.value) &&
            lengthDescriptor.value >= 0
            ? Math.min(lengthDescriptor.value, MAX_CONTAINER_ENTRIES)
            : 0;
        const result = [];
        for (let index = 0; index < length; index += 1) {
            let descriptor;
            try {
                descriptor = Object.getOwnPropertyDescriptor(value, String(index));
            }
            catch {
                result.push(null);
                continue;
            }
            result.push(descriptor !== undefined && "value" in descriptor ? sanitize(descriptor.value, seen, depth + 1) : null);
        }
        seen.delete(value);
        return result;
    }
    let keys;
    try {
        keys = Reflect.ownKeys(value).slice(0, MAX_CONTAINER_ENTRIES);
    }
    catch {
        seen.delete(value);
        return "[Unserializable]";
    }
    const result = Object.create(null);
    for (const key of keys) {
        if (typeof key !== "string" || isSensitiveKey(key)) {
            continue;
        }
        let descriptor;
        try {
            descriptor = Object.getOwnPropertyDescriptor(value, key);
        }
        catch {
            continue;
        }
        if (descriptor === undefined || !("value" in descriptor)) {
            continue;
        }
        result[key] = sanitize(descriptor.value, seen, depth + 1);
    }
    seen.delete(value);
    return result;
};
const isSensitiveKey = (key) => {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
    if (["__proto__", "prototype", "constructor"].includes(key.toLowerCase())) {
        return true;
    }
    if (normalized === "authorization" ||
        normalized === "proxyauthorization" ||
        normalized.includes("stack") ||
        normalized.includes("cause") ||
        normalized.includes("token") ||
        normalized.includes("secret") ||
        normalized.includes("password") ||
        normalized.includes("credential") ||
        normalized.includes("apikey")) {
        return true;
    }
    return normalized === "parents" || /(?:drive|file|folder|root|parent|snapshot).*ids?$/u.test(normalized);
};
const isNativeError = (value) => {
    try {
        return value instanceof Error;
    }
    catch {
        return false;
    }
};
//# sourceMappingURL=api-response.js.map