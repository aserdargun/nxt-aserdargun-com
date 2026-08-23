import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createGoogleDriveClient,
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
    const notesFolderId = requireSetting(env.NXT_NOTES_DRIVE_FOLDER_ID);
    expect(integrationFolderId).not.toBe(notesFolderId);

    const client = createGoogleDriveClient({
      clientId: requireSetting(env.GOOGLE_CLIENT_ID),
      clientSecret: requireSetting(env.GOOGLE_CLIENT_SECRET),
      refreshToken: requireSetting(env.GOOGLE_REFRESH_TOKEN)
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
      const updated = await storage.updateText({
        fileId,
        expectedVersion: created.version,
        mimeType: "text/plain",
        text: "two"
      });
      expect(BigInt(updated.version)).toBeGreaterThan(BigInt(created.version));
      await expect(storage.readText(fileId)).resolves.toMatchObject({
        text: "two"
      });
      const firstPage = await storage.listChildren({
        parentId: integrationFolderId,
        pageSize: 1
      });
      expect(firstPage.files.length).toBeLessThanOrEqual(1);
      if (firstPage.nextPageToken !== undefined) {
        await expect(
          storage.listChildren({
            parentId: integrationFolderId,
            pageSize: 1,
            pageToken: firstPage.nextPageToken
          })
        ).resolves.toMatchObject({ files: expect.any(Array) });
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
