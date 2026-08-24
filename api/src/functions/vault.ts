import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { RescanVaultRequestSchema, RescanVaultResponseSchema, VaultResponseSchema } from "@nxt/contracts";
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

export const createVaultHandlers = (dependencies: PrivateHandlerDependencies = defaultPrivateHandlerDependencies()) => ({
  getVault: (request: HttpRequest): Promise<HttpResponseInit> => handlePrivate(request, dependencies, async (services) => {
    const page = parseVaultPage(request, dependencies);
    const [index, preferences, tree] = await Promise.all([
      services.vault.readIndex(),
      services.preferences.read(),
      services.vault.vaultTree()
    ]);
    if (page.generation !== null && page.generation !== index.value.generation) throw new ApiResponseError("CONFLICT");
    const folderCandidates = tree.folders.slice(page.folderOffset, page.folderOffset + page.limit).map((folder) => ({
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
    const candidates = index.value.entries.slice(page.entryOffset, page.entryOffset + page.limit).map((entry) => ({
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
          outboundNoteIds: entry.outboundNoteIds.slice(0, 100),
          unresolvedWikiTargets: entry.unresolvedWikiTargets.slice(0, 100),
          attachments: entry.attachments.slice(0, 100).map((attachment) => ({
            name: attachment.name,
            mimeType: attachment.mimeType,
            size: attachment.size
          })),
          backlinks: entry.backlinks.slice(0, 100)
        }));
    const entries: typeof candidates = [];
    let entryBytes = 0;
    for (const candidate of candidates) {
      const bytes = new TextEncoder().encode(JSON.stringify(candidate)).byteLength;
      if (entries.length > 0 && entryBytes + bytes > MAX_ENTRY_PAGE_BYTES) break;
      entries.push(candidate);
      entryBytes += bytes;
    }
    const nextEntryOffset = page.entryOffset + entries.length;
    const nextFolderOffset = page.folderOffset + folders.length;
    const complete = nextEntryOffset >= index.value.entries.length && nextFolderOffset >= tree.folders.length;
    return typedJson({
      entries,
      preferences: { ...preferences.value, favorites: preferences.value.favorites.slice(0, 100), recent: preferences.value.recent.slice(0, 100) },
      folders,
      treeVersion: tree.treeVersion,
      cursor: complete ? null : dependencies.idCodec.encode(`vault:${index.value.generation}:${nextEntryOffset}:${nextFolderOffset}`),
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

const parseVaultPage = (request: HttpRequest, dependencies: PrivateHandlerDependencies): { entryOffset: number; folderOffset: number; limit: number; generation: number | null } => {
  let url: URL;
  try { url = new URL(request.url); } catch { throw new ApiResponseError("INVALID_INPUT"); }
  if ([...url.searchParams.keys()].some((key) => key !== "cursor" && key !== "limit")) throw new ApiResponseError("INVALID_INPUT");
  if (url.searchParams.getAll("cursor").length > 1 || url.searchParams.getAll("limit").length > 1) throw new ApiResponseError("INVALID_INPUT");
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw === null ? 100 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiResponseError("INVALID_INPUT");
  const cursor = url.searchParams.get("cursor");
  if (cursor === null) return { entryOffset: 0, folderOffset: 0, limit, generation: null };
  const decoded = dependencies.idCodec.decode(cursor);
  const match = /^vault:(\d+):(\d+):(\d+)$/u.exec(decoded);
  if (match === null) throw new ApiResponseError("INVALID_INPUT");
  const generation = Number(match[1]);
  const entryOffset = Number(match[2]);
  const folderOffset = Number(match[3]);
  if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(entryOffset) || !Number.isSafeInteger(folderOffset) || entryOffset < 0 || folderOffset < 0) throw new ApiResponseError("INVALID_INPUT");
  return { entryOffset, folderOffset, limit, generation };
};
