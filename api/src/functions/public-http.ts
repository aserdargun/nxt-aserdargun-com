import type { HttpResponseInit } from "@azure/functions";
import { randomUUID } from "node:crypto";

const PUBLIC_MAX_CONCURRENT = 8;
const PUBLIC_MAX_REQUESTS_PER_WINDOW = 120;
const PUBLIC_RATE_WINDOW_MS = 60_000;

export type PublicRequestRelease = () => void;

export class PublicRequestGate {
  private active = 0;
  private readonly admittedAt: number[] = [];

  public constructor(private readonly options: {
    maxConcurrent: number;
    maxRequests: number;
    windowMs: number;
    now?: () => number;
  }) {
    if (
      !Number.isSafeInteger(options.maxConcurrent) || options.maxConcurrent < 1 ||
      !Number.isSafeInteger(options.maxRequests) || options.maxRequests < 1 ||
      !Number.isSafeInteger(options.windowMs) || options.windowMs < 1
    ) throw new Error("invalid public request gate configuration");
  }

  public tryAcquire(): PublicRequestRelease | null {
    const now = this.options.now?.() ?? Date.now();
    const cutoff = now - this.options.windowMs;
    while (this.admittedAt[0] !== undefined && this.admittedAt[0] <= cutoff) {
      this.admittedAt.shift();
    }
    if (
      this.active >= this.options.maxConcurrent ||
      this.admittedAt.length >= this.options.maxRequests
    ) return null;

    this.active += 1;
    this.admittedAt.push(now);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }
}

export const publicRequestGate = new PublicRequestGate({
  maxConcurrent: PUBLIC_MAX_CONCURRENT,
  maxRequests: PUBLIC_MAX_REQUESTS_PER_WINDOW,
  windowMs: PUBLIC_RATE_WINDOW_MS
});

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
