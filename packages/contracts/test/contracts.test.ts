import { describe, expect, it } from "vitest";
import {
  ApiErrorSchema,
  NoteDocumentSchema,
  NoteFrontmatterSchema,
  PreferencesSchema,
  PublicationManifestSchema,
  VaultIndexSchema
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
          snapshotDriveId: "snapshot-drive-id",
          sourceNoteId: entry.id,
          publishedAt: "2026-08-23T12:00:00.000Z",
          revision: "1",
          assets: [
            {
              assetId: "b".repeat(22),
              snapshotDriveId: "asset-drive-id",
              mimeType: "image/webp",
              fileName: "plan.webp"
            }
          ]
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
