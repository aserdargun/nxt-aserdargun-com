import { HttpRequest } from "@azure/functions";
import { ApiResponseError } from "../src/http/api-response.js";
import { describe, expect, it, vi } from "vitest";
import { task7Routes } from "../src/functions/index.js";
import { createNoteHandlers } from "../src/functions/notes.js";
import { createVaultHandlers } from "../src/functions/vault.js";

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

const identityCodec = { encode: (value: string) => `opaque-${value}`, decode: (value: string) => value.replace(/^opaque-/u, "") };

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
            treeVersion: "tree-version",
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
    expect(serialized).toContain("opaque-raw-folder-drive-id");
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

    const response = await handlers.createNote(request("POST", "https://nxt.example/api/private/notes", {
      title: "Plan",
      body: "# Plan",
      folderId: "opaque-raw-folder-drive-id"
    }));

    expect(response.status).toBe(201);
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
});
