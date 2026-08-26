import { describe, expect, it, vi } from "vitest";
import type { VaultResponse } from "@nxt/contracts";
import {
  IncompleteVaultError,
  assembleVaultPages,
  attachmentResolverForNote,
  exactFolderForNote
} from "../api/vault";

const NOTE_ID = "018f47d2-6a34-7b2a-9f21-8a7034963aef";
const OTHER_NOTE_ID = "028f47d2-6a34-7b2a-9f21-8a7034963aef";
const FOLDER_ID = "v1.abcdefghijklmnop.folder_1.abcdefghijklmnopqrstuv";
const ASSET_ID = "v1.abcdefghijklmnop.asset_1.abcdefghijklmnopqrstuv";
const CURSOR = "v1.abcdefghijklmnop.cursor_1.abcdefghijklmnopqrstuv";

const entry = (relations: Partial<VaultResponse["entries"][number]> = {}): VaultResponse["entries"][number] => ({
  id: NOTE_ID,
  title: "Yıllık Plan",
  aliases: ["Plan"],
  path: "Notes/Plans/Yıllık Plan.md",
  created: "2026-08-23T09:00:00.000Z",
  updated: "2026-08-23T09:03:00.000Z",
  driveVersion: "7",
  tags: ["plan"],
  searchText: "yıllık hedefler",
  excerpt: "hedefler",
  outboundNoteIds: [],
  unresolvedWikiTargets: [],
  attachments: [],
  backlinks: [],
  ...relations
});

const page = (overrides: Partial<VaultResponse> = {}): VaultResponse => ({
  entries: [],
  preferences: { schemaVersion: 1, favorites: [], recent: [], theme: "dark" },
  folders: [],
  treeVersion: "a".repeat(64),
  cursor: null,
  complete: true,
  ...overrides
});

describe("complete authenticated vault assembly", () => {
  it("merges repeated relation pages exactly once and preserves paged preferences", async () => {
    const readPage = vi.fn((cursor: string | null) => Promise.resolve(cursor === null
      ? page({
        entries: [entry({ outboundNoteIds: [OTHER_NOTE_ID] })],
        preferences: { schemaVersion: 1, favorites: [NOTE_ID], recent: [], theme: "dark" },
        folders: [{ id: FOLDER_ID, name: "Plans", path: "Notes/Plans", version: "3", protected: false }],
        cursor: CURSOR,
        complete: false
      })
      : page({
        entries: [entry({
          outboundNoteIds: [OTHER_NOTE_ID],
          attachments: [{ assetId: ASSET_ID, name: "diagram.png", mimeType: "image/png", size: 42 }]
        })],
        preferences: { schemaVersion: 1, favorites: [NOTE_ID], recent: [NOTE_ID], theme: "dark" },
        folders: [{ id: FOLDER_ID, name: "Plans", path: "Notes/Plans", version: "3", protected: false }]
      })));

    const vault = await assembleVaultPages(readPage);

    expect(readPage).toHaveBeenNthCalledWith(1, null);
    expect(readPage).toHaveBeenNthCalledWith(2, CURSOR);
    expect(vault.entries[0]?.outboundNoteIds).toEqual([OTHER_NOTE_ID]);
    expect(vault.entries[0]?.attachments).toEqual([
      { assetId: ASSET_ID, name: "diagram.png", mimeType: "image/png", size: 42 }
    ]);
    expect(vault.preferences.favorites).toEqual([NOTE_ID]);
    expect(vault.preferences.recent).toEqual([NOTE_ID]);
  });

  it("fails closed when a later page changes a scalar or tree version", async () => {
    await expect(assembleVaultPages((cursor) => Promise.resolve(cursor === null
      ? page({ entries: [entry()], cursor: CURSOR, complete: false })
      : page({ entries: [entry({ title: "Changed" })] })))).rejects.toBeInstanceOf(IncompleteVaultError);

    await expect(assembleVaultPages((cursor) => Promise.resolve(cursor === null
      ? page({ cursor: CURSOR, complete: false })
      : page({ treeVersion: "b".repeat(64) })))).rejects.toBeInstanceOf(IncompleteVaultError);
  });

  it("fails closed on a cursor loop or contradictory terminal state", async () => {
    await expect(assembleVaultPages(() => Promise.resolve(page({ cursor: CURSOR, complete: false }))))
      .rejects.toBeInstanceOf(IncompleteVaultError);
    await expect(assembleVaultPages(() => Promise.resolve(page({ cursor: CURSOR, complete: true }))))
      .rejects.toBeInstanceOf(IncompleteVaultError);
  });
});

describe("selected note projection", () => {
  it("derives the exact opaque parent and only resolves canonical attachment references", () => {
    const note = entry({
      attachments: [{ assetId: ASSET_ID, name: "diagram.png", mimeType: "image/png", size: 42 }]
    });
    const folder = { id: FOLDER_ID, name: "Plans", path: "Notes/Plans", version: "3", protected: false } as const;

    expect(exactFolderForNote(note, [folder])).toEqual(folder);
    const resolve = attachmentResolverForNote(note);
    expect(resolve(`_assets/${NOTE_ID}/diagram.png`)).toBe(ASSET_ID);
    expect(resolve(`_assets/${NOTE_ID}/../diagram.png`)).toBeUndefined();
    expect(resolve("https://attacker.example/diagram.png")).toBeUndefined();
  });
});
