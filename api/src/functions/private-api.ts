import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { MAX_NOTE_SOURCE_BYTES } from "@nxt/contracts";
import type { OwnerIdentity } from "../auth/require-owner.js";
import { ownerFromRequest } from "./session.js";
import { ApiResponseError, errorResponse } from "../http/api-response.js";
import type { PreferencesService } from "../services/preferences-service.js";
import type { RescanService } from "../services/rescan-service.js";
import type { VaultService } from "../services/vault-service.js";
import type { AttachmentService } from "../services/attachment-service.js";
import { resolveTask7Services } from "../services/runtime-services.js";

const OPAQUE_ID_PATTERN = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/u;

export interface Task7Services {
  vault: VaultService;
  rescan: RescanService;
  preferences: PreferencesService;
  attachments: AttachmentService;
}

export interface IdCodec {
  encode(value: string): string;
  decode(value: string): string;
}

export interface PrivateHandlerDependencies {
  authorize(request: HttpRequest): OwnerIdentity;
  resolveServices(): Task7Services;
  idCodec: IdCodec;
}

export const defaultPrivateHandlerDependencies = (): PrivateHandlerDependencies => ({
  authorize: ownerFromRequest,
  resolveServices: () => {
    runtimeIdCodec();
    return resolveTask7Services();
  },
  idCodec: {
    encode: (value) => runtimeIdCodec().encode(value),
    decode: (value) => runtimeIdCodec().decode(value)
  }
});

export class OpaqueIdCodec implements IdCodec {
  private readonly key: Buffer;

  public constructor(secret: string) {
    if (secret.length < 32) throw new Error("opaque ID secret is too short");
    this.key = createHash("sha256").update("nxt:opaque-drive-id:v1\0").update(secret).digest();
  }

  public encode(value: string): string {
    if (value.length === 0 || value.length > 512) throw new ApiResponseError("DRIVE_UNAVAILABLE");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const token = `v1.${iv.toString("base64url")}.${encrypted.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
    if (token.length > 512) throw new ApiResponseError("DRIVE_UNAVAILABLE");
    return token;
  }

  public decode(token: string): string {
    if (token.length === 0 || token.length > 512) throw new ApiResponseError("INVALID_INPUT");
    const match = OPAQUE_ID_PATTERN.exec(token);
    if (match === null) throw new ApiResponseError("INVALID_INPUT");
    try {
      const iv = Buffer.from(match[1] as string, "base64url");
      const encrypted = Buffer.from(match[2] as string, "base64url");
      const tag = Buffer.from(match[3] as string, "base64url");
      if (iv.length !== 12 || tag.length !== 16 || encrypted.length === 0) throw new Error("invalid token");
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAuthTag(tag);
      const value = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
      if (value.length === 0 || value.length > 512) throw new Error("invalid value");
      return value;
    } catch {
      throw new ApiResponseError("INVALID_INPUT");
    }
  }
}

export const handlePrivate = async (
  request: HttpRequest,
  dependencies: PrivateHandlerDependencies,
  action: (services: Task7Services) => Promise<HttpResponseInit>
): Promise<HttpResponseInit> => {
  try {
    dependencies.authorize(request);
    return await action(dependencies.resolveServices());
  } catch (error) {
    return errorResponse(error);
  }
};

export const assertNoQuery = (request: HttpRequest): void => {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new ApiResponseError("INVALID_INPUT");
  }
  if ([...url.searchParams].length !== 0) throw new ApiResponseError("INVALID_INPUT");
};

export const parseBody = async <T>(request: HttpRequest, schema: { parse(value: unknown): T }): Promise<T> => {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new ApiResponseError("INVALID_INPUT");
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    for (const key of ["source", "body"] as const) {
      const candidate = (value as Record<string, unknown>)[key];
      if (typeof candidate === "string" && new TextEncoder().encode(candidate).byteLength > MAX_NOTE_SOURCE_BYTES) {
        throw new ApiResponseError("TOO_LARGE");
      }
    }
  }
  try { return schema.parse(value); } catch { throw new ApiResponseError("INVALID_INPUT"); }
};

export const pathValue = (request: HttpRequest, key: string, schema: { parse(value: unknown): string }): string => {
  try {
    return schema.parse(request.params[key]);
  } catch {
    throw new ApiResponseError("INVALID_INPUT");
  }
};

let cachedCodec: OpaqueIdCodec | undefined;
const runtimeIdCodec = (): OpaqueIdCodec => {
  if (cachedCodec !== undefined) return cachedCodec;
  cachedCodec = createRuntimeOpaqueIdCodec(process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REFRESH_TOKEN);
  return cachedCodec;
};

export const createRuntimeOpaqueIdCodec = (clientSecret: string | undefined, refreshToken: string | undefined): OpaqueIdCodec => {
  const secret = `${clientSecret ?? ""}\0${refreshToken ?? ""}`;
  if (secret.replace("\0", "").length < 32) throw new ApiResponseError("DRIVE_UNAVAILABLE");
  return new OpaqueIdCodec(secret);
};
