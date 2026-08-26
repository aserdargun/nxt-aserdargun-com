import MiniSearch from "minisearch";

export interface SearchRecord {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly folder: string;
  readonly tags: readonly string[];
  readonly favorite: boolean;
  readonly searchText: string;
}

export interface SearchResultItem {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly folder: string;
  readonly tags: readonly string[];
  readonly favorite: boolean;
  readonly score: number;
}

export type SearchWorkerRequest =
  | { readonly type: "initialize"; readonly requestId: number; readonly records: readonly SearchRecord[] }
  | { readonly type: "query"; readonly requestId: number; readonly query: string };

export type SearchWorkerResponse =
  | { readonly type: "ready"; readonly requestId: number }
  | { readonly type: "results"; readonly requestId: number; readonly results: readonly SearchResultItem[] }
  | { readonly type: "error"; readonly requestId: number };

export interface SearchIndex {
  readonly engine: MiniSearch<SearchRecord>;
  readonly records: ReadonlyMap<string, SearchRecord>;
}

const MAX_RECORDS = 100_000;
const MAX_QUERY_LENGTH = 512;
const MAX_RESULTS = 200;

export const normalizeTurkish = (value: string): string =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase("tr-TR")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .normalize("NFC");

const safeRecord = (value: SearchRecord): boolean =>
  typeof value.id === "string" && value.id.length > 0 && value.id.length <= 512 &&
  typeof value.title === "string" && value.title.length > 0 && value.title.length <= 160 &&
  typeof value.path === "string" && value.path.length > 0 && value.path.length <= 4096 &&
  typeof value.folder === "string" && value.folder.length <= 4096 &&
  Array.isArray(value.tags) && value.tags.length <= 64 && value.tags.every((tag) => typeof tag === "string" && tag.length <= 64) &&
  typeof value.favorite === "boolean" && typeof value.searchText === "string" && value.searchText.length <= 100_000;

export const createSearchIndex = (records: readonly SearchRecord[]): SearchIndex => {
  if (records.length > MAX_RECORDS || records.some((record) => !safeRecord(record))) {
    throw new Error("Invalid search records.");
  }
  const byId = new Map<string, SearchRecord>();
  for (const record of records) {
    if (byId.has(record.id)) throw new Error("Duplicate search record.");
    byId.set(record.id, record);
  }
  const engine = new MiniSearch<SearchRecord>({
    fields: ["title", "path", "folder", "tags", "searchText"],
    storeFields: ["id"],
    tokenize: (value) => normalizeTurkish(value).split(/[^\p{L}\p{N}_:-]+/u).filter(Boolean),
    processTerm: (term) => normalizeTurkish(term)
  });
  engine.addAll([...byId.values()]);
  return { engine, records: byId };
};

interface ParsedQuery {
  readonly text: string;
  readonly tags: readonly string[];
  readonly folders: readonly string[];
  readonly favorite: boolean | null;
}

const parseQuery = (value: string): ParsedQuery => {
  if (value.length > MAX_QUERY_LENGTH) throw new Error("Search query is too long.");
  const text: string[] = [];
  const tags: string[] = [];
  const folders: string[] = [];
  let favorite: boolean | null = null;
  for (const token of value.trim().split(/\s+/u).filter(Boolean)) {
    const match = /^(tag|folder|favorite):(.*)$/u.exec(token);
    if (match === null) {
      text.push(token);
      continue;
    }
    const name = match[1];
    const raw = match[2] ?? "";
    if (raw.length === 0) {
      text.push(token);
    } else if (name === "tag") {
      tags.push(normalizeTurkish(raw));
    } else if (name === "folder") {
      folders.push(normalizeTurkish(raw));
    } else if (raw === "true" || raw === "false") {
      favorite = raw === "true";
    } else {
      text.push(token);
    }
  }
  return { text: text.join(" "), tags, folders, favorite };
};

const matchesFilters = (record: SearchRecord, parsed: ParsedQuery): boolean => {
  const normalizedTags = record.tags.map(normalizeTurkish);
  if (!parsed.tags.every((tag) => normalizedTags.includes(tag))) return false;
  const normalizedFolder = normalizeTurkish(record.folder);
  if (!parsed.folders.every((folder) => normalizedFolder === folder)) return false;
  return parsed.favorite === null || record.favorite === parsed.favorite;
};

const projectResult = (record: SearchRecord, score: number): SearchResultItem => ({
  id: record.id,
  title: record.title,
  path: record.path,
  folder: record.folder,
  tags: record.tags,
  favorite: record.favorite,
  score
});

export const searchIndex = (index: SearchIndex, query: string): SearchResultItem[] => {
  const parsed = parseQuery(query);
  const scored = parsed.text.length === 0
    ? [...index.records.values()].map((record) => ({ id: record.id, score: 1 }))
    : index.engine.search(parsed.text, { prefix: true, fuzzy: 0.1 }).map((result) => ({ id: String(result.id), score: result.score }));
  return scored
    .flatMap(({ id, score }) => {
      const record = index.records.get(id);
      return record === undefined || !matchesFilters(record, parsed) ? [] : [projectResult(record, score)];
    })
    .sort((first, second) => second.score - first.score || first.title.localeCompare(second.title, "tr-TR") || first.id.localeCompare(second.id))
    .slice(0, MAX_RESULTS);
};

let workerIndex: SearchIndex | null = null;

const handleWorkerMessage = (request: SearchWorkerRequest): SearchWorkerResponse => {
  if (!Number.isSafeInteger(request.requestId) || request.requestId <= 0) return { type: "error", requestId: 0 };
  try {
    if (request.type === "initialize") {
      workerIndex = createSearchIndex(request.records);
      return { type: "ready", requestId: request.requestId };
    }
    if (workerIndex === null || typeof request.query !== "string") return { type: "error", requestId: request.requestId };
    return { type: "results", requestId: request.requestId, results: searchIndex(workerIndex, request.query) };
  } catch {
    return { type: "error", requestId: request.requestId };
  }
};

if (typeof document === "undefined" && typeof globalThis.addEventListener === "function") {
  globalThis.addEventListener("message", ((event: MessageEvent<SearchWorkerRequest>) => {
    globalThis.postMessage(handleWorkerMessage(event.data));
  }) as EventListener);
}
