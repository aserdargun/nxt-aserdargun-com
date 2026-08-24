import { describe, expect, it } from "vitest";
import {
  assertPrivateIntegrationFolderMetadata,
  wrapGoogleDriveClient
} from "../src/storage/google-drive-client.js";

describe("wrapGoogleDriveClient", () => {
  it("disables gaxios retries on metadata, media, list, revision, and write requests", async () => {
    const calls: Array<{ method: string; input: unknown; options: unknown }> = [];
    const response = { data: {} };
    const raw = {
      files: {
        get: async (input: unknown, options: unknown) => {
          calls.push({ method: "get", input, options });
          return response;
        },
        list: async (input: unknown, options: unknown) => {
          calls.push({ method: "list", input, options });
          return response;
        },
        create: async (input: unknown, options: unknown) => {
          calls.push({ method: "create", input, options });
          return response;
        },
        update: async (input: unknown, options: unknown) => {
          calls.push({ method: "update", input, options });
          return response;
        }
      },
      revisions: {
        list: async (input: unknown, options: unknown) => {
          calls.push({ method: "revisions.list", input, options });
          return response;
        }
      }
    };
    const client = wrapGoogleDriveClient(raw);

    await client.files.get({ fileId: "file", fields: "id" });
    await client.files.get({ fileId: "file", alt: "media" }, { responseType: "arraybuffer" });
    await client.files.list({ q: "'parent' in parents", spaces: "drive", pageSize: 1, fields: "files(id)" });
    await client.files.create({
      requestBody: { name: "file", mimeType: "text/plain", parents: ["parent"] },
      fields: "id"
    });
    await client.files.update(
      { fileId: "file", requestBody: { trashed: true }, fields: "id" },
      { headers: { "If-Match": '"observed-etag"' } }
    );
    await client.revisions.list({ fileId: "file", pageSize: 100, fields: "revisions(id)" });

    expect(calls.map(({ method, options }) => ({ method, options }))).toEqual([
      { method: "get", options: { retry: false } },
      { method: "get", options: { responseType: "arraybuffer", retry: false } },
      { method: "list", options: { retry: false } },
      { method: "create", options: { retry: false } },
      { method: "update", options: { headers: { "If-Match": '"observed-etag"' }, retry: false } },
      { method: "revisions.list", options: { retry: false } }
    ]);
  });

  it("accepts only the exact owned integration folder directly below the private root", () => {
    const metadata = {
      id: "integration-id",
      name: "integration-tests",
      mimeType: "application/vnd.google-apps.folder",
      parents: ["private-id"],
      trashed: false,
      ownedByMe: true,
      permissions: [{ id: "owner-permission", type: "user", role: "owner" }]
    };
    expect(() =>
      assertPrivateIntegrationFolderMetadata(metadata, {
        privateFolderId: "private-id",
        integrationFolderId: "integration-id",
        notesFolderId: "notes-id"
      })
    ).not.toThrow();

    const invalidCases = [
      { metadata: { ...metadata, id: "wrong-id" } },
      { metadata: { ...metadata, name: "Notes" } },
      { metadata: { ...metadata, mimeType: "text/plain" } },
      { metadata: { ...metadata, parents: ["notes-id"] } },
      { metadata: { ...metadata, parents: ["private-id", "other"] } },
      { metadata: { ...metadata, trashed: true } },
      { metadata: { ...metadata, ownedByMe: false } },
      { metadata: { ...metadata, permissions: [] } },
      { settings: { privateFolderId: "integration-id" } },
      { settings: { notesFolderId: "integration-id" } },
      { settings: { notesFolderId: "private-id" } }
    ];
    for (const invalid of invalidCases) {
      expect(() =>
        assertPrivateIntegrationFolderMetadata(
          invalid.metadata ?? metadata,
          {
            privateFolderId: "private-id",
            integrationFolderId: "integration-id",
            notesFolderId: "notes-id",
            ...invalid.settings
          }
        )
      ).toThrow("integration folder verification failed");
    }
  });
});
