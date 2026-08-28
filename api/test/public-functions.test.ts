import { HttpRequest } from "@azure/functions";
import { describe, expect, it, vi } from "vitest";
import { createPublicAssetHandler } from "../src/functions/public-assets.js";
import { createPublicNoteHandler } from "../src/functions/public-notes.js";
import { PublicRequestGate } from "../src/functions/public-http.js";
import { task7Routes, task8Routes, task9Routes } from "../src/functions/index.js";
import { createPublicationHandlers } from "../src/functions/publications.js";
import { ApiResponseError } from "../src/http/api-response.js";

const publicId = "A".repeat(22);
const assetId = "B".repeat(22);
const request = (method: string, url: string, params: Record<string, string> = {}, body?: unknown): HttpRequest => new HttpRequest({
  method,
  url,
  params,
  headers: { "content-type": "application/json" },
  ...(body === undefined ? {} : { body: { string: JSON.stringify(body) } })
});

describe("Task 9 functions", () => {
  it("bounds anonymous public work by rolling rate and concurrency", () => {
    let now = 1_000;
    const gate = new PublicRequestGate({
      maxConcurrent: 2,
      maxRequests: 3,
      windowMs: 100,
      now: () => now
    });

    const first = gate.tryAcquire();
    const second = gate.tryAcquire();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(gate.tryAcquire()).toBeNull();
    first?.();
    first?.();
    second?.();

    const third = gate.tryAcquire();
    expect(third).not.toBeNull();
    third?.();
    expect(gate.tryAcquire()).toBeNull();

    now += 101;
    expect(gate.tryAcquire()).not.toBeNull();
  });

  it("registers the Task 13 owner status route while preserving Task 7 and Task 8", () => {
    expect(task7Routes).toHaveLength(12);
    expect(task8Routes).toHaveLength(3);
    expect(task9Routes.map(({ method, route }) => `${method} ${route}`)).toEqual([
      "POST private/notes/{noteId}/publish",
      "GET private/notes/{noteId}/publication",
      "DELETE private/publications/{publicId}",
      "GET public/notes/{publicId}",
      "GET public/assets/{publicId}/{assetId}"
    ]);
  });

  it("authorizes publication status first and returns only the active revision projection", async () => {
    const getStatus = vi.fn(async () => ({
      publicId,
      publishedAt: "2026-08-26T12:00:00.000Z",
      sourceVersion: "7",
      attachmentCount: 2,
      activeRevisionId: "private-revision",
      snapshotFolderId: "private-folder"
    }));
    const handlers = createPublicationHandlers({
      authorize: () => ({ provider: "github", userId: "1", userDetails: "owner" }),
      resolveServices: () => ({
        publications: {
          publish: vi.fn(),
          revoke: vi.fn(),
          getStatus
        }
      })
    });
    const noteId = "018f47d2-6a34-7b2a-9f21-8a7034963aef";
    const response = await handlers.status(request(
      "GET",
      `https://nxt.example/api/private/notes/${noteId}/publication`,
      { noteId }
    ));

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({
      publicId,
      publishedAt: "2026-08-26T12:00:00.000Z",
      sourceVersion: "7",
      attachmentCount: 2
    });
    expect(JSON.stringify(response.jsonBody)).not.toMatch(/revision|folder|drive/iu);
    expect(getStatus).toHaveBeenCalledWith(noteId);
  });

  it("authorizes private publication before resolving services", async () => {
    const resolveServices = vi.fn();
    const handlers = createPublicationHandlers({
      authorize: () => { throw new ApiResponseError("FORBIDDEN"); },
      resolveServices
    });
    const response = await handlers.publish(request("POST", "https://nxt.example/api/private/notes/bad/publish", { noteId: "bad" }, {}));
    expect(response.status).toBe(403);
    expect(resolveServices).not.toHaveBeenCalled();
  });

  it("validates strict private inputs and returns only safe publication fields", async () => {
    const publish = vi.fn(async () => ({ publicId, publishedAt: "2026-08-24T12:00:00.000Z", snapshotDriveId: "raw-drive-id" }));
    const revoke = vi.fn(async () => ({ revoked: true as const }));
    const handlers = createPublicationHandlers({
      authorize: () => ({ provider: "github", userId: "1", userDetails: "owner" }),
      resolveServices: () => ({ publications: { publish, revoke, getStatus: vi.fn(async () => null) } })
    });
    const response = await handlers.publish(request("POST", `https://nxt.example/api/private/notes/018f47d2-6a34-7b2a-9f21-8a7034963aef/publish`, { noteId: "018f47d2-6a34-7b2a-9f21-8a7034963aef" }, { expectedVersion: "7" }));
    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ publicId, publishedAt: "2026-08-24T12:00:00.000Z" });
    expect(JSON.stringify(response.jsonBody)).not.toContain("raw-drive-id");

    const invalid = await handlers.publish(request("POST", `https://nxt.example/api/private/notes/018f47d2-6a34-7b2a-9f21-8a7034963aef/publish`, { noteId: "018f47d2-6a34-7b2a-9f21-8a7034963aef" }, { expectedVersion: "7", extra: true }));
    expect(invalid.status).toBe(400);
  });

  it("serves anonymous notes with no-store security headers and a request ID", async () => {
    const authorize = vi.fn();
    const handler = createPublicNoteHandler({
      resolveReader: () => ({
        getNote: async () => ({
          title: "Public",
          html: "<p>safe</p>",
          publishedAt: "2026-08-24T12:00:00.000Z",
          sourceVersion: "7",
          assets: [{ assetId, url: `/api/public/assets/${publicId}/${assetId}`, name: "safe.png", mimeType: "image/png", disposition: "inline" as const }]
        })
      })
    });
    const response = await handler(request("GET", `https://nxt.example/api/public/notes/${publicId}`, { publicId }));
    expect(response.status).toBe(200);
    expect(response.headers).toMatchObject({
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "x-content-type-options": "nosniff"
    });
    expect(response.headers?.["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(authorize).not.toHaveBeenCalled();
  });

  it("maps malformed, unknown, corrupt, and raw-ID public note probes to one generic 404", async () => {
    const resolveReader = vi.fn(() => ({ getNote: async () => { throw new ApiResponseError("DRIVE_UNAVAILABLE"); } }));
    const handler = createPublicNoteHandler({ resolveReader });
    for (const probe of ["bad", "raw-drive-file-id", publicId]) {
      const response = await handler(request("GET", `https://nxt.example/api/public/notes/${probe}`, { publicId: probe }));
      expect(response.status).toBe(404);
      expect(response.jsonBody).toMatchObject({ error: { code: "NOT_FOUND", message: "The requested resource was not found." } });
      expect(response.headers?.["cache-control"]).toBe("no-store");
      expect(response.headers?.["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/u);
      expect(JSON.stringify(response.jsonBody)).not.toMatch(/drive|manifest|path/iu);
    }
  });

  it("rejects saturated public routes before resolving Drive-backed readers", async () => {
    const resolveNoteReader = vi.fn();
    const resolveAssetReader = vi.fn();
    const noteHandler = createPublicNoteHandler({
      resolveReader: resolveNoteReader,
      admit: () => null
    });
    const assetHandler = createPublicAssetHandler({
      resolveReader: resolveAssetReader,
      admit: () => null
    });

    const noteResponse = await noteHandler(request(
      "GET",
      `https://nxt.example/api/public/notes/${publicId}`,
      { publicId }
    ));
    const assetResponse = await assetHandler(request(
      "GET",
      `https://nxt.example/api/public/assets/${publicId}/${assetId}`,
      { publicId, assetId }
    ));

    expect(noteResponse.status).toBe(404);
    expect(assetResponse.status).toBe(404);
    expect(resolveNoteReader).not.toHaveBeenCalled();
    expect(resolveAssetReader).not.toHaveBeenCalled();
  });

  it("derives public asset headers from verified delivery and uses a safe RFC5987 filename", async () => {
    const handler = createPublicAssetHandler({
      resolveReader: () => ({
        getAsset: async () => ({ bytes: Uint8Array.of(1, 2, 3), name: "evil\r\nname.webp", mimeType: "image/webp", disposition: "download" as const })
      })
    });
    const response = await handler(request("GET", `https://nxt.example/api/public/assets/${publicId}/${assetId}`, { publicId, assetId }));
    expect(response.status).toBe(200);
    expect(response.headers).toMatchObject({
      "content-type": "image/webp",
      "content-disposition": "attachment; filename*=UTF-8''evilname.webp",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "x-content-type-options": "nosniff"
    });
    expect(response.headers?.["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("never lets a public asset parameter reach private storage as an arbitrary identifier", async () => {
    const getAsset = vi.fn(async () => { throw new ApiResponseError("NOT_FOUND"); });
    const handler = createPublicAssetHandler({ resolveReader: () => ({ getAsset }) });
    const malformed = await handler(request("GET", "https://nxt.example/api/public/assets/raw/drive", { publicId: "raw-drive-id", assetId: "other-drive-id" }));
    expect(malformed.status).toBe(404);
    expect(getAsset).not.toHaveBeenCalled();

    const unknown = await handler(request("GET", `https://nxt.example/api/public/assets/${publicId}/${assetId}`, { publicId, assetId }));
    expect(unknown.status).toBe(404);
    expect(getAsset).toHaveBeenCalledWith(publicId, assetId);
  });
});
