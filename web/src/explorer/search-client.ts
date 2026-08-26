import type {
  SearchRecord,
  SearchResultItem,
  SearchWorkerRequest,
  SearchWorkerResponse
} from "./search-worker";

export interface SearchWorkerLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: SearchWorkerRequest): void;
  terminate(): void;
}

type Pending = {
  readonly kind: "initialize" | "query";
  readonly resolve: (value: readonly SearchResultItem[]) => void;
  readonly reject: (reason: unknown) => void;
};

export class StaleSearchResponseError extends Error {
  public constructor() {
    super("A newer search request replaced this result.");
    this.name = "StaleSearchResponseError";
  }
}

export class SearchClient {
  private nextRequestId = 1;
  private latestQueryRequestId = 0;
  private readonly pending = new Map<number, Pending>();
  private terminated = false;

  public constructor(private readonly worker: SearchWorkerLike) {
    worker.onmessage = (event) => this.receive(event.data);
    worker.onerror = () => this.failAll(new Error("Search worker failed."));
  }

  public initialize(records: readonly SearchRecord[]): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.terminated) {
        reject(new Error("Search client is terminated."));
        return;
      }
      const requestId = this.nextRequestId++;
      this.pending.set(requestId, { kind: "initialize", resolve: () => resolve(), reject });
      this.worker.postMessage({ type: "initialize", requestId, records });
    });
  }

  public query(query: string): Promise<readonly SearchResultItem[]> {
    if (query.length > 512) return Promise.reject(new Error("Search query is too long."));
    return new Promise((resolve, reject) => {
      if (this.terminated) {
        reject(new Error("Search client is terminated."));
        return;
      }
      for (const [requestId, pending] of this.pending) {
        if (pending.kind !== "query") continue;
        pending.reject(new StaleSearchResponseError());
        this.pending.delete(requestId);
      }
      const requestId = this.nextRequestId++;
      this.latestQueryRequestId = requestId;
      this.pending.set(requestId, { kind: "query", resolve, reject });
      this.worker.postMessage({ type: "query", requestId, query });
    });
  }

  public terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.failAll(new Error("Search client is terminated."));
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
  }

  private receive(value: unknown): void {
    if (!isResponse(value)) {
      const requestId = responseRequestId(value);
      if (requestId === null) return;
      const pending = this.pending.get(requestId);
      if (pending === undefined) return;
      this.pending.delete(requestId);
      pending.reject(new Error("Search worker returned an invalid response."));
      return;
    }
    const pending = this.pending.get(value.requestId);
    if (pending === undefined) return;
    this.pending.delete(value.requestId);
    if (value.type === "error") {
      pending.reject(new Error("Search worker rejected the request."));
      return;
    }
    if (pending.kind === "query" && value.requestId !== this.latestQueryRequestId) {
      pending.reject(new StaleSearchResponseError());
      return;
    }
    if (pending.kind === "initialize" && value.type !== "ready") {
      pending.reject(new Error("Search worker returned an invalid response."));
      return;
    }
    if (pending.kind === "query" && value.type !== "results") {
      pending.reject(new Error("Search worker returned an invalid response."));
      return;
    }
    pending.resolve(value.type === "results" ? value.results : []);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

const responseRequestId = (value: unknown): number | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const requestId = (value as { readonly requestId?: unknown }).requestId;
  return Number.isSafeInteger(requestId) && (requestId as number) > 0 ? requestId as number : null;
};

const isResult = (value: unknown): value is SearchResultItem => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const result = value as Partial<SearchResultItem>;
  return typeof result.id === "string" && result.id.length > 0 && result.id.length <= 512 &&
    typeof result.title === "string" && result.title.length > 0 && result.title.length <= 160 &&
    typeof result.path === "string" && result.path.length > 0 && result.path.length <= 4096 &&
    typeof result.folder === "string" && result.folder.length <= 4096 &&
    Array.isArray(result.tags) && result.tags.length <= 64 && result.tags.every((tag) => typeof tag === "string" && tag.length <= 64) &&
    typeof result.favorite === "boolean" &&
    typeof result.searchText === "string" && result.searchText.length <= 100_000 &&
    typeof result.score === "number" && Number.isFinite(result.score) && result.score >= 0;
};

const isResponse = (value: unknown): value is SearchWorkerResponse => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const response = value as Partial<SearchWorkerResponse>;
  if (!Number.isSafeInteger(response.requestId) || (response.requestId ?? 0) <= 0) return false;
  if (response.type === "ready" || response.type === "error") return true;
  return response.type === "results" && Array.isArray(response.results) && response.results.length <= 200 && response.results.every(isResult);
};

export const createSearchClient = async (records: readonly SearchRecord[]): Promise<SearchClient> => {
  const worker = new Worker(new URL("./search-worker.ts", import.meta.url), { type: "module", name: "nxt-vault-search" });
  const client = new SearchClient(worker);
  try {
    await client.initialize(records);
    return client;
  } catch (error) {
    client.terminate();
    throw error;
  }
};
