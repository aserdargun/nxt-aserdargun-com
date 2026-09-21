import { SessionResponseSchema } from "@nxt/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiTimeoutError, requestJson, requestOptionalJson } from "../api/client";

const session = { user: { userDetails: "owner" } };
const path = "/api/private/session";
const waitForAbort = (signal: AbortSignal): Promise<never> => new Promise((_, reject) => {
  const abort = (): void => reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("bounded API reads", () => {
  it.each([requestJson, requestOptionalJson])("aborts a stalled read and permits a fresh retry", async (request) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce((_, init) => waitForAbort(init!.signal!))
      .mockResolvedValueOnce(new Response(JSON.stringify(session)));
    vi.stubGlobal("fetch", fetchMock);
    const result = request(path, SessionResponseSchema);
    const rejected = expect(result).rejects.toBeInstanceOf(ApiTimeoutError);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await expect(request(path, SessionResponseSchema)).resolves.toEqual(session);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the deadline active while waiting for the response body", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((_, init) => {
      const response = new Response();
      response.json = () => waitForAbort(init!.signal!);
      return Promise.resolve(response);
    }));
    const rejected = expect(requestJson(path, SessionResponseSchema)).rejects.toBeInstanceOf(ApiTimeoutError);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves caller cancellation and cleans up its deadline", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error("Navigation cancelled");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((_, init) => waitForAbort(init!.signal!)));
    const rejected = expect(requestJson(path, SessionResponseSchema, undefined, { signal: controller.signal })).rejects.toBe(reason);
    controller.abort(reason);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not interrupt or retry a mutation that may already have reached storage", async () => {
    vi.useFakeTimers();
    let resolve: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => new Promise((done) => { resolve = done; }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = requestJson(path, SessionResponseSchema, undefined, { method: "PUT" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeUndefined();
    resolve?.(new Response(JSON.stringify(session)));
    await expect(pending).resolves.toEqual(session);
    expect(vi.getTimerCount()).toBe(0);
  });
});
