import { createHash } from "node:crypto";
import { PreferencesSchema, VaultIndexSchema } from "@nxt/contracts";
import { createGoogleDriveClient } from "../storage/google-drive-client.js";
import { GoogleDriveAdapter } from "../storage/google-drive-adapter.js";
import { RootBoundaryStorage } from "../storage/root-boundary.js";
import type { Task7Services } from "../functions/private-api.js";
import { PreferencesService } from "./preferences-service.js";
import { RescanService } from "./rescan-service.js";
import { SystemFileStore } from "./system-file-store.js";
import { VaultService } from "./vault-service.js";

let cached: Task7Services | undefined;

export const resolveTask7Services = (): Task7Services => {
  if (cached !== undefined) return cached;
  const clientSecret = env("GOOGLE_CLIENT_SECRET");
  const refreshToken = env("GOOGLE_REFRESH_TOKEN");
  const client = createGoogleDriveClient({
    clientId: env("GOOGLE_CLIENT_ID"),
    clientSecret,
    refreshToken
  });
  const vaultRootId = env("NXT_VAULT_DRIVE_FOLDER_ID");
  const privateRootId = env("NXT_PRIVATE_DRIVE_FOLDER_ID");
  const vaultStorage = new RootBoundaryStorage(new GoogleDriveAdapter(client, { rootId: vaultRootId }), vaultRootId);
  const privateStorage = new RootBoundaryStorage(new GoogleDriveAdapter(client, { rootId: privateRootId }), privateRootId);
  const indexStore = new SystemFileStore({
    storage: privateStorage,
    fileId: env("NXT_VAULT_INDEX_DRIVE_FILE_ID"),
    parentId: privateRootId,
    name: "vault-index.json",
    schema: VaultIndexSchema
  });
  const preferencesStore = new SystemFileStore({
    storage: privateStorage,
    fileId: env("NXT_PREFERENCES_DRIVE_FILE_ID"),
    parentId: privateRootId,
    name: "preferences.json",
    schema: PreferencesSchema
  });
  const tokenSecret = createHash("sha256")
    .update("nxt:task7-service-tokens:v1\0")
    .update(clientSecret)
    .update("\0")
    .update(refreshToken)
    .digest("hex");
  const vault = new VaultService({
    storage: vaultStorage,
    indexStore,
    folders: {
      notesId: env("NXT_NOTES_DRIVE_FOLDER_ID"),
      inboxId: env("NXT_INBOX_DRIVE_FOLDER_ID"),
      plansId: env("NXT_PLANS_DRIVE_FOLDER_ID"),
      archiveId: env("NXT_ARCHIVE_DRIVE_FOLDER_ID"),
      assetsId: env("NXT_ASSETS_DRIVE_FOLDER_ID")
    },
    confirmationSecret: tokenSecret
  });
  cached = {
    vault,
    rescan: new RescanService({
      storage: vaultStorage,
      indexStore,
      notesFolderId: env("NXT_NOTES_DRIVE_FOLDER_ID"),
      cursorSecret: tokenSecret
    }),
    preferences: new PreferencesService({ preferencesStore, indexStore })
  };
  return cached;
};

const env = (name: string): string => {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("Task 7 service configuration is incomplete.");
  return value;
};
