import type { HttpResponseInit } from "@azure/functions";
import type { ApiError } from "@nxt/contracts";
import { randomUUID } from "node:crypto";
import { isNativeError as nodeIsNativeError, isProxy as nodeIsProxy } from "node:util/types";

type ApiErrorCode = ApiError["error"]["code"];

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
} as const satisfies Record<ApiErrorCode, { status: number; message: string }>;

const ERROR_CODES = new Set<ApiErrorCode>(Object.keys(ERROR_DEFINITIONS) as ApiErrorCode[]);
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8"
} as const;
const MAX_SANITIZATION_DEPTH = 32;
const MAX_SANITIZATION_NODES = 8_192;
const MAX_SANITIZATION_ENTRIES = 16_384;
const MAX_SANITIZATION_OUTPUT_BYTES = 262_144;
const TRUNCATION_RESERVE_BYTES = 64;
const MAX_STRING_CODE_UNITS = MAX_SANITIZATION_OUTPUT_BYTES;
const MAX_KEY_CODE_UNITS = 256;
const MAX_PROTOTYPE_CHAIN_DEPTH = 32;
const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TRUNCATED = "[Truncated]";
const UNSERIALIZABLE = "[Unserializable]";
const ERROR_MARKER = "[Error]";
const CIRCULAR = "[Circular]";

interface SanitizationState {
  readonly path: WeakSet<object>;
  visitedNodes: number;
  visitedEntries: number;
  outputBytes: number;
  exhausted: boolean;
}

export class ApiResponseError extends Error {
  public readonly code: ApiErrorCode;
  public readonly status: number;

  public constructor(code: ApiErrorCode) {
    const definition = ERROR_DEFINITIONS[code];
    super(definition.message);
    this.name = "ApiResponseError";
    this.code = code;
    this.status = definition.status;
  }
}

export const json = (value: unknown, status = 200): HttpResponseInit => ({
  status,
  headers: JSON_HEADERS,
  jsonBody: safelySanitize(value)
});

export const errorResponse = (error: unknown, suppliedRequestId?: string): HttpResponseInit => {
  const code = extractErrorCode(error) ?? "DRIVE_UNAVAILABLE";
  const definition = ERROR_DEFINITIONS[code];
  const requestId = isRequestId(suppliedRequestId) ? suppliedRequestId : randomUUID();
  const body: ApiError = {
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

const extractErrorCode = (error: unknown): ApiErrorCode | null => {
  try {
    if ((typeof error !== "object" && typeof error !== "function") || error === null) {
      return null;
    }
    if (inspectProxy(error) !== false) {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor !== undefined && "value" in descriptor && isErrorCode(descriptor.value) ? descriptor.value : null;
  } catch {
    return null;
  }
};

const isErrorCode = (value: unknown): value is ApiErrorCode =>
  typeof value === "string" && ERROR_CODES.has(value as ApiErrorCode);

const isRequestId = (value: string | undefined): value is string =>
  typeof value === "string" && REQUEST_ID_PATTERN.test(value);

const safelySanitize = (value: unknown): unknown => {
  const state: SanitizationState = {
    path: new WeakSet<object>(),
    visitedNodes: 0,
    visitedEntries: 0,
    outputBytes: 0,
    exhausted: false
  };
  try {
    return sanitize(value, state, 0);
  } catch {
    return UNSERIALIZABLE;
  }
};

const sanitize = (value: unknown, state: SanitizationState, depth: number): unknown => {
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
    let converted: string;
    try {
      converted = String(value);
    } catch {
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
  } finally {
    state.path.delete(value);
  }
};

const sanitizeArray = (value: object, state: SanitizationState, depth: number): unknown => {
  if (!reserveOutput(state, 2)) {
    return truncate(state);
  }
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  } catch {
    return emitMarker(UNSERIALIZABLE, state);
  }
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    typeof lengthDescriptor.value !== "number" ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    return emitMarker(UNSERIALIZABLE, state);
  }

  const result: unknown[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    if (!visitEntry(state) || (index > 0 && !reserveOutput(state, 1))) {
      result.push(truncate(state));
      break;
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      result.push(emitMarker(UNSERIALIZABLE, state));
      continue;
    }
    const sanitized =
      descriptor !== undefined && "value" in descriptor
        ? sanitize(descriptor.value, state, depth + 1)
        : emitPrimitive(null, state);
    result.push(sanitized);
    if (state.exhausted) {
      break;
    }
  }
  return result;
};

const sanitizeObject = (value: object, state: SanitizationState, depth: number): unknown => {
  if (!admitPrototypeChain(value, state)) {
    return emitMarker(UNSERIALIZABLE, state);
  }
  if (!reserveOutput(state, 2)) {
    return truncate(state);
  }

  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
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
  } catch {
    return emitMarker(UNSERIALIZABLE, state);
  }
  return result;
};

const admitPrototypeChain = (value: object, state: SanitizationState): boolean => {
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
  } catch {
    return false;
  }

  const seen = new WeakSet<object>();
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
      prototype = Object.getPrototypeOf(prototype) as object | null;
    } catch {
      return false;
    }
  }
  return true;
};

const visitNode = (state: SanitizationState): boolean => {
  state.visitedNodes += 1;
  return state.visitedNodes <= MAX_SANITIZATION_NODES;
};

const visitEntry = (state: SanitizationState): boolean => {
  state.visitedEntries += 1;
  return state.visitedEntries <= MAX_SANITIZATION_ENTRIES;
};

const reserveOutput = (state: SanitizationState, bytes: number): boolean => {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    return false;
  }
  if (state.outputBytes + bytes > MAX_SANITIZATION_OUTPUT_BYTES - TRUNCATION_RESERVE_BYTES) {
    return false;
  }
  state.outputBytes += bytes;
  return true;
};

const emitPrimitive = (value: null | string | number | boolean, state: SanitizationState): unknown => {
  const bytes = primitiveBytes(value);
  if (bytes === null || !reserveOutput(state, bytes)) {
    return truncate(state);
  }
  return value;
};

const emitMarker = (marker: string, state: SanitizationState): string => {
  const bytes = serializedStringBytes(marker);
  if (bytes === null || !reserveOutput(state, bytes)) {
    return truncate(state);
  }
  return marker;
};

const truncate = (state: SanitizationState): string => {
  if (!state.exhausted) {
    state.exhausted = true;
    state.outputBytes = Math.min(
      MAX_SANITIZATION_OUTPUT_BYTES,
      state.outputBytes + (serializedStringBytes(TRUNCATED) ?? TRUNCATION_RESERVE_BYTES)
    );
  }
  return TRUNCATED;
};

const primitiveBytes = (value: null | string | number | boolean): number | null => {
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

const serializedStringBytes = (value: string): number | null => {
  if (value.length > MAX_STRING_CODE_UNITS) {
    return null;
  }
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? Buffer.byteLength(serialized, "utf8") : null;
  } catch {
    return null;
  }
};

const inspectArray = (value: object): boolean | null => {
  try {
    return Array.isArray(value);
  } catch {
    return null;
  }
};

const isSensitiveKey = (key: string): boolean => {
  const lowered = key.toLowerCase();
  const normalized = lowered.replace(/[^a-z0-9]/gu, "");
  if (["__proto__", "prototype", "constructor"].includes(lowered)) {
    return true;
  }
  if (
    normalized === "message" ||
    normalized === "authorization" ||
    normalized === "proxyauthorization" ||
    normalized.includes("stack") ||
    normalized.includes("cause") ||
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("credential") ||
    normalized.includes("apikey")
  ) {
    return true;
  }
  return normalized === "parents" || /(?:drive|file|folder|root|parent|snapshot).*ids?$/u.test(normalized);
};

const isNativeError = (value: object): boolean => {
  try {
    return nodeIsNativeError(value);
  } catch {
    return false;
  }
};

const inspectProxy = (value: object): boolean | null => {
  try {
    return nodeIsProxy(value);
  } catch {
    return null;
  }
};
