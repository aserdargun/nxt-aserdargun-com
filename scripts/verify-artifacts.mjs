import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const moduleCheckout = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const maxWebBytes = 250 * 1024 * 1024;
const maxWebFiles = 5_000;
const maxApiFiles = 100;
const sensitiveKeys = [
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
  "NXT_VAULT_DRIVE_FOLDER_ID",
  "NXT_PRIVATE_DRIVE_FOLDER_ID",
  "NXT_NOTES_DRIVE_FOLDER_ID",
  "NXT_INBOX_DRIVE_FOLDER_ID",
  "NXT_PLANS_DRIVE_FOLDER_ID",
  "NXT_ARCHIVE_DRIVE_FOLDER_ID",
  "NXT_ASSETS_DRIVE_FOLDER_ID",
  "NXT_PUBLISHED_DRIVE_FOLDER_ID",
  "NXT_VAULT_INDEX_DRIVE_FILE_ID",
  "NXT_PREFERENCES_DRIVE_FILE_ID",
  "NXT_PUBLICATION_MANIFEST_DRIVE_FILE_ID"
];
const maxTextBytes = 50 * 1024 * 1024;
const textExtensions = new Set(["", ".css", ".html", ".js", ".json", ".svg", ".txt", ".webmanifest", ".xml"]);
const forbiddenNames = /(?:^|\/)(?:\.env(?:\.|$)|control\.json$|.*(?:credential|client_secret|refresh_token).*)/iu;
const forbiddenExtensions = new Set([".map", ".pem", ".p12", ".pfx", ".key"]);
const expectedCsp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

const inspectArtifactRoot = async (root, label) => {
  let metadata;
  try {
    metadata = await lstat(root);
  } catch {
    throw new Error(`Missing ${label} artifact tree.`);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`Unsafe symlink or non-directory ${label} artifact root.`);
  const resolved = await realpath(root);
  if (resolved !== root) throw new Error(`Unsafe redirected ${label} artifact root.`);
  return { device: metadata.dev, inode: metadata.ino };
};

const revalidateArtifactRoot = async (root, label, identity) => {
  const current = await inspectArtifactRoot(root, label);
  if (current.device !== identity.device || current.inode !== identity.inode) throw new Error(`${label} artifact root changed during verification.`);
};

const collectTree = async (root, label, maximum) => {
  const identity = await inspectArtifactRoot(root, label);
  const rootRealpath = root;
  const files = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new Error(`Unsafe symlink in ${label} artifacts.`);
      const resolved = await realpath(path);
      const child = relative(rootRealpath, resolved);
      if (child === ".." || child.startsWith(`..${sep}`)) throw new Error(`Unsafe path in ${label} artifacts.`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push({ path, relative: relative(rootRealpath, path).split(sep).join("/"), size: metadata.size });
      else throw new Error(`Unsafe special file in ${label} artifacts.`);
      if (files.length > maximum) throw new Error(`Excessive ${label} artifact file count.`);
    }
  };
  await visit(rootRealpath);
  return { files: files.sort((a, b) => a.relative.localeCompare(b.relative)), identity };
};

const readJson = async (path, label) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`Invalid ${label}.`);
  }
};

const verifyStaticConfig = (config) => {
  const expectedRoutes = [
    { route: "/.auth/login/aad", statusCode: 404 },
    { route: "/api/private/*", allowedRoles: ["authenticated"] },
    { route: "/app/*", allowedRoles: ["authenticated"] }
  ];
  if (JSON.stringify(config.routes) !== JSON.stringify(expectedRoutes)) throw new Error("Invalid or shadowed Static Web Apps routes.");
  if (new Set(config.routes.map(({ route }) => route)).size !== config.routes.length) throw new Error("Duplicate Static Web Apps route.");
  if (config.routes.some(({ route }) => route === "/login")) throw new Error("The login route must not receive a platform role.");
  if (JSON.stringify(config.navigationFallback) !== JSON.stringify({ rewrite: "/index.html", exclude: ["/api/*", "/.auth/*"] })) {
    throw new Error("Invalid Static Web Apps navigation fallback.");
  }
  if (config.auth !== undefined) throw new Error("Free Static Web Apps cannot use Standard-only auth configuration.");
  const expectedHeaders = {
    "Content-Security-Policy": expectedCsp,
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "X-Content-Type-Options": "nosniff"
  };
  if (JSON.stringify(config.globalHeaders) !== JSON.stringify(expectedHeaders)) throw new Error("Invalid Static Web Apps security headers.");
  if (JSON.stringify(config.platform) !== JSON.stringify({ apiRuntime: "node:22" })) throw new Error("Invalid Static Web Apps API runtime.");
};

const scanFiles = async (files) => {
  for (const file of files) {
    const extension = extname(file.relative).toLowerCase();
    if (forbiddenNames.test(file.relative) || forbiddenExtensions.has(extension)) throw new Error("Unsafe generated artifact structure.");
    if (!textExtensions.has(extension)) continue;
    if (file.size > maxTextBytes) throw new Error("Text artifact exceeds the inspection bound.");
    const text = await readFile(file.path, "utf8");
    for (const key of sensitiveKeys) {
      const value = process.env[key];
      if (typeof value === "string" && value.length > 0 && text.includes(value)) {
        throw new Error(`Backend-only value found for ${key}.`);
      }
    }
  }
};

export const verifyArtifacts = async ({ checkoutPath = moduleCheckout } = {}) => {
  const checkout = await realpath(resolve(checkoutPath));
  const webRoot = join(checkout, "web", "dist");
  const apiRoot = join(checkout, "api-dist");
  const [webTree, apiTree] = await Promise.all([
    collectTree(webRoot, "web", maxWebFiles),
    collectTree(apiRoot, "API", maxApiFiles)
  ]);
  const { files: webFiles } = webTree;
  const { files: apiFiles } = apiTree;
  if (webFiles.reduce((sum, file) => sum + file.size, 0) >= maxWebBytes) throw new Error("Web artifacts exceed the 250 MiB limit.");
  for (const required of ["index.html", "staticwebapp.config.json"]) {
    if (!webFiles.some((file) => file.relative === required)) throw new Error(`Missing web artifact ${required}.`);
  }
  if (JSON.stringify(apiFiles.map(({ relative: path }) => path)) !== JSON.stringify(["host.json", "index.js", "package.json"])) {
    throw new Error("Invalid API artifact structure.");
  }
  const apiPackage = await readJson(join(apiRoot, "package.json"), "API package");
  const expectedPackage = {
    name: "nxt-api-artifact",
    private: true,
    type: "module",
    main: "index.js",
    dependencies: {
      "@azure/functions": "4.16.2",
      "file-type": "22.0.2",
      "googleapis": "176.0.0"
    }
  };
  if (JSON.stringify(apiPackage) !== JSON.stringify(expectedPackage)) throw new Error("Invalid API package contract.");
  const host = await readJson(join(apiRoot, "host.json"), "Functions host config");
  if (host.version !== "2.0") throw new Error("Invalid Functions host config.");
  const entry = await readFile(join(apiRoot, "index.js"), "utf8");
  if (!entry.includes("@azure/functions") || entry.includes("sourceMappingURL")) throw new Error("Invalid Functions entrypoint.");
  verifyStaticConfig(await readJson(join(webRoot, "staticwebapp.config.json"), "Static Web Apps config"));
  await scanFiles([...webFiles, ...apiFiles]);
  await Promise.all([
    revalidateArtifactRoot(webRoot, "web", webTree.identity),
    revalidateArtifactRoot(apiRoot, "API", apiTree.identity)
  ]);
  return { webFiles: webFiles.length, apiFiles: apiFiles.length };
};

const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = await verifyArtifacts();
  process.stdout.write(`Verified ${result.webFiles} web files and ${result.apiFiles} API files.\n`);
}
