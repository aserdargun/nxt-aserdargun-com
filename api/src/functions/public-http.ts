import type { HttpResponseInit } from "@azure/functions";
import { randomUUID } from "node:crypto";

export const publicHeaders = (requestId: string, contentType?: string): Record<string, string> => ({
  ...(contentType === undefined ? {} : { "content-type": contentType }),
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow",
  "x-content-type-options": "nosniff",
  "x-request-id": requestId
});

export const newPublicRequestId = (): string => randomUUID();

export const publicNotFound = (requestId: string): HttpResponseInit => ({
  status: 404,
  headers: publicHeaders(requestId, "application/json; charset=utf-8"),
  jsonBody: {
    error: {
      code: "NOT_FOUND",
      message: "The requested resource was not found.",
      requestId
    }
  }
});

export const hasNoQuery = (requestUrl: string): boolean => {
  try { return [...new URL(requestUrl).searchParams].length === 0; } catch { return false; }
};
