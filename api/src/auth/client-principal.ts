const MAX_HEADER_LENGTH = 16_384;
const MAX_DECODED_LENGTH = 8_192;
const MAX_ROLE_COUNT = 32;
const MAX_ROLE_LENGTH = 128;
const MAX_PROVIDER_LENGTH = 128;
const MAX_USER_DETAILS_LENGTH = 512;
const MAX_USER_ID_LENGTH = 512;

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const PRINCIPAL_KEYS = ["identityProvider", "userDetails", "userRoles", "userId"] as const;

export interface ClientPrincipal {
  readonly identityProvider: string;
  readonly userDetails: string;
  readonly userRoles: readonly string[];
  readonly userId: string;
}

export class ClientPrincipalDecodeError extends Error {
  public constructor() {
    super("invalid client principal");
    this.name = "ClientPrincipalDecodeError";
  }
}

export const decodeClientPrincipal = (header: string | null): ClientPrincipal | null => {
  if (header === null) {
    return null;
  }
  if (header.length === 0 || header.length > MAX_HEADER_LENGTH || !BASE64_PATTERN.test(header)) {
    throw new ClientPrincipalDecodeError();
  }

  const bytes = Buffer.from(header, "base64");
  if (bytes.length === 0 || bytes.length > MAX_DECODED_LENGTH || bytes.toString("base64") !== header) {
    throw new ClientPrincipalDecodeError();
  }

  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ClientPrincipalDecodeError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    throw new ClientPrincipalDecodeError();
  }
  if (!isPrincipal(parsed)) {
    throw new ClientPrincipalDecodeError();
  }

  const principal = Object.create(null) as {
    identityProvider: string;
    userDetails: string;
    userRoles: readonly string[];
    userId: string;
  };
  principal.identityProvider = parsed.identityProvider;
  principal.userDetails = parsed.userDetails;
  principal.userRoles = Object.freeze([...parsed.userRoles]);
  principal.userId = parsed.userId;
  return Object.freeze(principal);
};

const isPrincipal = (value: unknown): value is ClientPrincipal => {
  if (!isPlainRecord(value)) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== PRINCIPAL_KEYS.length || !PRINCIPAL_KEYS.every((key) => keys.includes(key))) {
    return false;
  }
  return (
    isBoundedNonBlankString(value.identityProvider, MAX_PROVIDER_LENGTH) &&
    isBoundedNonBlankString(value.userDetails, MAX_USER_DETAILS_LENGTH) &&
    isBoundedNonBlankString(value.userId, MAX_USER_ID_LENGTH) &&
    Array.isArray(value.userRoles) &&
    value.userRoles.length <= MAX_ROLE_COUNT &&
    value.userRoles.every((role: unknown) => isBoundedNonBlankString(role, MAX_ROLE_LENGTH))
  );
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;

const isBoundedNonBlankString = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.length <= maximum && value.trim().length > 0;
