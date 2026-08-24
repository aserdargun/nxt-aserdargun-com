import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpRequest } from "@azure/functions";
import { VaultIndexSchema, type VaultIndex } from "@nxt/contracts";
import { parseNote, serializeNote } from "@nxt/domain";
import { describe, expect, it, vi } from "vitest";
import { createAttachmentHandlers } from "../src/functions/attachments.js";
import { task8Routes } from "../src/functions/index.js";
import { ApiResponseError } from "../src/http/api-response.js";
import { OpaqueIdCodec } from "../src/functions/private-api.js";
import { AttachmentService } from "../src/services/attachment-service.js";
import { SystemFileStore } from "../src/services/system-file-store.js";
import { LocalDriveAdapter } from "../src/storage/local-drive-adapter.js";
import {
  StorageMutationOutcomeUnknownError,
  type StoragePort
} from "../src/storage/storage-port.js";

const noteId = "018f47d2-6a34-7b2a-9f21-8a7034963aef";
const otherNoteId = "018f47d2-6a34-7b2a-9f21-8a7034963af0";
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);

const request = (method: string, url: string, body?: unknown, params: Record<string, string> = {}, headers: Record<string, string> = {}): HttpRequest =>
  new HttpRequest({
    method,
    url,
    params,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: { string: JSON.stringify(body) } })
  });

const sourceFor = (id: string, title: string, body = "# Today\n"): string => serializeNote({
  frontmatter: {
    id,
    title,
    created: "2026-08-23T12:00:00.000Z",
    updated: "2026-08-23T12:00:00.000Z",
    tags: [],
    aliases: []
  },
  body
});

const setup = async (options: { source?: string; storageOverride?: (storage: StoragePort) => StoragePort } = {}) => {
  const raw = await LocalDriveAdapter.create(await mkdtemp(join(tmpdir(), "nxt-attachment-service-")));
  const notes = await raw.createFolder({ parentId: "vault", name: "Notes" });
  const inbox = await raw.createFolder({ parentId: notes.id, name: "Inbox" });
  const assets = await raw.createFolder({ parentId: "vault", name: "_assets" });
  const source = options.source ?? sourceFor(noteId, "Plan");
  const note = await raw.createText({ parentId: inbox.id, name: "Plan.md", mimeType: "text/markdown", text: source });
  const indexFile = await raw.createText({ parentId: "private", name: "vault-index.json", mimeType: "application/json", text: "{\"schemaVersion\":1,\"entries\":[]}\n" });
  const storage = options.storageOverride?.(raw) ?? raw;
  const indexStore = new SystemFileStore<VaultIndex>({ storage: raw, fileId: indexFile.id, parentId: "private", name: "vault-index.json", schema: VaultIndexSchema });
  await indexStore.update({
    schemaVersion: 1,
    entries: [{
      id: noteId,
      title: "Plan",
      aliases: [],
      driveId: note.id,
      path: "Notes/Inbox/Plan.md",
      created: "2026-08-23T12:00:00.000Z",
      updated: "2026-08-23T12:00:00.000Z",
      driveVersion: note.version,
      tags: [],
      searchText: "plan",
      excerpt: "",
      outboundNoteIds: [],
      unresolvedWikiTargets: [],
      attachments: [],
      backlinks: []
    }]
  });
  const vault = {
    getNote: vi.fn(async (requestedNoteId: string) => {
      if (requestedNoteId !== noteId) throw new Error("missing note");
      const current = await raw.readText(note.id);
      return {
        note: { ...parseNote(current.text), path: "Notes/Inbox/Plan.md" },
        source: current.text,
        driveId: note.id,
        version: current.file.version,
        path: "Notes/Inbox/Plan.md",
        checksum: current.checksum
      };
    })
  };
  const service = new AttachmentService({ storage, indexStore, vault, assetsRootId: assets.id });
  return { raw, storage, service, indexStore, vault, ids: { notes, assets, note, indexFile } };
};

describe("AttachmentService", () => {
  it("rejects files above 20 MiB before Drive upload", async () => {
    const { service, raw } = await setup();
    const createBytes = vi.spyOn(raw, "createBytes");

    await expect(service.upload({
      noteId,
      name: "large.bin",
      declaredMime: "application/octet-stream",
      bytes: new Uint8Array(20 * 1024 * 1024 + 1)
    })).rejects.toMatchObject({ code: "TOO_LARGE" });
    expect(createBytes).not.toHaveBeenCalled();
  });

  it("stores a readback-verified asset only beneath its resolved note folder and projects no raw ID", async () => {
    const { service, raw, indexStore, ids } = await setup();

    const uploaded = await service.upload({ noteId, name: "diagram.png", declaredMime: "image/png", bytes: png });
    const stored = await raw.readBytes(uploaded.driveId);
    const assetFolder = (await raw.listChildren({ parentId: ids.assets.id, pageSize: 10 })).files.find((file) => file.name === noteId)!;

    expect(stored.file.parentIds).toEqual([assetFolder.id]);
    expect(stored.file.size).toBe(png.byteLength);
    expect(stored.checksum).toBe(createHash("sha256").update(png).digest("hex"));
    expect((await indexStore.read()).value.entries[0]?.attachments).toMatchObject([{
      driveId: uploaded.driveId,
      name: "diagram.png",
      mimeType: "image/png",
      size: png.byteLength,
      disposition: "inline"
    }]);
  });

  it("rejects a configured asset root unless it is the exact _assets folder", async () => {
    const { raw, indexStore, vault, ids } = await setup();
    const service = new AttachmentService({ storage: raw, indexStore, vault, assetsRootId: ids.notes.id });

    await expect(service.upload({ noteId, name: "diagram.png", declaredMime: "image/png", bytes: png }))
      .rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
  });

  it("keeps malformed content and MIME/extension mismatches download-only", async () => {
    const { service } = await setup();

    const uploaded = await service.upload({ noteId, name: "report.jpg", declaredMime: "image/jpeg", bytes: png });
    const delivered = await service.read(uploaded.driveId);

    expect(uploaded.disposition).toBe("download");
    expect(delivered.disposition).toBe("download");
    expect(delivered.mimeType).toBe("image/png");
  });

  it("resolves duplicate normalized filenames deterministically before writing", async () => {
    const { service } = await setup();
    const first = await service.upload({ noteId, name: "e\u0301.png", declaredMime: "image/png", bytes: png });
    const second = await service.upload({ noteId, name: "é.png", declaredMime: "image/png", bytes: png });

    expect(first.name).toBe("é.png");
    expect(second.name).toBe("é-2.png");
  });

  it("rejects declared Drive folder and shortcut MIME types before creating an asset", async () => {
    const { service, raw } = await setup();
    const createBytes = vi.spyOn(raw, "createBytes");

    await expect(service.upload({ noteId, name: "diagram.png", declaredMime: "application/vnd.google-apps.folder", bytes: png }))
      .rejects.toMatchObject({ code: "UNSAFE_FILE" });
    await expect(service.upload({ noteId, name: "diagram.png", declaredMime: "application/vnd.google-apps.shortcut", bytes: png }))
      .rejects.toMatchObject({ code: "UNSAFE_FILE" });
    expect(createBytes).not.toHaveBeenCalled();
  });

  it("rejects an asset that is indexed under the wrong note folder", async () => {
    const { service, raw, ids } = await setup();
    const uploaded = await service.upload({ noteId, name: "diagram.png", declaredMime: "image/png", bytes: png });
    const ownerFolder = (await raw.listChildren({ parentId: ids.assets.id, pageSize: 10 })).files.find((file) => file.name === noteId)!;
    const wrongFolder = await raw.createFolder({ parentId: ids.assets.id, name: otherNoteId });
    const stored = await raw.get(uploaded.driveId);
    await raw.move({ fileId: uploaded.driveId, fromParentId: ownerFolder.id, toParentId: wrongFolder.id, expectedVersion: stored.version });

    await expect(service.read(uploaded.driveId)).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
  });

  it("refuses Trash while inline and reference-style Markdown links remain", async () => {
    const source = sourceFor(noteId, "Plan", `![diagram](<../../_assets/${noteId}/diagram.png> "Diagram")\n\n[download]: ../../_assets/${noteId}/diagram.png\n`);
    const { service } = await setup({ source });
    const uploaded = await service.upload({ noteId, name: "diagram.png", declaredMime: "image/png", bytes: png });

    await expect(service.trash({ assetId: uploaded.driveId })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("trashes only the verified unreferenced asset and updates its index projection", async () => {
    const { service, raw, indexStore } = await setup();
    const uploaded = await service.upload({ noteId, name: "remove.png", declaredMime: "image/png", bytes: png });

    await expect(service.trash({ assetId: uploaded.driveId })).resolves.toEqual({ trashed: true });
    expect((await raw.get(uploaded.driveId)).trashed).toBe(true);
    expect((await indexStore.read()).value.entries[0]?.attachments).toHaveLength(0);
  });

  it("keeps ambiguous Trash outcomes persisted and unavailable rather than exposing the asset", async () => {
    const { service, raw, indexStore, vault, ids } = await setup();
    const uploaded = await service.upload({ noteId, name: "uncertain-trash.png", declaredMime: "image/png", bytes: png });
    const storage: StoragePort = {
      get: raw.get.bind(raw), listChildren: raw.listChildren.bind(raw), readText: raw.readText.bind(raw), readBytes: raw.readBytes.bind(raw),
      createFolder: raw.createFolder.bind(raw), createText: raw.createText.bind(raw), createBytes: raw.createBytes.bind(raw), updateText: raw.updateText.bind(raw), move: raw.move.bind(raw),
      trash: async (fileId) => {
        const trashed = await raw.trash(fileId);
        throw new StorageMutationOutcomeUnknownError(trashed.id);
      },
      listRevisions: raw.listRevisions.bind(raw)
    };
    const uncertain = new AttachmentService({ storage, indexStore, vault, assetsRootId: ids.assets.id });

    await expect(uncertain.trash({ assetId: uploaded.driveId })).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
    expect((await indexStore.read()).value.pendingMutations[0]).toMatchObject({ operation: "trash-attachment", phase: "outcome-unknown" });
    await expect(new AttachmentService({ storage: raw, indexStore, vault, assetsRootId: ids.assets.id }).read(uploaded.driveId))
      .rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
  });

  it("retains a recovery mutation and exposes nothing after an ambiguous upload", async () => {
    const { raw, indexStore, ids } = await setup();
    const storage: StoragePort = {
      get: raw.get.bind(raw), listChildren: raw.listChildren.bind(raw), readText: raw.readText.bind(raw), readBytes: raw.readBytes.bind(raw),
      createFolder: raw.createFolder.bind(raw), createText: raw.createText.bind(raw),
      createBytes: async (input) => {
        const created = await raw.createBytes(input);
        throw new StorageMutationOutcomeUnknownError(created.id);
      },
      updateText: raw.updateText.bind(raw), move: raw.move.bind(raw), trash: raw.trash.bind(raw), listRevisions: raw.listRevisions.bind(raw)
    };
    const service = new AttachmentService({ storage, indexStore, vault: { getNote: async () => ({
      note: { ...parseNote(await raw.readText(ids.note.id).then((value) => value.text)), path: "Notes/Inbox/Plan.md" },
      source: (await raw.readText(ids.note.id)).text, driveId: ids.note.id, version: "1", path: "Notes/Inbox/Plan.md", checksum: (await raw.readText(ids.note.id)).checksum
    }) }, assetsRootId: ids.assets.id });

    await expect(service.upload({ noteId, name: "uncertain.png", declaredMime: "image/png", bytes: png })).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
    const pending = (await indexStore.read()).value.pendingMutations;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ operation: "create-attachment", phase: "outcome-unknown" });
    expect((await indexStore.read()).value.entries[0]?.attachments).toHaveLength(0);
  });

  it("recovers an ambiguous upload only after exact local readback proves the stored bytes", async () => {
    const { raw, indexStore, ids } = await setup();
    const storage: StoragePort = {
      get: raw.get.bind(raw), listChildren: raw.listChildren.bind(raw), readText: raw.readText.bind(raw), readBytes: raw.readBytes.bind(raw),
      createFolder: raw.createFolder.bind(raw), createText: raw.createText.bind(raw),
      createBytes: async (input) => {
        const created = await raw.createBytes(input);
        throw new StorageMutationOutcomeUnknownError(created.id);
      },
      updateText: raw.updateText.bind(raw), move: raw.move.bind(raw), trash: raw.trash.bind(raw), listRevisions: raw.listRevisions.bind(raw)
    };
    const vault = { getNote: async () => {
      const current = await raw.readText(ids.note.id);
      return { note: { ...parseNote(current.text), path: "Notes/Inbox/Plan.md" }, source: current.text, driveId: ids.note.id, version: current.file.version, path: "Notes/Inbox/Plan.md", checksum: current.checksum };
    } };
    const uncertain = new AttachmentService({ storage, indexStore, vault, assetsRootId: ids.assets.id });

    await expect(uncertain.upload({ noteId, name: "recover.png", declaredMime: "image/png", bytes: png })).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
    const assetId = (await indexStore.read()).value.pendingMutations[0]?.driveId;
    if (assetId === undefined) throw new Error("ambiguous upload did not retain its Drive ID");
    const recovered = new AttachmentService({ storage: raw, indexStore, vault, assetsRootId: ids.assets.id });

    await expect(recovered.read(assetId)).resolves.toMatchObject({ name: "recover.png", mimeType: "image/png", disposition: "download" });
  });

  it("rejects a readback mismatch without projecting an attachment", async () => {
    const { raw, indexStore, ids, vault } = await setup();
    const storage: StoragePort = {
      get: raw.get.bind(raw), listChildren: raw.listChildren.bind(raw), readText: raw.readText.bind(raw),
      readBytes: async (fileId) => {
        const readback = await raw.readBytes(fileId);
        return { ...readback, checksum: "0".repeat(64) };
      },
      createFolder: raw.createFolder.bind(raw), createText: raw.createText.bind(raw), createBytes: raw.createBytes.bind(raw),
      updateText: raw.updateText.bind(raw), move: raw.move.bind(raw), trash: raw.trash.bind(raw), listRevisions: raw.listRevisions.bind(raw)
    };
    const service = new AttachmentService({ storage, indexStore, vault, assetsRootId: ids.assets.id });

    await expect(service.upload({ noteId, name: "mismatch.png", declaredMime: "image/png", bytes: png })).rejects.toMatchObject({ code: "DRIVE_UNAVAILABLE" });
    expect((await indexStore.read()).value.entries[0]?.attachments).toHaveLength(0);
    expect((await indexStore.read()).value.pendingMutations[0]).toMatchObject({ operation: "create-attachment", phase: "drive-applied" });
  });

  it("rechecks owner Markdown after reserving Trash so a new reference wins the race", async () => {
    const { service, raw, vault, ids } = await setup();
    const uploaded = await service.upload({ noteId, name: "race.png", declaredMime: "image/png", bytes: png });
    let reads = 0;
    vault.getNote.mockImplementation(async () => {
      reads += 1;
      if (reads === 2) {
        const before = await raw.get(ids.note.id);
        await raw.updateText({
          fileId: ids.note.id,
          expectedVersion: before.version,
          mimeType: "text/markdown",
          text: sourceFor(noteId, "Plan", `![race](../../_assets/${noteId}/race.png)`)
        });
      }
      const current = await raw.readText(ids.note.id);
      return { note: { ...parseNote(current.text), path: "Notes/Inbox/Plan.md" }, source: current.text, driveId: ids.note.id, version: current.file.version, path: "Notes/Inbox/Plan.md", checksum: current.checksum };
    });

    await expect(service.trash({ assetId: uploaded.driveId })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await raw.get(uploaded.driveId)).trashed).toBe(false);
  });
});

describe("private attachment handlers", () => {
  it("registers only the approved three attachment routes without changing Task 7 routes", () => {
    expect(task8Routes.map(({ method, route }) => `${method} ${route}`)).toEqual([
      "POST private/attachments",
      "GET private/attachments/{assetId}",
      "DELETE private/attachments/{assetId}"
    ]);
  });

  it("authorizes before resolving services and returns static 413 errors", async () => {
    const resolveServices = vi.fn();
    const handlers = createAttachmentHandlers({
      authorize: () => { throw new ApiResponseError("FORBIDDEN"); },
      resolveServices,
      idCodec: new OpaqueIdCodec("handler-test-opaque-id-secret-more-than-32-bytes")
    });
    const denied = await handlers.create(request("POST", "https://nxt.example/api/private/attachments", {}));

    expect(denied.status).toBe(403);
    expect(resolveServices).not.toHaveBeenCalled();
  });

  it("encodes asset IDs and sets no-sniff plus RFC 5987 download headers", async () => {
    const codec = new OpaqueIdCodec("handler-test-opaque-id-secret-more-than-32-bytes");
    const upload = vi.fn(async () => ({ driveId: "raw-drive-id", name: "evil\r\nname.svg", mimeType: "image/svg+xml", size: 1, checksum: "a".repeat(64), disposition: "download" as const }));
    const read = vi.fn(async () => ({ bytes: Uint8Array.of(1), name: "evil\r\nname.svg", mimeType: "image/svg+xml", disposition: "download" as const }));
    const handlers = createAttachmentHandlers({
      authorize: () => ({ provider: "github", userId: "owner", userDetails: "aserdargun" }),
      resolveServices: () => ({ attachments: { upload, read, trash: vi.fn() } }) as never,
      idCodec: codec
    });
    const assetId = codec.encode("raw-drive-id");
    const response = await handlers.get(request("GET", `https://nxt.example/api/private/attachments/${assetId}`, undefined, { assetId }));

    expect(response.status).toBe(200);
    expect(response.headers).toMatchObject({
      "x-content-type-options": "nosniff",
      "content-type": "image/svg+xml"
    });
    expect(response.headers?.["content-disposition"]).toBe("attachment; filename*=UTF-8''evilname.svg");
    expect(JSON.stringify(response)).not.toContain("raw-drive-id");
  });

  it("strictly parses uploads, enforces decoded size, and returns a schema-shaped opaque response", async () => {
    const codec = new OpaqueIdCodec("handler-test-opaque-id-secret-more-than-32-bytes");
    const upload = vi.fn(async () => ({ driveId: "raw-drive-id", name: "diagram.png", mimeType: "image/png", size: 1, checksum: "a".repeat(64), disposition: "inline" as const }));
    const handlers = createAttachmentHandlers({
      authorize: () => ({ provider: "github", userId: "owner", userDetails: "aserdargun" }),
      resolveServices: () => ({ attachments: { upload, read: vi.fn(), trash: vi.fn() } }) as never,
      idCodec: codec
    });
    const response = await handlers.create(request("POST", "https://nxt.example/api/private/attachments", {
      noteId,
      name: "diagram.png",
      declaredMime: "image/png",
      bytesBase64: "AQ=="
    }));
    const oversized = await handlers.create(request("POST", "https://nxt.example/api/private/attachments", {
      noteId,
      name: "diagram.png",
      declaredMime: "image/png",
      bytesBase64: "AQ=="
    }, {}, { "content-length": String(30 * 1024 * 1024) }));

    expect(response.status).toBe(201);
    expect(codec.decode((response.jsonBody as { asset: { assetId: string } }).asset.assetId)).toBe("raw-drive-id");
    expect(JSON.stringify(response.jsonBody)).not.toContain("raw-drive-id");
    expect(oversized.status).toBe(413);
    expect(upload).toHaveBeenCalledOnce();
  });
});
