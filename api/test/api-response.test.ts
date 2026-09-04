import { ApiErrorSchema } from "@nxt/contracts";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { ApiResponseError, errorResponse, json, typedJson } from "../src/http/api-response.js";

const CANONICAL_REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
const GENERATED_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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
    expect(response.headers).toEqual({
      "content-type": "application/json; charset=utf-8"
    });
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

  it("keeps confirmation tokens redacted on the general untyped response path", () => {
    const response = json({ confirmationToken: `c1.${"a".repeat(120)}.${"b".repeat(43)}`, safe: "visible" });
    expect(response.jsonBody).toEqual({ safe: "visible" });
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
    expect(response.jsonBody).toEqual({
      hostile: "[Unserializable]",
      count: "4",
      missing: null
    });
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

  it("detects cross-realm native errors without reading their secret message", () => {
    const context = { messageReads: 0 };
    const crossRealmError = runInNewContext(
      `(() => {
        const error = new Error();
        Object.defineProperty(error, "message", {
          enumerable: true,
          get() {
            messageReads += 1;
            return "Bearer drive-file-id refresh_token";
          }
        });
        return error;
      })()`,
      context
    ) as unknown;

    const response = json(crossRealmError);

    expect(response.jsonBody).toBe("[Error]");
    expect(context.messageReads).toBe(0);
    expect(JSON.stringify(response.jsonBody)).not.toMatch(/Bearer|drive-file-id|refresh_token/u);
  });

  it("does not invoke Error-spoofing accessors", () => {
    let getterCalls = 0;
    const spoofed = Object.create(null) as Record<PropertyKey, unknown>;
    Object.defineProperty(spoofed, Symbol.toStringTag, {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("Bearer tag-secret");
      }
    });
    Object.defineProperty(spoofed, "message", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("Bearer message-secret");
      }
    });

    const response = json(spoofed);

    expect(getterCalls).toBe(0);
    expect(() => JSON.stringify(response.jsonBody)).not.toThrow();
    expect(JSON.stringify(response.jsonBody)).not.toContain("Bearer");
  });

  it("rejects a transparent Error proxy before inspection or enumeration", () => {
    let prototypeReads = 0;
    let ownKeyReads = 0;
    const proxiedError = new Proxy(new Error("Bearer proxied-error-secret"), {
      getPrototypeOf(target) {
        prototypeReads += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys(target) {
        ownKeyReads += 1;
        return Reflect.ownKeys(target);
      }
    });

    const response = json(proxiedError);

    expect(response.jsonBody).toBe("[Unserializable]");
    expect(prototypeReads).toBe(0);
    expect(ownKeyReads).toBe(0);
    expect(JSON.stringify(response.jsonBody)).not.toContain("proxied-error-secret");
  });

  it("rejects a plain-data proxy before an explosive ownKeys trap", () => {
    let ownKeyReads = 0;
    const proxiedSpoof = new Proxy(
      { message: "Bearer proxied-message-secret", safe: "not-admitted" },
      {
        ownKeys(target) {
          ownKeyReads += 1;
          Reflect.ownKeys(target);
          throw new Error("Bearer explosive-ownKeys-secret");
        }
      }
    );

    const response = json(proxiedSpoof);

    expect(response.jsonBody).toBe("[Unserializable]");
    expect(ownKeyReads).toBe(0);
    expect(JSON.stringify(response.jsonBody)).not.toContain("proxied-message-secret");
  });

  it("rejects an explosive Proxy used as the direct prototype before trap invocation", () => {
    let prototypeReads = 0;
    let ownKeyReads = 0;
    const hostilePrototype = new Proxy(
      { inherited: "Bearer direct-prototype-secret" },
      {
        getPrototypeOf() {
          prototypeReads += 1;
          throw new Error("Bearer direct-prototype-get-secret");
        },
        ownKeys() {
          ownKeyReads += 1;
          throw new Error("Bearer direct-prototype-ownKeys-secret");
        }
      }
    );
    const payload = Object.create(hostilePrototype) as Record<string, unknown>;
    payload.safe = "not-admitted";

    const response = json(payload);

    expect(response.jsonBody).toBe("[Unserializable]");
    expect(prototypeReads).toBe(0);
    expect(ownKeyReads).toBe(0);
    expect(JSON.stringify(response.jsonBody)).not.toContain("direct-prototype-secret");
  });

  it("rejects an explosive Proxy deeper in the prototype chain before trap invocation", () => {
    let prototypeReads = 0;
    let ownKeyReads = 0;
    const hostilePrototype = new Proxy(
      { inherited: "Bearer deep-prototype-secret" },
      {
        getPrototypeOf() {
          prototypeReads += 1;
          throw new Error("Bearer deep-prototype-get-secret");
        },
        ownKeys() {
          ownKeyReads += 1;
          throw new Error("Bearer deep-prototype-ownKeys-secret");
        }
      }
    );
    const admittedMiddle = Object.create(hostilePrototype) as Record<string, unknown>;
    const payload = Object.create(admittedMiddle) as Record<string, unknown>;
    payload.safe = "not-admitted";

    const response = json(payload);

    expect(response.jsonBody).toBe("[Unserializable]");
    expect(prototypeReads).toBe(0);
    expect(ownKeyReads).toBe(0);
    expect(JSON.stringify(response.jsonBody)).not.toContain("deep-prototype-secret");
  });

  it("rejects a revoked Proxy in the prototype chain without invoking its traps", () => {
    let prototypeReads = 0;
    let ownKeyReads = 0;
    const hostilePrototype = Proxy.revocable(
      { inherited: "Bearer revoked-prototype-secret" },
      {
        getPrototypeOf(target) {
          prototypeReads += 1;
          return Reflect.getPrototypeOf(target);
        },
        ownKeys(target) {
          ownKeyReads += 1;
          return Reflect.ownKeys(target);
        }
      }
    );
    const payload = Object.create(hostilePrototype.proxy) as Record<string, unknown>;
    payload.safe = "not-admitted";
    hostilePrototype.revoke();

    const response = json(payload);

    expect(response.jsonBody).toBe("[Unserializable]");
    expect(prototypeReads).toBe(0);
    expect(ownKeyReads).toBe(0);
    expect(JSON.stringify(response.jsonBody)).not.toContain("revoked-prototype-secret");
  });

  it("rejects an ordinary prototype chain beyond the bounded admission depth", () => {
    let prototype: object | null = null;
    for (let depth = 0; depth < 33; depth += 1) {
      prototype = Object.create(prototype) as object;
    }
    const payload = Object.create(prototype) as Record<string, unknown>;
    payload.safe = "not-admitted";

    expect(json(payload).jsonBody).toBe("[Unserializable]");
  });

  it("counts inherited yielded keys before skipping non-own descriptors", () => {
    const inherited = Object.create(null) as Record<string, unknown>;
    for (let index = 0; index < 20_000; index += 1) {
      Object.defineProperty(inherited, `inherited${index}`, {
        enumerable: true,
        get() {
          throw new Error("inherited accessor must not run");
        }
      });
    }
    const payload = Object.create(inherited) as Record<string, unknown>;

    const response = json(payload);

    expect(response.jsonBody).toBe("[Truncated]");
  });

  it("redacts an untrusted own data property normalized to message", () => {
    const payload = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(payload, "mes-sage", {
      enumerable: true,
      value: "Bearer plain-message-secret"
    });
    payload.safe = "visible";

    const response = json(payload);

    expect(response.jsonBody).toEqual({ safe: "visible" });
    expect(JSON.stringify(response.jsonBody)).not.toContain("plain-message-secret");
  });

  it("returns a static marker for revoked array and object proxies", () => {
    const revokedValues = [Proxy.revocable([], {}), Proxy.revocable({}, {})];
    for (const value of revokedValues) {
      value.revoke();

      expect(() => json({ value: value.proxy })).not.toThrow();
      expect(json({ value: value.proxy }).jsonBody).toEqual({
        value: "[Unserializable]"
      });
      expect(() => errorResponse(value.proxy)).not.toThrow();
      expect(errorResponse(value.proxy).status).toBe(503);
    }
  });

  it("uses global deterministic budgets for a shared DAG", () => {
    const sharedLeaf = { value: "x".repeat(256) };
    let dag: unknown = sharedLeaf;
    for (let depth = 0; depth < 12; depth += 1) {
      dag = { left: dag, right: dag };
    }

    const first = JSON.stringify(json(dag).jsonBody);
    const second = JSON.stringify(json(dag).jsonBody);

    expect(first).toBe(second);
    expect(first.includes("[Truncated]")).toBe(true);
    expect(Buffer.byteLength(first, "utf8")).toBeLessThanOrEqual(262_144);
  });

  it("short-circuits an oversized key before sensitive-key normalization", () => {
    const payload = Object.create(null) as Record<string, unknown>;
    const oversizedSensitiveLookalike = `${"_".repeat(1_000_000 - "authorization".length)}authorization`;
    payload[oversizedSensitiveLookalike] = "Bearer oversized-key-secret";

    const startedAt = performance.now();
    const response = json(payload);
    const elapsedMilliseconds = performance.now() - startedAt;
    const serialized = JSON.stringify(response.jsonBody);

    expect(response.jsonBody).toBe("[Truncated]");
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(64);
    expect(elapsedMilliseconds).toBeLessThan(500);
    expect(serialized).not.toContain("oversized-key-secret");
  });

  it("stops a many-key plain record at the monotonic entry budget", () => {
    const payload = Object.create(null) as Record<string, unknown>;
    for (let index = 0; index < 20_000; index += 1) {
      Object.defineProperty(payload, `safe${index}`, {
        enumerable: true,
        get() {
          throw new Error("accessor must not run");
        }
      });
    }

    const response = json(payload);
    const serialized = JSON.stringify(response.jsonBody);

    expect(response.jsonBody).toBe("[Truncated]");
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(64);
  });
});

describe("typedJson", () => {
  it("serializes a valid null payload as JSON instead of an empty Azure response", () => {
    const response = typedJson(null, {
      parse(value: unknown) {
        expect(value).toBeNull();
        return null;
      }
    });

    expect(response.status).toBe(200);
    expect(response.headers).toEqual({
      "content-type": "application/json; charset=utf-8"
    });
    expect(response.body).toBe("null");
    expect(response.jsonBody).toBeUndefined();
  });
});

describe("errorResponse", () => {
  it.each([
    ["UNAUTHORIZED", 401, "Authentication is required."],
    ["FORBIDDEN", 403, "This account cannot access the vault."],
    ["NOT_FOUND", 404, "The requested resource was not found."],
    ["CONFLICT", 409, "The resource changed. Refresh and try again."],
    ["INVALID_INPUT", 400, "The request is invalid."],
    ["DRIVE_UNAVAILABLE", 503, "The service is temporarily unavailable."],
    ["UNSAFE_FILE", 400, "The file is not safe to use."],
    ["TOO_LARGE", 413, "The file is too large."]
  ] as const)("maps %s domain errors to the contract and HTTP status", (code, status, officialMessage) => {
    const domainError = new ApiResponseError(code);
    Object.assign(domainError, {
      refresh_token: "refresh_token",
      authorization: "Bearer credential",
      driveId: "drive-file-id",
      cause: new Error("Bearer nested cause")
    });

    const response = errorResponse(domainError, CANONICAL_REQUEST_ID);
    const parsed = ApiErrorSchema.parse(response.jsonBody);
    const serialized = JSON.stringify(response.jsonBody);

    expect(response.status).toBe(status);
    expect(parsed.error).toMatchObject({ code, requestId: CANONICAL_REQUEST_ID });
    expect(parsed.error.message).toBe(officialMessage);
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
    expect(parsed.error.requestId).toMatch(GENERATED_REQUEST_ID_PATTERN);
    expect(JSON.stringify(response.jsonBody)).not.toMatch(/Bearer|drive-file-id|refresh_token|code-getter/u);
  });

  it("does not trust a caller-supplied enum error code", () => {
    const response = errorResponse(
      { code: "FORBIDDEN", message: "Bearer caller-message-secret" },
      CANONICAL_REQUEST_ID
    );
    const parsed = ApiErrorSchema.parse(response.jsonBody);

    expect(response.status).toBe(503);
    expect(parsed).toEqual({
      error: {
        code: "DRIVE_UNAVAILABLE",
        message: "The service is temporarily unavailable.",
        requestId: CANONICAL_REQUEST_ID
      }
    });
    expect(JSON.stringify(response.jsonBody)).not.toContain("caller-message-secret");
  });

  it("does not trust an Error with an enum-like code", () => {
    const dependencyError = new Error("Bearer raw-drive-id");
    Object.defineProperty(dependencyError, "code", { value: "NOT_FOUND", enumerable: true });

    const response = errorResponse(dependencyError, CANONICAL_REQUEST_ID);

    expect(response.status).toBe(503);
    expect(ApiErrorSchema.parse(response.jsonBody)).toEqual({
      error: {
        code: "DRIVE_UNAVAILABLE",
        message: "The service is temporarily unavailable.",
        requestId: CANONICAL_REQUEST_ID
      }
    });
    expect(JSON.stringify(response.jsonBody)).not.toMatch(/Bearer|raw-drive-id/u);
  });

  it("does not trust an object that only spoofs the domain-error prototype", () => {
    const spoofed = Object.create(ApiResponseError.prototype) as { code: string; message: string };
    Object.defineProperties(spoofed, {
      code: { value: "INVALID_INPUT", enumerable: true },
      message: { value: "Bearer forged-domain-error", enumerable: true }
    });

    const response = errorResponse(spoofed, CANONICAL_REQUEST_ID);

    expect(response.status).toBe(503);
    expect(ApiErrorSchema.parse(response.jsonBody).error.code).toBe("DRIVE_UNAVAILABLE");
    expect(JSON.stringify(response.jsonBody)).not.toContain("forged-domain-error");
  });

  it("fails closed for a runtime-mutated ApiResponseError code", () => {
    const mutated = new ApiResponseError("FORBIDDEN");
    Object.defineProperty(mutated, "code", { value: "CALLER_CONTROLLED" });

    expect(() => errorResponse(mutated, CANONICAL_REQUEST_ID)).not.toThrow();
    expect(ApiErrorSchema.parse(errorResponse(mutated, CANONICAL_REQUEST_ID).jsonBody)).toEqual({
      error: {
        code: "DRIVE_UNAVAILABLE",
        message: "The service is temporarily unavailable.",
        requestId: CANONICAL_REQUEST_ID
      }
    });
  });

  it.each([
    "refresh_token",
    "Bearer",
    "drive-file-id",
    "123e4567-e89B-42d3-a456-426614174000",
    "a".repeat(129),
    `${CANONICAL_REQUEST_ID}\nBearer`,
    `${CANONICAL_REQUEST_ID}-refresh_token`
  ])("generates a fresh canonical UUID instead of reflecting unsafe request ID %j", (unsafeRequestId) => {
    const callerError = {
      code: "FORBIDDEN",
      message: "Bearer caller-message-secret",
      refresh_token: "drive-file-id"
    };

    const response = errorResponse(callerError, unsafeRequestId);
    const parsed = ApiErrorSchema.parse(response.jsonBody);
    const serialized = JSON.stringify(response.jsonBody);

    expect(parsed.error.requestId).toMatch(GENERATED_REQUEST_ID_PATTERN);
    expect(parsed.error.requestId).not.toBe(unsafeRequestId);
    expect(serialized).not.toContain(unsafeRequestId);
    expect(serialized).not.toMatch(/caller-message-secret|refresh_token|drive-file-id/u);
  });

  it("preserves an exact canonical lowercase UUID request ID", () => {
    const response = errorResponse(new ApiResponseError("UNAUTHORIZED"), CANONICAL_REQUEST_ID);
    const parsed = ApiErrorSchema.parse(response.jsonBody);

    expect(parsed.error.requestId).toBe(CANONICAL_REQUEST_ID);
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
