import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { deriveIndex, parseNote, serializeNote } from "../packages/domain/dist/index.js";
import { LocalDriveAdapter } from "../api/dist/storage/local-drive-adapter.js";

const DRIVE_KEYS = [
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "NXT_VAULT_DRIVE_FOLDER_ID", "NXT_PRIVATE_DRIVE_FOLDER_ID",
  "NXT_NOTES_DRIVE_FOLDER_ID", "NXT_INBOX_DRIVE_FOLDER_ID", "NXT_PLANS_DRIVE_FOLDER_ID", "NXT_ARCHIVE_DRIVE_FOLDER_ID",
  "NXT_ASSETS_DRIVE_FOLDER_ID", "NXT_PUBLISHED_DRIVE_FOLDER_ID", "NXT_VAULT_INDEX_DRIVE_FILE_ID",
  "NXT_PREFERENCES_DRIVE_FILE_ID", "NXT_PUBLICATION_MANIFEST_DRIVE_FILE_ID"
];
const NOTE_ID = "018f47d2-6a34-7b2a-9f21-8a7034963aef";
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=", "base64"));

const assertNoLiveDrive = (environment) => {
  for (const key of DRIVE_KEYS) {
    if (typeof environment[key] === "string" && environment[key].trim().length > 0) {
      throw new Error(`Refusing live Drive environment key ${key}.`);
    }
  }
};

const assertFixturePath = async (checkoutPath, fixtureRoot, { requireExisting }) => {
  const checkout = await realpath(resolve(checkoutPath));
  const expectedParent = join(checkout, ".nxt-local", "fixtures");
  const candidate = resolve(fixtureRoot);
  if (candidate === expectedParent || !candidate.startsWith(`${expectedParent}${sep}`) || dirname(candidate) !== expectedParent) {
    throw new Error("Refusing unsafe local fixture root.");
  }
  await mkdir(expectedParent, { recursive: true, mode: 0o700 });
  if (await realpath(expectedParent) !== expectedParent) throw new Error("Refusing unsafe local fixture root.");
  let metadata;
  try { metadata = await lstat(candidate); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (metadata?.isSymbolicLink()) throw new Error("Refusing unsafe local fixture root.");
  if (requireExisting) {
    if (metadata === undefined || !metadata.isDirectory() || await realpath(candidate) !== candidate) {
      throw new Error("Refusing unsafe local fixture root.");
    }
  } else if (metadata !== undefined) {
    throw new Error("Refusing pre-existing local fixture root.");
  }
  return { checkout, fixtureRoot: candidate };
};

const seedSource = serializeNote({
  frontmatter: {
    id: NOTE_ID,
    title: "Welcome to NXT",
    created: "2026-08-23T12:00:00.000Z",
    updated: "2026-08-23T12:00:00.000Z",
    tags: ["welcome", "seed"],
    aliases: ["Welcome"]
  },
  body: "# Welcome to NXT\n\nThis local-only note links to [[2026 Planı]].\n"
});

const stableJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
const QUIESCENCE_POLL_MS = 10;
const QUIESCENCE_TIMEOUT_MS = 2_000;

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

const fixtureMutationIsActive = async (fixtureRoot) => {
  try {
    const metadata = await lstat(join(fixtureRoot, ".mutation.lock"));
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Refusing unsafe local fixture mutation lock.");
    }
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};

const waitForFixtureQuiescence = async (fixtureRoot) => {
  const deadline = Date.now() + QUIESCENCE_TIMEOUT_MS;
  let consecutiveClearChecks = 0;
  while (Date.now() <= deadline) {
    if (await fixtureMutationIsActive(fixtureRoot)) consecutiveClearChecks = 0;
    else consecutiveClearChecks += 1;
    if (consecutiveClearChecks === 2) return;
    await delay(QUIESCENCE_POLL_MS);
  }
  throw new Error("Refusing to reset a busy local fixture root.");
};

const assertSafeFixtureTree = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error("Refusing unsafe local fixture artifact.");
    if (metadata.isDirectory()) await assertSafeFixtureTree(path);
    else if (!metadata.isFile()) throw new Error("Refusing unsafe local fixture artifact.");
  }
};

export const seedLocalFixtures = async ({ checkoutPath, fixtureRoot, environment = process.env }) => {
  assertNoLiveDrive(environment);
  const safe = await assertFixturePath(checkoutPath, fixtureRoot, { requireExisting: false });
  await mkdir(safe.fixtureRoot, { mode: 0o700 });
  try {
    const storage = await LocalDriveAdapter.create(safe.fixtureRoot);
    const notes = await storage.createFolder({ parentId: "vault", name: "Notes" });
    const inbox = await storage.createFolder({ parentId: notes.id, name: "Inbox" });
    const plans = await storage.createFolder({ parentId: notes.id, name: "Plans" });
    const archive = await storage.createFolder({ parentId: notes.id, name: "Archive" });
    const assets = await storage.createFolder({ parentId: "vault", name: "_assets" });
    const published = await storage.createFolder({ parentId: "private", name: "published" });
    const seedNote = await storage.createText({ parentId: inbox.id, name: "Welcome to NXT.md", mimeType: "text/markdown", text: seedSource });
    const seedImage = await storage.createBytes({ parentId: assets.id, name: "seed.png", mimeType: "image/png", bytes: PNG });
    const indexValue = deriveIndex([{ source: seedSource, driveId: seedNote.id, path: "Notes/Inbox/Welcome to NXT.md", driveVersion: seedNote.version, attachments: [] }]);
    const index = await storage.createText({ parentId: "private", name: "vault-index.json", mimeType: "application/json", text: stableJson(indexValue) });
    const preferences = await storage.createText({
      parentId: "private", name: "preferences.json", mimeType: "application/json",
      text: stableJson({ schemaVersion: 1, favorites: [], recent: [], theme: "dark", panelState: { activeContext: "preview", explorerOpen: true } })
    });
    const manifest = await storage.createText({
      parentId: "private", name: "publication-manifest.json", mimeType: "application/json",
      text: stableJson({ schemaVersion: 1, generation: 0, entries: [], tombstones: [], operations: [], cleanup: [], cleanupOffset: 0, createRecoveryOffset: 0 })
    });
    const ids = {
      notes: notes.id, inbox: inbox.id, plans: plans.id, archive: archive.id, assets: assets.id, published: published.id,
      seedNote: seedNote.id, seedImage: seedImage.id, index: index.id, preferences: preferences.id, manifest: manifest.id
    };
    const descriptor = { version: 1, fixtureRoot: safe.fixtureRoot, noteId: NOTE_ID, ids };
    await writeFile(join(safe.fixtureRoot, ".fixture.json"), stableJson(descriptor), { encoding: "utf8", mode: 0o600, flag: "wx" });
    return descriptor;
  } catch (error) {
    await rm(safe.fixtureRoot, { recursive: true, force: true });
    throw error;
  }
};

const readDescriptor = async (checkoutPath, fixtureRoot) => {
  const safe = await assertFixturePath(checkoutPath, fixtureRoot, { requireExisting: true });
  const descriptorPath = join(safe.fixtureRoot, ".fixture.json");
  const metadata = await lstat(descriptorPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Refusing unsafe local fixture descriptor.");
  const value = JSON.parse(await readFile(descriptorPath, "utf8"));
  if (value?.version !== 1 || value.fixtureRoot !== safe.fixtureRoot || value.noteId !== NOTE_ID || typeof value.ids?.seedNote !== "string") {
    throw new Error("Refusing invalid local fixture descriptor.");
  }
  return value;
};

export const mutateLocalFixtureNote = async ({ checkoutPath, fixtureRoot, noteId, title, body }) => {
  const descriptor = await readDescriptor(checkoutPath, fixtureRoot);
  if (noteId !== descriptor.noteId || typeof title !== "string" || typeof body !== "string") throw new Error("Refusing invalid local fixture mutation.");
  const storage = await LocalDriveAdapter.create(fixtureRoot);
  const before = await storage.readText(descriptor.ids.seedNote);
  const parsed = parseNote(before.text);
  const source = serializeNote({
    frontmatter: { ...parsed.frontmatter, title, updated: new Date().toISOString() },
    body
  });
  const file = await storage.updateText({ fileId: descriptor.ids.seedNote, expectedVersion: before.file.version, mimeType: "text/markdown", text: source });
  return { noteId, title, previousVersion: before.file.version, version: file.version };
};

export const corruptLocalFixtureManifest = async ({ checkoutPath, fixtureRoot }) => {
  const descriptor = await readDescriptor(checkoutPath, fixtureRoot);
  const storage = await LocalDriveAdapter.create(fixtureRoot);
  const before = await storage.readText(descriptor.ids.manifest);
  await storage.updateText({
    fileId: descriptor.ids.manifest,
    expectedVersion: before.file.version,
    mimeType: "application/json",
    text: '{"schemaVersion":2,"entries":[{"secret":"must-not-leak"}]}\n'
  });
};

export const removeLocalFixtures = async ({ checkoutPath, fixtureRoot }) => {
  const safe = await assertFixturePath(checkoutPath, fixtureRoot, { requireExisting: true });
  await readDescriptor(checkoutPath, safe.fixtureRoot);
  await assertSafeFixtureTree(safe.fixtureRoot);
  await rm(safe.fixtureRoot, { recursive: true, maxRetries: 3, retryDelay: 10 });
};

export const resetLocalFixtures = async ({ checkoutPath, fixtureRoot, environment = process.env }) => {
  assertNoLiveDrive(environment);
  const safe = await assertFixturePath(checkoutPath, fixtureRoot, { requireExisting: true });
  await readDescriptor(checkoutPath, safe.fixtureRoot);
  await waitForFixtureQuiescence(safe.fixtureRoot);
  await assertSafeFixtureTree(safe.fixtureRoot);
  const quarantine = join(dirname(safe.fixtureRoot), `.playwright-reset-${randomUUID()}`);
  await rename(safe.fixtureRoot, quarantine);
  try {
    const seeded = await seedLocalFixtures({ checkoutPath: safe.checkout, fixtureRoot: safe.fixtureRoot, environment });
    await assertSafeFixtureTree(quarantine);
    await rm(quarantine, { recursive: true, maxRetries: 3, retryDelay: 10 });
    return seeded;
  } catch (error) {
    const current = await lstat(safe.fixtureRoot).catch((candidateError) => {
      if (candidateError?.code === "ENOENT") return undefined;
      throw candidateError;
    });
    if (current !== undefined) {
      if (!current.isDirectory() || current.isSymbolicLink()) throw error;
      await assertSafeFixtureTree(safe.fixtureRoot);
      await rm(safe.fixtureRoot, { recursive: true, maxRetries: 3, retryDelay: 10 });
    }
    await rename(quarantine, safe.fixtureRoot);
    throw error;
  }
};
