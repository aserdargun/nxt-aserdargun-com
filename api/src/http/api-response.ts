import type { HttpResponseInit } from "@azure/functions";
import type { ApiError } from "@nxt/contracts";
import { randomUUID } from "node:crypto";

type ApiErrorCode = ApiError["error"]["code"];

const ERROR_DEFINITIONS = {
  UNAUTHORIZED: { status: 401, message: "Authentication is required." },
  FORBIDDEN: { status: 403, message: "This account cannot access the vault." },
  NOT_FOUND: { status: 404, message: "The requested resource was not found." },
  CONFLICT: { status: 409, message: "The resource changed. Refresh and try again." },
  INVALID_INPUT: { status: 400, message: "The request is invalid." },
  DRIVE_UNAVAILABLE: { status: 503, message: "The service is temporarily unavailable." },
  UNSAFE_FILE: { status: 400, message: "The file is not safe to use." },
  TOO_LARGE: { status: 413, message: "The file is too large." }
} as const satisfies Record<ApiErrorCode, { status: number; message: string }>;

const ERROR_CODES = new Set<ApiErrorCode>(Object.keys(ERROR_DEFINITIONS) as ApiErrorCode[]);
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;
const MAX_SERIALIZATION_DEPTH = 32;
const MAX_CONTAINER_ENTRIES = 1_000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;

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
  jsonBody: sanitize(value, new WeakSet<object>(), 0)
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
  return json(body, definition.status);
};

const extractErrorCode = (error: unknown): ApiErrorCode | null => {
  try {
    if (error instanceof ApiResponseError) {
      return error.code;
    }
    if ((typeof error !== "object" && typeof error !== "function") || error === null) {
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

const sanitize = (value: unknown, seen: WeakSet<object>, depth: number): unknown => {
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
    let lengthDescriptor: PropertyDescriptor | undefined;
    try {
      lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    } catch {
      seen.delete(value);
      return "[Unserializable]";
    }
    const length =
      lengthDescriptor !== undefined &&
      "value" in lengthDescriptor &&
      typeof lengthDescriptor.value === "number" &&
      Number.isSafeInteger(lengthDescriptor.value) &&
      lengthDescriptor.value >= 0
        ? Math.min(lengthDescriptor.value, MAX_CONTAINER_ENTRIES)
        : 0;
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      } catch {
        result.push(null);
        continue;
      }
      result.push(descriptor !== undefined && "value" in descriptor ? sanitize(descriptor.value, seen, depth + 1) : null);
    }
    seen.delete(value);
    return result;
  }

  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value).slice(0, MAX_CONTAINER_ENTRIES);
  } catch {
    seen.delete(value);
    return "[Unserializable]";
  }

  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string" || isSensitiveKey(key)) {
      continue;
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
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

const isSensitiveKey = (key: string): boolean => {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
  if (["__proto__", "prototype", "constructor"].includes(key.toLowerCase())) {
    return true;
  }
  if (
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
    return value instanceof Error;
  } catch {
    return false;
  }
};
