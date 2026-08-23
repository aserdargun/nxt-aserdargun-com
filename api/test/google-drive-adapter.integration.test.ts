import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertPrivateIntegrationFolderMetadata,
  createGoogleDriveClient,
  GOOGLE_DRIVE_INTEGRATION_FOLDER_FIELDS,
  GoogleDriveAdapter,
  RootBoundaryStorage
} from "../src/storage/index.js";

const integrationEnabled = globalThis.process.env.NXT_DRIVE_INTEGRATION === "1";
const liveDescribe = integrationEnabled ? describe : describe.skip;

liveDescribe("GoogleDriveAdapter live integration", () => {
  it("uses fixtures exclusively below the configured integration-test folder", async () => {
    const env = globalThis.process.env;
    const integrationFolderId = requireSetting(
      env.NXT_INTEGRATION_TEST_DRIVE_FOLDER_ID
    );
    const privateFolderId = requireSetting(env.NXT_PRIVATE_DRIVE_FOLDER_ID);
    const notesFolderId = requireSetting(env.NXT_NOTES_DRIVE_FOLDER_ID);

    const client = createGoogleDriveClient({
      clientId: requireSetting(env.GOOGLE_CLIENT_ID),
      clientSecret: requireSetting(env.GOOGLE_CLIENT_SECRET),
      refreshToken: requireSetting(env.GOOGLE_REFRESH_TOKEN)
    });
    const rawIntegration = await client.files.get({
      fileId: integrationFolderId,
      fields: GOOGLE_DRIVE_INTEGRATION_FOLDER_FIELDS
    });
    assertPrivateIntegrationFolderMetadata(rawIntegration.data, {
      privateFolderId,
      integrationFolderId,
      notesFolderId
    });
    const storage = new RootBoundaryStorage(
      new GoogleDriveAdapter(client, { rootId: integrationFolderId }),
      integrationFolderId
    );
    const name = `nxt-integration-${randomUUID()}.txt`;
    let fileId: string | undefined;
    try {
      const created = await storage.createText({
        parentId: integrationFolderId,
        name,
        mimeType: "text/plain",
        text: "one"
      });
      fileId = created.id;
      expect(created.parentIds).toEqual([integrationFolderId]);
      const updated = await storage.updateText({
        fileId,
        expectedVersion: created.version,
        mimeType: "text/plain",
        text: "two"
      });
      expect(updated.parentIds).toEqual([integrationFolderId]);
      expect(BigInt(updated.version)).toBeGreaterThan(BigInt(created.version));
      const readback = await storage.readText(fileId);
      expect(readback).toMatchObject({ text: "two" });
      expect(readback.file.parentIds).toEqual([integrationFolderId]);
      const seenFileIds = new Set<string>();
      const seenPageTokens = new Set<string>();
      let pageToken: string | undefined;
      let exhausted = false;
      for (let page = 0; page < 1000; page += 1) {
        const children = await storage.listChildren({
          parentId: integrationFolderId,
          pageSize: 1,
          ...(pageToken === undefined ? {} : { pageToken })
        });
        assertDirectActiveIntegrationChildren(
          children.files,
          integrationFolderId,
          seenFileIds
        );
        if (children.nextPageToken === undefined) {
          exhausted = true;
          break;
        }
        if (seenPageTokens.has(children.nextPageToken)) {
          throw new Error("Live Drive integration pagination is invalid.");
        }
        seenPageTokens.add(children.nextPageToken);
        pageToken = children.nextPageToken;
      }
      if (!exhausted) {
        throw new Error("Live Drive integration pagination limit exceeded.");
      }
      expect((await storage.listRevisions(fileId)).length).toBeGreaterThan(0);
    } finally {
      if (fileId !== undefined) await storage.trash(fileId);
    }
  });
});

const requireSetting = (value: string | undefined): string => {
  if (value === undefined || value.trim() === "")
    throw new Error("Live Drive integration setting is missing.");
  return value;
};

const assertDirectActiveIntegrationChildren = (
  files: ReadonlyArray<{
    id: string;
    mimeType: string;
    parentIds: string[];
    trashed: boolean;
  }>,
  integrationFolderId: string,
  seenFileIds: Set<string>
): void => {
  for (const file of files) {
    if (
      file.id.length === 0 ||
      file.id.length > 512 ||
      /[\r\n\0]/u.test(file.id) ||
      seenFileIds.has(file.id) ||
      file.trashed ||
      file.mimeType === "application/vnd.google-apps.shortcut" ||
      file.parentIds.length !== 1 ||
      file.parentIds[0] !== integrationFolderId
    ) {
      throw new Error("Live Drive integration child verification failed.");
    }
    seenFileIds.add(file.id);
  }
};
