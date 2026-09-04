import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const NOTE_ID = "018f47d2-6a34-7b2a-9f21-8a7034963aef";
const PUBLIC_ID = "A".repeat(22);
const STATUS = {
  publicId: PUBLIC_ID,
  publishedAt: "2026-08-26T12:00:00.000Z",
  sourceVersion: "7",
  attachmentCount: 2
};
const PUBLIC_NOTE = {
  title: "Published plan",
  html: "<h1>Published plan</h1>",
  publishedAt: STATUS.publishedAt,
  sourceVersion: "7",
  assets: []
};

const json = (status: number, value: unknown): Response => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json" }
});

const deferred = <T,>(): { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void } => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("typed publication clients", () => {
  it("accepts publish only after private status and anonymous source-version readback", async () => {
    const { publicationClient } = await import("../api/publications");
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(json(200, { publicId: PUBLIC_ID, publishedAt: STATUS.publishedAt }))
      .mockResolvedValueOnce(json(200, STATUS))
      .mockResolvedValueOnce(json(200, PUBLIC_NOTE));
    vi.stubGlobal("fetch", fetchMock);

    await expect(publicationClient.publish(NOTE_ID, "7")).resolves.toEqual(STATUS);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      `/api/private/notes/${NOTE_ID}/publish`,
      `/api/private/notes/${NOTE_ID}/publication`,
      `/api/public/notes/${PUBLIC_ID}`
    ]);
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    expect(typeof body).toBe("string");
    if (typeof body !== "string") throw new Error("Expected a JSON request body.");
    expect(JSON.parse(body) as unknown).toEqual({ expectedVersion: "7" });
  });

  it("fails closed when either durable readback crosses the requested version boundary", async () => {
    const { publicationClient } = await import("../api/publications");
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(json(200, { publicId: PUBLIC_ID, publishedAt: STATUS.publishedAt }))
      .mockResolvedValueOnce(json(200, { ...STATUS, sourceVersion: "8" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(publicationClient.publish(NOTE_ID, "7")).rejects.toThrow("invalid response");

    fetchMock.mockReset()
      .mockResolvedValueOnce(json(200, { publicId: PUBLIC_ID, publishedAt: STATUS.publishedAt }))
      .mockResolvedValueOnce(json(200, STATUS))
      .mockResolvedValueOnce(json(200, { ...PUBLIC_NOTE, sourceVersion: "8" }));
    await expect(publicationClient.publish(NOTE_ID, "7")).rejects.toThrow("invalid response");
  });

  it("accepts revoke only after a cache-bypassed exact anonymous 404", async () => {
    const { publicationClient } = await import("../api/publications");
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(json(200, { revoked: true }))
      .mockResolvedValueOnce(json(404, {
        error: { code: "NOT_FOUND", message: "The requested resource was not found.", requestId: "request-1" }
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(publicationClient.revoke(PUBLIC_ID)).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/public/notes/${PUBLIC_ID}`);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "GET", cache: "no-store" });
    const verificationPath = fetchMock.mock.calls[1]?.[0];
    expect(typeof verificationPath).toBe("string");
    if (typeof verificationPath !== "string") throw new Error("Expected a relative verification path.");
    expect(verificationPath).not.toMatch(/[?#]/u);
  });

  it("rejects a revoke verification that is 200, malformed, or any non-404 status", async () => {
    const { publicationClient } = await import("../api/publications");
    for (const verification of [
      json(200, PUBLIC_NOTE),
      json(404, { error: { code: "DRIVE_UNAVAILABLE", message: "Unavailable", requestId: "request-2" } }),
      json(503, { error: { code: "DRIVE_UNAVAILABLE", message: "Unavailable", requestId: "request-3" } })
    ]) {
      const fetchMock = vi.fn<typeof fetch>();
      fetchMock.mockResolvedValueOnce(json(200, { revoked: true }))
        .mockResolvedValueOnce(verification);
      vi.stubGlobal("fetch", fetchMock);
      await expect(publicationClient.revoke(PUBLIC_ID)).rejects.toThrow();
    }
  });
});

describe("publish and revoke dialogs", () => {
  it("shows and politely announces copy success", async () => {
    const { PublicationStatus } = await import("../publication/publication-status");
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(navigator, "clipboard", "get").mockReturnValue({ writeText } as unknown as Clipboard);
    render(
      <PublicationStatus
        status={STATUS}
        client={{ getStatus: vi.fn(), publish: vi.fn(), revoke: vi.fn() }}
        onRevoked={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Copy link" }));
    const feedback = await screen.findByText("Link copied.");
    expect(feedback).toBeVisible();
    expect(feedback).toHaveClass("publication-copy-status");
    expect(feedback).not.toHaveClass("sr-only");
    expect(feedback).toHaveAttribute("aria-live", "polite");
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/p/${PUBLIC_ID}`);
  });

  it("keeps clipboard unavailability visible and polite", async () => {
    const { PublicationStatus } = await import("../publication/publication-status");
    const user = userEvent.setup();
    vi.spyOn(navigator, "clipboard", "get").mockReturnValue(undefined as unknown as Clipboard);
    render(
      <PublicationStatus
        status={STATUS}
        client={{ getStatus: vi.fn(), publish: vi.fn(), revoke: vi.fn() }}
        onRevoked={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Copy link" }));
    const feedback = screen.getByText("Copy unavailable");
    expect(feedback).toBeVisible();
    expect(feedback).toHaveClass("publication-copy-status");
    expect(feedback).toHaveAttribute("aria-live", "polite");
  });

  it("keeps the newest copy result when clipboard attempts settle out of order", async () => {
    const { PublicationStatus } = await import("../publication/publication-status");
    const user = userEvent.setup();
    const older = deferred<void>();
    const newer = deferred<void>();
    const writeText = vi.fn()
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    vi.spyOn(navigator, "clipboard", "get").mockReturnValue({ writeText } as unknown as Clipboard);
    render(
      <PublicationStatus
        status={STATUS}
        client={{ getStatus: vi.fn(), publish: vi.fn(), revoke: vi.fn() }}
        onRevoked={vi.fn()}
      />
    );

    const copy = screen.getByRole("button", { name: "Copy link" });
    await user.click(copy);
    await user.click(copy);
    expect(writeText).toHaveBeenCalledTimes(2);

    await act(async () => {
      newer.resolve(undefined);
      await newer.promise;
    });
    expect(screen.getByText("Link copied.")).toBeVisible();

    await act(async () => {
      older.reject(new Error("older copy failed"));
      await Promise.resolve();
    });
    expect(screen.getByText("Link copied.")).toBeVisible();
    expect(screen.queryByText("Copy unavailable")).not.toBeInTheDocument();
  });

  it("drops an old publication copy completion and allows copying the new link", async () => {
    const { PublicationStatus } = await import("../publication/publication-status");
    const user = userEvent.setup();
    const older = deferred<void>();
    const nextPublicId = "B".repeat(22);
    const nextStatus = { ...STATUS, publicId: nextPublicId };
    const writeText = vi.fn()
      .mockImplementationOnce(() => older.promise)
      .mockResolvedValueOnce(undefined);
    vi.spyOn(navigator, "clipboard", "get").mockReturnValue({ writeText } as unknown as Clipboard);
    const view = render(
      <PublicationStatus
        status={STATUS}
        client={{ getStatus: vi.fn(), publish: vi.fn(), revoke: vi.fn() }}
        onRevoked={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Copy link" }));
    view.rerender(
      <PublicationStatus
        status={nextStatus}
        client={{ getStatus: vi.fn(), publish: vi.fn(), revoke: vi.fn() }}
        onRevoked={vi.fn()}
      />
    );
    await act(async () => {
      older.resolve(undefined);
      await older.promise;
    });
    expect(screen.queryByText("Link copied.")).not.toBeInTheDocument();
    expect(screen.queryByText("Copy unavailable")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy link" }));
    expect(await screen.findByText("Link copied.")).toBeVisible();
    expect(writeText).toHaveBeenLastCalledWith(`${window.location.origin}/p/${nextPublicId}`);
  });

  it("restores focus to the publish trigger after a verified publish closes", async () => {
    const { PublishDialog } = await import("../publication/publish-dialog");
    const user = userEvent.setup();
    const publish = vi.fn().mockResolvedValue(STATUS);

    const Harness = (): React.JSX.Element => {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open publish</button>
          <PublishDialog
            open={open}
            onOpenChange={setOpen}
            noteId={NOTE_ID}
            sourceVersion="7"
            attachmentCount={2}
            client={{ getStatus: vi.fn(), publish, revoke: vi.fn() }}
            onPublished={vi.fn()}
          />
        </>
      );
    };

    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open publish" });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Publish snapshot" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Publish note" })).not.toBeInTheDocument());
    expect(document.activeElement).toBe(trigger);
  });

  it("shows the exact source version/count/noindex boundary and fences double submit", async () => {
    const { PublishDialog } = await import("../publication/publish-dialog");
    const user = userEvent.setup();
    const pending = deferred<typeof STATUS>();
    const publish = vi.fn(() => pending.promise);
    const onPublished = vi.fn();
    render(
      <PublishDialog
        open
        onOpenChange={vi.fn()}
        noteId={NOTE_ID}
        sourceVersion="7"
        attachmentCount={2}
        client={{ getStatus: vi.fn(), publish, revoke: vi.fn() }}
        onPublished={onPublished}
      />
    );

    const dialog = screen.getByRole("dialog", { name: "Publish note" });
    expect(dialog).toHaveTextContent("Version 7");
    expect(dialog).toHaveTextContent("2 referenced attachments");
    expect(dialog).toHaveTextContent("unlisted");
    expect(dialog).toHaveTextContent("noindex");
    const confirm = within(dialog).getByRole("button", { name: "Publish snapshot" });
    await user.dblClick(confirm);
    expect(publish).toHaveBeenCalledOnce();
    expect(confirm).toBeDisabled();
    pending.resolve(STATUS);
    await waitFor(() => expect(onPublished).toHaveBeenCalledWith(STATUS));
  });

  it("restores trigger focus and keeps authoritative status visible when 404 verification fails", async () => {
    const { PublicationStatus } = await import("../publication/publication-status");
    const user = userEvent.setup();
    const revoke = vi.fn().mockRejectedValue(new Error("verification failed"));
    render(
      <PublicationStatus
        status={STATUS}
        client={{ getStatus: vi.fn(), publish: vi.fn(), revoke }}
        onRevoked={vi.fn()}
      />
    );

    const trigger = screen.getByRole("button", { name: "Revoke" });
    trigger.focus();
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Revoke publication" });
    await user.click(within(dialog).getByRole("button", { name: "Confirm revoke" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be verified");
    expect(screen.getByRole("button", { name: "Revoke", hidden: true })).toBeVisible();
    expect(screen.getByRole("button", { name: "Copy link", hidden: true })).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
