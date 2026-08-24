import { HttpRequest } from "@azure/functions";
import { FolderResponseSchema, NoteResponseSchema, TrashResponseSchema, VaultResponseSchema } from "@nxt/contracts";
import { ApiResponseError } from "../src/http/api-response.js";
import { describe, expect, it, vi } from "vitest";
import { task7Routes } from "../src/functions/index.js";
import { createNoteHandlers } from "../src/functions/notes.js";
import { createVaultHandlers } from "../src/functions/vault.js";
import { createFolderHandlers } from "../src/functions/folders.js";
import { createRuntimeOpaqueIdCodec, OpaqueIdCodec } from "../src/functions/private-api.js";

const noteId = "018f47d2-6a34-7b2a-9f21-8a7034963aef";

const request = (method: string, url: string, body?: unknown, params: Record<string, string> = {}): HttpRequest =>
  new HttpRequest({
    method,
    url,
    params,
    ...(body === undefined ? {} : {
      headers: { "content-type": "application/json" },
      body: { string: JSON.stringify(body) }
    })
  });

const identityCodec = new OpaqueIdCodec("handler-test-opaque-id-secret-more-than-32-bytes");

describe("Task 7 Function registration", () => {
  it("registers exactly the approved v4 routes and methods", () => {
    expect(task7Routes.map(({ method, route }) => `${method} ${route}`)).toEqual([
      "GET private/vault",
      "POST private/vault/rescan",
      "POST private/notes",
      "GET private/notes/{noteId}",
      "PUT private/notes/{noteId}",
      "DELETE private/notes/{noteId}",
      "POST private/notes/{noteId}/move",
      "POST private/notes/{noteId}/archive",
      "POST private/folders",
      "PUT private/folders/{folderId}",
      "DELETE private/folders/{folderId}",
      "PUT private/preferences"
    ]);
    expect(task7Routes.every((route) => route.authLevel === "anonymous" && typeof route.handler === "function")).toBe(true);
  });

  it("fails closed without a sufficiently strong runtime opaque-ID secret", () => {
    expect(() => createRuntimeOpaqueIdCodec(undefined, undefined)).toThrowError(ApiResponseError);
    expect(() => createRuntimeOpaqueIdCodec("short", "also-short")).toThrowError(ApiResponseError);
  });
});

describe("private vault handlers", () => {
  it("authorizes defensively before resolving services or touching storage", async () => {
    const resolveServices = vi.fn();
    const handlers = createVaultHandlers({
      authorize: () => { throw new ApiResponseError("FORBIDDEN"); },
      resolveServices,
      idCodec: identityCodec
    });

    const response = await handlers.getVault(request("GET", "https://nxt.example/api/private/vault"));

    expect(response.status).toBe(403);
    expect(resolveServices).not.toHaveBeenCalled();
    expect(response.jsonBody).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("returns an authenticated vault projection without raw Drive IDs", async () => {
    const handlers = createVaultHandlers({
      authorize: () => ({ provider: "github", userId: "owner", userDetails: "aserdargun" }),
      resolveServices: () => ({
        vault: {
          readIndex: async () => ({
            value: {
              schemaVersion: 1,
              generation: 0,
              pendingMutations: [],
              rescanState: null,
              entries: [{
                id: noteId,
                title: "Plan",
                aliases: [],
                driveId: "raw-note-drive-id",
                path: "Notes/Plan.md",
                created: "2026-08-23T12:00:00.000Z",
                updated: "2026-08-23T12:00:00.000Z",
                driveVersion: "1",
                tags: [],
                searchText: "plan",
                excerpt: "",
                outboundNoteIds: [],
                unresolvedWikiTargets: [],
                attachments: [{ driveId: "raw-asset-drive-id", name: "x.png", mimeType: "image/png", size: 1 }],
                backlinks: []
              }]
            }
          }),
          vaultTree: async () => ({
            treeVersion: "a".repeat(64),
            folders: [{ id: "raw-folder-drive-id", name: "Notes", path: "Notes", version: "1", protected: true }]
          })
        },
        preferences: { read: async () => ({ value: { schemaVersion: 1, favorites: [], recent: [], theme: "system" } }) }
      }) as never,
      idCodec: identityCodec
    });

    const response = await handlers.getVault(request("GET", "https://nxt.example/api/private/vault"));
    const serialized = JSON.stringify(response.jsonBody);

    expect(response.status).toBe(200);
    expect(VaultResponseSchema.parse(response.jsonBody).folders).toHaveLength(1);
    expect(serialized).not.toMatch(/raw-note-drive-id|raw-asset-drive-id|"driveId"/u);
  });

  it("strictly validates rescan bodies and rejects query additions before invoking the service", async () => {
    const scanPage = vi.fn();
    const handlers = createVaultHandlers({
      authorize: () => ({ provider: "github", userId: "owner", userDetails: "aserdargun" }),
      resolveServices: () => ({ rescan: { scanPage } }) as never,
      idCodec: identityCodec
    });
    const badBody = await handlers.rescan(request("POST", "https://nxt.example/api/private/vault/rescan", {
      cursor: null,
      limit: 101,
      extra: true
    }));
    const badQuery = await handlers.rescan(request("POST", "https://nxt.example/api/private/vault/rescan?driveId=raw", {
      cursor: null,
      limit: 100
    }));

    expect(badBody.status).toBe(400);
    expect(badQuery.status).toBe(400);
    expect(scanPage).not.toHaveBeenCalled();
  });

  it("delivers a schema-valid confirmation that can be submitted unchanged for folder Trash", async () => {
    const confirmationToken = `c1.${"a".repeat(120)}.${"b".repeat(43)}`;
    const treeVersion = "c".repeat(64);
    const folder = { id: "raw-project-folder", name: "Project", path: "Notes/Project", version: "3", protected: false,
      deleteConfirmation: { descendantCount: 2, treeVersion, expiresAt: "2026-08-23T12:05:00.000Z", confirmationToken } };
    const trashFolder = vi.fn(async () => ({ trashed: true as const }));
    const services = {
      vault: {
        readIndex: async () => ({ value: { schemaVersion: 1, generation: 4, entries: [], pendingMutations: [], rescanState: null } }),
        vaultTree: async () => ({ treeVersion, folders: [folder] }),
        trashFolder
      },
      preferences: { read: async () => ({ value: { schemaVersion: 1, favorites: [], recent: [], theme: "system" } }) }
    } as never;
    const dependencies = {
      authorize: () => ({ provider: "github" as const, userId: "owner", userDetails: "aserdargun" }),
      resolveServices: () => services,
      idCodec: identityCodec
    };
    const vaultResponse = await createVaultHandlers(dependencies).getVault(request("GET", "https://nxt.example/api/private/vault"));
    const projected = VaultResponseSchema.parse(vaultResponse.jsonBody);
    const projectedFolder = projected.folders[0]!;

    const deleteResponse = await createFolderHandlers(dependencies).deleteFolder(request(
      "DELETE",
      `https://nxt.example/api/private/folders/${projectedFolder.id}`,
      { expectedTreeVersion: treeVersion, confirmationToken: projectedFolder.deleteConfirmation!.confirmationToken },
      { folderId: projectedFolder.id }
    ));

    expect(TrashResponseSchema.parse(deleteResponse.jsonBody)).toEqual({ trashed: true });
    expect(trashFolder).toHaveBeenCalledWith({ folderId: folder.id, expectedTreeVersion: treeVersion, confirmationToken });
  });

  it("paginates a large committed index in bounded schema-valid pages", async () => {
    const entries = Array.from({ length: 205 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      title: `Note ${index}`, aliases: [], driveId: `raw-${index}`, path: `Notes/Note ${index}.md`,
      created: "2026-08-23T12:00:00.000Z", updated: "2026-08-23T12:00:00.000Z", driveVersion: "1",
      tags: [], searchText: "", excerpt: "", outboundNoteIds: [], unresolvedWikiTargets: [], attachments: [], backlinks: []
    }));
    const services = {
      vault: {
        readIndex: async () => ({ value: { schemaVersion: 1, generation: 7, entries, pendingMutations: [], rescanState: null } }),
        vaultTree: async () => ({ treeVersion: "e".repeat(64), folders: [] })
      },
      preferences: { read: async () => ({ value: { schemaVersion: 1, favorites: [], recent: [], theme: "system" } }) }
    } as never;
    const handlers = createVaultHandlers({
      authorize: () => ({ provider: "github", userId: "owner", userDetails: "aserdargun" }),
      resolveServices: () => services,
      idCodec: identityCodec
    });
    const first = VaultResponseSchema.parse((await handlers.getVault(request("GET", "https://nxt.example/api/private/vault"))).jsonBody);
    const second = VaultResponseSchema.parse((await handlers.getVault(request("GET", `https://nxt.example/api/private/vault?cursor=${first.cursor}`))).jsonBody);
    expect(first.entries).toHaveLength(100);
    expect(first.complete).toBe(false);
    expect(second.entries).toHaveLength(100);
    expect(second.entries[0]?.title).toBe("Note 100");
  });

  it("rejects a vault cursor when the exact folder tree changes between pages", async () => {
    const entries = Array.from({ length: 101 }, (_, index) => ({
      id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      title: `Note ${index}`, aliases: [], driveId: `raw-${index}`, path: `Notes/Note ${index}.md`,
      created: "2026-08-23T12:00:00.000Z", updated: "2026-08-23T12:00:00.000Z", driveVersion: "1",
      tags: [], searchText: "", excerpt: "", outboundNoteIds: [], unresolvedWikiTargets: [], attachments: [], backlinks: []
    }));
    let treeVersion = "1".repeat(64);
    const handlers = createVaultHandlers({
      authorize: () => ({ provider: "github", userId: "owner", userDetails: "aserdargun" }),
      resolveServices: () => ({
        vault: {
          readIndex: async () => ({ value: { schemaVersion: 1, generation: 9, entries, pendingMutations: [], rescanState: null } }),
          vaultTree: async () => ({ treeVersion, folders: [] })
        },
        preferences: { read: async () => ({ value: { schemaVersion: 1, favorites: [], recent: [], theme: "system" } }) }
      }) as never,
      idCodec: identityCodec
    });
    const first = VaultResponseSchema.parse((await handlers.getVault(request("GET", "https://nxt.example/api/private/vault"))).jsonBody);
    treeVersion = "2".repeat(64);

    const stale = await handlers.getVault(request("GET", `https://nxt.example/api/private/vault?cursor=${first.cursor}`));

    expect(stale.status).toBe(409);
    expect(stale.jsonBody).toMatchObject({ error: { code: "CONFLICT" } });
  });

  it("uses one canonical folder order across pages when provider listing order changes", async () => {
    const treeVersion = "2".repeat(64);
    const folders = [
      { id: "raw-folder-charlie", name: "Charlie", path: "Notes/Charlie", version: "1", protected: false },
      { id: "raw-folder-alpha", name: "Alpha", path: "Notes/Alpha", version: "1", protected: false },
      { id: "raw-folder-bravo", name: "Bravo", path: "Notes/Bravo", version: "1", protected: false }
    ];
    let calls = 0;
    const handlers = createVaultHandlers({
      authorize: () => ({ provider: "github", userId: "owner", userDetails: "aserdargun" }),
      resolveServices: () => ({
        vault: {
          readIndex: async () => ({ value: { schemaVersion: 1, generation: 9, entries: [], pendingMutations: [], rescanState: null } }),
          vaultTree: async () => ({ treeVersion, folders: calls++ % 2 === 0 ? folders : [...folders].reverse() })
        },
        preferences: { read: async () => ({ value: { schemaVersion: 1, favorites: [], recent: [], theme: "system" } }) }
      }) as never,
      idCodec: identityCodec
    });

    const first = VaultResponseSchema.parse((await handlers.getVault(request("GET", "https://nxt.example/api/private/vault?limit=2"))).jsonBody);
    const second = VaultResponseSchema.parse((await handlers.getVault(request(
      "GET",
      `https://nxt.example/api/private/vault?limit=2&cursor=${encodeURIComponent(first.cursor!)}`
    ))).jsonBody);

    expect([...first.folders, ...second.folders].map((folder) => folder.path)).toEqual([
      "Notes/Alpha", "Notes/Bravo", "Notes/Charlie"
    ]);
    expect(second.cursor).toBeNull();
  });

  it("paginates every nested relation, attachment, backlink, and preference without slicing", async () => {
    const targetIds = Array.from({ length: 120 }, (_, index) => `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    const entry = {
      id: noteId, title: "Dense", aliases: [], driveId: "raw-dense", path: "Notes/Dense.md",
      created: "2026-08-23T12:00:00.000Z", updated: "2026-08-23T12:00:00.000Z", driveVersion: "1",
      tags: [], searchText: "s".repeat(100_000), excerpt: "e".repeat(4_000), outboundNoteIds: targetIds,
      unresolvedWikiTargets: Array.from({ length: 120 }, (_, index) => `Missing-${index}-${"x".repeat(140)}`),
      attachments: Array.from({ length: 120 }, (_, index) => ({
        driveId: `raw-asset-${index}`,
        name: `${String(index).padStart(3, "0")}-${"x".repeat(172)}.png`,
        mimeType: `application/${"x".repeat(244)}`,
        size: index
      })),
      backlinks: [...targetIds]
    };
    const favorites = [...targetIds];
    const recent = [...targetIds].reverse();
    const services = {
      vault: {
        readIndex: async () => ({ value: { schemaVersion: 1, generation: 10, entries: [entry], pendingMutations: [], rescanState: null } }),
        vaultTree: async () => ({ treeVersion: "3".repeat(64), folders: [] })
      },
      preferences: { read: async () => ({ value: { schemaVersion: 1, favorites, recent, theme: "system" } }) }
    } as never;
    const handlers = createVaultHandlers({
      authorize: () => ({ provider: "github", userId: "owner", userDetails: "aserdargun" }),
      resolveServices: () => services,
      idCodec: identityCodec
    });
    const seen = { outbound: new Set<string>(), unresolved: new Set<string>(), attachments: new Set<string>(), backlinks: new Set<string>(), favorites: new Set<string>(), recent: new Set<string>() };
    let cursor: string | null = null;
    do {
      const suffix = cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`;
      const page = VaultResponseSchema.parse((await handlers.getVault(request("GET", `https://nxt.example/api/private/vault${suffix}`))).jsonBody);
      for (const projected of page.entries) {
        projected.outboundNoteIds.forEach((id) => seen.outbound.add(id));
        projected.unresolvedWikiTargets.forEach((target) => seen.unresolved.add(target));
        projected.attachments.forEach((attachment) => seen.attachments.add(attachment.name));
        projected.backlinks.forEach((id) => seen.backlinks.add(id));
      }
      page.preferences.favorites.forEach((id) => seen.favorites.add(id));
      page.preferences.recent.forEach((id) => seen.recent.add(id));
      cursor = page.cursor;
    } while (cursor !== null);

    expect(Object.fromEntries(Object.entries(seen).map(([key, value]) => [key, value.size]))).toEqual({
      outbound: 120, unresolved: 120, attachments: 120, backlinks: 120, favorites: 120, recent: 120
    });
  });
});

describe("private note handlers", () => {
  it("decodes only server-issued folder references and strips internal IDs from note responses", async () => {
    const createNote = vi.fn(async (input) => ({
      note: {
        frontmatter: {
          id: noteId,
          title: input.title,
          created: "2026-08-23T12:00:00.000Z",
          updated: "2026-08-23T12:00:00.000Z",
          tags: [],
          aliases: []
        },
        body: input.body,
        path: "Notes/Inbox/Plan.md"
      },
      source: "portable source",
      driveId: "raw-note-drive-id",
      version: "2",
      path: "Notes/Inbox/Plan.md",
      checksum: "a".repeat(64)
    }));
    const handlers = createNoteHandlers({
      authorize: () => ({ provider: "github", userId: "owner", userDetails: "aserdargun" }),
      resolveServices: () => ({ vault: { createNote } }) as never,
      idCodec: identityCodec
    });

    const folderRef = identityCodec.encode("raw-folder-drive-id");
    const response = await handlers.createNote(request("POST", "https://nxt.example/api/private/notes", {
      title: "Plan",
      body: "# Plan",
      folderId: folderRef
    }));

    expect(response.status).toBe(201);
    expect(NoteResponseSchema.parse(response.jsonBody).checksum).toBe("a".repeat(64));
    expect(createNote).toHaveBeenCalledWith({ title: "Plan", body: "# Plan", folderId: "raw-folder-drive-id" });
    expect(JSON.stringify(response.jsonBody)).not.toMatch(/raw-note-drive-id|driveId/u);
  });

  it("validates path and body contracts and maps optimistic conflicts to static 409 errors", async () => {
    const updateNote = vi.fn(async () => { throw new ApiResponseError("CONFLICT"); });
    const handlers = createNoteHandlers({
      authorize: () => ({ provider: "github", userId: "owner", userDetails: "aserdargun" }),
      resolveServices: () => ({ vault: { updateNote } }) as never,
      idCodec: identityCodec
    });
    const invalid = await handlers.updateNote(request(
      "PUT",
      "https://nxt.example/api/private/notes/not-a-uuid",
      { expectedVersion: "1", source: "x" },
      { noteId: "not-a-uuid" }
    ));
    const conflict = await handlers.updateNote(request(
      "PUT",
      `https://nxt.example/api/private/notes/${noteId}`,
      { expectedVersion: "1", source: "local source" },
      { noteId }
    ));

    expect(invalid.status).toBe(400);
    expect(conflict.status).toBe(409);
    expect(conflict.jsonBody).toMatchObject({
      error: { code: "CONFLICT", message: "The resource changed. Refresh and try again." }
    });
    expect(JSON.stringify(conflict.jsonBody)).not.toContain("local source");
  });

  it("rejects a 300KB source with 413 before invoking the note service", async () => {
    const updateNote = vi.fn();
    const handlers = createNoteHandlers({
      authorize: () => ({ provider: "github", userId: "owner", userDetails: "aserdargun" }),
      resolveServices: () => ({ vault: { updateNote } }) as never,
      idCodec: identityCodec
    });
    const response = await handlers.updateNote(request(
      "PUT", `https://nxt.example/api/private/notes/${noteId}`,
      { expectedVersion: "1", source: "x".repeat(300_000) }, { noteId }
    ));
    expect(response.status).toBe(413);
    expect(updateNote).not.toHaveBeenCalled();
  });

  it("fails a typed response closed with 413 instead of returning truncated success data", async () => {
    const large = "x".repeat(200_000);
    const handlers = createNoteHandlers({
      authorize: () => ({ provider: "github", userId: "owner", userDetails: "aserdargun" }),
      resolveServices: () => ({ vault: { getNote: async () => ({
        note: { frontmatter: { id: noteId, title: "Large", created: "2026-08-23T12:00:00.000Z", updated: "2026-08-23T12:00:00.000Z", tags: [], aliases: [] }, body: large, path: "Notes/Large.md" },
        source: large, driveId: "raw", version: "1", path: "Notes/Large.md", checksum: "a".repeat(64)
      }) } }) as never,
      idCodec: identityCodec
    });
    const response = await handlers.getNote(request("GET", `https://nxt.example/api/private/notes/${noteId}`, undefined, { noteId }));
    expect(response.status).toBe(413);
    expect(JSON.stringify(response.jsonBody)).not.toContain("[Truncated]");
  });
});

describe("private folder handlers", () => {
  it("supports an atomic client rename-and-move request with opaque destination parent", async () => {
    const folderId = "raw-folder";
    const destinationId = "raw-destination";
    const updateFolder = vi.fn(async () => ({ id: folderId, name: "Renamed", version: "3" }));
    const treeVersion = "d".repeat(64);
    const services = { vault: {
      updateFolder,
      vaultTree: async () => ({ treeVersion, folders: [{ id: folderId, name: "Renamed", path: "Notes/Inbox/Renamed", version: "3", protected: false }] })
    } } as never;
    const dependencies = {
      authorize: () => ({ provider: "github" as const, userId: "owner", userDetails: "aserdargun" }),
      resolveServices: () => services,
      idCodec: identityCodec
    };
    const folderRef = identityCodec.encode(folderId);
    const parentRef = identityCodec.encode(destinationId);
    const response = await createFolderHandlers(dependencies).updateFolder(request(
      "PUT", `https://nxt.example/api/private/folders/${folderRef}`,
      { expectedVersion: "1", name: "Renamed", parentId: parentRef }, { folderId: folderRef }
    ));
    expect(FolderResponseSchema.parse(response.jsonBody).path).toBe("Notes/Inbox/Renamed");
    expect(updateFolder).toHaveBeenCalledTimes(1);
    expect(updateFolder).toHaveBeenCalledWith({ folderId, expectedVersion: "1", name: "Renamed", parentId: destinationId });
  });

  it("returns the static redacted 409 body for a trusted folder version conflict", async () => {
    const rawFolderId = "raw-folder-conflict-id";
    const folderRef = identityCodec.encode(rawFolderId);
    const handlers = createFolderHandlers({
      authorize: () => ({ provider: "github", userId: "owner", userDetails: "aserdargun" }),
      resolveServices: () => ({
        vault: {
          updateFolder: async () => { throw new ApiResponseError("CONFLICT"); }
        }
      }) as never,
      idCodec: identityCodec
    });

    const response = await handlers.updateFolder(request(
      "PUT",
      `https://nxt.example/api/private/folders/${folderRef}`,
      { expectedVersion: "7", name: "Renamed" },
      { folderId: folderRef }
    ));

    expect(response.status).toBe(409);
    expect(response.jsonBody).toMatchObject({
      error: {
        code: "CONFLICT",
        message: "The resource changed. Refresh and try again."
      }
    });
    expect(JSON.stringify(response.jsonBody)).not.toContain(rawFolderId);
  });
});
