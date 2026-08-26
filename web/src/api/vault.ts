import {
  CreateFolderRequestSchema,
  DeleteFolderRequestSchema,
  FolderResponseSchema,
  OpaqueIdSchema,
  PreferencesSchema,
  PreferencesResponseSchema,
  RescanVaultRequestSchema,
  RescanVaultResponseSchema,
  TrashResponseSchema,
  UpdateFolderRequestSchema,
  UpdatePreferencesRequestSchema,
  VaultResponseSchema,
  type RescanVaultResponse,
  type DeleteFolderRequest,
  type Preferences,
  type UpdatePreferencesRequest,
  type VaultResponse
} from "@nxt/contracts";
import { requestJson } from "./client";

export type FolderResponse = VaultResponse["folders"][number];
export type PreferencesResponse = VaultResponse["preferences"];
export type VaultEntry = VaultResponse["entries"][number];

export interface CompleteVault {
  readonly entries: readonly VaultEntry[];
  readonly preferences: Preferences;
  readonly folders: readonly FolderResponse[];
  readonly treeVersion: string;
}

export interface VaultClient {
  loadCompleteVault(): Promise<CompleteVault>;
  createFolder(input: { readonly parentId: string; readonly name: string }): Promise<FolderResponse>;
  updateFolder(folderId: string, input: { readonly expectedVersion: string; readonly name?: string; readonly parentId?: string }): Promise<FolderResponse>;
  trashFolder(folderId: string, input: DeleteFolderRequest): Promise<void>;
  updatePreferences(input: UpdatePreferencesRequest): Promise<PreferencesResponse>;
  rescanVault(): Promise<readonly RescanVaultResponse[]>;
}

const MAX_VAULT_PAGES = 10_000;
const MAX_TOTAL_ENTRIES = 100_000;
const MAX_TOTAL_FOLDERS = 100_000;
const MAX_TOTAL_RELATIONS = 500_000;

export class IncompleteVaultError extends Error {
  public constructor() {
    super("The complete vault could not be assembled safely.");
    this.name = "IncompleteVaultError";
  }
}

const fail = (): never => {
  throw new IncompleteVaultError();
};

const scalarEntry = (entry: VaultEntry): string => JSON.stringify({
  id: entry.id,
  title: entry.title,
  aliases: entry.aliases,
  path: entry.path,
  created: entry.created,
  updated: entry.updated,
  driveVersion: entry.driveVersion,
  tags: entry.tags,
  searchText: entry.searchText,
  excerpt: entry.excerpt
});

const dedupeAppend = <T>(target: T[], values: readonly T[], key: (value: T) => string): void => {
  const seen = new Set(target.map(key));
  for (const value of values) {
    const itemKey = key(value);
    if (seen.has(itemKey)) continue;
    target.push(value);
    seen.add(itemKey);
  }
};

const mergeEntry = (target: VaultEntry, page: VaultEntry): VaultEntry => {
  if (scalarEntry(target) !== scalarEntry(page)) fail();
  const outboundNoteIds = [...target.outboundNoteIds];
  const unresolvedWikiTargets = [...target.unresolvedWikiTargets];
  const attachments = [...target.attachments];
  const backlinks = [...target.backlinks];
  dedupeAppend(outboundNoteIds, page.outboundNoteIds, String);
  dedupeAppend(unresolvedWikiTargets, page.unresolvedWikiTargets, String);
  dedupeAppend(attachments, page.attachments, (item) => JSON.stringify(item));
  dedupeAppend(backlinks, page.backlinks, String);
  return { ...target, outboundNoteIds, unresolvedWikiTargets, attachments, backlinks };
};

const samePreferencesScalar = (first: VaultResponse["preferences"], second: VaultResponse["preferences"]): boolean =>
  first.schemaVersion === second.schemaVersion &&
  first.theme === second.theme &&
  JSON.stringify(first.panelState ?? null) === JSON.stringify(second.panelState ?? null);

const pagePath = (cursor: string | null): `/api/private/vault${string}` =>
  cursor === null
    ? "/api/private/vault?limit=100"
    : `/api/private/vault?limit=100&cursor=${encodeURIComponent(cursor)}`;

export const assembleVaultPages = async (
  readPage: (cursor: string | null) => Promise<VaultResponse>
): Promise<CompleteVault> => {
  const entries = new Map<string, VaultEntry>();
  const folders = new Map<string, FolderResponse>();
  const favorites: string[] = [];
  const recent: string[] = [];
  const cursors = new Set<string>();
  let preferences: VaultResponse["preferences"] | null = null;
  let preferencesChecksum: string | null = null;
  let treeVersion: string | null = null;
  let cursor: string | null = null;

  for (let pageNumber = 0; pageNumber < MAX_VAULT_PAGES; pageNumber += 1) {
    const page = await readPage(cursor);
    if ((page.complete && page.cursor !== null) || (!page.complete && page.cursor === null)) fail();
    if (treeVersion === null) treeVersion = page.treeVersion;
    else if (treeVersion !== page.treeVersion) fail();
    if (preferencesChecksum === null) preferencesChecksum = page.preferencesChecksum;
    else if (preferencesChecksum !== page.preferencesChecksum) fail();
    if (preferences === null) preferences = page.preferences;
    else if (!samePreferencesScalar(preferences, page.preferences)) fail();

    for (const pageEntry of page.entries) {
      const current = entries.get(pageEntry.id);
      entries.set(pageEntry.id, current === undefined ? pageEntry : mergeEntry(current, pageEntry));
    }
    for (const folder of page.folders) {
      const current = folders.get(folder.id);
      if (current !== undefined && JSON.stringify(current) !== JSON.stringify(folder)) fail();
      folders.set(folder.id, folder);
    }
    dedupeAppend(favorites, page.preferences.favorites, String);
    dedupeAppend(recent, page.preferences.recent, String);

    const relationCount = [...entries.values()].reduce(
      (sum, entry) => sum + entry.outboundNoteIds.length + entry.unresolvedWikiTargets.length + entry.attachments.length + entry.backlinks.length,
      0
    );
    if (entries.size > MAX_TOTAL_ENTRIES || folders.size > MAX_TOTAL_FOLDERS || relationCount > MAX_TOTAL_RELATIONS) fail();

    if (page.complete) {
      if (preferences === null || treeVersion === null) fail();
      return {
        entries: [...entries.values()],
        folders: [...folders.values()],
        treeVersion,
        preferences: PreferencesSchema.parse({ ...preferences, favorites, recent })
      };
    }
    const next = page.cursor;
    if (next === null || cursors.has(next)) fail();
    cursors.add(next as string);
    cursor = next;
  }
  return fail();
};

const loadCompleteVault = (): Promise<CompleteVault> =>
  assembleVaultPages((cursor) => requestJson(pagePath(cursor), VaultResponseSchema, undefined, { method: "GET" }));

const folderPath = (folderId: string): `/api/private/folders/${string}` =>
  `/api/private/folders/${OpaqueIdSchema.parse(folderId)}`;

export const vaultClient: VaultClient = {
  loadCompleteVault,
  createFolder: (input) => requestJson("/api/private/folders", FolderResponseSchema, undefined, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(CreateFolderRequestSchema.parse(input))
  }),
  updateFolder: (folderId, input) => requestJson(folderPath(folderId), FolderResponseSchema, undefined, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(UpdateFolderRequestSchema.parse(input))
  }),
  trashFolder: async (folderId, input) => {
    await requestJson(folderPath(folderId), TrashResponseSchema, undefined, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(DeleteFolderRequestSchema.parse(input))
    });
  },
  updatePreferences: (input) => requestJson("/api/private/preferences", PreferencesResponseSchema, undefined, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(UpdatePreferencesRequestSchema.parse(input))
  }),
  rescanVault: async () => {
    const pages: RescanVaultResponse[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_VAULT_PAGES; page += 1) {
      const result: RescanVaultResponse = await requestJson("/api/private/vault/rescan", RescanVaultResponseSchema, undefined, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(RescanVaultRequestSchema.parse({ cursor, limit: 100 }))
      });
      pages.push(result);
      if ((result.complete && result.cursor !== null) || (!result.complete && result.cursor === null)) fail();
      if (result.complete) return pages;
      if (result.cursor === null || seen.has(result.cursor)) fail();
      seen.add(result.cursor as string);
      cursor = result.cursor;
    }
    return fail();
  }
};

export const exactFolderForNote = (
  note: Pick<VaultEntry, "path">,
  folders: readonly FolderResponse[]
): FolderResponse => {
  const separator = note.path.lastIndexOf("/");
  if (separator <= 0) return fail();
  const parentPath = note.path.slice(0, separator);
  const matches = folders.filter((folder) => folder.path === parentPath);
  return matches.length === 1 ? matches[0]! : fail();
};

export const attachmentResolverForNote = (
  note: Pick<VaultEntry, "id" | "attachments">
): ((canonicalReference: string) => string | undefined) => {
  const byReference = new Map(note.attachments.map((attachment) => [
    `_assets/${note.id}/${attachment.name}`.normalize("NFC"),
    attachment.assetId
  ]));
  return (reference) => byReference.get(reference.normalize("NFC"));
};
