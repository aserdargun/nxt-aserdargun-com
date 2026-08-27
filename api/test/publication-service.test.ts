import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  PublicationManifestSchema,
  VaultIndexSchema,
  type PublicationManifest,
  type VaultIndex
} from "@nxt/contracts";
import { deriveIndex, serializeNote } from "@nxt/domain";
import { describe, expect, it } from "vitest";
import { AttachmentService } from "../src/services/attachment-service.js";
import {
  PublicPublicationReader,
  PublicationService
} from "../src/services/publication-service.js";
import { SystemFileStore } from "../src/services/system-file-store.js";
import { VaultService } from "../src/services/vault-service.js";
import { LocalDriveAdapter } from "../src/storage/local-drive-adapter.js";
import { RootBoundaryStorage } from "../src/storage/root-boundary.js";
import {
  StorageMutationOutcomeUnknownError,
  type StoragePort
} from "../src/storage/storage-port.js";

const noteId = "018f47d2-6a34-7b2a-9f21-8a7034963aef";
const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=", "base64"));
const webp = Uint8Array.from(Buffer.from("UklGRiYAAABXRUJQVlA4IBoAAABQAQCdASoBAAEAAgA0JZwABAAAAP75HbIQAA==", "base64"));

const sourceFor = (title: string, body = "# Public body\n"): string => serializeNote({
  frontmatter: {
    id: noteId,
    title,
    created: "2026-08-24T12:00:00.000Z",
    updated: "2026-08-24T12:00:00.000Z",
    tags: ["private-tag"],
    aliases: ["Private alias"]
  },
  body
});

const delegateStorage = (storage: StoragePort, overrides: Partial<StoragePort>): StoragePort => ({
  get: overrides.get ?? storage.get.bind(storage),
  listChildren: overrides.listChildren ?? storage.listChildren.bind(storage),
  readText: overrides.readText ?? storage.readText.bind(storage),
  readBytes: overrides.readBytes ?? storage.readBytes.bind(storage),
  createFolder: overrides.createFolder ?? storage.createFolder.bind(storage),
  createText: overrides.createText ?? storage.createText.bind(storage),
  createBytes: overrides.createBytes ?? storage.createBytes.bind(storage),
  updateText: overrides.updateText ?? storage.updateText.bind(storage),
  move: overrides.move ?? storage.move.bind(storage),
  trash: overrides.trash ?? storage.trash.bind(storage),
  listRevisions: overrides.listRevisions ?? storage.listRevisions.bind(storage)
});

const setup = async (options: {
  source?: string;
  privateStorage?: (storage: StoragePort, ids: { manifestId: string; publishedId: string }) => StoragePort;
} = {}) => {
  const raw = await LocalDriveAdapter.create(await mkdtemp(join(tmpdir(), "nxt-publication-")));
  const notes = await raw.createFolder({ parentId: "vault", name: "Notes" });
  const inbox = await raw.createFolder({ parentId: notes.id, name: "Inbox" });
  const plans = await raw.createFolder({ parentId: notes.id, name: "Plans" });
  const archive = await raw.createFolder({ parentId: notes.id, name: "Archive" });
  const assets = await raw.createFolder({ parentId: "vault", name: "_assets" });
  const published = await raw.createFolder({ parentId: "private", name: "published" });
  const source = options.source ?? sourceFor("Share me");
  const note = await raw.createText({ parentId: inbox.id, name: "Share.md", mimeType: "text/markdown", text: source });
  const indexFile = await raw.createText({ parentId: "private", name: "vault-index.json", mimeType: "application/json", text: '{"schemaVersion":1,"entries":[]}\n' });
  const manifestFile = await raw.createText({ parentId: "private", name: "publication-manifest.json", mimeType: "application/json", text: '{"schemaVersion":1,"entries":[]}\n' });
  const privateInner = options.privateStorage?.(raw, { manifestId: manifestFile.id, publishedId: published.id }) ?? raw;
  const privateStorage = new RootBoundaryStorage(privateInner, "private");
  const vaultStorage = new RootBoundaryStorage(raw, "vault");
  const indexStore = new SystemFileStore<VaultIndex>({ storage: privateStorage, fileId: indexFile.id, parentId: "private", name: "vault-index.json", schema: VaultIndexSchema });
  const manifestStore = new SystemFileStore<PublicationManifest>({ storage: privateStorage, fileId: manifestFile.id, parentId: "private", name: "publication-manifest.json", schema: PublicationManifestSchema });
  const entry = deriveIndex([{ source, driveId: note.id, path: "Notes/Inbox/Share.md", driveVersion: note.version, attachments: [] }]).entries[0];
  if (entry === undefined) throw new Error("missing publication note fixture");
  await indexStore.update({ schemaVersion: 1, entries: [entry] });
  const vault = new VaultService({
    storage: vaultStorage,
    indexStore,
    folders: { notesId: notes.id, inboxId: inbox.id, plansId: plans.id, archiveId: archive.id, assetsId: assets.id },
    confirmationSecret: "publication-test-confirmation-secret-more-than-32-bytes",
    now: () => new Date("2026-08-24T12:00:00.000Z")
  });
  const attachments = new AttachmentService({ storage: vaultStorage, indexStore, vault, assetsRootId: assets.id });
  const service = new PublicationService({
    storage: privateStorage,
    manifestStore,
    indexStore,
    vault,
    attachments,
    privateRootId: "private",
    publishedRootId: published.id,
    now: () => new Date("2026-08-24T12:00:00.000Z")
  });
  const reader = new PublicPublicationReader({
    storage: privateStorage,
    manifestStore,
    privateRootId: "private",
    publishedRootId: published.id
  });
  return {
    raw, privateStorage, vaultStorage, indexStore, manifestStore, vault, attachments, service, reader,
    ids: { notes, inbox, plans, archive, assets, published, note, indexFile, manifestFile }
  };
};

const publishCurrent = async (fixture: Awaited<ReturnType<typeof setup>>) => {
  const note = await fixture.vault.getNote(noteId);
  return fixture.service.publish({ noteId, expectedVersion: note.version });
};

const restartPublicationService = (
  fixture: Awaited<ReturnType<typeof setup>>,
  now = "2026-08-24T12:01:00.000Z"
): PublicationService => new PublicationService({
  storage: fixture.privateStorage,
  manifestStore: fixture.manifestStore,
  indexStore: fixture.indexStore,
  vault: fixture.vault,
  attachments: fixture.attachments,
  privateRootId: "private",
  publishedRootId: fixture.ids.published.id,
  now: () => new Date(now)
});

const missingPublicIdFor = (publicId: string): string =>
  publicId === "Z".repeat(22) ? "Y".repeat(22) : "Z".repeat(22);

type CleanupView = PublicationManifest["cleanup"][number] & {
  parentFolderId?: string | null;
  folderName?: string | null;
  operationId?: string | null;
};

const idFor = (value: number): string => {
  const bytes = new Uint8Array(16);
  new DataView(bytes.buffer).setUint32(12, value);
  return Buffer.from(bytes).toString("base64url");
};

const unresolvedCleanup = (index: number): PublicationManifest["cleanup"][number] => ({
  cleanupId: idFor(index + 1),
  publicId: "Q".repeat(22),
  folderId: `missing-cleanup-${index}`,
  expectedVersion: "1",
  marker: `pm1.${"Q".repeat(22)}.revision`,
  kind: "revision",
  queuedAt: "2026-08-24T11:00:00.000Z",
  ownershipVersion: null,
  parentFolderId: null,
  folderName: null,
  operationId: null
});

const allCleanup = (manifest: PublicationManifest): CleanupView[] => [
  ...(manifest.cleanup as CleanupView[]),
  ...manifest.tombstones.flatMap((tombstone) =>
    ((tombstone as typeof tombstone & { cleanup?: CleanupView[] }).cleanup ?? []))
];

const rewriteCleanup = async (
  fixture: Awaited<ReturnType<typeof setup>>,
  cleanupId: string,
  transform: (cleanup: CleanupView) => CleanupView
): Promise<void> => {
  await fixture.manifestStore.compareAndSet((manifest) => {
    const rewrite = (records: CleanupView[]): CleanupView[] => records.map((record) =>
      record.cleanupId === cleanupId ? transform(record) : record);
    return {
      ...manifest,
      cleanup: rewrite(manifest.cleanup as CleanupView[]),
      tombstones: manifest.tombstones.map((tombstone) => {
        const owned = (tombstone as typeof tombstone & { cleanup?: CleanupView[] }).cleanup;
        return owned === undefined ? tombstone : { ...tombstone, cleanup: rewrite(owned) };
      })
    } as PublicationManifest;
  });
};

describe("immutable publication snapshots", () => {
  it("projects reload-safe publication status from the exact active revision and clears it on revoke", async () => {
    const fixture = await setup();
    expect(await fixture.service.getStatus(noteId)).toBeNull();

    const published = await publishCurrent(fixture);
    const status = await fixture.service.getStatus(noteId);
    expect(status).toEqual({
      publicId: published.publicId,
      publishedAt: published.publishedAt,
      sourceVersion: fixture.ids.note.version,
      attachmentCount: 0
    });
    expect(Object.keys(status ?? {}).sort()).toEqual([
      "attachmentCount",
      "publicId",
      "publishedAt",
      "sourceVersion"
    ]);
    expect(await restartPublicationService(fixture).getStatus(noteId)).toEqual(status);

    await fixture.service.revoke({ publicId: published.publicId });
    expect(await restartPublicationService(fixture).getStatus(noteId)).toBeNull();
  });

  it("commits a 128-bit public ID last and exposes only a sanitized frozen projection", async () => {
    const fixture = await setup({ source: sourceFor("Share me", "# Hello\n\n<script>private()</script>\n") });
    const result = await publishCurrent(fixture);
    expect(result.publicId).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect(Object.keys(result).sort()).toEqual(["publicId", "publishedAt"]);

    const manifest = (await fixture.manifestStore.read()).value;
    expect(manifest.entries).toHaveLength(1);
    const publicNote = await fixture.reader.getNote(result.publicId);
    expect(publicNote).toMatchObject({ title: "Share me", publishedAt: result.publishedAt, assets: [] });
    expect(publicNote?.html).toContain("<h1");
    expect(publicNote?.html).not.toMatch(/script|private-tag|Private alias|Notes\/Inbox|drive/iu);
    expect(JSON.stringify(publicNote)).not.toContain(noteId);
  });

  it("does not expose a partial publication and leaves only bounded private cleanup state", async () => {
    let snapshotCreates = 0;
    const fixture = await setup({
      privateStorage: (raw) => delegateStorage(raw, {
        createBytes: async (input, context) => {
          if (input.appProperties?.nxtPublicationOperation !== undefined && ++snapshotCreates === 1) {
            throw new Error("injected snapshot write failure");
          }
          return raw.createBytes(input, context);
        }
      })
    });
    const opened = await fixture.vault.getNote(noteId);
    await expect(fixture.service.publish({ noteId, expectedVersion: opened.version }))
      .rejects.toThrow("The service is temporarily unavailable.");

    const manifest = (await fixture.manifestStore.read()).value;
    expect(manifest.entries).toEqual([]);
    expect(manifest.cleanup.length).toBeLessThanOrEqual(64);
    expect(manifest.operations).toEqual([]);
  });

  it("recovers and cleans an accepted public-root create after its immediate recovery read fails", async () => {
    let createdRootId: string | undefined;
    let failImmediateRecovery = false;
    const fixture = await setup({
      privateStorage: (raw, ids) => delegateStorage(raw, {
        createFolder: async (input, context) => {
          const created = await raw.createFolder(input, context);
          if (input.appProperties?.nxtPublicationKind === "public") {
            createdRootId = created.id;
            failImmediateRecovery = true;
          }
          return created;
        },
        listChildren: async (input, context) => {
          if (failImmediateRecovery && input.parentId === ids.publishedId) {
            failImmediateRecovery = false;
            throw new Error("injected accepted public-root recovery read failure");
          }
          return raw.listChildren(input, context);
        }
      })
    });

    await expect(publishCurrent(fixture)).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
    if (createdRootId === undefined) throw new Error("missing accepted public-root create");
    const created = await fixture.raw.get(createdRootId);
    const interrupted = (await fixture.manifestStore.read()).value;
    expect(interrupted.entries).toEqual([]);
    expect(interrupted.operations).toHaveLength(1);
    expect(interrupted.operations[0]).toMatchObject({ publicId: created.name, cleanupSlots: 2 });
    expect(created).toMatchObject({ parentIds: [fixture.ids.published.id], trashed: false });

    const restarted = restartPublicationService(fixture);
    await expect(restarted.revoke({ publicId: missingPublicIdFor(created.name) })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await fixture.raw.get(createdRootId)).toMatchObject({ trashed: true });
    const recovered = (await fixture.manifestStore.read()).value;
    expect(recovered.operations).toEqual([]);
    expect(allCleanup(recovered)).toEqual([]);
  });

  it("recovers an accepted revision create before cleaning its retained public parent", async () => {
    let publicRootId: string | undefined;
    let revisionFolderId: string | undefined;
    let failRevisionRecovery = false;
    let failPublicRootTrash = true;
    const fixture = await setup({
      privateStorage: (raw) => delegateStorage(raw, {
        createFolder: async (input, context) => {
          const created = await raw.createFolder(input, context);
          if (input.appProperties?.nxtPublicationKind === "public") publicRootId = created.id;
          if (input.appProperties?.nxtPublicationKind === "revision") {
            revisionFolderId = created.id;
            failRevisionRecovery = true;
          }
          return created;
        },
        listChildren: async (input, context) => {
          if (failRevisionRecovery && input.parentId === publicRootId) {
            failRevisionRecovery = false;
            throw new Error("injected accepted revision recovery read failure");
          }
          return raw.listChildren(input, context);
        },
        trash: async (input, context) => {
          if (failPublicRootTrash && input.fileId === publicRootId) {
            throw new StorageMutationOutcomeUnknownError(input.fileId);
          }
          return raw.trash(input, context);
        }
      })
    });

    await expect(publishCurrent(fixture)).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
    if (publicRootId === undefined || revisionFolderId === undefined) throw new Error("missing accepted revision fixture");
    const publicRoot = await fixture.raw.get(publicRootId);
    const interrupted = (await fixture.manifestStore.read()).value;
    expect(interrupted.entries).toEqual([]);
    expect(interrupted.operations).toHaveLength(1);
    expect(interrupted.operations[0]).toMatchObject({ publicFolderId: publicRootId, cleanupSlots: 2 });

    const restarted = restartPublicationService(fixture);
    await expect(restarted.revoke({ publicId: missingPublicIdFor(publicRoot.name) })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await fixture.raw.get(revisionFolderId)).toMatchObject({ trashed: true });
    expect(await fixture.raw.get(publicRootId)).toMatchObject({ trashed: false });
    expect(allCleanup((await fixture.manifestStore.read()).value)).toContainEqual(expect.objectContaining({
      kind: "public-root",
      folderId: publicRootId,
      parentFolderId: fixture.ids.published.id
    }));

    failPublicRootTrash = false;
    await expect(restarted.revoke({ publicId: missingPublicIdFor(publicRoot.name) })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await fixture.raw.get(publicRootId)).toMatchObject({ trashed: true });
    expect(allCleanup((await fixture.manifestStore.read()).value)).toEqual([]);
  });

  it("recovers an ambiguously accepted public-root create after its first discovery read fails", async () => {
    let createdRootId: string | undefined;
    let failImmediateRecovery = false;
    const fixture = await setup({
      privateStorage: (raw, ids) => delegateStorage(raw, {
        createFolder: async (input, context) => {
          const created = await raw.createFolder(input, context);
          if (input.appProperties?.nxtPublicationKind === "public") {
            createdRootId = created.id;
            failImmediateRecovery = true;
            throw new StorageMutationOutcomeUnknownError(created.id);
          }
          return created;
        },
        listChildren: async (input, context) => {
          if (failImmediateRecovery && input.parentId === ids.publishedId) {
            failImmediateRecovery = false;
            throw new Error("injected ambiguous public-root discovery failure");
          }
          return raw.listChildren(input, context);
        }
      })
    });

    await expect(publishCurrent(fixture)).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
    if (createdRootId === undefined) throw new Error("missing ambiguously accepted public root");
    const created = await fixture.raw.get(createdRootId);
    expect((await fixture.manifestStore.read()).value.operations).toHaveLength(1);

    const restarted = restartPublicationService(fixture);
    await expect(restarted.revoke({ publicId: missingPublicIdFor(created.name) })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await fixture.raw.get(createdRootId)).toMatchObject({ trashed: true });
    expect((await fixture.manifestStore.read()).value.operations).toEqual([]);
  });

  it("never recovers or trashes a non-stale attempted create owned by a live publisher", async () => {
    let releaseVerification!: () => void;
    let signalVerification!: () => void;
    const verificationGate = new Promise<void>((resolve) => { releaseVerification = resolve; });
    const verificationStarted = new Promise<void>((resolve) => { signalVerification = resolve; });
    let createdRootId: string | undefined;
    let pauseImmediateVerification = false;
    const fixture = await setup({
      privateStorage: (raw, ids) => delegateStorage(raw, {
        createFolder: async (input, context) => {
          const created = await raw.createFolder(input, context);
          if (input.appProperties?.nxtPublicationKind === "public" && createdRootId === undefined) {
            createdRootId = created.id;
            pauseImmediateVerification = true;
          }
          return created;
        },
        listChildren: async (input, context) => {
          if (pauseImmediateVerification && input.parentId === ids.publishedId) {
            pauseImmediateVerification = false;
            signalVerification();
            await verificationGate;
          }
          return raw.listChildren(input, context);
        }
      })
    });
    const opened = await fixture.vault.getNote(noteId);
    const origin = fixture.service.publish({ noteId, expectedVersion: opened.version });
    await verificationStarted;
    if (createdRootId === undefined) throw new Error("missing live attempted public root");
    const liveOperation = (await fixture.manifestStore.read()).value.operations[0];
    if (liveOperation === undefined) throw new Error("missing live publication operation");

    const contender = (await Promise.allSettled([
      fixture.service.publish({ noteId, expectedVersion: opened.version })
    ]))[0];
    const duringContention = (await fixture.manifestStore.read()).value;
    const duringFolder = await fixture.raw.get(createdRootId);
    releaseVerification();
    const originResult = (await Promise.allSettled([origin]))[0];

    expect(contender).toMatchObject({ status: "rejected", reason: { code: "CONFLICT" } });
    expect(duringContention.operations).toContainEqual(expect.objectContaining({
      operationId: liveOperation.operationId,
      createIntent: expect.objectContaining({
        state: "attempted",
        folderId: createdRootId,
        folderVersion: duringFolder.version
      })
    }));
    expect(allCleanup(duringContention)).toEqual([]);
    expect(duringFolder).toMatchObject({ trashed: false });
    expect(originResult).toMatchObject({
      status: "fulfilled",
      value: { publicId: liveOperation.publicId }
    });
    expect(await fixture.reader.getNote(liveOperation.publicId)).toMatchObject({ title: "Share me" });
  });

  it.each(["copied-marker duplicate", "wrong-parent and wrong-marker"] as const)(
    "keeps an interrupted create queued when discovery finds a %s",
    async (variant) => {
      let createdRootId: string | undefined;
      let failImmediateRecovery = false;
      const fixture = await setup({
        privateStorage: (raw, ids) => delegateStorage(raw, {
          createFolder: async (input, context) => {
            const created = await raw.createFolder(input, context);
            if (input.appProperties?.nxtPublicationKind === "public") {
              createdRootId = created.id;
              failImmediateRecovery = true;
            }
            return created;
          },
          listChildren: async (input, context) => {
            if (failImmediateRecovery && input.parentId === ids.publishedId) {
              failImmediateRecovery = false;
              throw new Error("injected interrupted create discovery failure");
            }
            return raw.listChildren(input, context);
          }
        })
      });

      await expect(publishCurrent(fixture)).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
      if (createdRootId === undefined) throw new Error("missing interrupted public root");
      let created = await fixture.raw.get(createdRootId);
      const additionalTargets: string[] = [];
      if (variant === "copied-marker duplicate") {
        const copied = await fixture.raw.createFolder({
          parentId: fixture.ids.published.id,
          name: created.name,
          appProperties: { ...created.appProperties }
        });
        additionalTargets.push(copied.id);
      } else {
        const holding = await fixture.raw.createFolder({ parentId: "private", name: "interrupted-create-holding" });
        created = await fixture.raw.move({
          fileId: created.id,
          fromParentId: fixture.ids.published.id,
          toParentId: holding.id,
          expectedVersion: created.version
        });
        const wrongMarker = await fixture.raw.createFolder({
          parentId: fixture.ids.published.id,
          name: created.name,
          appProperties: {
            nxtPublicationMarker: `pm1.${created.name}.copied`,
            nxtPublicationKind: "public",
            nxtPublicationPublicId: created.name
          }
        });
        additionalTargets.push(wrongMarker.id);
      }

      const restarted = restartPublicationService(fixture);
      await expect(restarted.revoke({ publicId: missingPublicIdFor(created.name) })).rejects.toMatchObject({ code: "NOT_FOUND" });
      const retained = (await fixture.manifestStore.read()).value;
      expect(retained.operations).toHaveLength(1);
      expect(retained.cleanup).toEqual([]);
      expect(await fixture.raw.get(createdRootId)).toMatchObject({ trashed: false });
      for (const targetId of additionalTargets) {
        expect(await fixture.raw.get(targetId)).toMatchObject({ trashed: false });
      }
    }
  );

  it("rotates beyond four retained create intents so unprovable owners cannot starve a later recovery", async () => {
    const fixture = await setup();
    const operations: PublicationManifest["operations"] = [];
    let recoverableFolderId: string | undefined;
    let recoverablePublicId: string | undefined;
    for (let index = 0; index < 5; index += 1) {
      const publicId = idFor(300 + index);
      const operationId = idFor(400 + index);
      const marker = `pm1.${publicId}.public`;
      let folderId: string | null = null;
      let folderVersion: string | null = null;
      if (index === 4) {
        const folder = await fixture.raw.createFolder({
          parentId: fixture.ids.published.id,
          name: publicId,
          appProperties: {
            nxtPublicationMarker: marker,
            nxtPublicationKind: "public",
            nxtPublicationPublicId: publicId
          }
        });
        folderId = folder.id;
        folderVersion = folder.version;
        recoverableFolderId = folder.id;
        recoverablePublicId = publicId;
      }
      operations.push({
        operationId,
        publicId,
        sourceNoteId: `018f47d2-6a34-7b2a-9f21-8a7034963a${(index + 1).toString(16).padStart(2, "0")}`,
        epoch: 1,
        startedAt: "2026-08-24T11:00:00.000Z",
        sourceVersion: "1",
        sourceChecksum: "a".repeat(64),
        sourcePath: `Notes/Inbox/Recovery-${index}.md`,
        publicFolderId: null,
        publicFolderVersion: null,
        revisionFolderId: null,
        revisionFolderVersion: null,
        revisionId: null,
        revisionMarker: null,
        createIntent: {
          kind: "public-root",
          state: "recoverable",
          parentFolderId: fixture.ids.published.id,
          folderName: publicId,
          marker,
          publicId,
          operationId,
          folderId,
          folderVersion
        },
        cleanupSlots: 2
      });
    }
    await fixture.manifestStore.compareAndSet((manifest) => ({ ...manifest, operations }));
    if (recoverableFolderId === undefined || recoverablePublicId === undefined) throw new Error("missing fifth recovery target");
    const missingPublicId = missingPublicIdFor(recoverablePublicId);

    await expect(fixture.service.revoke({ publicId: missingPublicId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const afterFirstBoundedPass = (await fixture.manifestStore.read()).value;
    expect(afterFirstBoundedPass.operations).toHaveLength(5);
    expect(await fixture.raw.get(recoverableFolderId)).toMatchObject({ trashed: false });

    await expect(fixture.service.revoke({ publicId: missingPublicId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const afterRotation = (await fixture.manifestStore.read()).value;
    expect(afterRotation.operations).toHaveLength(4);
    expect(afterRotation.operations.map((operation) => operation.publicId)).not.toContain(recoverablePublicId);
    expect(await fixture.raw.get(recoverableFolderId)).toMatchObject({ trashed: true });
    expect(allCleanup(afterRotation)).toEqual([]);
  });

  it("durably owns and cleans both first-publish folders when snapshot creation fails", async () => {
    let failSnapshot = true;
    const fixture = await setup({
      privateStorage: (raw) => delegateStorage(raw, {
        createBytes: async (input, context) => {
          if (failSnapshot && input.appProperties?.nxtPublicationKind === "note") {
            throw new Error("injected first publication failure");
          }
          return raw.createBytes(input, context);
        }
      })
    });

    await expect(publishCurrent(fixture)).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
    const failed = (await fixture.manifestStore.read()).value;
    const queued = allCleanup(failed);
    expect(failed.entries).toEqual([]);
    expect(failed.operations).toEqual([]);
    expect(queued.map((record) => record.kind).sort()).toEqual(["public-root", "revision"]);
    const publicRoot = queued.find((record) => record.kind === "public-root");
    const revision = queued.find((record) => record.kind === "revision");
    expect(publicRoot).toMatchObject({
      parentFolderId: fixture.ids.published.id,
      folderName: publicRoot?.publicId,
      operationId: null
    });
    expect(revision).toMatchObject({
      parentFolderId: publicRoot?.folderId,
      operationId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/u)
    });

    failSnapshot = false;
    await expect(fixture.service.revoke({ publicId: publicRoot?.publicId ?? "" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await fixture.raw.get(revision?.folderId ?? "missing")).trashed).toBe(true);
    expect((await fixture.raw.get(publicRoot?.folderId ?? "missing")).trashed).toBe(true);
    expect(allCleanup((await fixture.manifestStore.read()).value)).toEqual([]);
  });

  it("reserves two cleanup slots before creating a never-published public root", async () => {
    const fixture = await setup();
    await fixture.manifestStore.compareAndSet((manifest) => ({
      ...manifest,
      cleanup: Array.from({ length: 63 }, (_value, index) => unresolvedCleanup(index))
    }));

    await expect(publishCurrent(fixture)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await fixture.privateStorage.listChildren({ parentId: fixture.ids.published.id, pageSize: 100 })).files).toEqual([]);
    const manifest = (await fixture.manifestStore.read()).value;
    expect(manifest.cleanup).toHaveLength(63);
    expect(manifest.operations).toEqual([]);
  });

  it("refuses new snapshot work when every bounded cleanup slot is already reserved", async () => {
    const fixture = await setup();
    const cleanup = Array.from({ length: 64 }, (_, index) => ({
      cleanupId: Buffer.from(Uint8Array.from({ length: 16 }, (_value, offset) => offset === 15 ? index : 0)).toString("base64url"),
      publicId: "Q".repeat(22),
      folderId: `missing-cleanup-${index}`,
      expectedVersion: "1",
      marker: `pm1.${"Q".repeat(22)}.revision`,
      kind: "revision" as const,
      queuedAt: "2026-08-24T11:00:00.000Z"
    }));
    await fixture.manifestStore.compareAndSet((manifest) => ({ ...manifest, cleanup }));

    await expect(publishCurrent(fixture)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await fixture.privateStorage.listChildren({ parentId: fixture.ids.published.id, pageSize: 100 })).files).toEqual([]);
    expect((await fixture.manifestStore.read()).value.cleanup).toHaveLength(64);
  });

  it("keeps the anonymous reader dark until the final manifest commit", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const createdNote = new Promise<void>((resolve) => { entered = resolve; });
    let paused = false;
    const fixture = await setup({
      privateStorage: (raw) => delegateStorage(raw, {
        createBytes: async (input, context) => {
          const created = await raw.createBytes(input, context);
          if (!paused && input.appProperties?.nxtPublicationKind === "note") {
            paused = true;
            entered();
            await gate;
          }
          return created;
        }
      })
    });
    const opened = await fixture.vault.getNote(noteId);
    const publishing = fixture.service.publish({ noteId, expectedVersion: opened.version });
    await createdNote;
    const operation = (await fixture.manifestStore.read()).value.operations[0];
    if (operation === undefined) throw new Error("missing in-flight publication");
    expect(await fixture.reader.getNote(operation.publicId)).toBeNull();
    release();
    await expect(publishing).resolves.toMatchObject({ publicId: operation.publicId });
  });

  it("recovers an accepted final manifest write whose acknowledgement readback was lost", async () => {
    let loseNextRead = false;
    const fixture = await setup({
      privateStorage: (raw, ids) => delegateStorage(raw, {
        updateText: async (input, context) => {
          const updated = await raw.updateText(input, context);
          if (input.fileId === ids.manifestId) {
            const value = JSON.parse(input.text) as { entries?: unknown[]; operations?: unknown[] };
            if (value.entries?.length === 1 && value.operations?.length === 0) loseNextRead = true;
          }
          return updated;
        },
        readText: async (fileId, context) => {
          if (fileId === ids.manifestId && loseNextRead) {
            loseNextRead = false;
            throw new Error("lost accepted manifest readback");
          }
          return raw.readText(fileId, context);
        }
      })
    });
    const result = await publishCurrent(fixture);
    await expect(fixture.reader.getNote(result.publicId)).resolves.toMatchObject({ title: "Share me" });
    expect((await fixture.manifestStore.read()).value.cleanup).toEqual([]);
  });

  it("copies only exact referenced indexed assets and never serves a raw or unallowlisted ID", async () => {
    const fixture = await setup({ source: sourceFor("Assets", `![included](../../_assets/${noteId}/included.png)`) });
    const included = await fixture.attachments.upload({ noteId, name: "included.png", declaredMime: "image/png", bytes: png });
    const unrelated = await fixture.attachments.upload({ noteId, name: "unrelated.png", declaredMime: "image/png", bytes: png });
    const result = await publishCurrent(fixture);
    const note = await fixture.reader.getNote(result.publicId);
    expect(note?.assets).toHaveLength(1);
    expect(note?.assets[0]).toMatchObject({ name: "included.png", disposition: "inline" });
    expect(note?.assets[0]?.url).toBe(`/api/public/assets/${result.publicId}/${note.assets[0]?.assetId}`);
    expect(note?.html).toContain(`src="${note?.assets[0]?.url}"`);
    expect(note?.html).not.toMatch(/_assets|private\/attachments|018f47d2/iu);
    await expect(fixture.reader.getAsset(result.publicId, unrelated.driveId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(fixture.reader.getAsset(result.publicId, included.driveId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(fixture.reader.getAsset(result.publicId, "A".repeat(22))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a preexisting public asset URL that is not part of this snapshot allowlist", async () => {
    const fixture = await setup({ source: sourceFor("Probe", `![probe](/api/public/assets/${"A".repeat(22)}/${"B".repeat(22)})`) });
    await expect(publishCurrent(fixture)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect((await fixture.manifestStore.read()).value.entries).toEqual([]);
  });

  it("publishes legacy WebP bytes only as a fresh verified download", async () => {
    const fixture = await setup({ source: sourceFor("WebP", `![legacy](../../_assets/${noteId}/legacy.webp)`) });
    const uploaded = await fixture.attachments.upload({ noteId, name: "legacy.webp", declaredMime: "image/webp", bytes: webp });
    await fixture.indexStore.compareAndSet((index) => ({
      ...index,
      entries: index.entries.map((entry) => entry.id === noteId
        ? { ...entry, attachments: entry.attachments.map((asset) => asset.driveId === uploaded.driveId ? { ...asset, disposition: "inline" as const } : asset) }
        : entry)
    }));

    const result = await publishCurrent(fixture);
    const note = await fixture.reader.getNote(result.publicId);
    expect(note?.assets[0]?.disposition).toBe("download");
    const delivery = await fixture.reader.getAsset(result.publicId, note?.assets[0]?.assetId ?? "");
    expect(delivery).toMatchObject({ name: "legacy.webp", mimeType: "image/webp", disposition: "download" });
  });

  it("safely downgrades a legacy inline WebP projection while reading a snapshot", async () => {
    const fixture = await setup({ source: sourceFor("WebP", `![legacy](../../_assets/${noteId}/legacy.webp)`) });
    await fixture.attachments.upload({ noteId, name: "legacy.webp", declaredMime: "image/webp", bytes: webp });
    const result = await publishCurrent(fixture);
    const before = (await fixture.manifestStore.read()).value;
    const entry = before.entries[0];
    const revision = entry?.revisions.find((candidate) => candidate.revisionId === entry.activeRevisionId);
    if (entry === undefined || revision === undefined || revision.assets[0] === undefined) throw new Error("missing legacy projection fixture");
    const noteReadback = await fixture.privateStorage.readText(revision.noteSnapshotDriveId);
    const projection = JSON.parse(noteReadback.text) as { assets: Array<{ disposition: "inline" | "download" }> };
    projection.assets[0]!.disposition = "inline";
    const changedNote = `${JSON.stringify(projection, null, 2)}\n`;
    const changed = await fixture.privateStorage.updateText({
      fileId: revision.noteSnapshotDriveId,
      expectedVersion: noteReadback.file.version,
      mimeType: "application/json",
      text: changedNote
    });
    await fixture.manifestStore.compareAndSet((manifest) => ({
      ...manifest,
      entries: manifest.entries.map((candidate) => candidate.publicId !== result.publicId ? candidate : {
        ...candidate,
        revisions: candidate.revisions.map((item) => item.revisionId !== candidate.activeRevisionId ? item : {
          ...item,
          noteVersion: changed.version,
          noteChecksum: createHash("sha256").update(changedNote).digest("hex"),
          noteSize: new TextEncoder().encode(changedNote).byteLength,
          assets: item.assets.map((asset) => ({ ...asset, disposition: "inline" as const }))
        })
      })
    }));

    expect((await fixture.reader.getNote(result.publicId))?.assets[0]?.disposition).toBe("download");
    await expect(fixture.reader.getAsset(result.publicId, revision.assets[0].assetId)).resolves.toMatchObject({ disposition: "download" });
  });

  it("republishes under one stable public ID without mutating the prior revision", async () => {
    const fixture = await setup();
    const first = await publishCurrent(fixture);
    const firstManifest = (await fixture.manifestStore.read()).value;
    const firstRevision = firstManifest.entries[0]?.revisions.find((revision) => revision.revisionId === firstManifest.entries[0]?.activeRevisionId);
    if (firstRevision === undefined) throw new Error("missing first revision");
    const firstBytes = await fixture.privateStorage.readBytes(firstRevision.noteSnapshotDriveId);

    const opened = await fixture.vault.getNote(noteId);
    const updatedSource = sourceFor("Share me again", "# Changed\n");
    const updated = await fixture.vault.updateNote({ noteId, expectedVersion: opened.version, source: updatedSource });
    const second = await fixture.service.publish({ noteId, expectedVersion: updated.version });
    const manifest = (await fixture.manifestStore.read()).value;
    expect(second.publicId).toBe(first.publicId);
    expect(manifest.entries[0]?.revisions).toHaveLength(2);
    expect(manifest.entries[0]?.activeRevisionId).not.toBe(firstRevision.revisionId);
    expect(await fixture.privateStorage.readBytes(firstRevision.noteSnapshotDriveId)).toMatchObject({ checksum: firstBytes.checksum });
    expect((await fixture.reader.getNote(first.publicId))?.title).toBe("Share me again");
  });

  it("queues and recoverably trashes the immutable revision evicted by the thirty-third publish", async () => {
    const fixture = await setup();
    const first = await publishCurrent(fixture);
    const firstManifest = (await fixture.manifestStore.read()).value;
    const firstRevision = firstManifest.entries[0]?.revisions[0];
    if (firstRevision === undefined) throw new Error("missing first bounded-history revision");

    for (let revisionNumber = 2; revisionNumber <= 33; revisionNumber += 1) {
      const opened = await fixture.vault.getNote(noteId);
      const updated = await fixture.vault.updateNote({
        noteId,
        expectedVersion: opened.version,
        source: sourceFor(`Revision ${revisionNumber}`, `# Revision ${revisionNumber}\n`)
      });
      await fixture.service.publish({ noteId, expectedVersion: updated.version });
    }

    const bounded = (await fixture.manifestStore.read()).value;
    expect(bounded.entries[0]?.publicId).toBe(first.publicId);
    expect(bounded.entries[0]?.revisions).toHaveLength(32);
    expect(bounded.entries[0]?.revisions.some((revision) => revision.snapshotFolderId === firstRevision.snapshotFolderId)).toBe(false);
    const eviction = allCleanup(bounded).find((record) => record.folderId === firstRevision.snapshotFolderId);
    expect(eviction).toMatchObject({
      kind: "revision",
      expectedVersion: firstRevision.snapshotFolderVersion,
      marker: firstRevision.snapshotMarker,
      operationId: firstRevision.operationId
    });

    await expect(fixture.service.publish({ noteId, expectedVersion: "not-the-current-version" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await fixture.raw.get(firstRevision.snapshotFolderId)).trashed).toBe(true);
    expect(allCleanup((await fixture.manifestStore.read()).value).some((record) => record.cleanupId === eviction?.cleanupId)).toBe(false);
  }, 180_000);

  it("revokes the manifest first and keeps the URL revoked when conditional Trash is ambiguous", async () => {
    let failTrash = false;
    const fixture = await setup({
      privateStorage: (raw) => delegateStorage(raw, {
        trash: async (input, context) => {
          if (failTrash) {
            await raw.trash(input, context);
            throw new StorageMutationOutcomeUnknownError(input.fileId);
          }
          return raw.trash(input, context);
        }
      })
    });
    const publication = await publishCurrent(fixture);
    const before = (await fixture.manifestStore.read()).value;
    const active = before.entries[0]?.revisions.find((revision) => revision.revisionId === before.entries[0]?.activeRevisionId);
    if (active === undefined) throw new Error("missing accepted ambiguous Trash fixture");
    failTrash = true;
    await expect(fixture.service.revoke({ publicId: publication.publicId })).resolves.toEqual({ revoked: true });
    expect(await fixture.reader.getNote(publication.publicId)).toBeNull();
    const manifest = (await fixture.manifestStore.read()).value;
    expect(manifest.entries).toEqual([]);
    expect(manifest.tombstones[0]?.publicId).toBe(publication.publicId);
    expect(allCleanup(manifest).length).toBeGreaterThan(0);
    expect(await fixture.raw.get(active.snapshotFolderId)).toMatchObject({ trashed: true });

    failTrash = false;
    await fixture.service.revoke({ publicId: publication.publicId });
    expect(allCleanup((await fixture.manifestStore.read()).value)).toEqual([]);
  });

  it("keeps revoke dark and losslessly owns its snapshots when the unresolved cleanup queue is full", async () => {
    let failTrash = false;
    const fixture = await setup({
      privateStorage: (raw) => delegateStorage(raw, {
        trash: async (input, context) => {
          if (failTrash) throw new StorageMutationOutcomeUnknownError(input.fileId);
          return raw.trash(input, context);
        }
      })
    });
    const publication = await publishCurrent(fixture);
    const published = (await fixture.manifestStore.read()).value;
    const active = published.entries[0]?.revisions.find((revision) => revision.revisionId === published.entries[0]?.activeRevisionId);
    if (active === undefined) throw new Error("missing full-queue revoke fixture");
    const unresolved = Array.from({ length: 64 }, (_value, index) => unresolvedCleanup(index));
    await fixture.manifestStore.compareAndSet((manifest) => ({ ...manifest, cleanup: unresolved }));
    failTrash = true;

    await expect(fixture.service.revoke({ publicId: publication.publicId })).resolves.toEqual({ revoked: true });
    expect(await fixture.reader.getNote(publication.publicId)).toBeNull();
    const revoked = (await fixture.manifestStore.read()).value;
    expect(revoked.entries).toEqual([]);
    expect(revoked.cleanup.map((record) => record.cleanupId)).toEqual(unresolved.map((record) => record.cleanupId));
    const owned = allCleanup(revoked).filter((record) => record.folderId === active.snapshotFolderId);
    expect(owned).toHaveLength(1);
    expect(owned[0]).toMatchObject({
      publicId: publication.publicId,
      parentFolderId: revoked.tombstones[0]?.publicFolderId,
      folderName: active.revisionId,
      operationId: active.operationId,
      expectedVersion: active.snapshotFolderVersion
    });

    failTrash = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await fixture.service.revoke({ publicId: publication.publicId });
    }
    const recovered = (await fixture.manifestStore.read()).value;
    expect(await fixture.raw.get(active.snapshotFolderId)).toMatchObject({ trashed: true });
    expect(recovered.cleanup.map((record) => record.cleanupId)).toEqual(unresolved.map((record) => record.cleanupId));
    expect(allCleanup(recovered).some((record) => record.folderId === active.snapshotFolderId)).toBe(false);
  });

  it("makes the public URL dark before a successful snapshot Trash can finish", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const trashStarted = new Promise<void>((resolve) => { entered = resolve; });
    let paused = false;
    const fixture = await setup({
      privateStorage: (raw) => delegateStorage(raw, {
        trash: async (input, context) => {
          const target = await raw.get(input.fileId, context);
          if (!paused && target.appProperties?.nxtPublicationKind === "revision") {
            paused = true;
            entered();
            await gate;
          }
          return raw.trash(input, context);
        }
      })
    });
    const publication = await publishCurrent(fixture);
    const manifest = (await fixture.manifestStore.read()).value;
    const entry = manifest.entries[0];
    const revision = entry?.revisions.find((candidate) => candidate.revisionId === entry.activeRevisionId);
    if (revision === undefined) throw new Error("missing revoke-first fixture");
    const revoking = fixture.service.revoke({ publicId: publication.publicId });
    await trashStarted;
    expect(await fixture.reader.getNote(publication.publicId)).toBeNull();
    expect((await fixture.manifestStore.read()).value.entries).toEqual([]);
    expect(await fixture.raw.get(revision.snapshotFolderId)).toMatchObject({ trashed: false });
    release();
    await expect(revoking).resolves.toEqual({ revoked: true });
    expect(await fixture.raw.get(revision.snapshotFolderId)).toMatchObject({ trashed: true });
  });

  it("never trashes a cleanup target whose exact queued version changed", async () => {
    let failTrash = true;
    const fixture = await setup({
      privateStorage: (raw) => delegateStorage(raw, {
        trash: async (input, context) => {
          if (failTrash) throw new StorageMutationOutcomeUnknownError(input.fileId);
          return raw.trash(input, context);
        }
      })
    });
    const publication = await publishCurrent(fixture);
    await fixture.service.revoke({ publicId: publication.publicId });
    const queued = allCleanup((await fixture.manifestStore.read()).value)[0];
    if (queued === undefined) throw new Error("missing cleanup fence");
    const folder = await fixture.raw.get(queued.folderId);
    const changed = await fixture.raw.move({
      fileId: folder.id,
      fromParentId: folder.parentIds[0]!,
      toParentId: folder.parentIds[0]!,
      newName: `${folder.name}-changed`,
      expectedVersion: folder.version
    });
    failTrash = false;

    await fixture.service.revoke({ publicId: publication.publicId });
    expect(await fixture.raw.get(changed.id)).toMatchObject({ trashed: false, version: changed.version });
    expect(allCleanup((await fixture.manifestStore.read()).value)).toContainEqual(expect.objectContaining({ cleanupId: queued.cleanupId }));
  });

  it("never trashes a copied-marker folder from the wrong ancestry", async () => {
    let failTrash = true;
    const fixture = await setup({
      privateStorage: (raw) => delegateStorage(raw, {
        trash: async (input, context) => {
          if (failTrash) throw new StorageMutationOutcomeUnknownError(input.fileId);
          return raw.trash(input, context);
        }
      })
    });
    const publication = await publishCurrent(fixture);
    await fixture.service.revoke({ publicId: publication.publicId });
    const queued = allCleanup((await fixture.manifestStore.read()).value)[0];
    if (queued === undefined) throw new Error("missing copied-marker cleanup fixture");
    const original = await fixture.raw.get(queued.folderId);
    const holding = await fixture.raw.createFolder({ parentId: "private", name: "copied-marker-holding" });
    const copied = await fixture.raw.createFolder({
      parentId: holding.id,
      name: original.name,
      appProperties: { ...original.appProperties }
    });
    await rewriteCleanup(fixture, queued.cleanupId, (record) => ({
      ...record,
      folderId: copied.id,
      expectedVersion: copied.version
    }));
    failTrash = false;

    await fixture.service.revoke({ publicId: publication.publicId });
    expect(await fixture.raw.get(copied.id)).toMatchObject({ trashed: false });
    expect(allCleanup((await fixture.manifestStore.read()).value)).toContainEqual(expect.objectContaining({ cleanupId: queued.cleanupId }));
  });

  it.each([
    ["ordinary file", "text/plain"],
    ["shortcut", "application/vnd.google-apps.shortcut"]
  ])("never trashes a copied-marker %s in place of the owned folder", async (_label, mimeType) => {
    let failTrash = true;
    const fixture = await setup({
      privateStorage: (raw) => delegateStorage(raw, {
        trash: async (input, context) => {
          if (failTrash) throw new StorageMutationOutcomeUnknownError(input.fileId);
          return raw.trash(input, context);
        }
      })
    });
    const publication = await publishCurrent(fixture);
    await fixture.service.revoke({ publicId: publication.publicId });
    const queued = allCleanup((await fixture.manifestStore.read()).value)[0];
    if (queued === undefined) throw new Error("missing wrong-type cleanup fixture");
    const original = await fixture.raw.get(queued.folderId);
    const copied = await fixture.raw.createBytes({
      parentId: original.parentIds[0] as string,
      name: original.name,
      mimeType,
      bytes: Uint8Array.of(1),
      appProperties: { ...original.appProperties }
    });
    await rewriteCleanup(fixture, queued.cleanupId, (record) => ({
      ...record,
      folderId: copied.id,
      expectedVersion: copied.version
    }));
    failTrash = false;

    await fixture.service.revoke({ publicId: publication.publicId });
    expect(await fixture.raw.get(copied.id)).toMatchObject({ trashed: false });
    expect(allCleanup((await fixture.manifestStore.read()).value)).toContainEqual(expect.objectContaining({ cleanupId: queued.cleanupId }));
  });

  it("never trashes an owned marker after its exact queued name changed", async () => {
    let failTrash = true;
    const fixture = await setup({
      privateStorage: (raw) => delegateStorage(raw, {
        trash: async (input, context) => {
          if (failTrash) throw new StorageMutationOutcomeUnknownError(input.fileId);
          return raw.trash(input, context);
        }
      })
    });
    const publication = await publishCurrent(fixture);
    await fixture.service.revoke({ publicId: publication.publicId });
    const queued = allCleanup((await fixture.manifestStore.read()).value)[0];
    if (queued === undefined) throw new Error("missing changed-name cleanup fixture");
    const original = await fixture.raw.get(queued.folderId);
    const changed = await fixture.raw.move({
      fileId: original.id,
      fromParentId: original.parentIds[0] as string,
      toParentId: original.parentIds[0] as string,
      newName: `${original.name}-changed`,
      expectedVersion: original.version
    });
    await rewriteCleanup(fixture, queued.cleanupId, (record) => ({ ...record, expectedVersion: changed.version }));
    failTrash = false;

    await fixture.service.revoke({ publicId: publication.publicId });
    expect(await fixture.raw.get(changed.id)).toMatchObject({ trashed: false, name: changed.name });
    expect(allCleanup((await fixture.manifestStore.read()).value)).toContainEqual(expect.objectContaining({ cleanupId: queued.cleanupId }));
  });

  it("keeps cleanup durable when the exact post-Trash readback is missing", async () => {
    let failTrash = true;
    const readbackFailure: { targetId?: string } = {};
    const fixture = await setup({
      privateStorage: (raw) => delegateStorage(raw, {
        get: async (fileId, context) => {
          const file = await raw.get(fileId, context);
          if (fileId === readbackFailure.targetId && file.trashed && context?.allowTrashed === true) {
            throw new Error("injected missing post-Trash readback");
          }
          return file;
        },
        trash: async (input, context) => {
          if (failTrash) throw new StorageMutationOutcomeUnknownError(input.fileId);
          return raw.trash(input, context);
        }
      })
    });
    const publication = await publishCurrent(fixture);
    await fixture.service.revoke({ publicId: publication.publicId });
    const queued = allCleanup((await fixture.manifestStore.read()).value)[0];
    if (queued === undefined) throw new Error("missing post-Trash cleanup fixture");
    readbackFailure.targetId = queued.folderId;
    failTrash = false;

    await fixture.service.revoke({ publicId: publication.publicId });
    expect(await fixture.raw.get(queued.folderId)).toMatchObject({ trashed: true });
    expect(allCleanup((await fixture.manifestStore.read()).value)).toContainEqual(expect.objectContaining({ cleanupId: queued.cleanupId }));
  });

  it("never trashes cleanup through a published root moved away from the verified private boundary", async () => {
    let failTrash = true;
    const fixture = await setup({
      privateStorage: (raw) => delegateStorage(raw, {
        trash: async (input, context) => {
          if (failTrash) throw new StorageMutationOutcomeUnknownError(input.fileId);
          return raw.trash(input, context);
        }
      })
    });
    const publication = await publishCurrent(fixture);
    await fixture.service.revoke({ publicId: publication.publicId });
    const queued = allCleanup((await fixture.manifestStore.read()).value)[0];
    if (queued === undefined) throw new Error("missing moved-root cleanup fixture");
    const holding = await fixture.raw.createFolder({ parentId: "private", name: "moved-published-holding" });
    const published = await fixture.raw.get(fixture.ids.published.id);
    await fixture.raw.move({
      fileId: published.id,
      fromParentId: "private",
      toParentId: holding.id,
      expectedVersion: published.version
    });
    failTrash = false;

    await fixture.service.revoke({ publicId: publication.publicId });
    expect(await fixture.raw.get(queued.folderId)).toMatchObject({ trashed: false });
    expect(allCleanup((await fixture.manifestStore.read()).value)).toContainEqual(expect.objectContaining({ cleanupId: queued.cleanupId }));
  });

  it("fails public reads closed for corrupt manifests and wrong snapshot ancestry", async () => {
    const fixture = await setup();
    const publication = await publishCurrent(fixture);
    const manifest = (await fixture.manifestStore.read()).value;
    const revision = manifest.entries[0]?.revisions.find((candidate) => candidate.revisionId === manifest.entries[0]?.activeRevisionId);
    if (revision === undefined) throw new Error("missing active revision");
    const holding = await fixture.raw.createFolder({ parentId: "private", name: "holding" });
    const folder = await fixture.raw.get(revision.snapshotFolderId);
    await fixture.raw.move({ fileId: folder.id, fromParentId: folder.parentIds[0]!, toParentId: holding.id, expectedVersion: folder.version });
    expect(await fixture.reader.getNote(publication.publicId)).toBeNull();

    const manifestFile = await fixture.raw.get(fixture.ids.manifestFile.id);
    await fixture.raw.updateText({ fileId: manifestFile.id, expectedVersion: manifestFile.version, mimeType: "application/json", text: "{broken" });
    expect(await fixture.reader.getNote(publication.publicId)).toBeNull();
    await expect(fixture.reader.getAsset(publication.publicId, "A".repeat(22))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("recovers a marker-owned ambiguous folder create without adopting lookalikes", async () => {
    let inject = true;
    const fixture = await setup({
      privateStorage: (raw) => delegateStorage(raw, {
        createFolder: async (input, context) => {
          const created = await raw.createFolder(input, context);
          if (inject && input.appProperties?.nxtPublicationKind === "revision") {
            inject = false;
            throw new StorageMutationOutcomeUnknownError(created.id);
          }
          return created;
        }
      })
    });
    await expect(publishCurrent(fixture)).resolves.toMatchObject({ publicId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/u) });
  });

  it("fences and recovers a stale persisted operation after a restart", async () => {
    const fixture = await setup();
    const source = await fixture.vault.getNote(noteId);
    const publicId = "R".repeat(22);
    const oldOperationId = "S".repeat(22);
    const publicMarker = `pm1.${publicId}.public`;
    const revisionMarker = `pm1.${oldOperationId}.revision`;
    const publicFolder = await fixture.raw.createFolder({
      parentId: fixture.ids.published.id,
      name: publicId,
      appProperties: {
        nxtPublicationMarker: publicMarker,
        nxtPublicationKind: "public",
        nxtPublicationPublicId: publicId
      }
    });
    const staleRevision = await fixture.raw.createFolder({
      parentId: publicFolder.id,
      name: "v-stale",
      appProperties: {
        nxtPublicationMarker: revisionMarker,
        nxtPublicationKind: "revision",
        nxtPublicationPublicId: publicId,
        nxtPublicationOperation: oldOperationId
      }
    });
    await fixture.manifestStore.compareAndSet((manifest) => ({
      ...manifest,
      cleanup: Array.from({ length: 62 }, (_value, index) => unresolvedCleanup(index)),
      operations: [{
        operationId: oldOperationId,
        publicId,
        sourceNoteId: noteId,
        epoch: 1,
        startedAt: "2026-08-24T11:00:00.000Z",
        sourceVersion: source.version,
        sourceChecksum: source.checksum,
        sourcePath: source.path,
        publicFolderId: publicFolder.id,
        publicFolderVersion: publicFolder.version,
        revisionFolderId: staleRevision.id,
        revisionFolderVersion: staleRevision.version,
        revisionId: staleRevision.name,
        revisionMarker,
        createIntent: null,
        cleanupSlots: 2
      }]
    }));

    const result = await fixture.service.publish({ noteId, expectedVersion: source.version });
    expect(result.publicId).toBe(publicId);
    const manifest = (await fixture.manifestStore.read()).value;
    expect(manifest.operations).toEqual([]);
    expect(manifest.entries[0]?.publicId).toBe(publicId);
    expect(manifest.cleanup).toHaveLength(63);
    expect(manifest.cleanup.slice(0, 62).map((record) => record.cleanupId)).toEqual(
      Array.from({ length: 62 }, (_value, index) => unresolvedCleanup(index).cleanupId)
    );
    expect(manifest.cleanup).toContainEqual(expect.objectContaining({ folderId: staleRevision.id, marker: revisionMarker }));
    expect(await fixture.reader.getNote(publicId)).toMatchObject({ title: "Share me" });
  });

  it("allows only one concurrent publish operation for the same source epoch", async () => {
    const fixture = await setup();
    const opened = await fixture.vault.getNote(noteId);
    const results = await Promise.allSettled([
      fixture.service.publish({ noteId, expectedVersion: opened.version }),
      fixture.service.publish({ noteId, expectedVersion: opened.version })
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await fixture.manifestStore.read()).value.entries).toHaveLength(1);
  });

  it("fences a publish that began source resolution before an accepted revoke", async () => {
    const fixture = await setup();
    const first = await publishCurrent(fixture);
    const opened = await fixture.vault.getNote(noteId);
    const updated = await fixture.vault.updateNote({
      noteId,
      expectedVersion: opened.version,
      source: sourceFor("Pre-reservation race", "# Must stay revoked\n")
    });
    let release!: () => void;
    let signal!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { signal = resolve; });
    let paused = false;
    const delayedVault = {
      getNote: async (requestedNoteId: string) => {
        if (!paused) {
          paused = true;
          signal();
          await gate;
        }
        return fixture.vault.getNote(requestedNoteId);
      }
    };
    const publishing = new PublicationService({
      storage: fixture.privateStorage,
      manifestStore: fixture.manifestStore,
      indexStore: fixture.indexStore,
      vault: delayedVault,
      attachments: fixture.attachments,
      privateRootId: "private",
      publishedRootId: fixture.ids.published.id,
      now: () => new Date("2026-08-24T12:01:00.000Z")
    });

    const racingPublish = publishing.publish({ noteId, expectedVersion: updated.version });
    await entered;
    await fixture.service.revoke({ publicId: first.publicId });
    release();

    await expect(racingPublish).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await fixture.reader.getNote(first.publicId)).toBeNull();
    const manifest = (await fixture.manifestStore.read()).value;
    expect(manifest.entries).toEqual([]);
    expect(manifest.tombstones).toContainEqual(expect.objectContaining({ publicId: first.publicId }));
  });

  it("allows a publish explicitly begun after a completed revoke to reuse the stable public ID", async () => {
    const fixture = await setup();
    const first = await publishCurrent(fixture);
    await fixture.service.revoke({ publicId: first.publicId });
    expect(await fixture.reader.getNote(first.publicId)).toBeNull();

    const opened = await fixture.vault.getNote(noteId);
    const republished = await fixture.service.publish({ noteId, expectedVersion: opened.version });
    expect(republished.publicId).toBe(first.publicId);
    expect(await fixture.reader.getNote(first.publicId)).toMatchObject({ title: "Share me" });
    const manifest = (await fixture.manifestStore.read()).value;
    expect(manifest.entries[0]).toMatchObject({ publicId: first.publicId, epoch: 3 });
    expect(manifest.tombstones).toEqual([]);
  });

  it("lets an accepted revoke fence an older in-flight republish", async () => {
    const fixture = await setup({ source: sourceFor("Race", `![race](../../_assets/${noteId}/race.png)`) });
    await fixture.attachments.upload({ noteId, name: "race.png", declaredMime: "image/png", bytes: png });
    const first = await publishCurrent(fixture);
    const opened = await fixture.vault.getNote(noteId);
    const updated = await fixture.vault.updateNote({ noteId, expectedVersion: opened.version, source: sourceFor("Race changed", `![race](../../_assets/${noteId}/race.png)`) });
    let release!: () => void;
    let signal!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { signal = resolve; });
    let paused = false;
    const delayedAttachments = {
      readForNote: async (input: { noteId: string; assetId: string }) => {
        if (!paused) { paused = true; signal(); await gate; }
        return fixture.attachments.readForNote(input);
      }
    };
    const publishing = new PublicationService({
      storage: fixture.privateStorage,
      manifestStore: fixture.manifestStore,
      indexStore: fixture.indexStore,
      vault: fixture.vault,
      attachments: delayedAttachments,
      privateRootId: "private",
      publishedRootId: fixture.ids.published.id,
      now: () => new Date("2026-08-24T12:01:00.000Z")
    });
    const republish = publishing.publish({ noteId, expectedVersion: updated.version });
    await entered;
    await fixture.service.revoke({ publicId: first.publicId });
    release();
    await expect(republish).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await fixture.reader.getNote(first.publicId)).toBeNull();
  });

  it("uses exact checksums for every copied immutable byte sequence", async () => {
    const fixture = await setup();
    await publishCurrent(fixture);
    const manifest = (await fixture.manifestStore.read()).value;
    const entry = manifest.entries[0];
    const revision = entry?.revisions.find((candidate) => candidate.revisionId === entry.activeRevisionId);
    if (revision === undefined) throw new Error("missing checksum revision");
    const readback = await fixture.privateStorage.readBytes(revision.noteSnapshotDriveId);
    expect(readback.checksum).toBe(createHash("sha256").update(readback.bytes).digest("hex"));
    expect(readback.checksum).toBe(revision.noteChecksum);
  });
});
