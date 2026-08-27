import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { loadGoogleApisFromApiPackage } from "./google-drive-googleapis.mjs";
import { parseEnvFile } from "./google-drive-provision.mjs";
import { readDriveOwner, verifyOwnerEmail } from "./google-drive-oauth.mjs";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const GOOGLE_MIME_PREFIX = "application/vnd.google-apps.";
const SYSTEM_JSON_NAMES = new Set(["vault-index.json", "preferences.json", "publication-manifest.json"]);
const ROOT_CONTRACT = Object.freeze([
  { label: "vault", name: "NXT-ASERDARGUN-COM", envKey: "NXT_VAULT_DRIVE_FOLDER_ID" },
  { label: "private", name: "NXT-PRIVATE-COM", envKey: "NXT_PRIVATE_DRIVE_FOLDER_ID" }
]);
const DEFAULT_LIMITS = Object.freeze({
  maxPages: 1_000,
  maxOperations: 20_000,
  maxEntries: 10_000,
  maxDepth: 64,
  maxFileBytes: 20 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024
});
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const SAFE_MIME = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u;
const SAFE_ID = /^[^\0\r\n]{1,512}$/u;
const SAFE_CHECKSUM = /^[0-9a-f]{32}$/u;
const SAFE_SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

const refuse = (message) => new Error(`Refusing Drive backup: ${message}.`);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const md5 = (value) => createHash("md5").update(value).digest("hex");
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const hasExactKeys = (value, keys) => isRecord(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const safeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
const safePathSegment = (value) => typeof value === "string" && value.length > 0 && value.length <= 1024 &&
  value !== "." && value !== ".." && !/[\\/\0\r\n]/u.test(value);
const pathCollisionKey = (segments) => segments.map((segment) => segment.normalize("NFC").toLocaleLowerCase("en-US")).join("/");
const combineLimits = (limits = {}) => {
  if (!isRecord(limits) || Object.keys(limits).some((key) => !Object.hasOwn(DEFAULT_LIMITS, key))) throw refuse("limits are invalid");
  const result = { ...DEFAULT_LIMITS, ...limits };
  if (Object.values(result).some((value) => !Number.isSafeInteger(value) || value <= 0)) throw refuse("limits are invalid");
  return result;
};
const assertRootInputs = (roots) => {
  if (!Array.isArray(roots) || roots.length !== 2) throw refuse("both distinct roots are required");
  for (const expected of ROOT_CONTRACT) {
    const root = roots.find((candidate) => candidate?.label === expected.label);
    if (!hasExactKeys(root, ["label", "id", "name"]) || root.name !== expected.name || !SAFE_ID.test(root.id)) throw refuse("root contract is invalid");
  }
  if (new Set(roots.map((root) => root.id)).size !== 2) throw refuse("both distinct roots are required");
};
const parseSize = (value) => {
  const parsed = typeof value === "string" && /^[0-9]+$/u.test(value) ? Number(value) : value;
  if (!safeInteger(parsed)) throw refuse("file size metadata is invalid");
  return parsed;
};
const validateMetadata = (value, { expectedId, expectedName, expectedParent, root = false }) => {
  if (!isRecord(value) || !SAFE_ID.test(value.id) || (expectedId !== undefined && value.id !== expectedId) ||
      !safePathSegment(value.name) ||
      (expectedName !== undefined && value.name !== expectedName) || typeof value.mimeType !== "string" || !SAFE_MIME.test(value.mimeType) ||
      value.trashed !== false || value.ownedByMe !== true || !Array.isArray(value.parents) || value.parents.length !== 1 || !SAFE_ID.test(value.parents[0])) {
    throw refuse("Drive metadata is malformed");
  }
  if (expectedParent !== undefined && value.parents[0] !== expectedParent) throw refuse("Drive parent ancestry is ambiguous");
  if (root && value.mimeType !== FOLDER_MIME) throw refuse("verified roots must be folders");
  if (value.mimeType.startsWith(GOOGLE_MIME_PREFIX) && value.mimeType !== FOLDER_MIME) throw refuse("unsupported Google-native MIME type");
  if (value.mimeType === FOLDER_MIME) {
    return { id: value.id, name: value.name, mimeType: value.mimeType, parentId: value.parents[0], size: null, version: null, modifiedTime: null, checksum: null };
  }
  if (typeof value.version !== "string" || value.version.length === 0 || value.version.length > 128 || /[\0\r\n]/u.test(value.version) ||
      typeof value.modifiedTime !== "string" || !SAFE_TIMESTAMP.test(value.modifiedTime) || !SAFE_CHECKSUM.test(value.md5Checksum)) {
    throw refuse("file metadata or download checksum is invalid");
  }
  return {
    id: value.id,
    name: value.name,
    mimeType: value.mimeType,
    parentId: value.parents[0],
    size: parseSize(value.size),
    version: value.version,
    modifiedTime: value.modifiedTime,
    checksum: value.md5Checksum
  };
};
const shouldExport = (metadata, includeBinaries) => {
  if (metadata.mimeType === FOLDER_MIME) return false;
  if (metadata.mimeType === "text/markdown") {
    if (!metadata.name.toLocaleLowerCase("en-US").endsWith(".md")) throw refuse("Markdown metadata is malformed");
    return true;
  }
  if (metadata.mimeType === "application/json" && SYSTEM_JSON_NAMES.has(metadata.name)) return true;
  return includeBinaries;
};
const increment = (state, key, maximum, label) => {
  state[key] += 1;
  if (state[key] > maximum) throw refuse(`${label} limit exceeded`);
};
const writeNewFile = async (path, bytes, mode = 0o600) => {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
};
const prepareOutput = async (outputPath) => {
  const requested = resolve(outputPath);
  if (["", ".", ".."].includes(basename(requested))) throw refuse("new output directory is invalid");
  const parent = await realpath(dirname(requested)).catch(() => { throw refuse("output parent is unavailable"); });
  const output = join(parent, basename(requested));
  try {
    await lstat(output);
    throw refuse("a new output directory is required");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(output, { mode: 0o700 });
  await chmod(output, 0o700);
  await writeNewFile(join(output, ".incomplete"), "Backup inventory is incomplete.\n");
  return output;
};
const ensureExportDirectory = async (output, label, created) => {
  if (!created.has("files")) { await mkdir(join(output, "files"), { mode: 0o700 }); created.add("files"); }
  if (!created.has(label)) { await mkdir(join(output, "files", label), { mode: 0o700 }); created.add(label); }
};

export const createBackupInventory = async ({ outputPath, roots, adapter, includeBinaries = false, limits }) => {
  assertRootInputs(roots);
  if (!isRecord(adapter) || typeof adapter.getRoot !== "function" || typeof adapter.listChildren !== "function" || typeof adapter.download !== "function") throw refuse("backup adapter is invalid");
  const bounds = combineLimits(limits);
  const output = await prepareOutput(outputPath);
  const state = { pages: 0, operations: 0, entries: 0, totalBytes: 0 };
  const entries = [];
  const seenIds = new Set(roots.map((root) => root.id));
  const seenPaths = new Set();
  const createdDirectories = new Set();
  try {
    const verifiedRoots = [];
    for (const root of roots) {
      increment(state, "operations", bounds.maxOperations, "operation");
      const metadata = validateMetadata(await adapter.getRoot(root.id), { expectedId: root.id, expectedName: root.name, root: true });
      verifiedRoots.push({ label: root.label, id: root.id, name: metadata.name });
    }
    const queue = roots.map((root) => ({ root, folderId: root.id, segments: [], depth: 0 }));
    while (queue.length > 0) {
      const current = queue.shift();
      if (current.depth > bounds.maxDepth) throw refuse("folder depth limit exceeded");
      let pageToken;
      const pageTokens = new Set();
      while (true) {
        increment(state, "pages", bounds.maxPages, "pagination");
        increment(state, "operations", bounds.maxOperations, "operation");
        const page = await adapter.listChildren({ parentId: current.folderId, pageToken, pageSize: 100 });
        if (!isRecord(page) || !Array.isArray(page.files)) throw refuse("pagination response is malformed");
        for (const raw of page.files) {
          const metadata = validateMetadata(raw, { expectedParent: current.folderId });
          if (seenIds.has(metadata.id)) throw refuse("duplicate or cyclic Drive ID detected");
          seenIds.add(metadata.id);
          increment(state, "entries", bounds.maxEntries, "entry");
          const segments = [...current.segments, metadata.name];
          const relativePath = segments.join("/");
          if (relativePath.length > 16_384) throw refuse("relative path length limit exceeded");
          const collisionKey = `${current.root.label}:${pathCollisionKey(segments)}`;
          if (seenPaths.has(collisionKey)) throw refuse("normalized path collision detected");
          seenPaths.add(collisionKey);
          let exportedPath = null;
          let contentSha256 = null;
          if (shouldExport(metadata, includeBinaries)) {
            if (metadata.size > bounds.maxFileBytes) throw refuse("file size limit exceeded");
            if (state.totalBytes + metadata.size > bounds.maxTotalBytes) throw refuse("total size limit exceeded");
            increment(state, "operations", bounds.maxOperations, "operation");
            const downloaded = await adapter.download({ fileId: metadata.id });
            const bytes = Buffer.isBuffer(downloaded) ? downloaded : downloaded instanceof Uint8Array ? Buffer.from(downloaded) : undefined;
            if (bytes === undefined || bytes.byteLength !== metadata.size || md5(bytes) !== metadata.checksum) throw refuse("download checksum does not match metadata");
            state.totalBytes += bytes.byteLength;
            await ensureExportDirectory(output, current.root.label, createdDirectories);
            exportedPath = `files/${current.root.label}/${sha256(metadata.id)}.bin`;
            await writeNewFile(join(output, ...exportedPath.split("/")), bytes);
            contentSha256 = sha256(bytes);
          }
          entries.push({
            rootLabel: current.root.label,
            name: metadata.name,
            relativePath,
            driveId: metadata.id,
            parentId: metadata.parentId,
            mimeType: metadata.mimeType,
            size: metadata.size,
            version: metadata.version,
            modifiedTime: metadata.modifiedTime,
            checksum: metadata.checksum,
            exportedPath,
            contentSha256
          });
          if (metadata.mimeType === FOLDER_MIME) queue.push({ root: current.root, folderId: metadata.id, segments, depth: current.depth + 1 });
        }
        const next = page.nextPageToken;
        if (next === undefined || next === null || next === "") break;
        if (typeof next !== "string" || next.length > 1024 || /[\0\r\n]/u.test(next) || pageTokens.has(next)) throw refuse("pagination token is invalid");
        pageTokens.add(next);
        pageToken = next;
      }
    }
    entries.sort((left, right) => left.rootLabel.localeCompare(right.rootLabel, "en") || left.relativePath.localeCompare(right.relativePath, "en") || left.driveId.localeCompare(right.driveId, "en"));
    const counts = {
      entries: entries.length,
      exported: entries.filter((entry) => entry.exportedPath !== null).length,
      metadataOnly: entries.filter((entry) => entry.mimeType !== FOLDER_MIME && entry.exportedPath === null).length,
      roots: verifiedRoots.length
    };
    const manifest = { schemaVersion: 1, createdAt: new Date().toISOString(), roots: verifiedRoots, entries, counts };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) throw refuse("manifest size limit exceeded");
    await writeNewFile(join(output, "manifest.json"), manifestBytes);
    await unlink(join(output, ".incomplete"));
    return { outputPath: output, counts, roots: verifiedRoots.map((root) => root.label) };
  } catch (error) {
    await chmod(join(output, ".incomplete"), 0o600).catch(() => undefined);
    throw error;
  }
};

const readNoFollow = async (path, maximum) => {
  const metadata = await lstat(path).catch(() => { throw refuse("required backup file is missing"); });
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw refuse("backup path must be a regular file, not a symlink or special file");
  if ((metadata.mode & 0o777) !== 0o600) throw refuse("backup files must use mode 0600");
  if (metadata.size > maximum) throw refuse("backup file size limit exceeded");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return await handle.readFile(); }
  finally { await handle.close(); }
};
const validateManifest = (manifest) => {
  if (!hasExactKeys(manifest, ["schemaVersion", "createdAt", "roots", "entries", "counts"]) || manifest.schemaVersion !== 1 ||
      typeof manifest.createdAt !== "string" || !SAFE_TIMESTAMP.test(manifest.createdAt) || !Array.isArray(manifest.roots) || !Array.isArray(manifest.entries) ||
      !hasExactKeys(manifest.counts, ["entries", "exported", "metadataOnly", "roots"])) throw refuse("manifest schema is invalid");
  assertRootInputs(manifest.roots);
  const ids = new Set(manifest.roots.map((root) => root.id));
  const exports = new Set();
  for (const entry of manifest.entries) {
    if (!hasExactKeys(entry, ["rootLabel", "name", "relativePath", "driveId", "parentId", "mimeType", "size", "version", "modifiedTime", "checksum", "exportedPath", "contentSha256"]) ||
        !["vault", "private"].includes(entry.rootLabel) || !safePathSegment(entry.name) || typeof entry.relativePath !== "string" || entry.relativePath.length === 0 || entry.relativePath.length > 16_384 || /[\\\0\r\n]/u.test(entry.relativePath) ||
        !SAFE_ID.test(entry.driveId) || !SAFE_ID.test(entry.parentId) || ids.has(entry.driveId) || typeof entry.mimeType !== "string" || !SAFE_MIME.test(entry.mimeType)) {
      throw refuse("manifest entry is invalid");
    }
    ids.add(entry.driveId);
    const folder = entry.mimeType === FOLDER_MIME;
    if (folder) {
      if (entry.size !== null || entry.version !== null || entry.modifiedTime !== null || entry.checksum !== null || entry.exportedPath !== null || entry.contentSha256 !== null) throw refuse("folder manifest entry is invalid");
      continue;
    }
    if (!safeInteger(entry.size) || typeof entry.version !== "string" || !SAFE_TIMESTAMP.test(entry.modifiedTime) || !SAFE_CHECKSUM.test(entry.checksum)) throw refuse("file manifest entry is invalid");
    if (entry.exportedPath === null) {
      if (entry.contentSha256 !== null) throw refuse("metadata-only entry has a file checksum");
      continue;
    }
    const expectedPath = `files/${entry.rootLabel}/${sha256(entry.driveId)}.bin`;
    if (entry.exportedPath !== expectedPath || !SAFE_SHA256.test(entry.contentSha256) || exports.has(entry.exportedPath)) throw refuse("exported path is invalid or duplicated");
    exports.add(entry.exportedPath);
  }
  const byId = new Map(manifest.entries.map((entry) => [entry.driveId, entry]));
  const rootsByLabel = new Map(manifest.roots.map((root) => [root.label, root]));
  const visiting = new Set();
  const checked = new Set();
  const pathKeys = new Set();
  const checkAncestry = (entry) => {
    if (checked.has(entry.driveId)) return;
    if (visiting.has(entry.driveId)) throw refuse("manifest parent ancestry contains a cycle");
    visiting.add(entry.driveId);
    const root = rootsByLabel.get(entry.rootLabel);
    let expectedPath;
    if (entry.parentId === root.id) expectedPath = entry.name;
    else {
      const parent = byId.get(entry.parentId);
      if (parent === undefined || parent.rootLabel !== entry.rootLabel || parent.mimeType !== FOLDER_MIME) throw refuse("manifest parent ancestry is invalid");
      checkAncestry(parent);
      expectedPath = `${parent.relativePath}/${entry.name}`;
    }
    if (entry.relativePath !== expectedPath) throw refuse("manifest relative path is inconsistent");
    const key = `${entry.rootLabel}:${pathCollisionKey(entry.relativePath.split("/"))}`;
    if (pathKeys.has(key)) throw refuse("manifest normalized path collision detected");
    pathKeys.add(key);
    visiting.delete(entry.driveId);
    checked.add(entry.driveId);
  };
  for (const entry of manifest.entries) checkAncestry(entry);
  const derived = {
    entries: manifest.entries.length,
    exported: exports.size,
    metadataOnly: manifest.entries.filter((entry) => entry.mimeType !== FOLDER_MIME && entry.exportedPath === null).length,
    roots: manifest.roots.length
  };
  if (JSON.stringify(manifest.counts) !== JSON.stringify(derived)) throw refuse("manifest counts are invalid");
  return { exports, counts: derived };
};
const collectPaths = async (root, current = root, result = new Set()) => {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    const relativePath = relative(root, path).split(sep).join("/");
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw refuse("backup contains a symlink or special file");
    result.add(relativePath);
    if (entry.isDirectory()) await collectPaths(root, path, result);
  }
  return result;
};

export const verifyBackup = async ({ outputPath }) => {
  const requested = resolve(outputPath);
  const output = await realpath(requested).catch(() => { throw refuse("backup output is unavailable"); });
  const rootMetadata = await lstat(requested);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw refuse("backup output must be a regular directory");
  if ((rootMetadata.mode & 0o777) !== 0o700) throw refuse("backup output must use mode 0700");
  try { await lstat(join(output, ".incomplete")); throw refuse("backup inventory is incomplete"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const manifestBytes = await readNoFollow(join(output, "manifest.json"), MAX_MANIFEST_BYTES);
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")); }
  catch { throw refuse("manifest JSON is invalid"); }
  const { exports, counts } = validateManifest(manifest);
  for (const entry of manifest.entries) {
    if (entry.exportedPath === null) continue;
    const bytes = await readNoFollow(join(output, ...entry.exportedPath.split("/")), DEFAULT_LIMITS.maxFileBytes);
    if (bytes.byteLength !== entry.size || md5(bytes) !== entry.checksum || sha256(bytes) !== entry.contentSha256) throw refuse("exported file checksum mismatch");
  }
  const actual = await collectPaths(output);
  const allowed = new Set(["manifest.json"]);
  if (exports.size > 0) allowed.add("files");
  for (const root of ROOT_CONTRACT) {
    if ([...exports].some((path) => path.startsWith(`files/${root.label}/`))) allowed.add(`files/${root.label}`);
  }
  for (const path of exports) allowed.add(path);
  for (const path of actual) if (!allowed.has(path)) throw refuse("extra backup path detected");
  for (const path of allowed) if (!actual.has(path)) throw refuse("required backup path is missing");
  return { counts, roots: manifest.roots.map((root) => root.label).sort() };
};

export const createGoogleBackupAdapter = (drive) => {
  const fields = "id,name,mimeType,parents,trashed,ownedByMe,size,version,modifiedTime,md5Checksum";
  return {
    async getRoot(fileId) {
      const response = await drive.files.get({ fileId, fields }, { retry: false });
      return response.data;
    },
    async listChildren({ parentId, pageToken, pageSize }) {
      const escaped = parentId.replaceAll("'", "\\'");
      const response = await drive.files.list({
        q: `'${escaped}' in parents and trashed = false`,
        spaces: "drive",
        pageSize,
        ...(pageToken === undefined ? {} : { pageToken }),
        fields: `nextPageToken,files(${fields})`
      }, { retry: false });
      return { files: response.data?.files ?? [], nextPageToken: response.data?.nextPageToken };
    },
    async download({ fileId }) {
      const response = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer", retry: false });
      return Buffer.from(response.data);
    }
  };
};

const readBackupEnvironment = async (cwd) => {
  const path = resolve(cwd, ".env.local");
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600 || metadata.size > 128 * 1024) throw refuse(".env.local must be a mode-0600 regular non-symlink");
  const bytes = await readNoFollow(path, 128 * 1024);
  const env = parseEnvFile(bytes.toString("utf8"));
  const requireValue = (key) => {
    const value = env[key];
    if (typeof value !== "string" || value.trim() === "" || /[\0\r\n]/u.test(value)) throw refuse(`required environment key ${key} is missing`);
    return value;
  };
  return {
    clientId: requireValue("GOOGLE_CLIENT_ID"),
    clientSecret: requireValue("GOOGLE_CLIENT_SECRET"),
    refreshToken: requireValue("GOOGLE_REFRESH_TOKEN"),
    ownerEmail: requireValue("NXT_ALLOWED_GOOGLE_EMAIL"),
    roots: ROOT_CONTRACT.map((root) => ({ label: root.label, name: root.name, id: requireValue(root.envKey) }))
  };
};

export const runBackupCli = async ({ cwd = process.cwd(), argv = process.argv.slice(2), loadGoogleApis = loadGoogleApisFromApiPackage, log = console.log }) => {
  if (argv[0] === "verify" && argv.length === 3 && argv[1] === "--output") {
    const result = await verifyBackup({ outputPath: resolve(cwd, argv[2]) });
    log(`Backup verified: roots=${result.roots.join(",")}, entries=${result.counts.entries}, exported=${result.counts.exported}, metadata-only=${result.counts.metadataOnly}.`);
    return result;
  }
  const includeBinaries = argv.at(-1) === "--include-binaries";
  if (argv[0] !== "inventory" || argv[1] !== "--output" || (argv.length !== 3 && !(argv.length === 4 && includeBinaries))) {
    throw new Error("Usage: google-drive-backup.mjs <inventory|verify> --output <directory> [--include-binaries]");
  }
  const env = await readBackupEnvironment(cwd);
  const { google } = await loadGoogleApis();
  const auth = new google.auth.OAuth2(env.clientId, env.clientSecret);
  auth.setCredentials({ refresh_token: env.refreshToken });
  const drive = google.drive({ version: "v3", auth });
  const owner = await readDriveOwner(drive);
  verifyOwnerEmail({ expectedEmail: env.ownerEmail, actualEmail: owner?.emailAddress });
  const result = await createBackupInventory({ outputPath: resolve(cwd, argv[2]), roots: env.roots, adapter: createGoogleBackupAdapter(drive), includeBinaries });
  log(`Backup inventory complete: roots=${result.roots.join(",")}, entries=${result.counts.entries}, exported=${result.counts.exported}, metadata-only=${result.counts.metadataOnly}.`);
  return result;
};

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runBackupCli({}).catch(() => {
    process.stderr.write("Drive backup operation failed.\n");
    process.exitCode = 1;
  });
}
