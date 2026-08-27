import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const folderMime = "application/vnd.google-apps.folder";
const md5 = (value) => createHash("md5").update(value).digest("hex");
const run = promisify(execFile);
const metadata = ({ id, name, mimeType, parentId, bytes, version = "1", modifiedTime = "2026-08-23T12:00:00.000Z" }) => ({
  id, name, mimeType, parents: parentId === undefined ? ["root"] : [parentId], trashed: false, ownedByMe: true,
  version, modifiedTime,
  ...(mimeType === folderMime ? {} : { size: String(bytes.byteLength), md5Checksum: md5(bytes) })
});
const roots = [
  { label: "vault", id: "vault-root-id", name: "NXT-ASERDARGUN-COM" },
  { label: "private", id: "private-root-id", name: "NXT-PRIVATE-COM" }
];
const makeAdapter = ({ pages, downloads, roots: rootRecords }) => ({
  getRoot: async (id) => rootRecords[id],
  listChildren: async ({ parentId, pageToken }) => pages[`${parentId}:${pageToken ?? "first"}`] ?? { files: [] },
  download: async ({ fileId }) => downloads[fileId]
});
const loadBackup = () => import("../scripts/google-drive-backup.mjs");

test("two-root paginated inventory downloads Markdown and approved system JSON then verifies offline", async (context) => {
  const { createBackupInventory, runBackupCli, verifyBackup } = await loadBackup();
  const parent = await mkdtemp(join(tmpdir(), "nxt-backup-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const output = join(parent, "inventory");
  const note = Buffer.from("# Backup\n", "utf8");
  const system = Buffer.from('{"schemaVersion":1,"entries":[]}\n', "utf8");
  const vaultRoot = metadata({ id: roots[0].id, name: roots[0].name, mimeType: folderMime });
  const privateRoot = metadata({ id: roots[1].id, name: roots[1].name, mimeType: folderMime });
  const notes = metadata({ id: "notes-folder", name: "Notes", mimeType: folderMime, parentId: roots[0].id });
  const noteFile = metadata({ id: "note-id", name: "Plan.md", mimeType: "text/markdown", parentId: notes.id, bytes: note });
  const systemFile = metadata({ id: "index-id", name: "vault-index.json", mimeType: "application/json", parentId: roots[1].id, bytes: system });
  const adapter = makeAdapter({
    roots: { [roots[0].id]: vaultRoot, [roots[1].id]: privateRoot },
    pages: {
      [`${roots[0].id}:first`]: { files: [notes], nextPageToken: "vault-next" },
      [`${roots[0].id}:vault-next`]: { files: [] },
      [`${notes.id}:first`]: { files: [noteFile] },
      [`${roots[1].id}:first`]: { files: [systemFile] }
    },
    downloads: { [noteFile.id]: note, [systemFile.id]: system }
  });
  const created = await createBackupInventory({ outputPath: output, roots, adapter });
  assert.deepEqual(created.counts, { entries: 3, exported: 2, metadataOnly: 0, roots: 2 });
  const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.roots.map(({ label, name }) => ({ label, name })), roots.map(({ label, name }) => ({ label, name })));
  assert.equal(manifest.entries.find((entry) => entry.driveId === noteFile.id).relativePath, "Notes/Plan.md");
  assert.ok(manifest.entries.every((entry) => entry.exportedPath === null || /^files\/(vault|private)\/[0-9a-f]{64}\.bin$/u.test(entry.exportedPath)));
  assert.equal((await lstat(output)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(output, "manifest.json"))).mode & 0o777, 0o600);
  assert.deepEqual((await verifyBackup({ outputPath: output })).counts, created.counts);
  const lines = [];
  await runBackupCli({
    cwd: parent,
    argv: ["verify", "--output", output],
    loadGoogleApis: async () => { throw new Error("offline verify contacted Google"); },
    log: (line) => lines.push(line)
  });
  assert.deepEqual(lines, ["Backup verified: roots=private,vault, entries=3, exported=2, metadata-only=0."]);
});

test("binary inventory is metadata-only by default and bounded download is explicit", async (context) => {
  const { createBackupInventory, verifyBackup } = await loadBackup();
  const parent = await mkdtemp(join(tmpdir(), "nxt-backup-binary-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const image = Buffer.from("bounded-binary", "utf8");
  const vaultRoot = metadata({ id: roots[0].id, name: roots[0].name, mimeType: folderMime });
  const privateRoot = metadata({ id: roots[1].id, name: roots[1].name, mimeType: folderMime });
  const binary = metadata({ id: "image-id", name: "figure.png", mimeType: "image/png", parentId: roots[0].id, bytes: image });
  const adapter = makeAdapter({
    roots: { [roots[0].id]: vaultRoot, [roots[1].id]: privateRoot },
    pages: { [`${roots[0].id}:first`]: { files: [binary] }, [`${roots[1].id}:first`]: { files: [] } },
    downloads: { [binary.id]: image }
  });
  const metadataOutput = join(parent, "metadata");
  assert.equal((await createBackupInventory({ outputPath: metadataOutput, roots, adapter })).counts.metadataOnly, 1);
  assert.deepEqual((await verifyBackup({ outputPath: metadataOutput })).counts.metadataOnly, 1);
  const binaryOutput = join(parent, "binary");
  assert.equal((await createBackupInventory({ outputPath: binaryOutput, roots, adapter, includeBinaries: true })).counts.exported, 1);
  assert.deepEqual((await verifyBackup({ outputPath: binaryOutput })).counts.exported, 1);
});

test("inventory refuses duplicate, cycle, parent ambiguity, checksum, pagination, size, root, and output hazards", async (context) => {
  const { createBackupInventory } = await loadBackup();
  const parent = await mkdtemp(join(tmpdir(), "nxt-backup-refusal-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const emptyRootRecords = {
    [roots[0].id]: metadata({ id: roots[0].id, name: roots[0].name, mimeType: folderMime }),
    [roots[1].id]: metadata({ id: roots[1].id, name: roots[1].name, mimeType: folderMime })
  };
  const safeAdapter = makeAdapter({ roots: emptyRootRecords, pages: {}, downloads: {} });
  await mkdir(join(parent, "existing"));
  await assert.rejects(createBackupInventory({ outputPath: join(parent, "existing"), roots, adapter: safeAdapter }), /new output/u);
  const symlinkOutput = join(parent, "linked");
  await symlink(join(parent, "existing"), symlinkOutput);
  await assert.rejects(createBackupInventory({ outputPath: symlinkOutput, roots, adapter: safeAdapter }), /new output/u);
  await assert.rejects(createBackupInventory({ outputPath: join(parent, "same-roots"), roots: [roots[0], { ...roots[1], id: roots[0].id }], adapter: safeAdapter }), /distinct roots/u);

  const folder = metadata({ id: "folder", name: "Folder", mimeType: folderMime, parentId: roots[0].id });
  const duplicateAdapter = makeAdapter({
    roots: emptyRootRecords,
    pages: { [`${roots[0].id}:first`]: { files: [folder, folder] }, [`${roots[1].id}:first`]: { files: [] } }, downloads: {}
  });
  await assert.rejects(createBackupInventory({ outputPath: join(parent, "duplicate"), roots, adapter: duplicateAdapter }), /duplicate or cyclic Drive ID/u);

  const wrongParent = { ...folder, id: "wrong-parent", parents: ["somewhere-else"] };
  const parentAdapter = makeAdapter({
    roots: emptyRootRecords,
    pages: { [`${roots[0].id}:first`]: { files: [wrongParent] }, [`${roots[1].id}:first`]: { files: [] } }, downloads: {}
  });
  await assert.rejects(createBackupInventory({ outputPath: join(parent, "parent"), roots, adapter: parentAdapter }), /parent ancestry/u);

  const slashName = { ...folder, id: "slash-name", name: "../escape" };
  const slashAdapter = makeAdapter({
    roots: emptyRootRecords,
    pages: { [`${roots[0].id}:first`]: { files: [slashName] }, [`${roots[1].id}:first`]: { files: [] } }, downloads: {}
  });
  await assert.rejects(createBackupInventory({ outputPath: join(parent, "slash"), roots, adapter: slashAdapter }), /metadata|path segment/u);

  const firstBytes = Buffer.from("first", "utf8");
  const secondBytes = Buffer.from("second", "utf8");
  const firstCollision = metadata({ id: "collision-one", name: "Résumé.md", mimeType: "text/markdown", parentId: roots[0].id, bytes: firstBytes });
  const secondCollision = metadata({ id: "collision-two", name: "re\u0301sume\u0301.md", mimeType: "text/markdown", parentId: roots[0].id, bytes: secondBytes });
  const collisionAdapter = makeAdapter({
    roots: emptyRootRecords,
    pages: { [`${roots[0].id}:first`]: { files: [firstCollision, secondCollision] }, [`${roots[1].id}:first`]: { files: [] } },
    downloads: { [firstCollision.id]: firstBytes, [secondCollision.id]: secondBytes }
  });
  await assert.rejects(createBackupInventory({ outputPath: join(parent, "collision"), roots, adapter: collisionAdapter }), /normalized path collision/u);

  const bytes = Buffer.from("checksum", "utf8");
  const text = { ...metadata({ id: "text", name: "note.md", mimeType: "text/markdown", parentId: roots[0].id, bytes }), md5Checksum: undefined };
  const checksumAdapter = makeAdapter({
    roots: emptyRootRecords,
    pages: { [`${roots[0].id}:first`]: { files: [text] }, [`${roots[1].id}:first`]: { files: [] } }, downloads: { text: bytes }
  });
  await assert.rejects(createBackupInventory({ outputPath: join(parent, "checksum"), roots, adapter: checksumAdapter }), /download checksum/u);

  const pageAdapter = makeAdapter({
    roots: emptyRootRecords,
    pages: { [`${roots[0].id}:first`]: { files: [], nextPageToken: "again" }, [`${roots[0].id}:again`]: { files: [], nextPageToken: "again" } }, downloads: {}
  });
  await assert.rejects(createBackupInventory({ outputPath: join(parent, "page"), roots, adapter: pageAdapter }), /pagination/u);
  const oversized = metadata({ id: "large", name: "large.md", mimeType: "text/markdown", parentId: roots[0].id, bytes: Buffer.alloc(20) });
  const sizeAdapter = makeAdapter({ roots: emptyRootRecords, pages: { [`${roots[0].id}:first`]: { files: [oversized] }, [`${roots[1].id}:first`]: { files: [] } }, downloads: { large: Buffer.alloc(20) } });
  await assert.rejects(createBackupInventory({ outputPath: join(parent, "size"), roots, adapter: sizeAdapter, limits: { maxFileBytes: 10 } }), /size limit/u);
});

test("offline verify rejects missing, extra, symlink, special, and changed files without contacting Drive", async (context) => {
  const { createBackupInventory, verifyBackup } = await loadBackup();
  const parent = await mkdtemp(join(tmpdir(), "nxt-backup-verify-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const bytes = Buffer.from("# Verified\n", "utf8");
  const rootRecords = {
    [roots[0].id]: metadata({ id: roots[0].id, name: roots[0].name, mimeType: folderMime }),
    [roots[1].id]: metadata({ id: roots[1].id, name: roots[1].name, mimeType: folderMime })
  };
  const file = metadata({ id: "note", name: "note.md", mimeType: "text/markdown", parentId: roots[0].id, bytes });
  const adapter = makeAdapter({ roots: rootRecords, pages: { [`${roots[0].id}:first`]: { files: [file] }, [`${roots[1].id}:first`]: { files: [] } }, downloads: { note: bytes } });
  const output = join(parent, "inventory");
  await createBackupInventory({ outputPath: output, roots, adapter });
  const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
  const exported = join(output, manifest.entries.find((entry) => entry.driveId === "note").exportedPath);
  await writeFile(exported, "tampered\n");
  await assert.rejects(verifyBackup({ outputPath: output }), /checksum/u);
  await writeFile(exported, bytes);
  await writeFile(join(output, "extra.txt"), "extra\n");
  await assert.rejects(verifyBackup({ outputPath: output }), /extra backup path/u);
  await rm(join(output, "extra.txt"));
  await rm(exported);
  await symlink(join(output, "manifest.json"), exported);
  await assert.rejects(verifyBackup({ outputPath: output }), /symlink|regular file/u);
  await rm(exported);
  await writeFile(exported, bytes);
  await chmod(exported, 0o600);
  await rm(exported);
  await run("mkfifo", [exported]);
  await assert.rejects(verifyBackup({ outputPath: output }), /symlink or special file/u);
  await rm(exported);
  await writeFile(exported, bytes, { mode: 0o600 });
  await chmod(join(output, "manifest.json"), 0o644);
  await assert.rejects(verifyBackup({ outputPath: output }), /mode 0600/u);
  await chmod(join(output, "manifest.json"), 0o600);
  const original = JSON.stringify(manifest, null, 2) + "\n";
  const wrongPath = structuredClone(manifest);
  wrongPath.entries[0].relativePath = "wrong.md";
  await writeFile(join(output, "manifest.json"), `${JSON.stringify(wrongPath, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(verifyBackup({ outputPath: output }), /relative path/u);
  const wrongParentManifest = structuredClone(manifest);
  wrongParentManifest.entries[0].parentId = roots[1].id;
  await writeFile(join(output, "manifest.json"), `${JSON.stringify(wrongParentManifest, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(verifyBackup({ outputPath: output }), /parent ancestry/u);
  const collisionManifest = structuredClone(manifest);
  collisionManifest.entries.push({
    ...collisionManifest.entries[0],
    name: "NOTE.md",
    relativePath: "NOTE.md",
    driveId: "note-case-collision",
    exportedPath: null,
    contentSha256: null
  });
  collisionManifest.counts.entries += 1;
  collisionManifest.counts.metadataOnly += 1;
  await writeFile(join(output, "manifest.json"), `${JSON.stringify(collisionManifest, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(verifyBackup({ outputPath: output }), /normalized path collision/u);
  const cycleManifest = structuredClone(manifest);
  cycleManifest.entries.push(
    {
      rootLabel: "vault", name: "A", relativePath: "B/A", driveId: "folder-a", parentId: "folder-b",
      mimeType: folderMime, size: null, version: null, modifiedTime: null, checksum: null, exportedPath: null, contentSha256: null
    },
    {
      rootLabel: "vault", name: "B", relativePath: "A/B", driveId: "folder-b", parentId: "folder-a",
      mimeType: folderMime, size: null, version: null, modifiedTime: null, checksum: null, exportedPath: null, contentSha256: null
    }
  );
  cycleManifest.counts.entries += 2;
  await writeFile(join(output, "manifest.json"), `${JSON.stringify(cycleManifest, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(verifyBackup({ outputPath: output }), /cycle/u);
  await writeFile(join(output, "manifest.json"), original, { mode: 0o600 });
});
