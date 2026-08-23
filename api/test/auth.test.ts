import { HttpRequest } from "@azure/functions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeClientPrincipal } from "../src/auth/client-principal.js";
import { requireOwner } from "../src/auth/require-owner.js";
import { sessionHandler } from "../src/functions/session.js";

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64");

const ownerPrincipal = {
  identityProvider: "github",
  userDetails: "aserdargun",
  userRoles: ["anonymous", "authenticated"],
  userId: "owner-id"
};

const expectAuthFailure = (action: () => unknown, status: 401 | 403, code: "UNAUTHORIZED" | "FORBIDDEN"): void => {
  try {
    action();
  } catch (error) {
    expect(error).toMatchObject({ status, code });
    return;
  }
  throw new Error("expected authorization to fail");
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("decodeClientPrincipal", () => {
  it("decodes a bounded strict principal into a prototype-free record", () => {
    const principal = decodeClientPrincipal(encode(ownerPrincipal));

    expect(principal).toEqual(ownerPrincipal);
    expect(Object.getPrototypeOf(principal)).toBeNull();
    expect(Object.getPrototypeOf(principal?.userRoles)).toBe(Array.prototype);
  });

  it("rejects non-canonical base64, invalid UTF-8, oversized input, and invalid JSON", () => {
    const invalidUtf8 = Buffer.from([0xc3, 0x28]).toString("base64");
    const invalidHeaders = [
      "e30",
      "e30=\n",
      "e30$",
      invalidUtf8,
      Buffer.from("not-json", "utf8").toString("base64"),
      "A".repeat(16_388)
    ];

    for (const header of invalidHeaders) {
      expect(() => decodeClientPrincipal(header)).toThrow();
    }
  });

  it("rejects schema additions, dangerous keys, empty fields, and unbounded roles", () => {
    const withDangerousKey =
      '{"identityProvider":"github","userDetails":"aserdargun","userRoles":["authenticated"],"userId":"owner-id","__proto__":{"polluted":true}}';
    const invalidPrincipals = [
      { ...ownerPrincipal, extra: true },
      JSON.parse(withDangerousKey) as unknown,
      { ...ownerPrincipal, userDetails: " " },
      { ...ownerPrincipal, userId: "" },
      { ...ownerPrincipal, userRoles: ["authenticated", ...Array.from({ length: 32 }, () => "role")] },
      { ...ownerPrincipal, userRoles: ["authenticated", { role: "owner" }] }
    ];

    for (const principal of invalidPrincipals) {
      expect(() => decodeClientPrincipal(encode(principal))).toThrow();
    }
  });
});

describe("requireOwner", () => {
  it("accepts trimmed case-insensitive GitHub identity but returns the configured canonical owner", () => {
    const header = encode({
      ...ownerPrincipal,
      identityProvider: " GitHub ",
      userDetails: " ASERDARGUN "
    });

    expect(
      requireOwner({
        header,
        host: "nxt.example",
        environment: "production",
        allowedUser: "Aserdargun",
        localBypass: false
      })
    ).toEqual({ provider: "github", userId: "owner-id", userDetails: "Aserdargun" });
  });

  it.each([
    { identityProvider: "github", userDetails: "other", userRoles: ["authenticated"], userId: "x" },
    { identityProvider: "aad", userDetails: "aserdargun", userRoles: ["authenticated"], userId: "x" },
    { identityProvider: "github", userDetails: "aserdargun", userRoles: ["anonymous"], userId: "x" },
    { identityProvider: "github", userDetails: "aserdargun", userRoles: ["Authenticated"], userId: "x" }
  ])("classifies a valid non-owner principal as forbidden %#", (principal) => {
    expectAuthFailure(
      () =>
        requireOwner({
          header: encode(principal),
          host: "nxt.example",
          environment: "production",
          allowedUser: "aserdargun",
          localBypass: false
        }),
      403,
      "FORBIDDEN"
    );
  });

  it("classifies missing and malformed principals as unauthorized", () => {
    for (const header of [null, "not-base64", encode({ identityProvider: "github" })]) {
      expectAuthFailure(
        () =>
          requireOwner({
            header,
            host: "nxt.example",
            environment: "production",
            allowedUser: "aserdargun",
            localBypass: false
          }),
        401,
        "UNAUTHORIZED"
      );
    }
  });

  it.each(["localhost", "LOCALHOST:4280", "127.0.0.1", "127.0.0.1:4280", "[::1]", "[::1]:4280"])(
    "allows an explicit non-production bypass on the syntactic loopback host %s",
    (host) => {
      expect(
        requireOwner({
          header: null,
          host,
          environment: "development",
          allowedUser: "aserdargun",
          localBypass: true
        })
      ).toEqual({ provider: "github", userId: "local-bypass", userDetails: "aserdargun" });
    }
  );

  it.each([
    "localhost.example",
    "localhost.",
    "localhost@evil.example",
    "evil.example@localhost",
    "127.0.0.1.example",
    "127.0.0.2",
    "[::1].example",
    "localhost, evil.example",
    "http://localhost:4280",
    "localhost/path",
    "localhost:0",
    "localhost:65536"
  ])("rejects loopback lookalike or non-host syntax %s", (host) => {
    expectAuthFailure(
      () =>
        requireOwner({
          header: null,
          host,
          environment: "development",
          allowedUser: "aserdargun",
          localBypass: true
        }),
      401,
      "UNAUTHORIZED"
    );
  });

  it("rejects bypass in production or when it was not explicitly enabled", () => {
    for (const input of [
      { environment: "production", localBypass: true },
      { environment: " Production ", localBypass: true },
      { environment: "development", localBypass: false }
    ]) {
      expectAuthFailure(
        () =>
          requireOwner({
            header: null,
            host: "127.0.0.1:4280",
            allowedUser: "aserdargun",
            ...input
          }),
        401,
        "UNAUTHORIZED"
      );
    }
  });
});

describe("private session handler", () => {
  it("defensively authorizes the principal despite the anonymous function auth level", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NXT_ALLOWED_GITHUB_USER", "aserdargun");
    vi.stubEnv("NXT_LOCAL_AUTH_BYPASS", "0");
    const request = new HttpRequest({
      method: "GET",
      url: "https://nxt.example/api/private/session",
      headers: { "x-ms-client-principal": encode(ownerPrincipal) }
    });

    const response = await sessionHandler(request);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ owner: { provider: "github", username: "aserdargun" } });
  });

  it.each([
    { principal: null, status: 401, code: "UNAUTHORIZED" },
    { principal: { ...ownerPrincipal, userDetails: "other" }, status: 403, code: "FORBIDDEN" }
  ])("returns a redacted typed error for a rejected request %#", async ({ principal, status, code }) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NXT_ALLOWED_GITHUB_USER", "aserdargun");
    const request = new HttpRequest({
      method: "GET",
      url: "https://nxt.example/api/private/session",
      headers: principal === null ? {} : { "x-ms-client-principal": encode(principal) }
    });

    const response = await sessionHandler(request);

    expect(response.status).toBe(status);
    expect(response.jsonBody).toMatchObject({ error: { code } });
    expect(JSON.stringify(response.jsonBody)).not.toContain("owner-id");
  });

  it("does not trust a forwarded loopback host for local bypass", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NXT_ALLOWED_GITHUB_USER", "aserdargun");
    vi.stubEnv("NXT_LOCAL_AUTH_BYPASS", "1");
    const request = new HttpRequest({
      method: "GET",
      url: "http://nxt.example/api/private/session",
      headers: { "x-forwarded-host": "localhost:4280" }
    });

    const response = await sessionHandler(request);
    expect(response.status).toBe(401);
  });
});
