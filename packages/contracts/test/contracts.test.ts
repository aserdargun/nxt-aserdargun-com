import { describe, expect, it } from "vitest";
import {
  ApiErrorSchema,
  ConfirmationTokenSchema,
  CreateFolderRequestSchema,
  FolderResponseSchema,
  NoteDocumentSchema,
  NoteFrontmatterSchema,
  NoteResponseSchema,
  PreferencesSchema,
  PreferencesResponseSchema,
  PublicationManifestSchema,
  RescanVaultResponseSchema,
  UpdateFolderRequestSchema,
  UpdateNoteRequestSchema,
  VaultResponseSchema,
  VaultIndexSchema,
  VaultPendingMutationSchema
} from "../src/index.js";

describe("NoteFrontmatterSchema", () => {
  it("accepts a portable note and rejects publication state", () => {
    const result = NoteFrontmatterSchema.parse({
      id: "018f47d2-6a34-7b2a-9f21-8a7034963aef",
      title: "2026 Planı",
      created: "2026-08-23T12:00:00.000Z",
      updated: "2026-08-23T12:00:00.000Z",
      tags: ["plan", "2026"],
      aliases: ["Yıllık Plan"]
    });

    expect(result.title).toBe("2026 Planı");
    expect(() => NoteFrontmatterSchema.parse({ ...result, visibility: "public" })).toThrow();
  });

  it("accepts canonical UTC timestamps and rejects non-UTC offsets", () => {
    const note = {
      id: "018f47d2-6a34-7b2a-9f21-8a7034963aef",
      title: "UTC Plan",
      created: "2026-08-23T12:00:00.000Z",
      updated: "2026-08-23T12:00:00.000Z",
      tags: [],
      aliases: []
    };

    expect(NoteFrontmatterSchema.parse(note).created).toBe("2026-08-23T12:00:00.000Z");
    expect(() =>
      NoteFrontmatterSchema.parse({ ...note, updated: "2026-08-23T15:00:00.000+03:00" })
    ).toThrow();
  });
});

it("normalizes note lists and rejects duplicate folded values", () => {
  const note = NoteFrontmatterSchema.parse({
    id: "018f47d2-6a34-7b2a-9f21-8a7034963aef",
    title: "  Plan  ",
    created: "2026-08-23T12:00:00.000Z",
    updated: "2026-08-23T12:00:00.000Z",
    tags: [" plan "],
    aliases: [" Yıllık Plan "]
  });

  expect(note).toMatchObject({ title: "Plan", tags: ["plan"], aliases: ["Yıllık Plan"] });
  expect(() =>
    NoteFrontmatterSchema.parse({ ...note, tags: ["Plan", "plan"], aliases: ["Yıllık Plan"] })
  ).toThrow("tags must be unique");
  expect(() => NoteDocumentSchema.parse({ frontmatter: note, body: "# Plan", extra: true })).toThrow();
});

it("requires 128-bit public identifiers and schema versions", () => {
  expect(() =>
    PublicationManifestSchema.parse({ schemaVersion: 1, entries: [{ publicId: "short" }] })
  ).toThrow();
  expect(PreferencesSchema.parse({ schemaVersion: 1, favorites: [], recent: [], theme: "dark" }).theme).toBe(
    "dark"
  );
});

it("strictly validates versioned private index, preferences, and publication state", () => {
  const entry = {
    id: "018f47d2-6a34-7b2a-9f21-8a7034963aef",
    title: "Plan",
    aliases: [],
    driveId: "note-drive-id",
    path: "Notes/Plans/Plan.md",
    created: "2026-08-23T12:00:00.000Z",
    updated: "2026-08-23T12:00:00.000Z",
    driveVersion: "4",
    tags: ["plan"],
    searchText: "plan",
    excerpt: "Plan",
    outboundNoteIds: [],
    unresolvedWikiTargets: [],
    attachments: [],
    backlinks: []
  };
  expect(VaultIndexSchema.parse({ schemaVersion: 1, entries: [entry] }).entries).toHaveLength(1);
  expect(() => VaultIndexSchema.parse({ schemaVersion: 2, entries: [entry] })).toThrow();
  expect(() => PreferencesSchema.parse({ schemaVersion: 1, favorites: [], recent: [], theme: "dark", token: "no" })).toThrow();

  expect(
    PublicationManifestSchema.parse({
      schemaVersion: 1,
      entries: [
        {
          publicId: "a".repeat(22),
          sourceNoteId: entry.id,
          epoch: 1,
          publicFolderId: "public-folder-id",
          publicFolderVersion: "1",
          activeRevisionId: "v-source",
          revisions: [{
            revisionId: "v-source",
            operationId: "c".repeat(22),
            snapshotFolderId: "snapshot-folder-id",
            snapshotFolderVersion: "1",
            snapshotMarker: `pm1.${"c".repeat(22)}.revision`,
            assetsFolderId: "assets-folder-id",
            assetsFolderVersion: "1",
            assetsMarker: `pm1.${"c".repeat(22)}.assets`,
            noteSnapshotDriveId: "snapshot-drive-id",
            noteVersion: "1",
            noteChecksum: "d".repeat(64),
            noteSize: 1,
            noteMarker: `pm1.${"c".repeat(22)}.note`,
            sourceVersion: "4",
            sourceChecksum: "e".repeat(64),
            sourcePath: entry.path,
            publishedAt: "2026-08-23T12:00:00.000Z",
            assets: [{
              assetId: "b".repeat(22),
              snapshotDriveId: "asset-drive-id",
              mimeType: "image/webp",
              fileName: "plan.webp",
              size: 1,
              checksum: "f".repeat(64),
              disposition: "download",
              marker: `pm1.${"c".repeat(22)}.${"b".repeat(22)}`,
              version: "1"
            }]
          }]
        }
      ]
    }).entries[0]?.publicId
  ).toBe("a".repeat(22));
});

it("exposes redacted typed API errors", () => {
  expect(
    ApiErrorSchema.parse({
      error: { code: "CONFLICT", message: "The note changed.", requestId: "req-123" }
    }).error.code
  ).toBe("CONFLICT");
  expect(() => ApiErrorSchema.parse({ error: { code: "TOKEN", message: "bad", requestId: "req-123" } })).toThrow();
});

it("defines strict Drive-ID-free private response contracts", () => {
  const safeEntry = {
    id: "018f47d2-6a34-7b2a-9f21-8a7034963aef",
    title: "Plan",
    aliases: [],
    path: "Notes/Plan.md",
    created: "2026-08-23T12:00:00.000Z",
    updated: "2026-08-23T12:00:00.000Z",
    driveVersion: "4",
    tags: [],
    searchText: "plan",
    excerpt: "",
    outboundNoteIds: [],
    unresolvedWikiTargets: [],
    attachments: [{
      assetId: `v1.${"d".repeat(16)}.${"e".repeat(8)}.${"f".repeat(22)}`,
      name: "x.png",
      mimeType: "image/png",
      size: 1
    }],
    backlinks: []
  };
  const preferences = { schemaVersion: 1 as const, favorites: [], recent: [], theme: "system" as const };
  const confirmation = {
    descendantCount: 1,
    treeVersion: "a".repeat(64),
    expiresAt: "2026-08-23T12:05:00.000Z",
    confirmationToken: `c1.${"a".repeat(120)}.${"b".repeat(43)}`
  };
  const folder = {
    id: `v1.${"a".repeat(16)}.${"b".repeat(8)}.${"c".repeat(22)}`,
    name: "Project",
    path: "Notes/Project",
    version: "2",
    protected: false,
    deleteConfirmation: confirmation
  };
  expect(VaultResponseSchema.parse({
    entries: [safeEntry],
    preferences,
    folders: [folder],
    treeVersion: "a".repeat(64),
    cursor: null,
    complete: true
  }).folders[0]?.deleteConfirmation).toEqual(confirmation);
  expect(FolderResponseSchema.parse(folder).id).toBe(folder.id);
  expect(PreferencesResponseSchema.parse(preferences)).toEqual(preferences);
  expect(RescanVaultResponseSchema.parse({
    cursor: null,
    processed: 1,
    complete: true,
    records: [{ noteId: safeEntry.id, title: "Plan", path: "Notes/Plan.md", version: "4" }],
    recoveries: [{
      path: "Notes/Externally-Changed.md",
      rawSource: "",
      error: "External change detected. Rescan is reconciling the index."
    }]
  }).recoveries).toHaveLength(1);
  expect(NoteResponseSchema.parse({
    note: {
      frontmatter: {
        id: safeEntry.id,
        title: "Plan",
        created: safeEntry.created,
        updated: safeEntry.updated,
        tags: [],
        aliases: []
      },
      body: "# Plan\n"
    },
    source: "# Plan\n",
    version: "4",
    path: "Notes/Plan.md",
    checksum: "a".repeat(64)
  }).path).toBe("Notes/Plan.md");
  expect(() => VaultResponseSchema.parse({ entries: [{ ...safeEntry, driveId: "raw" }], preferences, folders: [], treeVersion: "a".repeat(64), cursor: null, complete: true })).toThrow();
  expect(() => VaultResponseSchema.parse({
    entries: [{ ...safeEntry, attachments: [{ name: "x.png", mimeType: "image/png", size: 1, assetId: "raw-drive-id" }] }],
    preferences,
    folders: [],
    treeVersion: "a".repeat(64),
    cursor: null,
    complete: true
  })).toThrow();
  expect(() => NoteResponseSchema.parse({ note: {}, driveId: "raw", version: "1", path: "Notes/x.md" })).toThrow();
  expect(() => RescanVaultResponseSchema.parse({
    cursor: null,
    processed: 100,
    complete: false,
    records: Array.from({ length: 100 }, () => ({ noteId: safeEntry.id, title: "Plan", path: "Notes/Plan.md", version: "4" })),
    recoveries: Array.from({ length: 100 }, () => ({ path: "Notes/Changed.md", rawSource: "", error: "External change detected. Rescan is reconciling the index." }))
  })).toThrow("rescan response exceeds 100 items");
});

it("bounds note source bytes and validates safe folder mutation and confirmation tokens", () => {
  expect(() => UpdateNoteRequestSchema.parse({ expectedVersion: "1", source: "x".repeat(300_000) })).toThrow();
  expect(UpdateFolderRequestSchema.parse({
    expectedVersion: "1",
    name: "Renamed",
    parentId: `v1.${"a".repeat(16)}.${"b".repeat(8)}.${"c".repeat(22)}`
  })).toMatchObject({ name: "Renamed" });
  expect(() => UpdateFolderRequestSchema.parse({ expectedVersion: "1" })).toThrow();
  expect(ConfirmationTokenSchema.parse(`c1.${"a".repeat(120)}.${"b".repeat(43)}`)).toContain("c1.");
  expect(() => ConfirmationTokenSchema.parse("raw-folder-id.secret")).toThrow();
});

it("keeps folder pending names at 255 and attachment pending names at 180 code points", () => {
  const base = {
    id: "00000000-0000-4000-8000-000000000001",
    ownerId: "00000000-0000-4000-8000-000000000002",
    operation: "create-folder" as const,
    phase: "reserved" as const,
    fence: 1,
    createdAt: "2026-08-24T00:00:00.000Z",
    expiresAt: "2026-08-24T00:15:00.000Z"
  };
  expect(VaultPendingMutationSchema.safeParse({ ...base, targetName: "f".repeat(255) }).success).toBe(true);
  expect(VaultPendingMutationSchema.safeParse({ ...base, targetName: "f".repeat(256) }).success).toBe(false);
  expect(VaultPendingMutationSchema.safeParse({ ...base, operation: "create-attachment", targetName: "a".repeat(181) }).success).toBe(false);
});

it("bounds the private per-claim attachment recovery identity", () => {
  const mutation = {
    id: "00000000-0000-4000-8000-000000000001",
    ownerId: "00000000-0000-4000-8000-000000000002",
    operation: "create-attachment" as const,
    phase: "outcome-unknown" as const,
    fence: 3,
    createdAt: "2026-08-24T00:00:00.000Z",
    expiresAt: "2026-08-24T00:15:00.000Z",
    recoveryClaimId: `rc1.${"a".repeat(22)}`
  };
  expect(VaultPendingMutationSchema.safeParse(mutation).success).toBe(true);
  expect(VaultPendingMutationSchema.safeParse({ ...mutation, recoveryClaimId: `rc1.${"a".repeat(23)}` }).success).toBe(false);
  expect(VaultPendingMutationSchema.safeParse({ ...mutation, recoveryClaimId: "raw-owner-token" }).success).toBe(false);
});

it("uses NFC Unicode code points, not UTF-16 units, for every folder name boundary", () => {
  const name = "🙂".repeat(255);
  expect(CreateFolderRequestSchema.safeParse({ parentId: `v1.${"a".repeat(16)}.${"b".repeat(8)}.${"c".repeat(22)}`, name }).success).toBe(true);
  expect(UpdateFolderRequestSchema.safeParse({ expectedVersion: "1", name }).success).toBe(true);
  expect(CreateFolderRequestSchema.safeParse({ parentId: `v1.${"a".repeat(16)}.${"b".repeat(8)}.${"c".repeat(22)}`, name: "🙂".repeat(256) }).success).toBe(false);
});
