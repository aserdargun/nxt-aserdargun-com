import { createHash, randomUUID } from "node:crypto";
import { chmod, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PreferencesSchema,
  PublicationManifestSchema,
  VaultIndexSchema
} from "../packages/contracts/dist/index.js";
import {
  planFolders,
  readDriveOwner,
  verifyOwnerEmail
} from "./google-drive-oauth.mjs";
import { loadGoogleApisFromApiPackage } from "./google-drive-googleapis.mjs";

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const JSON_MIME_TYPE = "application/json";
const ROOT_PARENT_ID = "root";
const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/u;
const PROVISION_FIELDS =
  "id,name,mimeType,parents,trashed,ownedByMe,permissions(id,type,role,emailAddress),version,md5Checksum";
const PROVISION_LIST_FIELDS = `nextPageToken,files(${PROVISION_FIELDS})`;
const MAX_PROVISION_PAGES = 1000;

const SYSTEM_FILES = [
  {
    name: "vault-index.json",
    setting: "NXT_VAULT_INDEX_DRIVE_FILE_ID",
    emptyValue: { schemaVersion: 1, entries: [] },
    schema: VaultIndexSchema
  },
  {
    name: "preferences.json",
    setting: "NXT_PREFERENCES_DRIVE_FILE_ID",
    emptyValue: {
      schemaVersion: 1,
      favorites: [],
      recent: [],
      theme: "system"
    },
    schema: PreferencesSchema
  },
  {
    name: "publication-manifest.json",
    setting: "NXT_PUBLICATION_MANIFEST_DRIVE_FILE_ID",
    emptyValue: { schemaVersion: 1, entries: [] },
    schema: PublicationManifestSchema
  }
];

export const systemFileDefinitions = () =>
  SYSTEM_FILES.map(({ name, setting, emptyValue }) => ({
    name,
    setting,
    emptyValue: globalThis.structuredClone(emptyValue)
  }));

export const buildEnvFile = (source, updates) => {
  if (typeof source !== "string")
    throw new Error("Environment source must be text.");
  parseEnvFile(source);
  const entries = Object.entries(updates);
  for (const [key, value] of entries) assertEnvEntry(key, value);
  const lines = source === "" ? [] : source.replace(/\r\n/gu, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const seen = new Set();
  const replaced = lines.map((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=/u.exec(line);
    if (match === null || !Object.hasOwn(updates, match[1])) return line;
    const key = match[1];
    if (seen.has(key))
      throw new Error("Environment file contains a duplicate managed key.");
    seen.add(key);
    return `${key}=${updates[key]}`;
  });
  for (const [key, value] of entries) {
    if (!seen.has(key)) replaced.push(`${key}=${value}`);
  }
  return `${replaced.join("\n")}\n`;
};

export const readEnvFile = async (path) => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return "";
    throw error;
  }
};

export const parseEnvFile = (source) => {
  const values = {};
  for (const rawLine of source.replace(/\r\n/gu, "\n").split("\n")) {
    const line = rawLine;
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0)
      throw new Error("Environment file contains an invalid line.");
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!ENV_KEY_PATTERN.test(key) || Object.hasOwn(values, key)) {
      throw new Error("Environment file contains an invalid or duplicate key.");
    }
    values[key] = value;
  }
  return values;
};

export const writeEnvFileAtomic = async (path, updates) => {
  const next = buildEnvFile(await readEnvFile(path), updates);
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${globalThis.process.pid}.${randomUUID()}.tmp`
  );
  let temporary;
  try {
    temporary = await open(temporaryPath, "wx", 0o600);
    await temporary.writeFile(next, { encoding: "utf8" });
    await temporary.sync();
    await temporary.close();
    temporary = undefined;
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await temporary?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
};

export const createGoogleProvisioningClient = (drive) => ({
  async listExact({ parentId, name, mimeType }) {
    const q = `'${escapeDriveQueryLiteral(parentId)}' in parents and name = '${escapeDriveQueryLiteral(name)}' and mimeType = '${escapeDriveQueryLiteral(mimeType)}' and trashed = false`;
    const files = [];
    const seenTokens = new Set();
    let pageToken;
    for (let page = 0; page < MAX_PROVISION_PAGES; page += 1) {
      const response = await drive.files.list(
        {
          q,
          spaces: "drive",
          pageSize: 100,
          ...(pageToken === undefined ? {} : { pageToken }),
          fields: PROVISION_LIST_FIELDS
        },
        { retry: false }
      );
      const pageFiles = response?.data?.files;
      if (pageFiles !== undefined) {
        if (!Array.isArray(pageFiles))
          throw new Error("Google Drive provisioning response is invalid.");
        files.push(...pageFiles);
      }
      const nextPageToken = response?.data?.nextPageToken;
      if (
        nextPageToken === undefined ||
        nextPageToken === null ||
        nextPageToken === ""
      )
        return files;
      if (typeof nextPageToken !== "string" || seenTokens.has(nextPageToken)) {
        throw new Error("Google Drive provisioning pagination is invalid.");
      }
      seenTokens.add(nextPageToken);
      pageToken = nextPageToken;
    }
    throw new Error("Google Drive provisioning pagination limit exceeded.");
  },
  async create({ parentId, name, mimeType, content }) {
    const response = await drive.files.create(
      {
        requestBody: { name, mimeType, parents: [parentId] },
        ...(content === undefined
          ? {}
          : { media: { mimeType, body: content } }),
        fields: PROVISION_FIELDS
      },
      { retry: false }
    );
    return response.data;
  },
  async get(id) {
    const response = await drive.files.get(
      {
        fileId: id,
        fields: PROVISION_FIELDS
      },
      { retry: false }
    );
    return response.data;
  },
  async readText(id) {
    const response = await drive.files.get(
      { fileId: id, alt: "media" },
      { responseType: "text", retry: false }
    );
    if (typeof response.data !== "string")
      throw new Error("Google Drive system file content is invalid.");
    return response.data;
  }
});

export const runProvisioningCli = async ({ cwd, loadGoogleApis, log }) => {
  const envPath = resolve(cwd, ".env.local");
  const env = parseEnvFile(await readEnvFile(envPath));
  const clientId = requireEnvValue(env, "GOOGLE_CLIENT_ID");
  const clientSecret = requireEnvValue(env, "GOOGLE_CLIENT_SECRET");
  const refreshToken = requireEnvValue(env, "GOOGLE_REFRESH_TOKEN");
  const expectedOwnerEmail = requireEnvValue(env, "NXT_ALLOWED_GOOGLE_EMAIL");
  const { google } = await loadGoogleApis();
  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  const drive = google.drive({ version: "v3", auth });
  const owner = await readDriveOwner(drive);
  const ownerEmail = verifyOwnerEmail({
    expectedEmail: expectedOwnerEmail,
    actualEmail: owner?.emailAddress
  });
  const rootResponse = await drive.files.get(
    {
      fileId: ROOT_PARENT_ID,
      fields: "id"
    },
    { retry: false }
  );
  const rootParentId = requireDriveId(rootResponse.data?.id);
  const result = await provisionDriveLayout({
    client: createGoogleProvisioningClient(drive),
    ownerEmail,
    expectedOwnerEmail,
    rootParentId,
    log
  });
  await writeEnvFileAtomic(envPath, result.settings);
  log("Drive layout verified: NXT-ASERDARGUN-COM and NXT-PRIVATE-COM.");
  return {
    ownerEmail,
    systemFileCount: Object.keys(result.systemFiles).length
  };
};

export const provisionDriveLayout = async ({
  client,
  ownerEmail,
  expectedOwnerEmail,
  rootParentId = ROOT_PARENT_ID,
  log = () => undefined
}) => {
  verifyOwnerEmail({
    expectedEmail: expectedOwnerEmail,
    actualEmail: ownerEmail
  });
  log("Google owner account verified.");
  const plan = planFolders();
  const vaultRoot = await ensureFolder(client, rootParentId, plan.vaultRoot);
  const privateRoot = await ensureFolder(
    client,
    rootParentId,
    plan.privateRoot
  );
  const notes = await ensureFolder(client, vaultRoot.id, "Notes");
  const assets = await ensureFolder(client, vaultRoot.id, "_assets");
  const inbox = await ensureFolder(client, notes.id, "Inbox");
  const plans = await ensureFolder(client, notes.id, "Plans");
  const archive = await ensureFolder(client, notes.id, "Archive");
  const published = await ensureFolder(client, privateRoot.id, "published");
  const integration = await ensureFolder(
    client,
    privateRoot.id,
    "integration-tests"
  );
  const systemFiles = {};
  for (const definition of SYSTEM_FILES) {
    systemFiles[definition.setting] = await ensureSystemFile(
      client,
      privateRoot.id,
      definition
    );
    log(`System file verified: ${definition.name}`);
  }
  return {
    settings: {
      NXT_VAULT_DRIVE_FOLDER_ID: vaultRoot.id,
      NXT_NOTES_DRIVE_FOLDER_ID: notes.id,
      NXT_ASSETS_DRIVE_FOLDER_ID: assets.id,
      NXT_INBOX_DRIVE_FOLDER_ID: inbox.id,
      NXT_PLANS_DRIVE_FOLDER_ID: plans.id,
      NXT_ARCHIVE_DRIVE_FOLDER_ID: archive.id,
      NXT_PRIVATE_DRIVE_FOLDER_ID: privateRoot.id,
      NXT_PUBLISHED_DRIVE_FOLDER_ID: published.id,
      NXT_INTEGRATION_TEST_DRIVE_FOLDER_ID: integration.id,
      NXT_VAULT_INDEX_DRIVE_FILE_ID:
        systemFiles.NXT_VAULT_INDEX_DRIVE_FILE_ID.id,
      NXT_PREFERENCES_DRIVE_FILE_ID:
        systemFiles.NXT_PREFERENCES_DRIVE_FILE_ID.id,
      NXT_PUBLICATION_MANIFEST_DRIVE_FILE_ID:
        systemFiles.NXT_PUBLICATION_MANIFEST_DRIVE_FILE_ID.id
    },
    systemFiles
  };
};

const ensureFolder = async (client, parentId, name) => {
  const matches = await client.listExact({
    parentId,
    name,
    mimeType: FOLDER_MIME_TYPE
  });
  assertMatches(matches, name);
  const candidate =
    matches.length === 0
      ? await client.create({ parentId, name, mimeType: FOLDER_MIME_TYPE })
      : matches[0];
  const readback = await client.get(candidate.id);
  assertFolderReadback(readback, parentId, name);
  return readback;
};

const ensureSystemFile = async (client, parentId, definition) => {
  const matches = await client.listExact({
    parentId,
    name: definition.name,
    mimeType: JSON_MIME_TYPE
  });
  assertMatches(matches, definition.name);
  let candidate;
  if (matches.length === 0) {
    candidate = await client.create({
      parentId,
      name: definition.name,
      mimeType: JSON_MIME_TYPE,
      content: `${JSON.stringify(definition.emptyValue, null, 2)}\n`
    });
  } else {
    candidate = matches[0];
  }
  const readback = await client.get(candidate.id);
  assertSystemFileReadback(readback, parentId, definition.name);
  let text;
  try {
    text = await client.readText(readback.id);
  } catch {
    throw new Error(`Invalid system file: ${definition.name}.`);
  }
  if (typeof readback.version !== "string" || readback.version === "") {
    throw new Error(
      `System file readback is missing a version: ${definition.name}.`
    );
  }
  if (typeof readback.md5Checksum !== "string" || readback.md5Checksum === "") {
    throw new Error(
      `System file readback is missing a checksum: ${definition.name}.`
    );
  }
  if (createHash("md5").update(text).digest("hex") !== readback.md5Checksum) {
    throw new Error(
      `System file checksum verification failed: ${definition.name}.`
    );
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Invalid system file: ${definition.name}.`);
  }
  if (!definition.schema.safeParse(value).success) {
    throw new Error(`Invalid system file: ${definition.name}.`);
  }
  return {
    id: readback.id,
    version: readback.version,
    checksum: readback.md5Checksum
  };
};

const assertMatches = (matches, name) => {
  if (!Array.isArray(matches))
    throw new Error(`Drive lookup failed for ${name}.`);
  if (matches.length > 1) throw new Error(`Duplicate Drive item: ${name}.`);
};

const assertFolderReadback = (file, parentId, name) => {
  if (
    !isRecord(file) ||
    file.name !== name ||
    file.mimeType !== FOLDER_MIME_TYPE ||
    file.trashed !== false ||
    file.ownedByMe !== true ||
    !Array.isArray(file.parents) ||
    file.parents.length !== 1 ||
    file.parents[0] !== parentId ||
    !hasOwnerPermission(file.permissions)
  ) {
    throw new Error(
      `Drive folder ownership or ancestry verification failed: ${name}.`
    );
  }
};

const assertSystemFileReadback = (file, parentId, name) => {
  if (
    !isRecord(file) ||
    file.name !== name ||
    file.mimeType !== JSON_MIME_TYPE ||
    file.trashed !== false ||
    file.ownedByMe !== true ||
    !Array.isArray(file.parents) ||
    file.parents.length !== 1 ||
    file.parents[0] !== parentId ||
    !hasOwnerPermission(file.permissions)
  ) {
    throw new Error(
      `System file ownership or ancestry verification failed: ${name}.`
    );
  }
};

const hasOwnerPermission = (permissions) =>
  Array.isArray(permissions) &&
  permissions.some(
    (permission) =>
      isRecord(permission) &&
      permission.type === "user" &&
      permission.role === "owner"
  );

const assertEnvEntry = (key, value) => {
  if (
    !ENV_KEY_PATTERN.test(key) ||
    typeof value !== "string" ||
    /[\r\n\0]/u.test(value)
  ) {
    throw new Error("Environment update contains an unsafe key or value.");
  }
};

const requireEnvValue = (env, key) => {
  const value = env[key];
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${key} must be set in .env.local.`);
  return value;
};

const requireDriveId = (value) => {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error("Google Drive root readback is invalid.");
  }
  return value;
};

const escapeDriveQueryLiteral = (value) =>
  String(value).replace(/\\/gu, "\\\\").replace(/'/gu, "\\'");

const safeErrorMessage = (error) => {
  const message = error instanceof Error ? error.message : "";
  if (
    message.startsWith("GOOGLE_") ||
    message.startsWith("NXT_ALLOWED_GOOGLE_EMAIL") ||
    message.startsWith("The authorized Google account") ||
    message.startsWith("Google account readback") ||
    message.startsWith("Duplicate Drive item") ||
    message.startsWith("Invalid system file") ||
    message.startsWith("Drive folder ownership") ||
    message.startsWith("System file ownership")
  ) {
    return message;
  }
  return "Google Drive provisioning failed.";
};

export const loadGoogleApisForProvisioning = () =>
  loadGoogleApisFromApiPackage();

const main = async () => {
  try {
    await runProvisioningCli({
      cwd: globalThis.process.cwd(),
      loadGoogleApis: loadGoogleApisForProvisioning,
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

const isNotFound = (error) => isRecord(error) && error.code === "ENOENT";
const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

if (isMain) await main();
