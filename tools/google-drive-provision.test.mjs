import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { URL } from "node:url";
import {
  GOOGLE_DRIVE_SCOPE,
  createOAuthRequest,
  parseDesktopClient,
  planFolders,
  validateOAuthCallback,
  verifyOwnerEmail
} from "../scripts/google-drive-oauth.mjs";
import {
  buildEnvFile,
  createGoogleProvisioningClient,
  parseEnvFile,
  provisionDriveLayout,
  systemFileDefinitions,
  writeEnvFileAtomic
} from "../scripts/google-drive-provision.mjs";
import { completeGoogleAuthorization } from "../scripts/google-drive-authorize.mjs";

test("accepts only a downloaded Desktop-app OAuth installed client", () => {
  assert.deepEqual(
    parseDesktopClient({
      installed: {
        client_id: "desktop-client-id",
        client_secret: "secret",
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        redirect_uris: ["http://localhost"]
      }
    }),
    {
      clientId: "desktop-client-id",
      clientSecret: "secret",
      authUri: "https://accounts.google.com/o/oauth2/auth",
      tokenUri: "https://oauth2.googleapis.com/token"
    }
  );
  assert.throws(
    () =>
      parseDesktopClient({
        web: { client_id: "web-client-id", client_secret: "secret" }
      }),
    /Desktop app/u
  );
  assert.equal(
    parseDesktopClient({
      installed: { client_id: "desktop-client-id", client_secret: "secret" }
    }).clientId,
    "desktop-client-id"
  );
});

test("OAuth is loopback-only, high-port, offline, consent-bound, state-bound, PKCE, and full Drive scope", () => {
  const request = createOAuthRequest({
    clientId: "desktop-client-id",
    redirectUri: "http://127.0.0.1:34117/",
    state: "fixed-state",
    verifier: "a".repeat(64)
  });
  const url = new URL(request.authorizationUrl);
  assert.equal(url.searchParams.get("scope"), GOOGLE_DRIVE_SCOPE);
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("state"), "fixed-state");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    url.searchParams.get("code_challenge"),
    "_-BU_nrgy23GXDr5th1SCfQ5hR20PQulmXM33xVGaOs"
  );
  assert.equal(url.hostname, "accounts.google.com");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:34117/");
  assert.throws(
    () =>
      createOAuthRequest({
        clientId: "desktop-client-id",
        redirectUri: "http://localhost:34117/",
        state: "fixed-state",
        verifier: "a".repeat(64)
      }),
    /loopback/u
  );
  assert.throws(
    () =>
      createOAuthRequest({
        clientId: "desktop-client-id",
        redirectUri: "http://127.0.0.1:1024/",
        state: "fixed-state",
        verifier: "a".repeat(64)
      }),
    /high port/u
  );
});

test("provisioning plans two exact sibling roots and required children", () => {
  assert.deepEqual(planFolders(), {
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
});

test("owner readback rejects a different or missing Google account before provisioning", () => {
  assert.equal(
    verifyOwnerEmail({
      expectedEmail: "Owner@Example.com",
      actualEmail: "owner@example.com"
    }),
    "owner@example.com"
  );
  assert.throws(
    () =>
      verifyOwnerEmail({
        expectedEmail: "owner@example.com",
        actualEmail: "other@example.com"
      }),
    /account does not match/u
  );
  assert.throws(
    () =>
      verifyOwnerEmail({
        expectedEmail: "owner@example.com",
        actualEmail: undefined
      }),
    /account readback/u
  );
});

test("env persistence retains unrelated settings, emits exact keys once, and never logs values", async () => {
  const secret = "refresh-secret-value";
  const output = buildEnvFile(
    "NXT_ALLOWED_GITHUB_USER=aserdargun\nGOOGLE_REFRESH_TOKEN=old\n",
    {
      GOOGLE_REFRESH_TOKEN: secret,
      NXT_VAULT_DRIVE_FOLDER_ID: "vault-id"
    }
  );
  assert.equal(
    output,
    "NXT_ALLOWED_GITHUB_USER=aserdargun\nGOOGLE_REFRESH_TOKEN=refresh-secret-value\nNXT_VAULT_DRIVE_FOLDER_ID=vault-id\n"
  );

  const logs = [];
  const fake = createProvisionClient();
  await provisionDriveLayout({
    client: fake.client,
    ownerEmail: "owner@example.com",
    expectedOwnerEmail: "owner@example.com",
    log: (message) => logs.push(message)
  });
  assert.equal(logs.join("\n").includes(secret), false);
  assert.equal(logs.join("\n").includes("root-drive-id"), false);
});

test("provisioning creates exact siblings, children, and valid system files once then reuses them", async () => {
  const fake = createProvisionClient();
  const first = await provisionDriveLayout({
    client: fake.client,
    ownerEmail: "owner@example.com",
    expectedOwnerEmail: "owner@example.com",
    log: () => undefined
  });
  const createsAfterFirst = fake.creates.length;
  const second = await provisionDriveLayout({
    client: fake.client,
    ownerEmail: "owner@example.com",
    expectedOwnerEmail: "owner@example.com",
    log: () => undefined
  });

  assert.deepEqual(Object.keys(first.settings).sort(), [
    "NXT_ARCHIVE_DRIVE_FOLDER_ID",
    "NXT_ASSETS_DRIVE_FOLDER_ID",
    "NXT_INBOX_DRIVE_FOLDER_ID",
    "NXT_INTEGRATION_TEST_DRIVE_FOLDER_ID",
    "NXT_NOTES_DRIVE_FOLDER_ID",
    "NXT_PLANS_DRIVE_FOLDER_ID",
    "NXT_PREFERENCES_DRIVE_FILE_ID",
    "NXT_PRIVATE_DRIVE_FOLDER_ID",
    "NXT_PUBLICATION_MANIFEST_DRIVE_FILE_ID",
    "NXT_PUBLISHED_DRIVE_FOLDER_ID",
    "NXT_VAULT_DRIVE_FOLDER_ID",
    "NXT_VAULT_INDEX_DRIVE_FILE_ID"
  ]);
  assert.equal(first.settings.NXT_VAULT_DRIVE_FOLDER_ID, "root-drive-id");
  assert.deepEqual(second.settings, first.settings);
  assert.equal(fake.creates.length, createsAfterFirst);
  assert.deepEqual(
    fake.creates
      .filter(
        (entry) => entry.mimeType === "application/vnd.google-apps.folder"
      )
      .map((entry) => [entry.name, entry.parentId]),
    [
      ["NXT-ASERDARGUN-COM", "root"],
      ["NXT-PRIVATE-COM", "root"],
      ["Notes", "root-drive-id"],
      ["_assets", "root-drive-id"],
      ["Inbox", "notes-drive-id"],
      ["Plans", "notes-drive-id"],
      ["Archive", "notes-drive-id"],
      ["published", "private-drive-id"],
      ["integration-tests", "private-drive-id"]
    ]
  );
  for (const definition of systemFileDefinitions()) {
    const created = fake.creates.find(
      (entry) => entry.name === definition.name
    );
    assert.equal(created?.mimeType, "application/json");
    assert.deepEqual(
      JSON.parse(created?.content ?? "null"),
      definition.emptyValue
    );
  }
});

test("provisioning fails closed on duplicates, ownership mismatch, or invalid system JSON without replacement", async () => {
  const duplicate = createProvisionClient();
  duplicate.seedFolder({
    id: "duplicate-root",
    name: "NXT-ASERDARGUN-COM",
    parentId: "root"
  });
  duplicate.seedFolder({
    id: "duplicate-root-2",
    name: "NXT-ASERDARGUN-COM",
    parentId: "root"
  });
  await assert.rejects(
    provisionDriveLayout({
      client: duplicate.client,
      ownerEmail: "owner@example.com",
      expectedOwnerEmail: "owner@example.com",
      log: () => undefined
    }),
    /duplicate/iu
  );

  const notOwned = createProvisionClient({ ownedByMe: false });
  await assert.rejects(
    provisionDriveLayout({
      client: notOwned.client,
      ownerEmail: "owner@example.com",
      expectedOwnerEmail: "owner@example.com",
      log: () => undefined
    }),
    /ownership/iu
  );

  const invalid = createProvisionClient();
  await provisionDriveLayout({
    client: invalid.client,
    ownerEmail: "owner@example.com",
    expectedOwnerEmail: "owner@example.com",
    log: () => undefined
  });
  const manifest = invalid.files.find(
    (file) => file.name === "publication-manifest.json"
  );
  manifest.content = '{"schemaVersion":1,"entries":"bad"}';
  const createCount = invalid.creates.length;
  await assert.rejects(
    provisionDriveLayout({
      client: invalid.client,
      ownerEmail: "owner@example.com",
      expectedOwnerEmail: "owner@example.com",
      log: () => undefined
    }),
    /invalid system file/iu
  );
  assert.equal(invalid.creates.length, createCount);

  const checksumMismatch = createProvisionClient({
    checksum: "wrong-checksum"
  });
  await assert.rejects(
    provisionDriveLayout({
      client: checksumMismatch.client,
      ownerEmail: "owner@example.com",
      expectedOwnerEmail: "owner@example.com",
      log: () => undefined
    }),
    /checksum/iu
  );
});

test("authorization persists only durable credentials after exact owner readback without secret logs", async () => {
  const persisted = [];
  const logs = [];
  const refreshToken = "refresh-token-that-must-not-be-logged";
  const result = await completeGoogleAuthorization({
    clientConfig: {
      installed: {
        client_id: "desktop-client-id",
        client_secret: "client-secret"
      }
    },
    expectedOwnerEmail: "owner@example.com",
    redirectUri: "http://127.0.0.1:34117/",
    state: "fixed-state",
    verifier: "a".repeat(64),
    requestCode: async ({ authorizationUrl }) => {
      assert.equal(
        new URL(authorizationUrl).searchParams.get("prompt"),
        "consent"
      );
      return "authorization-code";
    },
    exchangeCode: async ({ code, verifier }) => {
      assert.equal(code, "authorization-code");
      assert.equal(verifier, "a".repeat(64));
      return {
        refresh_token: refreshToken,
        access_token: "ephemeral-access-token"
      };
    },
    readOwner: async () => ({
      emailAddress: "OWNER@example.com",
      displayName: "Owner"
    }),
    persist: async (settings) => persisted.push(settings),
    log: (message) => logs.push(message)
  });

  assert.deepEqual(result, { ownerEmail: "owner@example.com" });
  assert.deepEqual(persisted, [
    {
      GOOGLE_CLIENT_ID: "desktop-client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
      GOOGLE_REFRESH_TOKEN: refreshToken
    }
  ]);
  assert.deepEqual(logs, [
    "Verified Google owner: owner@example.com",
    "Refresh credential stored."
  ]);
  assert.equal(logs.join("\n").includes(refreshToken), false);
  assert.equal(logs.join("\n").includes("client-secret"), false);
  assert.equal(logs.join("\n").includes("authorization-code"), false);
});

test("authorization rejects missing refresh credentials or a wrong owner before persistence", async () => {
  let persistenceCalls = 0;
  const common = {
    clientConfig: {
      installed: {
        client_id: "desktop-client-id",
        client_secret: "client-secret"
      }
    },
    expectedOwnerEmail: "owner@example.com",
    redirectUri: "http://127.0.0.1:34117/",
    state: "fixed-state",
    verifier: "a".repeat(64),
    requestCode: async () => "authorization-code",
    persist: async () => {
      persistenceCalls += 1;
    },
    log: () => undefined
  };
  await assert.rejects(
    completeGoogleAuthorization({
      ...common,
      exchangeCode: async () => ({ access_token: "ephemeral-only" }),
      readOwner: async () => ({ emailAddress: "owner@example.com" })
    }),
    /revoke the prior grant/iu
  );
  await assert.rejects(
    completeGoogleAuthorization({
      ...common,
      exchangeCode: async () => ({ refresh_token: "refresh-token" }),
      readOwner: async () => ({ emailAddress: "other@example.com" })
    }),
    /account does not match/iu
  );
  assert.equal(persistenceCalls, 0);
});

test("the Google provisioning client escapes queries, paginates, and disables every gaxios retry", async () => {
  const calls = [];
  const responses = [
    { data: { files: [{ id: "first" }], nextPageToken: "next" } },
    { data: { files: [{ id: "second" }] } }
  ];
  const client = createGoogleProvisioningClient({
    files: {
      list: async (input, options) => {
        calls.push({ method: "list", input, options });
        return responses.shift();
      },
      create: async (input, options) => {
        calls.push({ method: "create", input, options });
        return { data: { id: "created" } };
      },
      get: async (input, options) => {
        calls.push({ method: "get", input, options });
        return input.alt === "media"
          ? { data: "content" }
          : { data: { id: input.fileId } };
      }
    }
  });
  await assert.doesNotReject(() =>
    client.listExact({
      parentId: "parent'\\unsafe",
      name: "name'\\unsafe",
      mimeType: "application/json"
    })
  );
  await client.create({
    parentId: "parent",
    name: "file.json",
    mimeType: "application/json",
    content: "{}"
  });
  await client.get("file-id");
  await client.readText("file-id");
  assert.deepEqual(calls, [
    {
      method: "list",
      input: {
        q: "'parent\\'\\\\unsafe' in parents and name = 'name\\'\\\\unsafe' and mimeType = 'application/json' and trashed = false",
        spaces: "drive",
        pageSize: 100,
        fields:
          "nextPageToken,files(id,name,mimeType,parents,trashed,ownedByMe,permissions(id,type,role,emailAddress),version,md5Checksum)"
      },
      options: { retry: false }
    },
    {
      method: "list",
      input: {
        q: "'parent\\'\\\\unsafe' in parents and name = 'name\\'\\\\unsafe' and mimeType = 'application/json' and trashed = false",
        spaces: "drive",
        pageSize: 100,
        pageToken: "next",
        fields:
          "nextPageToken,files(id,name,mimeType,parents,trashed,ownedByMe,permissions(id,type,role,emailAddress),version,md5Checksum)"
      },
      options: { retry: false }
    },
    {
      method: "create",
      input: {
        requestBody: {
          name: "file.json",
          mimeType: "application/json",
          parents: ["parent"]
        },
        media: { mimeType: "application/json", body: "{}" },
        fields:
          "id,name,mimeType,parents,trashed,ownedByMe,permissions(id,type,role,emailAddress),version,md5Checksum"
      },
      options: { retry: false }
    },
    {
      method: "get",
      input: {
        fileId: "file-id",
        fields:
          "id,name,mimeType,parents,trashed,ownedByMe,permissions(id,type,role,emailAddress),version,md5Checksum"
      },
      options: { retry: false }
    },
    {
      method: "get",
      input: { fileId: "file-id", alt: "media" },
      options: { responseType: "text", retry: false }
    }
  ]);
});

test("provisioning verifies top-level siblings against the resolved My Drive root ID", async () => {
  const fake = createProvisionClient();
  await provisionDriveLayout({
    client: fake.client,
    ownerEmail: "owner@example.com",
    expectedOwnerEmail: "owner@example.com",
    rootParentId: "resolved-my-drive-root",
    log: () => undefined
  });
  assert.deepEqual(
    fake.creates.slice(0, 2).map(({ name, parentId }) => [name, parentId]),
    [
      ["NXT-ASERDARGUN-COM", "resolved-my-drive-root"],
      ["NXT-PRIVATE-COM", "resolved-my-drive-root"]
    ]
  );
});

test("callback validation accepts only the bound loopback host, root path, and state", () => {
  assert.equal(
    validateOAuthCallback({
      callbackUrl:
        "http://127.0.0.1:34117/?code=one-time-code&state=fixed-state",
      expectedRedirectUri: "http://127.0.0.1:34117/",
      expectedState: "fixed-state"
    }),
    "one-time-code"
  );
  for (const callbackUrl of [
    "http://127.0.0.1:34117/callback?code=code&state=fixed-state",
    "http://127.0.0.1:34118/?code=code&state=fixed-state",
    "http://127.0.0.1:34117/?code=code&state=wrong-state"
  ]) {
    assert.throws(
      () =>
        validateOAuthCallback({
          callbackUrl,
          expectedRedirectUri: "http://127.0.0.1:34117/",
          expectedState: "fixed-state"
        }),
      /callback/iu
    );
  }
});

test("callback validation rejects duplicate or ambiguous query parameters without surfacing query values", () => {
  const sensitive = "sensitive-code-value";
  const callbackUrls = [
    `http://127.0.0.1:34117/?code=${sensitive}&code=second&state=fixed-state`,
    `http://127.0.0.1:34117/?code=${sensitive}&state=fixed-state&state=fixed-state`,
    `http://127.0.0.1:34117/?code=${sensitive}&state=fixed-state&error=denied`,
    "http://127.0.0.1:34117/?state=fixed-state",
    "http://127.0.0.1:34117/?code=&state=fixed-state"
  ];
  for (const callbackUrl of callbackUrls) {
    let message = "";
    assert.throws(() => {
      try {
        validateOAuthCallback({
          callbackUrl,
          expectedRedirectUri: "http://127.0.0.1:34117/",
          expectedState: "fixed-state"
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
        throw error;
      }
    }, /OAuth/iu);
    assert.equal(message.includes(sensitive), false);
    assert.equal(message.includes("denied"), false);
  }
});

test("environment parsing canonicalizes CRLF and rejects controls, duplicates, and injected newlines", () => {
  assert.deepEqual(parseEnvFile("SAFE=ok\r\nSECOND=two\r\n"), {
    SAFE: "ok",
    SECOND: "two"
  });
  assert.equal(
    buildEnvFile("SAFE=ok\r\nSECOND=two\r\n", { SAFE: "next" }),
    "SAFE=next\nSECOND=two\n"
  );
  for (const source of [
    "  GOOGLE_REFRESH_TOKEN=old\n",
    "\tGOOGLE_REFRESH_TOKEN=old\n",
    "GOOGLE_REFRESH_TOKEN=one\nGOOGLE_REFRESH_TOKEN=two\n",
    "SAFE=ok\rINJECTED=1",
    "SAFE=ok\0INJECTED=1",
    "SAFE=ok\u0001INJECTED=1"
  ]) {
    assert.throws(() => parseEnvFile(source), /environment/iu);
    assert.throws(
      () => buildEnvFile(source, { GOOGLE_REFRESH_TOKEN: "next" }),
      /environment/iu
    );
  }
  assert.throws(
    () => buildEnvFile("", { GOOGLE_REFRESH_TOKEN: "line-one\nline-two" }),
    /unsafe/iu
  );
  for (const value of ["one\rINVALID=two", "one\0INVALID=two", "one\tunsafe"])
    assert.throws(
      () => buildEnvFile("", { GOOGLE_REFRESH_TOKEN: value }),
      /unsafe/iu
    );
});

test("downloaded Desktop OAuth credential filename patterns are ignored without hiding unrelated JSON", () => {
  for (const path of [
    "Desktop-app-client.json",
    "Desktop-app-client-123.json",
    "client_secret_123.apps.googleusercontent.com.json"
  ]) {
    const result = spawnSync("git", ["check-ignore", "--no-index", "--quiet", "--", path], {
      cwd: globalThis.process.cwd()
    });
    assert.equal(result.status, 0, path);
  }
  const unrelated = spawnSync("git", ["check-ignore", "--no-index", "--quiet", "--", "client-settings.json"], {
    cwd: globalThis.process.cwd()
  });
  assert.equal(unrelated.status, 1);
});

test("atomic environment persistence writes mode 0600 and leaves no temporary file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nxt-env-test-"));
  const path = join(directory, "settings.env");
  await writeEnvFileAtomic(path, {
    GOOGLE_REFRESH_TOKEN: "durable-refresh-token"
  });

  assert.equal(
    await readFile(path, "utf8"),
    "GOOGLE_REFRESH_TOKEN=durable-refresh-token\n"
  );
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(directory), ["settings.env"]);
});

const createProvisionClient = ({ ownedByMe = true, checksum } = {}) => {
  const files = [];
  const creates = [];
  const ids = new Map([
    ["NXT-ASERDARGUN-COM", "root-drive-id"],
    ["NXT-PRIVATE-COM", "private-drive-id"],
    ["Notes", "notes-drive-id"],
    ["_assets", "assets-drive-id"],
    ["Inbox", "inbox-drive-id"],
    ["Plans", "plans-drive-id"],
    ["Archive", "archive-drive-id"],
    ["published", "published-drive-id"],
    ["integration-tests", "integration-drive-id"],
    ["vault-index.json", "vault-index-file-id"],
    ["preferences.json", "preferences-file-id"],
    ["publication-manifest.json", "publication-manifest-file-id"]
  ]);
  const metadata = (file) => ({
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    parents: [file.parentId],
    trashed: false,
    ownedByMe,
    permissions: [{ role: "owner", type: "user" }],
    version: file.version ?? "1",
    md5Checksum:
      file.content === undefined
        ? undefined
        : (checksum ?? createHash("md5").update(file.content).digest("hex"))
  });
  const seedFolder = ({ id, name, parentId }) => {
    files.push({
      id,
      name,
      parentId,
      mimeType: "application/vnd.google-apps.folder",
      version: "1"
    });
  };
  const client = {
    async listExact({ parentId, name, mimeType }) {
      return files
        .filter(
          (file) =>
            file.parentId === parentId &&
            file.name === name &&
            file.mimeType === mimeType
        )
        .map(metadata);
    },
    async create({ parentId, name, mimeType, content }) {
      const file = {
        id: ids.get(name) ?? `generated-${files.length}`,
        name,
        parentId,
        mimeType,
        content,
        version: "1"
      };
      files.push(file);
      creates.push({ parentId, name, mimeType, content });
      return metadata(file);
    },
    async get(id) {
      const file = files.find((entry) => entry.id === id);
      if (file === undefined) throw new Error("not found");
      return metadata(file);
    },
    async readText(id) {
      const file = files.find((entry) => entry.id === id);
      if (file === undefined || file.content === undefined)
        throw new Error("not found");
      return file.content;
    }
  };
  return { client, creates, files, seedFolder };
};
