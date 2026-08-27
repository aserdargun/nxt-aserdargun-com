import { describe, expect, it } from "vitest";
import {
  assertPrivateIntegrationFolderMetadata,
  wrapGoogleDriveClient
} from "../src/storage/google-drive-client.js";

describe("wrapGoogleDriveClient", () => {
  it("uses the Drive v2 resource token for preconditioned writes and disables gaxios retries", async () => {
    const calls: Array<{ method: string; input: unknown; options: unknown }> = [];
    const response = { data: {} };
    const rawV3 = {
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
      },
      revisions: {
        list: async (input: unknown, options: unknown) => {
          calls.push({ method: "revisions.list", input, options });
          return response;
        }
      }
    };
    const rawV2 = {
      files: {
        get: async (input: unknown, options: unknown) => {
          calls.push({ method: "v2.files.get", input, options });
          return { data: { id: "file", etag: '"observed-etag"', version: "7" } };
        },
        patch: async (input: unknown, options: unknown) => {
          calls.push({ method: "v2.files.patch", input, options });
          return response;
        },
        update: async (input: unknown, options: unknown) => {
          calls.push({ method: "v2.files.update", input, options });
          return response;
        }
      }
    };
    const client = wrapGoogleDriveClient(rawV3, rawV2);

    await client.files.get({ fileId: "file", fields: "id" });
    await client.files.get({ fileId: "file", alt: "media" }, { responseType: "arraybuffer" });
    await client.files.getVersion("file");
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
      { method: "v2.files.get", options: { retry: false } },
      { method: "list", options: { retry: false } },
      { method: "create", options: { retry: false } },
      { method: "v2.files.patch", options: { headers: { "If-Match": '"observed-etag"' }, retry: false } },
      { method: "revisions.list", options: { retry: false } }
    ]);

    expect(calls[2]?.input).toEqual({
      fileId: "file",
      fields: "id,etag,version",
      updateViewedDate: false
    });
    expect(calls[5]?.input).toEqual({
      fileId: "file",
      requestBody: { labels: { trashed: true } },
      fields: "id"
    });
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

  it("maps a Drive v3 rename and parent move to one preconditioned v2 patch", async () => {
    const { client, patches } = versionedClient();

    await client.files.update(
      {
        fileId: "file",
        requestBody: { name: "renamed.md" },
        addParents: "new-parent",
        removeParents: "old-parent",
        fields: "id"
      },
      { headers: { "If-Match": '"observed-etag"' } }
    );

    expect(patches).toEqual([
      {
        input: {
          fileId: "file",
          requestBody: { title: "renamed.md" },
          addParents: "new-parent",
          removeParents: "old-parent",
          fields: "id"
        },
        options: {
          headers: { "If-Match": '"observed-etag"' },
          retry: false
        }
      }
    ]);
  });

  it("maps a Drive v3 media update to one preconditioned v2 update", async () => {
    const { client, updates } = versionedClient();

    await client.files.update(
      {
        fileId: "file",
        requestBody: { mimeType: "text/markdown" },
        media: { mimeType: "text/markdown", body: "next" },
        fields: "id"
      },
      { headers: { "If-Match": '"observed-etag"' } }
    );

    expect(updates).toEqual([
      {
        input: {
          fileId: "file",
          requestBody: { mimeType: "text/markdown" },
          media: { mimeType: "text/markdown", body: "next" },
          fields: "id"
        },
        options: {
          headers: { "If-Match": '"observed-etag"' },
          retry: false
        }
      }
    ]);
  });
});

const versionedClient = () => {
  const response = { data: {} };
  const patches: Array<{ input: unknown; options: unknown }> = [];
  const updates: Array<{ input: unknown; options: unknown }> = [];
  const rawV3 = {
    files: {
      get: async () => response,
      list: async () => response,
      create: async () => response
    },
    revisions: { list: async () => response }
  };
  const rawV2 = {
    files: {
      get: async () => ({
        data: { id: "file", etag: '"observed-etag"', version: "7" }
      }),
      patch: async (input: unknown, options: unknown) => {
        patches.push({ input, options });
        return response;
      },
      update: async (input: unknown, options: unknown) => {
        updates.push({ input, options });
        return response;
      }
    }
  };
  return { client: wrapGoogleDriveClient(rawV3, rawV2), patches, updates };
};
