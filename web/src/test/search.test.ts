import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SearchClient,
  StaleSearchResponseError,
  type SearchWorkerLike
} from "../explorer/search-client";
import { SearchPanel } from "../explorer/search-panel";
import { createSearchIndex, searchIndex, type SearchRecord } from "../explorer/search-worker";

const deferredControl = vi.hoisted(() => ({ hold: false, value: "" }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useDeferredValue<T>(value: T): T {
      const deferred = actual.useDeferredValue(value);
      if (deferredControl.hold) return deferredControl.value as T;
      deferredControl.value = deferred as string;
      return deferred;
    }
  };
});

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

afterEach(() => {
  cleanup();
  deferredControl.hold = false;
  deferredControl.value = "";
});

describe("bounded Turkish vault search", () => {
  it("shows an empty result only after the current query completes and clears it without recreating the client", async () => {
    const user = userEvent.setup();
    const query = vi.fn().mockResolvedValue([]);
    const terminate = vi.fn();
    const createClient = vi.fn().mockResolvedValue({ query, terminate });
    render(createElement(SearchPanel, {
      records: indexFixture,
      onOpenNote: vi.fn(),
      createClient
    }));

    await user.type(screen.getByRole("searchbox", { name: "Search files" }), "not present");

    expect(await screen.findByText("No matching notes")).toBeVisible();
    expect(query).toHaveBeenLastCalledWith("not present");
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByRole("searchbox", { name: "Search files" })).toHaveValue("");
    expect(createClient).toHaveBeenCalledOnce();
  });

  it("does not replay an unchanged requested query when the change callback is replaced", async () => {
    const firstChange = vi.fn();
    const view = render(createElement(SearchPanel, {
      records: indexFixture,
      onOpenNote: vi.fn(),
      requestedQuery: "plan",
      onQueryChange: firstChange,
      createClient: vi.fn().mockResolvedValue({ query: vi.fn().mockResolvedValue([]), terminate: vi.fn() })
    }));
    const search = screen.getByRole("searchbox", { name: "Search files" });
    await waitFor(() => expect(search).toHaveValue("plan"));

    fireEvent.change(search, { target: { value: "personal" } });
    expect(search).toHaveValue("personal");

    view.rerender(createElement(SearchPanel, {
      records: indexFixture,
      onOpenNote: vi.fn(),
      requestedQuery: "plan",
      onQueryChange: vi.fn(),
      createClient: vi.fn().mockResolvedValue({ query: vi.fn().mockResolvedValue([]), terminate: vi.fn() })
    }));

    expect(search).toHaveValue("personal");
  });

  it.each([
    ["result", [{ id: "note-2026", title: "2026 Yıllık Planı", path: "Notes/Plans/2026 Yıllık Planı.md", folder: "Plans", tags: ["plan"], favorite: true, score: 10 }]],
    ["empty state", []]
  ] as const)("hides an earlier %s synchronously when the visible query outruns the deferred query", async (_state, priorAnswer) => {
    let resolveCurrent!: (value: []) => void;
    const current = new Promise<[]>((resolve) => { resolveCurrent = resolve; });
    const query = vi.fn((value: string) => value === "missing" ? current : Promise.resolve(priorAnswer));
    const createClient = vi.fn().mockResolvedValue({ query, terminate: vi.fn() });
    const props = {
      records: indexFixture,
      onOpenNote: vi.fn(),
      createClient
    };
    const view = render(createElement(SearchPanel, props));

    fireEvent.change(screen.getByRole("searchbox", { name: "Search files" }), { target: { value: "plan" } });
    if (priorAnswer.length === 0) expect(await screen.findByText("No matching notes")).toBeVisible();
    else expect(await screen.findByRole("button", { name: /2026 Yıllık Planı/u })).toBeVisible();
    deferredControl.hold = true;
    fireEvent.change(screen.getByRole("searchbox", { name: "Search files" }), { target: { value: "missing" } });

    expect(screen.getByRole("searchbox", { name: "Search files" })).toHaveValue("missing");
    expect(screen.queryByRole("button", { name: /2026 Yıllık Planı/u })).not.toBeInTheDocument();
    expect(screen.queryByText("No matching notes")).not.toBeInTheDocument();
    deferredControl.hold = false;
    view.rerender(createElement(SearchPanel, props));
    await waitFor(() => expect(query).toHaveBeenLastCalledWith("missing"));
    resolveCurrent([]);
    expect(await screen.findByText("No matching notes")).toBeVisible();
  });

  it("searches Turkish text, title, tag, folder, and favorite", () => {
    const index = createSearchIndex(indexFixture);
    const results = searchIndex(index, "yıllık tag:plan folder:Plans favorite:true");
    expect(results.map((item) => item.id)).toEqual(["note-2026"]);
    expect(results[0]).not.toHaveProperty("searchText");
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

  it("rejects every pending request when a malformed worker response has no usable request ID", async () => {
    const worker = new ControlledWorker();
    const client = new SearchClient(worker);
    const ready = client.initialize(indexFixture);

    worker.respond({ type: "ready", requestId: "not-an-integer" });

    await expect(ready).rejects.toThrow("invalid response");
    expect(worker.terminate).toHaveBeenCalledOnce();
    await expect(client.query("plan")).rejects.toThrow("terminated");
  });
});
