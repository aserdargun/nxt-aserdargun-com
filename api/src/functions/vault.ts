import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { RescanVaultRequestSchema, RescanVaultResponseSchema, VaultResponseSchema, type VaultIndexEntry } from "@nxt/contracts";
import { ApiResponseError, typedJson } from "../http/api-response.js";
import {
  assertNoQuery,
  defaultPrivateHandlerDependencies,
  handlePrivate,
  parseBody,
  type PrivateHandlerDependencies
} from "./private-api.js";

const MAX_ENTRY_PAGE_BYTES = 180_000;
const MAX_FOLDER_PAGE_BYTES = 60_000;
const MAX_SINGLE_ENTRY_BYTES = 170_000;

export const createVaultHandlers = (dependencies: PrivateHandlerDependencies = defaultPrivateHandlerDependencies()) => ({
  getVault: (request: HttpRequest): Promise<HttpResponseInit> => handlePrivate(request, dependencies, async (services) => {
    const page = parseVaultPage(request, dependencies);
    const [index, preferences, tree] = await Promise.all([
      services.vault.readIndex(),
      services.preferences.read(),
      services.vault.vaultTree()
    ]);
    if (page.generation !== null && page.generation !== index.value.generation) throw new ApiResponseError("CONFLICT");
    if (page.treeVersion !== null && page.treeVersion !== tree.treeVersion) throw new ApiResponseError("CONFLICT");
    if (page.preferencesChecksum !== null && page.preferencesChecksum !== preferences.checksum) throw new ApiResponseError("CONFLICT");
    const orderedFolders = [...tree.folders].sort((first, second) => {
      const firstPath = first.path.normalize("NFKC").toLocaleLowerCase("en-US");
      const secondPath = second.path.normalize("NFKC").toLocaleLowerCase("en-US");
      return firstPath.localeCompare(secondPath, "en-US") || first.id.localeCompare(second.id, "en-US");
    });
    const folderCandidates = orderedFolders.slice(page.folderOffset, page.folderOffset + page.limit).map((folder) => ({
      id: dependencies.idCodec.encode(folder.id),
      name: folder.name,
      path: folder.path,
      version: folder.version,
      protected: folder.protected,
      ...(folder.deleteConfirmation === undefined ? {} : { deleteConfirmation: folder.deleteConfirmation })
    }));
    const folders: typeof folderCandidates = [];
    let folderBytes = 0;
    for (const candidate of folderCandidates) {
      const bytes = new TextEncoder().encode(JSON.stringify(candidate)).byteLength;
      if (folders.length > 0 && folderBytes + bytes > MAX_FOLDER_PAGE_BYTES) break;
      folders.push(candidate);
      folderBytes += bytes;
    }
    const entries: Array<ReturnType<typeof projectEntryPage>> = [];
    let entryBytes = 0;
    let nextEntryOffset = page.entryOffset;
    let relationOffsets = { ...page.relationOffsets };
    while (entries.length < page.limit && nextEntryOffset < index.value.entries.length) {
      const entry = index.value.entries[nextEntryOffset];
      if (entry === undefined) break;
      const candidate = projectEntryPage(entry, relationOffsets, (id) => dependencies.idCodec.encode(id));
      const bytes = new TextEncoder().encode(JSON.stringify(candidate)).byteLength;
      if (entries.length > 0 && entryBytes + bytes > MAX_ENTRY_PAGE_BYTES) break;
      entries.push(candidate);
      entryBytes += bytes;
      relationOffsets = {
        outbound: relationOffsets.outbound + candidate.outboundNoteIds.length,
        unresolved: relationOffsets.unresolved + candidate.unresolvedWikiTargets.length,
        attachments: relationOffsets.attachments + candidate.attachments.length,
        backlinks: relationOffsets.backlinks + candidate.backlinks.length
      };
      const relationsRemain =
        relationOffsets.outbound < entry.outboundNoteIds.length ||
        relationOffsets.unresolved < entry.unresolvedWikiTargets.length ||
        relationOffsets.attachments < entry.attachments.length ||
        relationOffsets.backlinks < entry.backlinks.length;
      if (relationsRemain) {
        if (
          candidate.outboundNoteIds.length + candidate.unresolvedWikiTargets.length +
          candidate.attachments.length + candidate.backlinks.length === 0
        ) throw new ApiResponseError("TOO_LARGE");
        break;
      }
      nextEntryOffset += 1;
      relationOffsets = emptyRelationOffsets();
    }
    const nextFolderOffset = page.folderOffset + folders.length;
    const favoriteEnd = Math.min(page.favoriteOffset + 100, preferences.value.favorites.length);
    const recentEnd = Math.min(page.recentOffset + 100, preferences.value.recent.length);
    const nextFavoriteOffset = favoriteEnd;
    const nextRecentOffset = recentEnd;
    const complete = nextEntryOffset >= index.value.entries.length && nextFolderOffset >= orderedFolders.length &&
      nextFavoriteOffset >= preferences.value.favorites.length && nextRecentOffset >= preferences.value.recent.length;
    return typedJson({
      entries,
      preferences: {
        ...preferences.value,
        favorites: preferences.value.favorites.slice(page.favoriteOffset, favoriteEnd),
        recent: preferences.value.recent.slice(page.recentOffset, recentEnd)
      },
      preferencesChecksum: preferences.checksum,
      folders,
      treeVersion: tree.treeVersion,
      cursor: complete ? null : dependencies.idCodec.encode([
        "vault3",
        index.value.generation,
        tree.treeVersion,
        preferences.checksum,
        nextEntryOffset,
        relationOffsets.outbound,
        relationOffsets.unresolved,
        relationOffsets.attachments,
        relationOffsets.backlinks,
        nextFolderOffset,
        nextFavoriteOffset,
        nextRecentOffset
      ].join(":")),
      complete
    }, VaultResponseSchema);
  }),
  rescan: (request: HttpRequest): Promise<HttpResponseInit> => handlePrivate(request, dependencies, async (services) => {
    assertNoQuery(request);
    const body = await parseBody(request, RescanVaultRequestSchema);
    return typedJson(await services.rescan.scanPage(body), RescanVaultResponseSchema);
  })
});

const defaults = createVaultHandlers();
export const getVaultHandler = defaults.getVault;
export const rescanVaultHandler = defaults.rescan;

type RelationOffsets = { outbound: number; unresolved: number; attachments: number; backlinks: number };
type VaultPage = {
  entryOffset: number;
  folderOffset: number;
  favoriteOffset: number;
  recentOffset: number;
  relationOffsets: RelationOffsets;
  limit: number;
  generation: number | null;
  treeVersion: string | null;
  preferencesChecksum: string | null;
};

const parseVaultPage = (request: HttpRequest, dependencies: PrivateHandlerDependencies): VaultPage => {
  let url: URL;
  try { url = new URL(request.url); } catch { throw new ApiResponseError("INVALID_INPUT"); }
  if ([...url.searchParams.keys()].some((key) => key !== "cursor" && key !== "limit")) throw new ApiResponseError("INVALID_INPUT");
  if (url.searchParams.getAll("cursor").length > 1 || url.searchParams.getAll("limit").length > 1) throw new ApiResponseError("INVALID_INPUT");
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw === null ? 100 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiResponseError("INVALID_INPUT");
  const cursor = url.searchParams.get("cursor");
  if (cursor === null) return {
    entryOffset: 0,
    folderOffset: 0,
    favoriteOffset: 0,
    recentOffset: 0,
    relationOffsets: emptyRelationOffsets(),
    limit,
    generation: null,
    treeVersion: null,
    preferencesChecksum: null
  };
  const decoded = dependencies.idCodec.decode(cursor);
  const match = /^vault3:(\d+):([a-f0-9]{64}):([a-f0-9]{64}):(\d+):(\d+):(\d+):(\d+):(\d+):(\d+):(\d+):(\d+)$/u.exec(decoded);
  if (match === null) throw new ApiResponseError("INVALID_INPUT");
  const generation = Number(match[1]);
  const treeVersion = match[2] as string;
  const preferencesChecksum = match[3] as string;
  const numbers = match.slice(4).map(Number);
  if (!Number.isSafeInteger(generation) || numbers.some((value) => !Number.isSafeInteger(value) || value < 0)) throw new ApiResponseError("INVALID_INPUT");
  return {
    entryOffset: numbers[0] as number,
    relationOffsets: {
      outbound: numbers[1] as number,
      unresolved: numbers[2] as number,
      attachments: numbers[3] as number,
      backlinks: numbers[4] as number
    },
    folderOffset: numbers[5] as number,
    favoriteOffset: numbers[6] as number,
    recentOffset: numbers[7] as number,
    limit,
    generation,
    treeVersion,
    preferencesChecksum
  };
};

const emptyRelationOffsets = (): RelationOffsets => ({ outbound: 0, unresolved: 0, attachments: 0, backlinks: 0 });

const projectEntryPage = (
  entry: VaultIndexEntry,
  offsets: RelationOffsets,
  encodeId: (value: string) => string
) => {
  const projected = {
    id: entry.id,
    title: entry.title,
    aliases: entry.aliases,
    path: entry.path,
    created: entry.created,
    updated: entry.updated,
    driveVersion: entry.driveVersion,
    tags: entry.tags,
    searchText: entry.searchText,
    excerpt: entry.excerpt,
    outboundNoteIds: [] as string[],
    unresolvedWikiTargets: [] as string[],
    attachments: [] as Array<{ assetId: string; name: string; mimeType: string; size: number; disposition?: "inline" | "download" }>,
    backlinks: [] as string[]
  };
  const positions = { ...offsets };
  const blocked = new Set<keyof RelationOffsets>();
  const kinds: Array<keyof RelationOffsets> = ["outbound", "unresolved", "attachments", "backlinks"];
  while (blocked.size < kinds.length) {
    let advanced = false;
    for (const kind of kinds) {
      if (blocked.has(kind) || projectedLength(projected, kind) >= 100) {
        blocked.add(kind);
        continue;
      }
      const item = relationItem(entry, kind, positions[kind], encodeId);
      if (item === undefined) {
        blocked.add(kind);
        continue;
      }
      pushRelationItem(projected, kind, item);
      if (new TextEncoder().encode(JSON.stringify(projected)).byteLength > MAX_SINGLE_ENTRY_BYTES) {
        popRelationItem(projected, kind);
        blocked.add(kind);
        continue;
      }
      positions[kind] += 1;
      advanced = true;
    }
    if (!advanced) break;
  }
  return projected;
};

type ProjectedEntry = {
  outboundNoteIds: string[];
  unresolvedWikiTargets: string[];
  attachments: Array<{ assetId: string; name: string; mimeType: string; size: number; disposition?: "inline" | "download" }>;
  backlinks: string[];
};

const projectedLength = (entry: ProjectedEntry, kind: keyof RelationOffsets): number =>
  kind === "outbound" ? entry.outboundNoteIds.length :
    kind === "unresolved" ? entry.unresolvedWikiTargets.length :
      kind === "attachments" ? entry.attachments.length : entry.backlinks.length;

type ProjectedAttachment = { assetId: string; name: string; mimeType: string; size: number; disposition?: "inline" | "download" };

const relationItem = (
  entry: VaultIndexEntry,
  kind: keyof RelationOffsets,
  position: number,
  encodeId: (value: string) => string
): string | ProjectedAttachment | undefined => {
  if (kind === "outbound") return entry.outboundNoteIds[position];
  if (kind === "unresolved") return entry.unresolvedWikiTargets[position];
  if (kind === "backlinks") return entry.backlinks[position];
  const attachment = entry.attachments[position];
  return attachment === undefined ? undefined : {
    assetId: encodeId(attachment.driveId),
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    ...(attachment.disposition === undefined ? {} : { disposition: attachment.disposition })
  };
};

const pushRelationItem = (entry: ProjectedEntry, kind: keyof RelationOffsets, item: string | ProjectedAttachment): void => {
  if (kind === "outbound") entry.outboundNoteIds.push(item as string);
  else if (kind === "unresolved") entry.unresolvedWikiTargets.push(item as string);
  else if (kind === "attachments") entry.attachments.push(item as ProjectedAttachment);
  else entry.backlinks.push(item as string);
};

const popRelationItem = (entry: ProjectedEntry, kind: keyof RelationOffsets): void => {
  if (kind === "outbound") entry.outboundNoteIds.pop();
  else if (kind === "unresolved") entry.unresolvedWikiTargets.pop();
  else if (kind === "attachments") entry.attachments.pop();
  else entry.backlinks.pop();
};
