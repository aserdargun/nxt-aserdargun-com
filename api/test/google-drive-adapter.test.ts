import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  GoogleDriveAdapter,
  RootBoundaryStorage
} from "../src/storage/index.js";
import type { GoogleDriveClient } from "../src/storage/google-drive-client.js";

const FILE_FIELDS =
  "id,name,mimeType,parents,version,modifiedTime,size,trashed,md5Checksum";
const LIST_FIELDS = `nextPageToken,files(${FILE_FIELDS})`;
const REVISION_FIELDS = "nextPageToken,revisions(id,modifiedTime)";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const SHORTCUT_MIME_TYPE = "application/vnd.google-apps.shortcut";

describe("GoogleDriveAdapter", () => {
  it("escapes query literals, uses exact fields, and forwards pagination", async () => {
    const calls: unknown[] = [];
    const client = createClient({
      list: async (input) => {
        calls.push(input);
        return {
          data: {
            files: [
              driveFile({ id: "child", name: "safe.md", parents: ["parent"] })
            ],
            nextPageToken: "next-page"
          }
        };
      }
    });
    const adapter = new GoogleDriveAdapter(client);
    const page = await adapter.listChildren({
      parentId: "parent'\\) or name != 'safe",
      pageToken: "supplied-page",
      pageSize: 2
    });

    expect(calls).toEqual([
      {
        q: "'parent\\'\\\\) or name != \\'safe' in parents and trashed = false",
        spaces: "drive",
        pageSize: 2,
        pageToken: "supplied-page",
        fields: LIST_FIELDS
      }
    ]);
    expect(page).toEqual({
      files: [
        {
          id: "child",
          name: "safe.md",
          mimeType: "text/markdown",
          parentIds: ["parent"],
          version: "1",
          modifiedTime: "2026-08-23T00:00:00.000Z",
          size: 4,
          trashed: false
        }
      ],
      nextPageToken: "next-page"
    });
  });

  it("paginates revision reads with the exact field mask", async () => {
    const calls: unknown[] = [];
    const responses = [
      {
        data: {
          revisions: [{ id: "1", modifiedTime: "2026-08-22T00:00:00.000Z" }],
          nextPageToken: "next"
        }
      },
      {
        data: {
          revisions: [{ id: "2", modifiedTime: "2026-08-23T00:00:00.000Z" }]
        }
      }
    ];
    const adapter = new GoogleDriveAdapter(
      createClient({
        revisionsList: async (input) => {
          calls.push(input);
          return responses.shift() as (typeof responses)[number];
        }
      })
    );

    await expect(adapter.listRevisions("file-id")).resolves.toEqual([
      { id: "1", modifiedTime: "2026-08-22T00:00:00.000Z" },
      { id: "2", modifiedTime: "2026-08-23T00:00:00.000Z" }
    ]);
    expect(calls).toEqual([
      { fileId: "file-id", pageSize: 100, fields: REVISION_FIELDS },
      {
        fileId: "file-id",
        pageSize: 100,
        fields: REVISION_FIELDS,
        pageToken: "next"
      }
    ]);
  });

  it("stops before a text update when the observed version conflicts", async () => {
    let updateCalls = 0;
    const adapter = new GoogleDriveAdapter(
      createClient({
        get: async () => ({ data: driveFile({ version: "7" }) }),
        update: async () => {
          updateCalls += 1;
          return { data: { id: "file-id" } };
        }
      })
    );

    await expect(
      adapter.updateText({
        fileId: "file-id",
        expectedVersion: "6",
        mimeType: "text/markdown",
        text: "next"
      })
    ).rejects.toThrow("version conflict");
    expect(updateCalls).toBe(0);
  });

  it("uses multipart upload, reads back the checksum, and never retries a write", async () => {
    const updateInputs: unknown[] = [];
    let metadataVersion = "1";
    const client = createClient({
      get: async () => ({
        data: driveFile({
          version: metadataVersion,
          size: "4",
          md5Checksum: createHash("md5")
            .update(metadataVersion === "1" ? "old!" : "next")
            .digest("hex")
        })
      }),
      update: async (input) => {
        updateInputs.push(input);
        metadataVersion = "2";
        return { data: { id: "file-id" } };
      }
    });
    const adapter = new GoogleDriveAdapter(client);
    const updated = await adapter.updateText({
      fileId: "file-id",
      expectedVersion: "1",
      mimeType: "text/markdown",
      text: "next"
    });

    expect(updateInputs).toEqual([
      {
        fileId: "file-id",
        requestBody: { mimeType: "text/markdown" },
        media: { mimeType: "text/markdown", body: "next" },
        fields: "id"
      }
    ]);
    expect(updated.version).toBe("2");

    let failedWriteCalls = 0;
    const failing = new GoogleDriveAdapter(
      createClient({
        get: async () => ({ data: driveFile({ version: "1" }) }),
        update: async () => {
          failedWriteCalls += 1;
          throw statusError(503, "write-token");
        }
      }),
      { sleep: async () => undefined, random: () => 0 }
    );
    await expect(
      failing.updateText({
        fileId: "file-id",
        expectedVersion: "1",
        mimeType: "text/markdown",
        text: "next"
      })
    ).rejects.toThrow("Drive write failed");
    expect(failedWriteCalls).toBe(1);
  });

  it("retries only allowlisted idempotent read statuses with a bounded attempt count", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const adapter = new GoogleDriveAdapter(
      createClient({
        get: async () => {
          attempts += 1;
          if (attempts < 3)
            throw statusError(attempts === 1 ? 429 : 503, "read-token");
          return { data: driveFile() };
        }
      }),
      {
        sleep: async (milliseconds) => delays.push(milliseconds),
        random: () => 0
      }
    );
    await expect(adapter.get("file-id")).resolves.toMatchObject({
      id: "file-id"
    });
    expect(attempts).toBe(3);
    expect(delays).toEqual([50, 100]);

    let forbiddenAttempts = 0;
    const forbidden = new GoogleDriveAdapter(
      createClient({
        get: async () => {
          forbiddenAttempts += 1;
          throw statusError(403, "secret-in-error");
        }
      }),
      { sleep: async () => undefined, random: () => 0 }
    );
    await expect(forbidden.get("raw-private-drive-id")).rejects.toThrow(
      "Drive read failed"
    );
    expect(forbiddenAttempts).toBe(1);

    for (const status of [408, 501]) {
      let nonAllowlistedAttempts = 0;
      const nonAllowlisted = new GoogleDriveAdapter(
        createClient({
          get: async () => {
            nonAllowlistedAttempts += 1;
            throw statusError(status, "non-allowlisted-token");
          }
        }),
        { sleep: async () => undefined, random: () => 0 }
      );
      await expect(nonAllowlisted.get("file-id")).rejects.toThrow(
        "Drive read failed"
      );
      expect(nonAllowlistedAttempts).toBe(1);
    }

    let unavailableAttempts = 0;
    const unavailable = new GoogleDriveAdapter(
      createClient({
        get: async () => {
          unavailableAttempts += 1;
          throw statusError(503, "unavailable-token");
        }
      }),
      { sleep: async () => undefined, random: () => 0 }
    );
    await expect(unavailable.get("file-id")).rejects.toThrow(
      "Drive read failed"
    );
    expect(unavailableAttempts).toBe(3);
  });

  it("redacts client errors and emits no secret logs", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const adapter = new GoogleDriveAdapter(
      createClient({
        get: async () => {
          throw statusError(
            403,
            "refresh-token raw-private-drive-id Authorization: Bearer secret"
          );
        }
      })
    );
    let surfaced = "";
    try {
      await adapter.get("raw-private-drive-id");
    } catch (error) {
      surfaced = error instanceof Error ? error.message : String(error);
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
    expect(surfaced).toBe("Google Drive read failed.");
    expect(surfaced).not.toContain("raw-private-drive-id");
    expect(surfaced).not.toContain("refresh-token");
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("combines with the root boundary to reject ambiguous ancestry, shortcuts, and Trash", async () => {
    const graph = new Map([
      [
        "vault",
        driveFile({
          id: "vault",
          name: "vault",
          mimeType: FOLDER_MIME_TYPE,
          parents: []
        })
      ],
      ["note", driveFile({ id: "note", parents: ["vault", "other"] })],
      [
        "link",
        driveFile({
          id: "link",
          mimeType: SHORTCUT_MIME_TYPE,
          parents: ["vault"]
        })
      ],
      [
        "trashed",
        driveFile({ id: "trashed", parents: ["vault"], trashed: true })
      ]
    ]);
    const bounded = new RootBoundaryStorage(
      new GoogleDriveAdapter(
        createClient({
          get: async ({ fileId }) => ({ data: graph.get(fileId) })
        })
      ),
      "vault"
    );

    await expect(bounded.assertInside("note")).rejects.toThrow(
      "ambiguous ancestry"
    );
    await expect(bounded.assertInside("link")).rejects.toThrow("shortcut");
    await expect(bounded.assertInside("trashed")).rejects.toThrow("trashed");
  });

  it("normalizes only the configured boundary root while retaining descendant ancestry", async () => {
    const graph = new Map([
      [
        "vault",
        driveFile({
          id: "vault",
          name: "vault",
          mimeType: FOLDER_MIME_TYPE,
          parents: ["my-drive"]
        })
      ],
      ["note", driveFile({ id: "note", parents: ["vault"] })]
    ]);
    const bounded = new RootBoundaryStorage(
      new GoogleDriveAdapter(
        createClient({
          get: async ({ fileId }) => ({ data: graph.get(fileId) })
        }),
        { rootId: "vault" }
      ),
      "vault"
    );

    await expect(bounded.assertInside("note")).resolves.toBeUndefined();
  });

  it("moves items to Trash only through files.update", async () => {
    const calls: unknown[] = [];
    let metadataReads = 0;
    const adapter = new GoogleDriveAdapter(
      createClient({
        update: async (input) => {
          calls.push(input);
          return { data: { id: "file-id" } };
        },
        get: async () => ({
          data: driveFile({
            trashed: metadataReads++ > 0,
            version: metadataReads > 1 ? "2" : "1"
          })
        })
      })
    );
    const trashed = await adapter.trash("file-id");

    expect(calls).toEqual([
      { fileId: "file-id", requestBody: { trashed: true }, fields: "id" }
    ]);
    expect(trashed.trashed).toBe(true);
  });

  it("never trashes the configured boundary root", async () => {
    let updateCalls = 0;
    const adapter = new GoogleDriveAdapter(
      createClient({
        update: async () => {
          updateCalls += 1;
          return { data: { id: "vault" } };
        }
      }),
      { rootId: "vault" }
    );

    await expect(adapter.trash("vault")).rejects.toThrow(
      "cannot trash configured root"
    );
    expect(updateCalls).toBe(0);
  });

  it("creates bytes through multipart and rejects checksum mismatch", async () => {
    const createInputs: unknown[] = [];
    const adapter = new GoogleDriveAdapter(
      createClient({
        create: async (input) => {
          createInputs.push(input);
          return { data: { id: "created-id" } };
        },
        get: async () => ({
          data: driveFile({ id: "created-id", md5Checksum: "wrong" })
        })
      })
    );

    await expect(
      adapter.createBytes({
        parentId: "parent-id",
        name: "asset.bin",
        mimeType: "application/octet-stream",
        bytes: new Uint8Array([1, 2, 3])
      })
    ).rejects.toThrow("upload verification failed");
    expect(createInputs).toEqual([
      {
        requestBody: {
          name: "asset.bin",
          mimeType: "application/octet-stream",
          parents: ["parent-id"]
        },
        media: {
          mimeType: "application/octet-stream",
          body: new Uint8Array([1, 2, 3])
        },
        fields: "id"
      }
    ]);
  });

  it("fails create readback when Drive changes the requested parent, name, or MIME", async () => {
    const adapter = new GoogleDriveAdapter(
      createClient({
        create: async () => ({ data: { id: "created-id" } }),
        get: async () => ({
          data: driveFile({
            id: "created-id",
            name: "unexpected",
            mimeType: FOLDER_MIME_TYPE,
            parents: ["other-parent"],
            size: undefined,
            md5Checksum: undefined
          })
        })
      })
    );

    await expect(
      adapter.createFolder({ parentId: "parent-id", name: "expected" })
    ).rejects.toThrow("create verification failed");
  });

  it("rejects a create whose readback ID differs from the write response", async () => {
    const adapter = new GoogleDriveAdapter(
      createClient({
        create: async () => ({ data: { id: "created-id" } }),
        get: async () => ({
          data: driveFile({
            id: "different-id",
            name: "expected",
            mimeType: FOLDER_MIME_TYPE,
            parents: ["parent-id"],
            size: undefined,
            md5Checksum: undefined
          })
        })
      })
    );

    await expect(
      adapter.createFolder({ parentId: "parent-id", name: "expected" })
    ).rejects.toThrow("create verification failed");
  });

  it("rejects update MIME changes and any concurrent identity, name, MIME, ancestry, trash, or version change", async () => {
    let writes = 0;
    const changedMime = new GoogleDriveAdapter(
      createClient({
        get: async () => ({ data: driveFile() }),
        update: async () => {
          writes += 1;
          return { data: { id: "file-id" } };
        }
      })
    );
    await expect(
      changedMime.updateText({
        fileId: "file-id",
        expectedVersion: "1",
        mimeType: "text/plain",
        text: "next"
      })
    ).rejects.toThrow("MIME");
    expect(writes).toBe(0);

    const mutations = [
      { id: "different-id" },
      { name: "renamed.md" },
      { mimeType: "text/plain" },
      { parents: ["other-parent"] },
      { parents: ["parent", "other-parent"] },
      { trashed: true },
      { version: "1" }
    ];
    for (const mutation of mutations) {
      let metadataReads = 0;
      const adapter = new GoogleDriveAdapter(
        createClient({
          get: async () => ({
            data:
              metadataReads++ === 0
                ? driveFile()
                : driveFile({
                    version: "2",
                    size: "4",
                    md5Checksum: createHash("md5").update("next").digest("hex"),
                    ...mutation
                  })
          }),
          update: async () => ({ data: { id: "file-id" } })
        })
      );
      await expect(
        adapter.updateText({
          fileId: "file-id",
          expectedVersion: "1",
          mimeType: "text/markdown",
          text: "next"
        })
      ).rejects.toThrow("upload verification failed");
    }

    const wrongWriteId = new GoogleDriveAdapter(
      createClient({
        get: async () => ({ data: driveFile() }),
        update: async () => ({ data: { id: "different-id" } })
      })
    );
    await expect(
      wrongWriteId.updateText({
        fileId: "file-id",
        expectedVersion: "1",
        mimeType: "text/markdown",
        text: "next"
      })
    ).rejects.toThrow("upload verification failed");
  });

  it("verifies move identity, name, MIME, active state, exact parent, and newer version", async () => {
    const failures = [
      { after: { id: "different-id" } },
      { after: { name: "renamed.md" } },
      { after: { mimeType: "text/plain" } },
      { after: { trashed: true } },
      { after: { parents: ["other-parent"] } },
      { after: { parents: ["to-parent", "other-parent"] } },
      { after: { version: "1" } },
      { after: {}, writeId: "different-id" }
    ];
    for (const failure of failures) {
      let metadataReads = 0;
      const adapter = new GoogleDriveAdapter(
        createClient({
          get: async () => ({
            data:
              metadataReads++ === 0
                ? driveFile({ parents: ["from-parent"] })
                : driveFile({
                    parents: ["to-parent"],
                    version: "2",
                    ...failure.after
                  })
          }),
          update: async () => ({
            data: { id: failure.writeId ?? "file-id" }
          })
        })
      );
      await expect(
        adapter.move({
          fileId: "file-id",
          fromParentId: "from-parent",
          toParentId: "to-parent"
        })
      ).rejects.toThrow("move verification failed");
    }

    let metadataReads = 0;
    const renamed = new GoogleDriveAdapter(
      createClient({
        get: async () => ({
          data:
            metadataReads++ === 0
              ? driveFile({ parents: ["from-parent"] })
              : driveFile({
                  name: "renamed.md",
                  parents: ["to-parent"],
                  version: "2"
                })
        }),
        update: async () => ({ data: { id: "file-id" } })
      })
    );
    await expect(
      renamed.move({
        fileId: "file-id",
        fromParentId: "from-parent",
        toParentId: "to-parent",
        newName: "renamed.md"
      })
    ).resolves.toMatchObject({ name: "renamed.md", parentIds: ["to-parent"] });
  });

  it("verifies trash identity, name, MIME, ancestry, prior active state, and newer version", async () => {
    const failures = [
      { after: { id: "different-id" } },
      { after: { name: "renamed.md" } },
      { after: { mimeType: "text/plain" } },
      { after: { trashed: false } },
      { after: { parents: ["other-parent"] } },
      { after: { parents: ["parent", "other-parent"] } },
      { after: { version: "1" } },
      { after: {}, writeId: "different-id" }
    ];
    for (const failure of failures) {
      let metadataReads = 0;
      const adapter = new GoogleDriveAdapter(
        createClient({
          get: async () => ({
            data:
              metadataReads++ === 0
                ? driveFile()
                : driveFile({ trashed: true, version: "2", ...failure.after })
          }),
          update: async () => ({
            data: { id: failure.writeId ?? "file-id" }
          })
        })
      );
      await expect(adapter.trash("file-id")).rejects.toThrow(
        "Trash verification failed"
      );
    }

    let updateCalls = 0;
    const alreadyTrashed = new GoogleDriveAdapter(
      createClient({
        get: async () => ({ data: driveFile({ trashed: true }) }),
        update: async () => {
          updateCalls += 1;
          return { data: { id: "file-id" } };
        }
      })
    );
    await expect(alreadyTrashed.trash("file-id")).rejects.toThrow("trashed");
    expect(updateCalls).toBe(0);
  });

  it("rejects a media read whose bytes do not match Drive checksum metadata", async () => {
    const adapter = new GoogleDriveAdapter(
      createClient({
        get: async (input) =>
          input.alt === "media"
            ? { data: new TextEncoder().encode("tampered") }
            : {
                data: driveFile({
                  md5Checksum: createHash("md5")
                    .update("expected")
                    .digest("hex"),
                  size: "8"
                })
              }
      })
    );

    await expect(adapter.readBytes("file-id")).rejects.toThrow(
      "checksum verification failed"
    );
  });
});

const driveFile = (overrides: Record<string, unknown> = {}) => ({
  id: "file-id",
  name: "note.md",
  mimeType: "text/markdown",
  parents: ["parent"],
  version: "1",
  modifiedTime: "2026-08-23T00:00:00.000Z",
  size: "4",
  trashed: false,
  md5Checksum: createHash("md5").update("text").digest("hex"),
  ...overrides
});

const statusError = (status: number, message: string) =>
  Object.assign(new Error(message), { response: { status } });

const createClient = (
  overrides: {
    get?: GoogleDriveClient["files"]["get"];
    list?: GoogleDriveClient["files"]["list"];
    create?: GoogleDriveClient["files"]["create"];
    update?: GoogleDriveClient["files"]["update"];
    revisionsList?: GoogleDriveClient["revisions"]["list"];
  } = {}
): GoogleDriveClient => ({
  files: {
    get: overrides.get ?? (async () => ({ data: driveFile() })),
    list: overrides.list ?? (async () => ({ data: { files: [] } })),
    create: overrides.create ?? (async () => ({ data: { id: "created-id" } })),
    update: overrides.update ?? (async () => ({ data: { id: "file-id" } }))
  },
  revisions: {
    list: overrides.revisionsList ?? (async () => ({ data: { revisions: [] } }))
  }
});
