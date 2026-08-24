import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultIndexSchema } from "@nxt/contracts";
import { serializeNote } from "@nxt/domain";
import { describe, expect, it } from "vitest";
import { RescanService } from "../src/services/rescan-service.js";
import { SystemFileStore } from "../src/services/system-file-store.js";
import { LocalDriveAdapter } from "../src/storage/local-drive-adapter.js";
import type { StoragePort } from "../src/storage/storage-port.js";

const validSource = serializeNote({
  frontmatter: {
    id: "018f47d2-6a34-7b2a-9f21-8a7034963aef",
    title: "External",
    created: "2026-08-23T12:00:00.000Z",
    updated: "2026-08-23T12:00:00.000Z",
    tags: [],
    aliases: []
  },
  body: "[[Other]]"
});

const setup = async (wrap?: (storage: StoragePort) => StoragePort) => {
  const raw = await LocalDriveAdapter.create(await mkdtemp(join(tmpdir(), "nxt-rescan-")));
  const notes = await raw.createFolder({ parentId: "vault", name: "Notes" });
  const plans = await raw.createFolder({ parentId: notes.id, name: "Plans" });
  const assets = await raw.createFolder({ parentId: "vault", name: "_assets" });
  const privateFile = await raw.createText({
    parentId: "private",
    name: "vault-index.json",
    mimeType: "application/json",
    text: '{"schemaVersion":1,"entries":[]}\n'
  });
  const storage = wrap?.(raw) ?? raw;
  const indexStore = new SystemFileStore({
    storage,
    fileId: privateFile.id,
    parentId: "private",
    name: "vault-index.json",
    schema: VaultIndexSchema
  });
  const rescan = new RescanService({
    storage,
    indexStore,
    notesFolderId: notes.id,
    cursorSecret: "test-only-rescan-cursor-secret-32-bytes",
    now: () => new Date("2026-08-23T12:00:00.000Z")
  });
  return { raw, storage, rescan, indexStore, ids: { notes, plans, assets, privateFile } };
};

describe("RescanService", () => {
  it("discovers only Markdown below Notes and preserves invalid raw source for recovery", async () => {
    const { raw, rescan, ids } = await setup();
    await raw.createText({ parentId: ids.plans.id, name: "External.md", mimeType: "text/markdown", text: validSource });
    const invalidRaw = "---\ntitle: broken\n---\n\nraw recovery body";
    await raw.createText({ parentId: ids.plans.id, name: "Broken.md", mimeType: "text/markdown", text: invalidRaw });
    await raw.createText({ parentId: ids.plans.id, name: "Ignore.txt", mimeType: "text/plain", text: "ignore" });
    await raw.createText({ parentId: ids.assets.id, name: "Asset.md", mimeType: "text/markdown", text: validSource });
    await raw.createText({ parentId: "private", name: "Private.md", mimeType: "text/markdown", text: validSource });

    let page = await rescan.scanPage({ cursor: null, limit: 2 });
    const cursors = new Set<string>();
    const records = [...page.records];
    const recoveries = [...page.recoveries];
    while (!page.complete) {
      expect(page.cursor).not.toBeNull();
      expect(page.cursor?.length).toBeLessThanOrEqual(512);
      expect(cursors.has(page.cursor!)).toBe(false);
      cursors.add(page.cursor!);
      page = await rescan.scanPage({ cursor: page.cursor, limit: 2 });
      records.push(...page.records);
      recoveries.push(...page.recoveries);
    }

    expect(records.map((item) => item.path)).toEqual(["Notes/Plans/External.md"]);
    expect(recoveries).toEqual([
      expect.objectContaining({ path: "Notes/Plans/Broken.md", rawSource: invalidRaw })
    ]);
    const index = (await rescan.readIndex()).value;
    expect(index.entries.map((item) => item.path)).toEqual(["Notes/Plans/External.md"]);
  });

  it("never asks Drive for or processes more than 100 entries in one request", async () => {
    let listed = 0;
    const { raw, ids } = await setup();
    for (let index = 0; index < 140; index += 1) {
      await raw.createText({ parentId: ids.plans.id, name: `Ignore-${index}.txt`, mimeType: "text/plain", text: "x" });
    }
    const storage: StoragePort = {
      ...raw,
      get: raw.get.bind(raw),
      listChildren: async (input) => {
        expect(input.pageSize).toBeLessThanOrEqual(100 - listed);
        const result = await raw.listChildren(input);
        listed += result.files.length;
        return result;
      },
      readText: raw.readText.bind(raw),
      readBytes: raw.readBytes.bind(raw),
      createFolder: raw.createFolder.bind(raw),
      createText: raw.createText.bind(raw),
      createBytes: raw.createBytes.bind(raw),
      updateText: raw.updateText.bind(raw),
      move: raw.move.bind(raw),
      trash: raw.trash.bind(raw),
      listRevisions: raw.listRevisions.bind(raw)
    };
    const store = new SystemFileStore({
      storage,
      fileId: ids.privateFile.id,
      parentId: "private",
      name: "vault-index.json",
      schema: VaultIndexSchema
    });
    const rescan = new RescanService({
      storage,
      indexStore: store,
      notesFolderId: ids.notes.id,
      cursorSecret: "test-only-rescan-cursor-secret-32-bytes"
    });

    const page = await rescan.scanPage({ cursor: null, limit: 100 });

    expect(page.processed).toBeLessThanOrEqual(100);
    expect(listed).toBeLessThanOrEqual(100);
  });

  it("rejects tampered cursors and preserves the prior valid index when final update fails", async () => {
    const { raw, ids } = await setup();
    await raw.createText({ parentId: ids.plans.id, name: "External.md", mimeType: "text/markdown", text: validSource });
    const previous = await raw.readText(ids.privateFile.id);
    let failIndexWrite = true;
    const storage: StoragePort = {
      ...raw,
      get: raw.get.bind(raw),
      listChildren: raw.listChildren.bind(raw),
      readText: raw.readText.bind(raw),
      readBytes: raw.readBytes.bind(raw),
      createFolder: raw.createFolder.bind(raw),
      createText: raw.createText.bind(raw),
      createBytes: raw.createBytes.bind(raw),
      updateText: async (input) => {
        if (failIndexWrite && input.fileId === ids.privateFile.id) throw new Error("injected partial write failure");
        return raw.updateText(input);
      },
      move: raw.move.bind(raw),
      trash: raw.trash.bind(raw),
      listRevisions: raw.listRevisions.bind(raw)
    };
    const indexStore = new SystemFileStore({
      storage,
      fileId: ids.privateFile.id,
      parentId: "private",
      name: "vault-index.json",
      schema: VaultIndexSchema
    });
    const rescan = new RescanService({
      storage,
      indexStore,
      notesFolderId: ids.notes.id,
      cursorSecret: "test-only-rescan-cursor-secret-32-bytes"
    });

    const first = await rescan.scanPage({ cursor: null, limit: 1 });
    expect(first.cursor).not.toBeNull();
    await expect(
      rescan.scanPage({ cursor: `${first.cursor!.slice(0, -1)}x`, limit: 100 })
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    let page = first;
    await expect(async () => {
      while (!page.complete) page = await rescan.scanPage({ cursor: page.cursor, limit: 100 });
    }).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
    expect((await raw.readText(ids.privateFile.id)).text).toBe(previous.text);

    failIndexWrite = false;
    page = await rescan.scanPage({ cursor: null, limit: 100 });
    while (!page.complete) page = await rescan.scanPage({ cursor: page.cursor, limit: 100 });
    expect((await rescan.readIndex()).value.entries).toHaveLength(1);
  });
});
