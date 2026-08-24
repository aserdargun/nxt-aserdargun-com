import { randomUUID } from "node:crypto";
import { isNativeError as nodeIsNativeError, isProxy as nodeIsProxy } from "node:util/types";
const ERROR_DEFINITIONS = {
    UNAUTHORIZED: { status: 401, message: "Authentication is required." },
    FORBIDDEN: { status: 403, message: "This account cannot access the vault." },
    NOT_FOUND: { status: 404, message: "The requested resource was not found." },
    CONFLICT: {
        status: 409,
        message: "The resource changed. Refresh and try again."
    },
    INVALID_INPUT: { status: 400, message: "The request is invalid." },
    DRIVE_UNAVAILABLE: {
        status: 503,
        message: "The service is temporarily unavailable."
    },
    UNSAFE_FILE: { status: 400, message: "The file is not safe to use." },
    TOO_LARGE: { status: 413, message: "The file is too large." }
};
const ERROR_CODES = new Set(Object.keys(ERROR_DEFINITIONS));
const JSON_HEADERS = {
    "content-type": "application/json; charset=utf-8"
};
const MAX_SANITIZATION_DEPTH = 32;
const MAX_SANITIZATION_NODES = 8_192;
const MAX_SANITIZATION_ENTRIES = 16_384;
const MAX_SANITIZATION_OUTPUT_BYTES = 262_144;
const TRUNCATION_RESERVE_BYTES = 64;
const MAX_STRING_CODE_UNITS = MAX_SANITIZATION_OUTPUT_BYTES;
const MAX_KEY_CODE_UNITS = 256;
const MAX_PROTOTYPE_CHAIN_DEPTH = 32;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TRUNCATED = "[Truncated]";
const UNSERIALIZABLE = "[Unserializable]";
const ERROR_MARKER = "[Error]";
const CIRCULAR = "[Circular]";
const TRUSTED_API_ERRORS = new WeakSet();
export class ApiResponseError extends Error {
    code;
    status;
    constructor(code) {
        const definition = ERROR_DEFINITIONS[code];
        super(definition.message);
        this.name = "ApiResponseError";
        this.code = code;
        this.status = definition.status;
        TRUSTED_API_ERRORS.add(this);
    }
}
export const json = (value, status = 200) => ({
    status,
    headers: JSON_HEADERS,
    jsonBody: safelySanitize(value)
});
export const typedJson = (value, schema, status = 200) => {
    let unvalidatedSource;
    try {
        unvalidatedSource = JSON.stringify(value);
    }
    catch {
        throw new ApiResponseError("DRIVE_UNAVAILABLE");
    }
    if (new TextEncoder().encode(unvalidatedSource).byteLength > MAX_SANITIZATION_OUTPUT_BYTES)
        throw new ApiResponseError("TOO_LARGE");
    let parsed;
    try {
        parsed = schema.parse(value);
    }
    catch {
        throw new ApiResponseError("DRIVE_UNAVAILABLE");
    }
    let source;
    try {
        source = JSON.stringify(parsed);
    }
    catch {
        throw new ApiResponseError("DRIVE_UNAVAILABLE");
    }
    if (new TextEncoder().encode(source).byteLength > MAX_SANITIZATION_OUTPUT_BYTES)
        throw new ApiResponseError("TOO_LARGE");
    return { status, headers: JSON_HEADERS, jsonBody: parsed };
};
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
    return {
        status: definition.status,
        headers: JSON_HEADERS,
        jsonBody: body
    };
};
const extractErrorCode = (error) => {
    try {
        if (!(error instanceof ApiResponseError) || !TRUSTED_API_ERRORS.has(error))
            return null;
        if (inspectProxy(error) !== false) {
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
const safelySanitize = (value) => {
    const state = {
        path: new WeakSet(),
        visitedNodes: 0,
        visitedEntries: 0,
        outputBytes: 0,
        exhausted: false
    };
    try {
        return sanitize(value, state, 0);
    }
    catch {
        return UNSERIALIZABLE;
    }
};
const sanitize = (value, state, depth) => {
    if (state.exhausted || depth > MAX_SANITIZATION_DEPTH || !visitNode(state)) {
        return truncate(state);
    }
    if (value === null || typeof value === "string" || typeof value === "boolean") {
        return emitPrimitive(value, state);
    }
    if (typeof value === "number") {
        return emitPrimitive(Number.isFinite(value) ? value : null, state);
    }
    if (typeof value === "bigint") {
        let converted;
        try {
            converted = String(value);
        }
        catch {
            return emitMarker(UNSERIALIZABLE, state);
        }
        return emitPrimitive(converted, state);
    }
    if ((typeof value !== "object" && typeof value !== "function") || value === null) {
        return emitPrimitive(null, state);
    }
    if (inspectProxy(value) !== false) {
        return emitMarker(UNSERIALIZABLE, state);
    }
    if (typeof value !== "object") {
        return emitPrimitive(null, state);
    }
    if (isNativeError(value)) {
        return emitMarker(ERROR_MARKER, state);
    }
    if (state.path.has(value)) {
        return emitMarker(CIRCULAR, state);
    }
    const arrayKind = inspectArray(value);
    if (arrayKind === null) {
        return emitMarker(UNSERIALIZABLE, state);
    }
    state.path.add(value);
    try {
        return arrayKind ? sanitizeArray(value, state, depth) : sanitizeObject(value, state, depth);
    }
    finally {
        state.path.delete(value);
    }
};
const sanitizeArray = (value, state, depth) => {
    if (!reserveOutput(state, 2)) {
        return truncate(state);
    }
    let lengthDescriptor;
    try {
        lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    }
    catch {
        return emitMarker(UNSERIALIZABLE, state);
    }
    if (lengthDescriptor === undefined ||
        !("value" in lengthDescriptor) ||
        typeof lengthDescriptor.value !== "number" ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0) {
        return emitMarker(UNSERIALIZABLE, state);
    }
    const result = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
        if (!visitEntry(state) || (index > 0 && !reserveOutput(state, 1))) {
            result.push(truncate(state));
            break;
        }
        let descriptor;
        try {
            descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        }
        catch {
            result.push(emitMarker(UNSERIALIZABLE, state));
            continue;
        }
        const sanitized = descriptor !== undefined && "value" in descriptor
            ? sanitize(descriptor.value, state, depth + 1)
            : emitPrimitive(null, state);
        result.push(sanitized);
        if (state.exhausted) {
            break;
        }
    }
    return result;
};
const sanitizeObject = (value, state, depth) => {
    if (!admitPrototypeChain(value, state)) {
        return emitMarker(UNSERIALIZABLE, state);
    }
    if (!reserveOutput(state, 2)) {
        return truncate(state);
    }
    const result = Object.create(null);
    try {
        for (const key in value) {
            if (!visitEntry(state) || key.length > MAX_KEY_CODE_UNITS) {
                return truncate(state);
            }
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
                continue;
            }
            if (isSensitiveKey(key)) {
                continue;
            }
            const keyBytes = serializedStringBytes(key);
            if (keyBytes === null || !reserveOutput(state, keyBytes + 2)) {
                return truncate(state);
            }
            result[key] = sanitize(descriptor.value, state, depth + 1);
            if (state.exhausted) {
                break;
            }
        }
    }
    catch {
        return emitMarker(UNSERIALIZABLE, state);
    }
    return result;
};
const admitPrototypeChain = (value, state) => {
    let prototype;
    try {
        prototype = Object.getPrototypeOf(value);
    }
    catch {
        return false;
    }
    const seen = new WeakSet();
    let depth = 0;
    while (prototype !== null) {
        if (inspectProxy(prototype) !== false) {
            return false;
        }
        depth += 1;
        if (!visitNode(state) || depth > MAX_PROTOTYPE_CHAIN_DEPTH || seen.has(prototype)) {
            return false;
        }
        seen.add(prototype);
        try {
            prototype = Object.getPrototypeOf(prototype);
        }
        catch {
            return false;
        }
    }
    return true;
};
const visitNode = (state) => {
    state.visitedNodes += 1;
    return state.visitedNodes <= MAX_SANITIZATION_NODES;
};
const visitEntry = (state) => {
    state.visitedEntries += 1;
    return state.visitedEntries <= MAX_SANITIZATION_ENTRIES;
};
const reserveOutput = (state, bytes) => {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
        return false;
    }
    if (state.outputBytes + bytes > MAX_SANITIZATION_OUTPUT_BYTES - TRUNCATION_RESERVE_BYTES) {
        return false;
    }
    state.outputBytes += bytes;
    return true;
};
const emitPrimitive = (value, state) => {
    const bytes = primitiveBytes(value);
    if (bytes === null || !reserveOutput(state, bytes)) {
        return truncate(state);
    }
    return value;
};
const emitMarker = (marker, state) => {
    const bytes = serializedStringBytes(marker);
    if (bytes === null || !reserveOutput(state, bytes)) {
        return truncate(state);
    }
    return marker;
};
const truncate = (state) => {
    if (!state.exhausted) {
        state.exhausted = true;
        state.outputBytes = Math.min(MAX_SANITIZATION_OUTPUT_BYTES, state.outputBytes + (serializedStringBytes(TRUNCATED) ?? TRUNCATION_RESERVE_BYTES));
    }
    return TRUNCATED;
};
const primitiveBytes = (value) => {
    if (typeof value === "string") {
        return serializedStringBytes(value);
    }
    if (value === null) {
        return 4;
    }
    if (typeof value === "boolean") {
        return value ? 4 : 5;
    }
    return 32;
};
const serializedStringBytes = (value) => {
    if (value.length > MAX_STRING_CODE_UNITS) {
        return null;
    }
    try {
        const serialized = JSON.stringify(value);
        return typeof serialized === "string" ? Buffer.byteLength(serialized, "utf8") : null;
    }
    catch {
        return null;
    }
};
const inspectArray = (value) => {
    try {
        return Array.isArray(value);
    }
    catch {
        return null;
    }
};
const isSensitiveKey = (key) => {
    const lowered = key.toLowerCase();
    const normalized = lowered.replace(/[^a-z0-9]/gu, "");
    if (["__proto__", "prototype", "constructor"].includes(lowered)) {
        return true;
    }
    if (normalized === "message" ||
        normalized === "authorization" ||
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
        return nodeIsNativeError(value);
    }
    catch {
        return false;
    }
};
const inspectProxy = (value) => {
    try {
        return nodeIsProxy(value);
    }
    catch {
        return null;
    }
};
//# sourceMappingURL=api-response.js.map