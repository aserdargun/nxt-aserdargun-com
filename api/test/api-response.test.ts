import { ApiErrorSchema } from "@nxt/contracts";
import { describe, expect, it } from "vitest";
import { ApiResponseError, errorResponse, json } from "../src/http/api-response.js";

describe("json", () => {
  it("recursively removes sensitive fields without invoking getters or retaining cycles", () => {
    let getterCalls = 0;
    const payload: Record<string, unknown> = {
      safe: "visible",
      nested: {
        refresh_token: "refresh_token",
        authorization: "Bearer credential",
        driveFileId: "drive-file-id",
        child: { clientSecret: "secret-value", value: "kept" }
      },
      cause: { message: "drive-file-id" },
      nestedCause: { message: "drive-file-id" },
      stack: "Bearer stack-secret",
      errorStack: "Bearer error-stack-secret",
      driveIds: ["drive-file-id"]
    };
    Object.defineProperty(payload, "throwingGetter", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("Bearer getter-secret");
      }
    });
    payload.self = payload;

    const response = json(payload);
    const serialized = JSON.stringify(response.jsonBody);

    expect(response.status).toBe(200);
    expect(response.headers).toEqual({ "content-type": "application/json; charset=utf-8" });
    expect(serialized).toContain('"safe":"visible"');
    expect(serialized).toContain('"value":"kept"');
    expect(serialized).toContain("[Circular]");
    expect(getterCalls).toBe(0);
    for (const secret of [
      "refresh_token",
      "Bearer",
      "credential",
      "drive-file-id",
      "clientSecret",
      "secret-value",
      "cause",
      "Cause",
      "stack",
      "Stack",
      "driveIds",
      "throwingGetter"
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("serializes hostile proxy, bigint, and undefined values to safe JSON data", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("Bearer proxy-secret");
        }
      }
    );

    const response = json({ hostile, count: 4n, missing: undefined });

    expect(() => JSON.stringify(response.jsonBody)).not.toThrow();
    expect(response.jsonBody).toEqual({ hostile: "[Unserializable]", count: "4", missing: null });
  });

  it("does not invoke accessors stored at array indexes", () => {
    let getterCalls = 0;
    const values: unknown[] = [];
    Object.defineProperty(values, "0", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("Bearer array-getter-secret");
      }
    });
    values.length = 1;

    const response = json({ values });

    expect(getterCalls).toBe(0);
    expect(response.jsonBody).toEqual({ values: [null] });
    expect(JSON.stringify(response.jsonBody)).not.toContain("Bearer");
  });

  it("does not serialize native Error messages", () => {
    const response = json(new Error("Bearer drive-file-id refresh_token"));

    expect(response.jsonBody).toBe("[Error]");
    expect(JSON.stringify(response.jsonBody)).not.toMatch(/Bearer|drive-file-id|refresh_token/u);
  });
});

describe("errorResponse", () => {
  it.each([
    ["UNAUTHORIZED", 401],
    ["FORBIDDEN", 403],
    ["NOT_FOUND", 404],
    ["CONFLICT", 409],
    ["INVALID_INPUT", 400],
    ["DRIVE_UNAVAILABLE", 503],
    ["UNSAFE_FILE", 400],
    ["TOO_LARGE", 413]
  ] as const)("maps %s domain errors to the contract and HTTP status", (code, status) => {
    const domainError = new ApiResponseError(code);
    Object.assign(domainError, {
      refresh_token: "refresh_token",
      authorization: "Bearer credential",
      driveId: "drive-file-id",
      cause: new Error("Bearer nested cause")
    });

    const response = errorResponse(domainError, "req-fixed");
    const parsed = ApiErrorSchema.parse(response.jsonBody);
    const serialized = JSON.stringify(response.jsonBody);

    expect(response.status).toBe(status);
    expect(parsed.error).toMatchObject({ code, requestId: "req-fixed" });
    for (const secret of ["refresh_token", "Bearer", "credential", "drive-file-id", "nested cause", "stack", "cause"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("generates a request ID and fails closed for unknown or accessor-based error codes", () => {
    const unknown = new Error("Bearer drive-file-id refresh_token");
    Object.defineProperty(unknown, "code", {
      get() {
        throw new Error("Bearer code-getter");
      }
    });

    const response = errorResponse(unknown);
    const parsed = ApiErrorSchema.parse(response.jsonBody);

    expect(response.status).toBe(503);
    expect(parsed.error.code).toBe("DRIVE_UNAVAILABLE");
    expect(parsed.error.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(JSON.stringify(response.jsonBody)).not.toMatch(/Bearer|drive-file-id|refresh_token|code-getter/u);
  });

  it("fails closed when a hostile error proxy rejects prototype inspection", () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("Bearer proxy-prototype-secret");
        }
      }
    );

    expect(() => errorResponse(hostile)).not.toThrow();
    expect(errorResponse(hostile).status).toBe(503);
  });
});
