import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const PUBLIC_ID = "A".repeat(22);
const ASSET_ID = "B".repeat(22);
const asset = {
  assetId: ASSET_ID,
  url: `/api/public/assets/${PUBLIC_ID}/${ASSET_ID}`,
  name: "diagram.png",
  mimeType: "image/png",
  disposition: "inline" as const
};
const note = {
  title: "Published plan",
  html: "<p>Frozen body</p>",
  publishedAt: "2026-08-26T12:00:00.000Z",
  sourceVersion: "7",
  assets: [asset]
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.head.querySelectorAll('meta[name="robots"]').forEach((item) => item.remove());
});

describe("anonymous public note", () => {
  it("route-splits directly to the anonymous client without any private or session request", async () => {
    const { appRoutes } = await import("../app/router");
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(new Response(JSON.stringify(note), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const router = createMemoryRouter(appRoutes, { initialEntries: [`/p/${PUBLIC_ID}`] });
    render(<RouterProvider router={router} />);

    expect(await screen.findByRole("heading", { name: "Published plan" })).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestPath = fetchMock.mock.calls[0]?.[0];
    expect(requestPath).toBe(`/api/public/notes/${PUBLIC_ID}`);
    if (typeof requestPath !== "string") throw new Error("Expected a relative public path.");
    expect(requestPath).not.toContain("/api/private/");
    expect(requestPath).not.toContain("/.auth/me");
  });

  it("keeps loading and rendered public states noindex and owner-free", async () => {
    const { PublicNotePage } = await import("../publication/public-note-page");
    const getNote = vi.fn().mockResolvedValue(note);
    render(<PublicNotePage publicId={PUBLIC_ID} client={{ getNote }} />);

    expect(document.querySelector('meta[name="robots"]')).toHaveAttribute("content", "noindex,nofollow");
    expect(await screen.findByRole("heading", { name: "Published plan" })).toBeVisible();
    expect(screen.queryByTestId("owner-shell")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Drive/iu)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /public notes/iu })).not.toBeInTheDocument();
  });

  it("lets an equivalent leading body H1 own the single visible document title", async () => {
    const { PublicNotePage } = await import("../publication/public-note-page");
    const title = "Published plan";
    const getNote = vi.fn().mockResolvedValue({
      ...note,
      title,
      html: '<h1 id="body-title"> Published\u00a0  plan </h1><p>Frozen body</p>'
    });
    render(<PublicNotePage publicId={PUBLIC_ID} client={{ getNote }} />);

    await screen.findByText("Frozen body");
    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent?.normalize("NFC").replace(/\s+/gu, " ").trim()).toBe(title);
  });

  it("retains the metadata H1 when the frozen HTML has no leading H1", async () => {
    const { PublicNotePage } = await import("../publication/public-note-page");
    const getNote = vi.fn().mockResolvedValue({
      ...note,
      html: "<p>Frozen body</p><h2>Details</h2>"
    });
    render(<PublicNotePage publicId={PUBLIC_ID} client={{ getNote }} />);

    expect(await screen.findByRole("heading", { level: 1, name: "Published plan" })).toBeVisible();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("retains the metadata H1 when the leading body H1 differs by case", async () => {
    const { PublicNotePage } = await import("../publication/public-note-page");
    const getNote = vi.fn().mockResolvedValue({ ...note, html: "<h1>published plan</h1>" });
    render(<PublicNotePage publicId={PUBLIC_ID} client={{ getNote }} />);

    expect(await screen.findByRole("heading", { level: 1, name: "Published plan" })).toBeVisible();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(2);
  });

  it("retains the metadata H1 when an equivalent body H1 appears later", async () => {
    const { PublicNotePage } = await import("../publication/public-note-page");
    const getNote = vi.fn().mockResolvedValue({
      ...note,
      html: "<p>Intro</p><h1>Published plan</h1>"
    });
    render(<PublicNotePage publicId={PUBLIC_ID} client={{ getNote }} />);

    await screen.findAllByRole("heading", { level: 1, name: "Published plan" });
    expect(screen.getAllByRole("heading", { level: 1, name: "Published plan" })).toHaveLength(2);
  });

  it("validates the route ID before fetch and maps every failure to one generic Not found surface", async () => {
    const { PublicNotePage } = await import("../publication/public-note-page");
    const getNote = vi.fn();
    const { rerender } = render(<PublicNotePage publicId="raw-drive-id" client={{ getNote }} />);
    expect(await screen.findByRole("heading", { name: "Not found" })).toBeVisible();
    expect(getNote).not.toHaveBeenCalled();
    expect(document.querySelector('meta[name="robots"]')).toHaveAttribute("content", "noindex,nofollow");

    getNote.mockResolvedValueOnce(null);
    rerender(<PublicNotePage publicId={PUBLIC_ID} client={{ getNote }} />);
    expect(await screen.findByRole("heading", { name: "Not found" })).toBeVisible();

    getNote.mockRejectedValueOnce(new Error("private manifest path"));
    rerender(<PublicNotePage publicId={"C".repeat(22)} client={{ getNote }} />);
    expect(await screen.findByRole("heading", { name: "Not found" })).toBeVisible();
    expect(document.body).not.toHaveTextContent("private manifest path");
  });

  it("restores pre-existing robots metadata exactly on unmount", async () => {
    const { PublicNotePage } = await import("../publication/public-note-page");
    const existing = document.createElement("meta");
    existing.name = "robots";
    existing.content = "index,follow";
    document.head.append(existing);
    const view = render(<PublicNotePage publicId={PUBLIC_ID} client={{ getNote: vi.fn().mockResolvedValue(note) }} />);
    expect(existing).toHaveAttribute("content", "noindex,nofollow");
    await screen.findByRole("heading", { name: "Published plan" });
    view.unmount();
    expect(existing).toHaveAttribute("content", "index,follow");
    expect(document.head.querySelectorAll('meta[name="robots"]')).toHaveLength(1);
  });

  it("renders only exact same-public-ID allowlisted asset URLs", async () => {
    const { PublicAttachment } = await import("../publication/public-attachment");
    const { rerender } = render(<PublicAttachment publicId={PUBLIC_ID} asset={asset} />);
    expect(screen.getByRole("img", { name: "diagram.png" })).toHaveAttribute("src", asset.url);

    rerender(<PublicAttachment publicId={PUBLIC_ID} asset={{ ...asset, url: `/api/public/assets/${"C".repeat(22)}/${ASSET_ID}` }} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    rerender(<PublicAttachment publicId={PUBLIC_ID} asset={{ ...asset, url: `${asset.url}?download=1` }} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Attachment unavailable");
  });

  it("drops a stale public read after the ID changes", async () => {
    const { PublicNotePage } = await import("../publication/public-note-page");
    let resolve!: (value: typeof note) => void;
    const first = new Promise<typeof note>((next) => { resolve = next; });
    const getNote = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ ...note, title: "New publication" });
    const { rerender } = render(<PublicNotePage publicId={PUBLIC_ID} client={{ getNote }} />);
    rerender(<PublicNotePage publicId={"C".repeat(22)} client={{ getNote }} />);
    expect(await screen.findByRole("heading", { name: "New publication" })).toBeVisible();
    resolve(note);
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Published plan" })).not.toBeInTheDocument());
  });
});
