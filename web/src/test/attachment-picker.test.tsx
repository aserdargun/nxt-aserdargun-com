import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const NOTE_ID = "018f47d2-6a34-7b2a-9f21-8a7034963aef";
const OTHER_NOTE_ID = "028f47d2-6a34-7b2a-9f21-8a7034963aef";
const ASSET_ID = `v1.${"a".repeat(16)}.asset.${"b".repeat(22)}`;
const MAX_BYTES = 20 * 1024 * 1024;

const uploaded = {
  asset: {
    assetId: ASSET_ID,
    name: "diagram.png",
    mimeType: "image/png",
    size: 4,
    disposition: "inline" as const
  }
};

const deferred = <T,>(): { promise: Promise<T>; resolve(value: T): void } => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
};

const testFile = (
  name = "diagram.png",
  type = "image/png",
  bytes = Uint8Array.of(1, 2, 3, 4),
  reportedSize = bytes.byteLength
): { file: File; read: ReturnType<typeof vi.fn> } => {
  const file = new File([bytes], name, { type });
  const read = vi.fn(() => Promise.resolve(bytes.buffer.slice(0)));
  Object.defineProperty(file, "arrayBuffer", { configurable: true, value: read });
  Object.defineProperty(file, "size", { configurable: true, value: reportedSize });
  return { file, read };
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("attachment picker", () => {
  it("rejects more than exactly 20 MiB before reading, encoding, or requesting", async () => {
    const { AttachmentPicker } = await import("../editor/attachment-picker");
    const user = userEvent.setup();
    const upload = vi.fn();
    const { file, read } = testFile("large.bin", "application/octet-stream", Uint8Array.of(1), MAX_BYTES + 1);
    render(<AttachmentPicker noteId={NOTE_ID} client={{ upload, trash: vi.fn() }} onUploaded={vi.fn()} />);

    await user.upload(screen.getByLabelText("Add attachment"), file);

    expect(screen.getByRole("alert")).toHaveTextContent("20 MB");
    expect(read).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("rejects multi-file drops without reading any file", async () => {
    const { AttachmentPicker } = await import("../editor/attachment-picker");
    const first = testFile("first.png");
    const second = testFile("second.png");
    const upload = vi.fn();
    render(<AttachmentPicker noteId={NOTE_ID} client={{ upload, trash: vi.fn() }} onUploaded={vi.fn()} />);

    fireEvent.drop(screen.getByTestId("attachment-drop-target"), {
      dataTransfer: { files: [first.file, second.file] }
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("one file");
    expect(first.read).not.toHaveBeenCalled();
    expect(second.read).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("preserves ordinary text paste and uploads exactly one pasted image", async () => {
    const { AttachmentPicker } = await import("../editor/attachment-picker");
    const image = testFile();
    const upload = vi.fn().mockResolvedValue(uploaded);
    const onUploaded = vi.fn();
    render(<AttachmentPicker noteId={NOTE_ID} client={{ upload, trash: vi.fn() }} onUploaded={onUploaded} />);

    const textPaste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(textPaste, "clipboardData", {
      value: { files: [], getData: (kind: string) => kind === "text/plain" ? "ordinary text" : "" }
    });
    document.dispatchEvent(textPaste);
    expect(textPaste.defaultPrevented).toBe(false);
    expect(upload).not.toHaveBeenCalled();

    const imagePaste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(imagePaste, "clipboardData", {
      value: { files: [image.file], getData: () => "" }
    });
    document.dispatchEvent(imagePaste);
    expect(imagePaste.defaultPrevented).toBe(true);
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(uploaded.asset));
    expect(upload).toHaveBeenCalledWith({
      noteId: NOTE_ID,
      name: "diagram.png",
      declaredMime: "image/png",
      bytesBase64: "AQIDBA=="
    });
  });

  it("fences concurrent selection and stale note-change completion", async () => {
    const { AttachmentPicker } = await import("../editor/attachment-picker");
    const user = userEvent.setup();
    const pending = deferred<typeof uploaded>();
    const upload = vi.fn(() => pending.promise);
    const onUploaded = vi.fn();
    const first = testFile("first.png");
    const second = testFile("second.png");
    const { rerender } = render(
      <AttachmentPicker noteId={NOTE_ID} client={{ upload, trash: vi.fn() }} onUploaded={onUploaded} />
    );

    await user.upload(screen.getByLabelText("Add attachment"), first.file);
    await user.upload(screen.getByLabelText("Add attachment"), second.file);
    expect(upload).toHaveBeenCalledOnce();
    expect(second.read).not.toHaveBeenCalled();

    rerender(
      <AttachmentPicker noteId={OTHER_NOTE_ID} client={{ upload, trash: vi.fn() }} onUploaded={onUploaded} />
    );
    pending.resolve(uploaded);
    await waitFor(() => expect(screen.getByLabelText("Add attachment")).not.toBeDisabled());
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it("drops an unmounted async completion and resets input for the same file", async () => {
    const { AttachmentPicker } = await import("../editor/attachment-picker");
    const user = userEvent.setup();
    const pending = deferred<typeof uploaded>();
    const upload = vi.fn()
      .mockResolvedValueOnce(uploaded)
      .mockImplementationOnce(() => pending.promise);
    const onUploaded = vi.fn();
    const selected = testFile();
    const view = render(
      <AttachmentPicker noteId={NOTE_ID} client={{ upload, trash: vi.fn() }} onUploaded={onUploaded} />
    );
    const input = screen.getByLabelText("Add attachment");

    await user.upload(input, selected.file);
    await waitFor(() => expect(onUploaded).toHaveBeenCalledOnce());
    await user.upload(input, selected.file);
    expect(upload).toHaveBeenCalledTimes(2);
    view.unmount();
    pending.resolve(uploaded);
    await Promise.resolve();
    expect(onUploaded).toHaveBeenCalledOnce();
  });
});

describe("persisted attachment cards", () => {
  it("renders only classified same-origin inline surfaces and downloads everything else", async () => {
    const { AttachmentView } = await import("../editor/attachment-view");
    const image = render(<AttachmentView attachment={uploaded.asset} onTrash={vi.fn()} />);
    expect(screen.getByRole("img", { name: "diagram.png" })).toHaveAttribute(
      "src",
      `/api/private/attachments/${ASSET_ID}`
    );
    image.unmount();

    const pdf = { ...uploaded.asset, name: "plan.pdf", mimeType: "application/pdf", disposition: "inline" as const };
    const pdfView = render(<AttachmentView attachment={pdf} onTrash={vi.fn()} />);
    expect(document.querySelector("object")).toHaveAttribute("data", `/api/private/attachments/${ASSET_ID}`);
    pdfView.unmount();

    const archive = { ...uploaded.asset, name: "plan.zip", mimeType: "application/zip", disposition: "download" as const };
    render(<AttachmentView attachment={archive} onTrash={vi.fn()} />);
    expect(screen.getByRole("link", { name: "Download plan.zip" })).toHaveAttribute(
      "href",
      `/api/private/attachments/${ASSET_ID}`
    );
    expect(screen.getByRole("link", { name: "Download plan.zip" })).toHaveAttribute("download");
  });

  it("requires explicit Trash confirmation and submits only the opaque asset ID", async () => {
    const { AttachmentView } = await import("../editor/attachment-view");
    const user = userEvent.setup();
    const onTrash = vi.fn().mockResolvedValue(undefined);
    render(<AttachmentView attachment={uploaded.asset} onTrash={onTrash} />);

    await user.click(screen.getByRole("button", { name: "Trash diagram.png" }));
    const dialog = screen.getByRole("dialog", { name: "Move attachment to Trash" });
    expect(onTrash).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Move to Trash" }));
    await waitFor(() => expect(onTrash).toHaveBeenCalledWith(ASSET_ID));
  });
});
