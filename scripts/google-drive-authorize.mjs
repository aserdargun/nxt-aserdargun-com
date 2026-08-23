#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { URL, pathToFileURL } from "node:url";
import {
  createOAuthRequest,
  parseDesktopClient,
  readDriveOwner,
  requireRefreshToken,
  validateOAuthCallback,
  verifyOwnerEmail
} from "./google-drive-oauth.mjs";
import {
  parseEnvFile,
  readEnvFile,
  writeEnvFileAtomic
} from "./google-drive-provision.mjs";
import { loadGoogleApisFromApiPackage } from "./google-drive-googleapis.mjs";

export const loadGoogleApisForAuthorization = () =>
  loadGoogleApisFromApiPackage();

export const completeGoogleAuthorization = async ({
  clientConfig,
  expectedOwnerEmail,
  redirectUri,
  state,
  verifier,
  requestCode,
  exchangeCode,
  readOwner,
  persist,
  log = () => undefined
}) => {
  const desktop = parseDesktopClient(clientConfig);
  const request = createOAuthRequest({
    clientId: desktop.clientId,
    redirectUri,
    state,
    verifier
  });
  const code = await requestCode({
    authorizationUrl: request.authorizationUrl,
    state
  });
  const tokens = await exchangeCode({
    clientId: desktop.clientId,
    clientSecret: desktop.clientSecret,
    redirectUri,
    code,
    verifier
  });
  const refreshToken = requireRefreshToken(tokens);
  const owner = await readOwner(tokens);
  const ownerEmail = verifyOwnerEmail({
    expectedEmail: expectedOwnerEmail,
    actualEmail: owner?.emailAddress
  });
  await persist({
    GOOGLE_CLIENT_ID: desktop.clientId,
    GOOGLE_CLIENT_SECRET: desktop.clientSecret,
    GOOGLE_REFRESH_TOKEN: refreshToken
  });
  log(`Verified Google owner: ${ownerEmail}`);
  log("Refresh credential stored.");
  return { ownerEmail };
};

export const runAuthorizationCli = async ({
  argv,
  cwd,
  loadGoogleApis,
  openBrowser,
  log
}) => {
  const clientConfigPath = parseClientConfigArgument(argv, cwd);
  const clientConfig = parseJson(await readFile(clientConfigPath, "utf8"));
  const envPath = resolve(cwd, ".env.local");
  const env = parseEnvFile(await readEnvFile(envPath));
  const expectedOwnerEmail = requireEnvValue(env, "NXT_ALLOWED_GOOGLE_EMAIL");
  const callback = await createLoopbackCallbackReceiver();
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  try {
    const { google } = await loadGoogleApis();
    let authorizedClient;
    return await completeGoogleAuthorization({
      clientConfig,
      expectedOwnerEmail,
      redirectUri: callback.redirectUri,
      state,
      verifier,
      requestCode: async ({ authorizationUrl }) => {
        const code = callback.receiveCode(state);
        await openBrowser(authorizationUrl);
        return code;
      },
      exchangeCode: async ({
        clientId,
        clientSecret,
        redirectUri,
        code,
        verifier: codeVerifier
      }) => {
        const oauth = new google.auth.OAuth2(
          clientId,
          clientSecret,
          redirectUri
        );
        const response = await oauth.getToken({
          code,
          codeVerifier,
          redirect_uri: redirectUri
        });
        oauth.setCredentials(response.tokens);
        authorizedClient = oauth;
        return response.tokens;
      },
      readOwner: async (tokens) => {
        if (authorizedClient === undefined)
          throw new Error("OAuth client was not initialized.");
        authorizedClient.setCredentials(tokens);
        const drive = google.drive({ version: "v3", auth: authorizedClient });
        return readDriveOwner(drive);
      },
      persist: (settings) => writeEnvFileAtomic(envPath, settings),
      log
    });
  } finally {
    await callback.close();
  }
};

export const createLoopbackCallbackReceiver = async () => {
  let settle;
  let reject;
  let settled = false;
  const result = new Promise((resolveResult, rejectResult) => {
    settle = resolveResult;
    reject = rejectResult;
  });
  const server = createServer((request, response) => {
    const address = server.address();
    if (typeof address !== "object" || address === null) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end("Authorization failed.");
      return;
    }
    const redirectUri = `http://127.0.0.1:${address.port}/`;
    try {
      if (
        request.method !== "GET" ||
        request.headers.host !== `127.0.0.1:${address.port}` ||
        request.url === undefined
      ) {
        throw new Error("OAuth callback host or path is invalid.");
      }
      const code = validateOAuthCallback({
        callbackUrl: new URL(request.url, redirectUri).href,
        expectedRedirectUri: redirectUri,
        expectedState: receiverState
      });
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("Authorization received. You may close this tab.");
      settleOnce(code);
    } catch (error) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Authorization failed.");
      rejectOnce(error);
    }
  });
  let receiverState = "";
  const settleOnce = (code) => {
    if (settled) return;
    settled = true;
    settle(code);
  };
  const rejectOnce = (error) => {
    if (settled) return;
    settled = true;
    reject(error);
  };
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (
    typeof address !== "object" ||
    address === null ||
    address.address !== "127.0.0.1" ||
    address.port < 1025
  ) {
    await closeServer(server);
    throw new Error("Could not bind an available loopback high port.");
  }
  return {
    redirectUri: `http://127.0.0.1:${address.port}/`,
    receiveCode(state) {
      if (receiverState !== "")
        throw new Error("OAuth callback receiver is already bound to state.");
      receiverState = state;
      return result;
    },
    close: () => closeServer(server)
  };
};

const parseClientConfigArgument = (argv, cwd) => {
  if (
    !Array.isArray(argv) ||
    argv.length !== 2 ||
    argv[0] !== "--client-config"
  ) {
    throw new Error(
      "Usage: google-drive-authorize.mjs --client-config <Desktop-app-client.json>"
    );
  }
  if (typeof argv[1] !== "string" || argv[1].trim() === "") {
    throw new Error("A Desktop app client configuration path is required.");
  }
  return resolve(cwd, argv[1]);
};

const parseJson = (source) => {
  try {
    return JSON.parse(source);
  } catch {
    throw new Error("The Desktop app client configuration is not valid JSON.");
  }
};

const requireEnvValue = (env, key) => {
  const value = env[key];
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${key} must be set in .env.local.`);
  return value;
};

const openSystemBrowser = async (url) => {
  const command =
    globalThis.process.platform === "darwin" ? "/usr/bin/open" : "xdg-open";
  await new Promise((resolveSpawn, rejectSpawn) => {
    const child = spawn(command, [url], { detached: true, stdio: "ignore" });
    child.once("error", rejectSpawn);
    child.once("spawn", () => {
      child.unref();
      resolveSpawn();
    });
  });
};

const closeServer = (server) =>
  new Promise((resolveClose, rejectClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close((error) =>
      error === undefined ? resolveClose() : rejectClose(error)
    );
  });

const safeErrorMessage = (error) => {
  const message = error instanceof Error ? error.message : "";
  const safePrefixes = [
    "Usage:",
    "A Desktop app",
    "The Desktop app",
    "NXT_ALLOWED_GOOGLE_EMAIL",
    "OAuth callback",
    "OAuth authorization",
    "No refresh credential",
    "The authorized Google account",
    "Google account readback",
    "Could not bind"
  ];
  return safePrefixes.some((prefix) => message.startsWith(prefix))
    ? message
    : "Google Drive authorization failed.";
};

const main = async () => {
  try {
    await runAuthorizationCli({
      argv: globalThis.process.argv.slice(2),
      cwd: globalThis.process.cwd(),
      loadGoogleApis: loadGoogleApisForAuthorization,
      openBrowser: openSystemBrowser,
      log: (message) => globalThis.console.log(message)
    });
  } catch (error) {
    globalThis.console.error(safeErrorMessage(error));
    globalThis.process.exitCode = 1;
  }
};

const isMain =
  globalThis.process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(globalThis.process.argv[1])).href;

if (isMain) await main();
