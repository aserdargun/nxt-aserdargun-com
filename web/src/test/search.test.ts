import { describe, expect, it, vi } from "vitest";
import {
  SearchClient,
  StaleSearchResponseError,
  type SearchWorkerLike
} from "../explorer/search-client";
import { createSearchIndex, searchIndex, type SearchRecord } from "../explorer/search-worker";

const indexFixture: readonly SearchRecord[] = [
  {
    id: "note-2026",
    title: "2026 Yıllık Planı",
    path: "Notes/Plans/2026 Yıllık Planı.md",
    folder: "Plans",
    tags: ["plan"],
    favorite: true,
    searchText: "yıllık hedefler"
  },
  {
    id: "note-idea",
    title: "Işık fikri",
    path: "Notes/Ideas/Işık.md",
    folder: "Ideas",
    tags: ["fikir"],
    favorite: false,
    searchText: "ışık"
  }
];

class ControlledWorker implements SearchWorkerLike {
  public onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;
  public readonly postMessage = vi.fn();
  public readonly terminate = vi.fn();

  public respond(value: unknown): void {
    this.onmessage?.({ data: value } as MessageEvent<unknown>);
  }
}

describe("bounded Turkish vault search", () => {
  it("searches Turkish text, title, tag, folder, and favorite", () => {
    const index = createSearchIndex(indexFixture);
    expect(searchIndex(index, "yıllık tag:plan folder:Plans favorite:true").map((item) => item.id)).toEqual([
      "note-2026"
    ]);
    expect(searchIndex(index, "ISIK").map((item) => item.id)).toEqual(["note-idea"]);
  });

  it("keeps unknown filter names as ordinary search text", () => {
    const index = createSearchIndex([
      ...indexFixture,
      { ...indexFixture[1]!, id: "note-status", title: "status:active" }
    ]);
    expect(searchIndex(index, "status:active").map((item) => item.id)).toEqual(["note-status"]);
  });

  it("fences stale worker responses and terminates explicitly", async () => {
    const worker = new ControlledWorker();
    const client = new SearchClient(worker);
    const ready = client.initialize(indexFixture);
    const init = worker.postMessage.mock.calls[0]?.[0] as { requestId: number };
    worker.respond({ type: "ready", requestId: init.requestId });
    await ready;

    const first = client.query("ilk");
    const second = client.query("ikinci");
    const firstRequest = worker.postMessage.mock.calls[1]?.[0] as { requestId: number };
    const secondRequest = worker.postMessage.mock.calls[2]?.[0] as { requestId: number };
    worker.respond({ type: "results", requestId: firstRequest.requestId, results: [] });
    worker.respond({ type: "results", requestId: secondRequest.requestId, results: [] });

    await expect(first).rejects.toBeInstanceOf(StaleSearchResponseError);
    await expect(second).resolves.toEqual([]);
    client.terminate();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("fails a pending query closed when the worker returns malformed results", async () => {
    const worker = new ControlledWorker();
    const client = new SearchClient(worker);
    const ready = client.initialize(indexFixture);
    const init = worker.postMessage.mock.calls[0]?.[0] as { requestId: number };
    worker.respond({ type: "ready", requestId: init.requestId });
    await ready;

    const query = client.query("plan");
    const request = worker.postMessage.mock.calls[1]?.[0] as { requestId: number };
    worker.respond({ type: "results", requestId: request.requestId, results: [{ id: 42 }] });

    await expect(query).rejects.toThrow("invalid response");
    client.terminate();
  });
});
