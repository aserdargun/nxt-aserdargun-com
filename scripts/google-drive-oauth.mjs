import { createHash, timingSafeEqual } from "node:crypto";
import { URL } from "node:url";
import { TextEncoder } from "node:util";

export const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

const DEFAULT_AUTH_URI = "https://accounts.google.com/o/oauth2/v2/auth";
const DESKTOP_CLIENT_AUTH_URI = "https://accounts.google.com/o/oauth2/auth";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const MIN_HIGH_PORT = 1025;
const MAX_PORT = 65_535;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/u;

export const parseDesktopClient = (input) => {
  if (!isRecord(input) || !isRecord(input.installed)) {
    throw new Error(
      "A downloaded Google OAuth Desktop app client is required."
    );
  }
  const installed = input.installed;
  const clientId = requireNonEmptyString(
    installed.client_id,
    "Desktop app client ID"
  );
  const clientSecret = requireNonEmptyString(
    installed.client_secret,
    "Desktop app client secret"
  );
  const authUri = optionalExactUri(
    installed.auth_uri,
    DESKTOP_CLIENT_AUTH_URI,
    "Desktop app authorization URI"
  );
  const tokenUri = optionalExactUri(
    installed.token_uri,
    DEFAULT_TOKEN_URI,
    "Desktop app token URI"
  );
  if (installed.redirect_uris !== undefined) {
    if (
      !Array.isArray(installed.redirect_uris) ||
      installed.redirect_uris.length === 0 ||
      !installed.redirect_uris.every(
        (value) => typeof value === "string" && isDesktopRedirectTemplate(value)
      )
    ) {
      throw new Error(
        "The OAuth configuration is not a valid Desktop app client."
      );
    }
  }
  return { clientId, clientSecret, authUri, tokenUri };
};

export const createOAuthRequest = ({
  clientId,
  redirectUri,
  state,
  verifier
}) => {
  const safeClientId = requireNonEmptyString(clientId, "OAuth client ID");
  const safeState = requireNonEmptyString(state, "OAuth state");
  if (!PKCE_VERIFIER_PATTERN.test(verifier)) {
    throw new Error("PKCE verifier must use 43 to 128 RFC 7636 characters.");
  }
  const redirect = parseLoopbackRedirect(redirectUri);
  const challenge = createHash("sha256")
    .update(verifier, "ascii")
    .digest("base64url");
  const authorization = new URL(DEFAULT_AUTH_URI);
  authorization.searchParams.set("client_id", safeClientId);
  authorization.searchParams.set("redirect_uri", redirect.href);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("scope", GOOGLE_DRIVE_SCOPE);
  authorization.searchParams.set("access_type", "offline");
  authorization.searchParams.set("prompt", "consent");
  authorization.searchParams.set("state", safeState);
  authorization.searchParams.set("code_challenge", challenge);
  authorization.searchParams.set("code_challenge_method", "S256");
  return { authorizationUrl: authorization.href, codeChallenge: challenge };
};

export const validateOAuthCallback = ({
  callbackUrl,
  expectedRedirectUri,
  expectedState
}) => {
  const expected = parseLoopbackRedirect(expectedRedirectUri);
  let callback;
  try {
    callback = new URL(callbackUrl);
  } catch {
    throw new Error("OAuth callback is invalid.");
  }
  if (
    callback.protocol !== expected.protocol ||
    callback.hostname !== expected.hostname ||
    callback.port !== expected.port ||
    callback.pathname !== "/" ||
    callback.username !== "" ||
    callback.password !== "" ||
    callback.hash !== ""
  ) {
    throw new Error("OAuth callback host or path is invalid.");
  }
  const receivedState = callback.searchParams.get("state");
  if (
    receivedState === null ||
    !constantTimeEqual(receivedState, expectedState)
  ) {
    throw new Error("OAuth callback state is invalid.");
  }
  const oauthError = callback.searchParams.get("error");
  if (oauthError !== null) {
    throw new Error("OAuth authorization was not granted.");
  }
  const code = callback.searchParams.get("code");
  if (code === null || code.trim() === "") {
    throw new Error("OAuth callback did not contain an authorization code.");
  }
  return code;
};

export const verifyOwnerEmail = ({ expectedEmail, actualEmail }) => {
  const expected = normalizeEmail(
    expectedEmail,
    "Expected Google owner email is required."
  );
  if (actualEmail === undefined || actualEmail === null) {
    throw new Error("Google account readback did not return an email address.");
  }
  const actual = normalizeEmail(
    actualEmail,
    "Google account readback did not return a valid email address."
  );
  if (!constantTimeEqual(actual, expected)) {
    throw new Error(
      "The authorized Google account does not match the configured owner."
    );
  }
  return actual;
};

export const requireRefreshToken = (tokens) => {
  if (
    !isRecord(tokens) ||
    typeof tokens.refresh_token !== "string" ||
    tokens.refresh_token.trim() === ""
  ) {
    throw new Error(
      "No refresh credential was returned. Revoke the prior grant and reauthorize with consent."
    );
  }
  return tokens.refresh_token;
};

export const planFolders = () => ({
  vaultRoot: "NXT-ASERDARGUN-COM",
  privateRoot: "NXT-PRIVATE-COM",
  vaultChildren: ["Notes", "_assets"],
  noteChildren: ["Inbox", "Plans", "Archive"],
  privateChildren: ["published", "integration-tests"],
  privateFiles: [
    "vault-index.json",
    "preferences.json",
    "publication-manifest.json"
  ]
});

const parseLoopbackRedirect = (redirectUri) => {
  let redirect;
  try {
    redirect = new URL(redirectUri);
  } catch {
    throw new Error("OAuth redirect must be a loopback URL.");
  }
  const port = Number(redirect.port);
  if (
    redirect.protocol !== "http:" ||
    redirect.hostname !== "127.0.0.1" ||
    redirect.pathname !== "/" ||
    redirect.search !== "" ||
    redirect.hash !== "" ||
    redirect.username !== "" ||
    redirect.password !== ""
  ) {
    throw new Error("OAuth redirect must use the 127.0.0.1 loopback root.");
  }
  if (!Number.isInteger(port) || port < MIN_HIGH_PORT || port > MAX_PORT) {
    throw new Error("OAuth redirect must use an explicit high port.");
  }
  return redirect;
};

const optionalExactUri = (value, expected, label) => {
  if (value === undefined) return expected;
  if (value !== expected)
    throw new Error(`${label} is invalid for a Google Desktop app client.`);
  return expected;
};

const isDesktopRedirectTemplate = (value) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
};

const normalizeEmail = (value, message) => {
  if (typeof value !== "string") throw new Error(message);
  const normalized = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/u.test(normalized)) throw new Error(message);
  return normalized;
};

const constantTimeEqual = (left, right) => {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
};

const requireNonEmptyString = (value, label) => {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} is required.`);
  return value;
};

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
