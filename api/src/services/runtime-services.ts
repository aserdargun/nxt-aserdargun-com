import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { PreferencesSchema, PublicationManifestSchema, VaultIndexSchema } from "@nxt/contracts";
import { createGoogleDriveClient } from "../storage/google-drive-client.js";
import { GoogleDriveAdapter } from "../storage/google-drive-adapter.js";
import { LocalDriveAdapter } from "../storage/local-drive-adapter.js";
import { RootBoundaryStorage } from "../storage/root-boundary.js";
import type { Task7Services } from "../functions/private-api.js";
import { createRuntimeOpaqueIdCodec } from "../functions/private-api.js";
import { PreferencesService } from "./preferences-service.js";
import { RescanService } from "./rescan-service.js";
import { AttachmentService } from "./attachment-service.js";
import { SystemFileStore } from "./system-file-store.js";
import { VaultService } from "./vault-service.js";
import { PublicationService, PublicPublicationReader } from "./publication-service.js";

const GOOGLE_KEYS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"] as const;
type RuntimeIds = {
  notes: string; inbox: string; plans: string; archive: string; assets: string; published: string;
  index: string; preferences: string; manifest: string;
};
type RuntimeComposition = { task7: Task7Services; task9: Task9Services };

let compositionPromise: Promise<RuntimeComposition> | undefined;

export interface Task9Services {
  publications: PublicationService;
  reader: PublicPublicationReader;
}

export const resolveTask7Services = (): Promise<Task7Services> => {
  compositionPromise ??= createRuntimeComposition();
  return compositionPromise.then(({ task7 }) => task7);
};

export const resolveTask9Services = (): Promise<Task9Services> => {
  compositionPromise ??= createRuntimeComposition();
  return compositionPromise.then(({ task9 }) => task9);
};

const createRuntimeComposition = async (): Promise<RuntimeComposition> => {
  if (process.env.NXT_LOCAL_STORAGE_MODE === "filesystem") return createLocalComposition();
  return createGoogleComposition();
};

const createGoogleComposition = (): RuntimeComposition => {
  const clientSecret = env("GOOGLE_CLIENT_SECRET");
  const refreshToken = env("GOOGLE_REFRESH_TOKEN");
  const client = createGoogleDriveClient({ clientId: env("GOOGLE_CLIENT_ID"), clientSecret, refreshToken });
  const vaultRootId = env("NXT_VAULT_DRIVE_FOLDER_ID");
  const privateRootId = env("NXT_PRIVATE_DRIVE_FOLDER_ID");
  const ids: RuntimeIds = {
    notes: env("NXT_NOTES_DRIVE_FOLDER_ID"), inbox: env("NXT_INBOX_DRIVE_FOLDER_ID"), plans: env("NXT_PLANS_DRIVE_FOLDER_ID"),
    archive: env("NXT_ARCHIVE_DRIVE_FOLDER_ID"), assets: env("NXT_ASSETS_DRIVE_FOLDER_ID"), published: env("NXT_PUBLISHED_DRIVE_FOLDER_ID"),
    index: env("NXT_VAULT_INDEX_DRIVE_FILE_ID"), preferences: env("NXT_PREFERENCES_DRIVE_FILE_ID"), manifest: env("NXT_PUBLICATION_MANIFEST_DRIVE_FILE_ID")
  };
  return compose(
    new RootBoundaryStorage(new GoogleDriveAdapter(client, { rootId: vaultRootId }), vaultRootId),
    new RootBoundaryStorage(new GoogleDriveAdapter(client, { rootId: privateRootId }), privateRootId),
    privateRootId,
    ids,
    createHash("sha256").update("nxt:runtime-service-tokens:v1\0").update(clientSecret).update("\0").update(refreshToken).digest("hex"),
    [clientSecret, refreshToken]
  );
};

const createLocalComposition = async (): Promise<RuntimeComposition> => {
  if (
    process.env.NXT_LOCAL_AUTH_BYPASS !== "1" || process.env.NODE_ENV !== "development" ||
    process.env.AZURE_FUNCTIONS_ENVIRONMENT !== "Development"
  ) throw new Error("Local runtime is not permitted.");
  for (const key of GOOGLE_KEYS) if (typeof process.env[key] === "string" && process.env[key]?.trim() !== "") {
    throw new Error("Local runtime is not permitted.");
  }
  const configuredCheckout = requiredLocal("NXT_LOCAL_CHECKOUT_ROOT");
  const checkout = await realpath(resolve(configuredCheckout));
  const cwdCheckout = await realpath(resolve(process.cwd(), ".."));
  if (checkout !== configuredCheckout || checkout !== cwdCheckout) throw new Error("Local runtime is not permitted.");
  const expectedParent = join(checkout, ".nxt-local", "fixtures");
  const configuredRoot = requiredLocal("NXT_LOCAL_FIXTURE_ROOT");
  const fixtureRoot = resolve(configuredRoot);
  if (fixtureRoot !== join(expectedParent, "playwright") || !fixtureRoot.startsWith(`${expectedParent}${sep}`)) {
    throw new Error("Local runtime is not permitted.");
  }
  const metadata = await lstat(fixtureRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(fixtureRoot) !== fixtureRoot) {
    throw new Error("Local runtime is not permitted.");
  }
  const descriptor = JSON.parse(await readFile(join(fixtureRoot, ".fixture.json"), "utf8")) as unknown;
  const ids = parseLocalDescriptor(descriptor, fixtureRoot);
  const raw = await LocalDriveAdapter.create(fixtureRoot);
  const tokenSecret = createHash("sha256").update("nxt:local-runtime-service-tokens:v1\0").update(checkout).update("\0").update(fixtureRoot).digest("hex");
  return compose(
    new RootBoundaryStorage(raw, "vault"),
    new RootBoundaryStorage(raw, "private"),
    "private",
    ids,
    tokenSecret,
    [tokenSecret, tokenSecret]
  );
};

const compose = (
  vaultStorage: RootBoundaryStorage,
  privateStorage: RootBoundaryStorage,
  privateRootId: string,
  ids: RuntimeIds,
  tokenSecret: string,
  opaqueSecrets: readonly [string, string]
): RuntimeComposition => {
  const indexStore = new SystemFileStore({ storage: privateStorage, fileId: ids.index, parentId: privateRootId, name: "vault-index.json", schema: VaultIndexSchema });
  const preferencesStore = new SystemFileStore({ storage: privateStorage, fileId: ids.preferences, parentId: privateRootId, name: "preferences.json", schema: PreferencesSchema });
  const manifestStore = new SystemFileStore({ storage: privateStorage, fileId: ids.manifest, parentId: privateRootId, name: "publication-manifest.json", schema: PublicationManifestSchema });
  const vault = new VaultService({
    storage: vaultStorage,
    indexStore,
    folders: { notesId: ids.notes, inboxId: ids.inbox, plansId: ids.plans, archiveId: ids.archive, assetsId: ids.assets },
    confirmationSecret: tokenSecret,
    preferencesStore
  });
  const attachments = new AttachmentService({ storage: vaultStorage, indexStore, vault, assetsRootId: ids.assets });
  const reader = new PublicPublicationReader({ storage: privateStorage, manifestStore, privateRootId, publishedRootId: ids.published });
  return {
    task7: {
      vault,
      rescan: new RescanService({ storage: vaultStorage, indexStore, notesFolderId: ids.notes, cursorSecret: tokenSecret }),
      preferences: new PreferencesService({ preferencesStore, indexStore }),
      attachments
    },
    task9: {
      reader,
      publications: new PublicationService({
        storage: privateStorage,
        manifestStore,
        indexStore,
        vault,
        attachments,
        privateRootId,
        publishedRootId: ids.published,
        decodeAttachmentId: (opaqueId) => createRuntimeOpaqueIdCodec(opaqueSecrets[0], opaqueSecrets[1]).decode(opaqueId)
      })
    }
  };
};

const parseLocalDescriptor = (value: unknown, fixtureRoot: string): RuntimeIds => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Local runtime is not permitted.");
  const record = value as Record<string, unknown>;
  const ids = record.ids;
  if (record.version !== 1 || record.fixtureRoot !== fixtureRoot || typeof ids !== "object" || ids === null || Array.isArray(ids)) {
    throw new Error("Local runtime is not permitted.");
  }
  const source = ids as Record<string, unknown>;
  const result = Object.fromEntries(["notes", "inbox", "plans", "archive", "assets", "published", "index", "preferences", "manifest"].map((key) => {
    const id = source[key];
    if (typeof id !== "string" || id.length === 0 || id.length > 512) throw new Error("Local runtime is not permitted.");
    return [key, id];
  })) as RuntimeIds;
  return result;
};

const requiredLocal = (name: string): string => {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("Local runtime is not permitted.");
  return value;
};

const env = (name: string): string => {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("Task 7 service configuration is incomplete.");
  return value;
};
