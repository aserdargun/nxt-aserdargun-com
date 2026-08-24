import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreferencesSchema, VaultIndexSchema, type VaultIndex } from "@nxt/contracts";
import { describe, expect, it } from "vitest";
import { PreferencesService } from "../src/services/preferences-service.js";
import { SystemFileStore } from "../src/services/system-file-store.js";
import { LocalDriveAdapter } from "../src/storage/local-drive-adapter.js";

const existing = "018f47d2-6a34-7b2a-9f21-8a7034963aef";
const missing = "018f47d2-6a34-7b2a-9f21-8a7034963aff";

const index: VaultIndex = {
  schemaVersion: 1,
  entries: [{
    id: existing,
    title: "Existing",
    aliases: [],
    driveId: "internal-note-drive-id",
    path: "Notes/Existing.md",
    created: "2026-08-23T12:00:00.000Z",
    updated: "2026-08-23T12:00:00.000Z",
    driveVersion: "1",
    tags: [],
    searchText: "existing",
    excerpt: "",
    outboundNoteIds: [],
    unresolvedWikiTargets: [],
    attachments: [],
    backlinks: []
  }]
};

describe("PreferencesService", () => {
  it("validates, deduplicates, and prunes note IDs without rewriting Markdown", async () => {
    const storage = await LocalDriveAdapter.create(await mkdtemp(join(tmpdir(), "nxt-preferences-")));
    const note = await storage.createText({ parentId: "vault", name: "Existing.md", mimeType: "text/markdown", text: "unchanged" });
    const indexFile = await storage.createText({
      parentId: "private",
      name: "vault-index.json",
      mimeType: "application/json",
      text: `${JSON.stringify(index)}\n`
    });
    const preferencesFile = await storage.createText({
      parentId: "private",
      name: "preferences.json",
      mimeType: "application/json",
      text: '{"schemaVersion":1,"favorites":[],"recent":[],"theme":"system"}\n'
    });
    const service = new PreferencesService({
      preferencesStore: new SystemFileStore({
        storage,
        fileId: preferencesFile.id,
        parentId: "private",
        name: "preferences.json",
        schema: PreferencesSchema
      }),
      indexStore: new SystemFileStore({
        storage,
        fileId: indexFile.id,
        parentId: "private",
        name: "vault-index.json",
        schema: VaultIndexSchema
      })
    });
    const noteBefore = await storage.get(note.id);

    const result = await service.update({
      favorites: [existing, existing, missing],
      recent: [missing, existing, existing],
      theme: "dark",
      panelState: { activeContext: "backlinks", explorerOpen: false }
    });

    expect(result.value).toEqual({
      schemaVersion: 1,
      favorites: [existing],
      recent: [existing],
      theme: "dark",
      panelState: { activeContext: "backlinks", explorerOpen: false }
    });
    expect((await storage.get(note.id)).version).toBe(noteBefore.version);
    expect(PreferencesSchema.parse(JSON.parse((await storage.readText(preferencesFile.id)).text))).toEqual(result.value);

    const currentIndex = await storage.get(indexFile.id);
    await storage.updateText({
      fileId: indexFile.id,
      expectedVersion: currentIndex.version,
      mimeType: "application/json",
      text: '{"schemaVersion":1,"entries":[]}\n'
    });
    expect((await service.read()).value).toMatchObject({ favorites: [], recent: [] });
    expect((await storage.get(note.id)).version).toBe(noteBefore.version);
  });

  it("rejects invalid preference shapes before writing", async () => {
    const storage = await LocalDriveAdapter.create(await mkdtemp(join(tmpdir(), "nxt-preferences-invalid-")));
    const indexFile = await storage.createText({ parentId: "private", name: "vault-index.json", mimeType: "application/json", text: `${JSON.stringify(index)}\n` });
    const preferencesFile = await storage.createText({ parentId: "private", name: "preferences.json", mimeType: "application/json", text: '{"schemaVersion":1,"favorites":[],"recent":[],"theme":"system"}\n' });
    const service = new PreferencesService({
      preferencesStore: new SystemFileStore({ storage, fileId: preferencesFile.id, parentId: "private", name: "preferences.json", schema: PreferencesSchema }),
      indexStore: new SystemFileStore({ storage, fileId: indexFile.id, parentId: "private", name: "vault-index.json", schema: VaultIndexSchema })
    });
    const before = await storage.readText(preferencesFile.id);

    await expect(service.update({ favorites: [], recent: [], theme: "blue" } as never))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect((await storage.readText(preferencesFile.id)).text).toBe(before.text);
  });
});
