import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FormatToolbar } from "../editor/format-toolbar";
import type { MarkdownEditorHandle } from "../editor/markdown-editor";
import type { AttachmentClient } from "../api/attachments";

const NOTE_ID = "018f47d2-6a34-7b2a-9f21-8a7034963aef";

afterEach(() => {
  cleanup();
});

const buildHandle = (overrides: Partial<MarkdownEditorHandle> = {}): MarkdownEditorHandle => ({
  wrapSelection: vi.fn(),
  prefixLine: vi.fn(),
  insertAtCursor: vi.fn(),
  getView: () => null,
  ...overrides
});

describe("FormatToolbar", () => {
  it("renders every formatting control with an accessible label", () => {
    render(<FormatToolbar noteId={NOTE_ID} notePath="plans/test.md" editor={buildHandle()} />);
    expect(screen.getByRole("toolbar", { name: "Format toolbar" })).toBeInTheDocument();
    expect(screen.getByLabelText("Bold")).toBeInTheDocument();
    expect(screen.getByLabelText("Italic")).toBeInTheDocument();
    expect(screen.getByLabelText("Heading 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Heading 3")).toBeInTheDocument();
    expect(screen.getByLabelText("Bulleted list")).toBeInTheDocument();
    expect(screen.getByLabelText("Numbered list")).toBeInTheDocument();
    expect(screen.getByLabelText("Blockquote")).toBeInTheDocument();
    expect(screen.getByLabelText("Inline code")).toBeInTheDocument();
    expect(screen.getByLabelText("Code block")).toBeInTheDocument();
    expect(screen.getByLabelText("Link")).toBeInTheDocument();
    expect(screen.getByLabelText(/attachment/i)).toBeInTheDocument();
  });

  it("forwards bold and italic to the editor handle with Markdown markers", () => {
    const editor = buildHandle();
    render(<FormatToolbar noteId={NOTE_ID} notePath="a.md" editor={editor} />);
    fireEvent.click(screen.getByLabelText("Bold"));
    fireEvent.click(screen.getByLabelText("Italic"));
    expect(editor.wrapSelection).toHaveBeenCalledWith("**", "**", "bold text");
    expect(editor.wrapSelection).toHaveBeenCalledWith("*", "*", "italic text");
  });

  it("forwards heading, list, and quote prefixLine calls", () => {
    const editor = buildHandle();
    render(<FormatToolbar noteId={NOTE_ID} notePath="a.md" editor={editor} />);
    fireEvent.click(screen.getByLabelText("Heading 1"));
    fireEvent.click(screen.getByLabelText("Bulleted list"));
    fireEvent.click(screen.getByLabelText("Blockquote"));
    expect(editor.prefixLine).toHaveBeenCalledWith("# ");
    expect(editor.prefixLine).toHaveBeenCalledWith("- ");
    expect(editor.prefixLine).toHaveBeenCalledWith("> ");
  });

  it("opens an inline URL input when Link is clicked and commits via Enter", () => {
    const editor = buildHandle();
    render(<FormatToolbar noteId={NOTE_ID} notePath="a.md" editor={editor} />);
    fireEvent.click(screen.getByLabelText("Link"));
    const input = screen.getByLabelText("Link URL");
    fireEvent.change(input, { target: { value: "https://nxt.aserdargun.com" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(editor.wrapSelection).toHaveBeenCalledWith("[", "](https://nxt.aserdargun.com)", "link text");
  });

  it("uploads a chosen file and inserts portable attachment Markdown at the cursor", async () => {
    const editor = buildHandle();
    const upload = vi.fn(() => Promise.resolve({
      asset: { assetId: "asset_1", name: "photo.png", mimeType: "image/png", size: 12, disposition: "inline" as const }
    }));
    const trash = vi.fn(() => Promise.resolve());
    const client: AttachmentClient = { upload, trash };
    const onUploaded = vi.fn();
    render(
      <FormatToolbar
        noteId={NOTE_ID}
        notePath="plans/test.md"
        editor={editor}
        attachmentClient={client}
        onAttachmentUploaded={onUploaded}
      />
    );
    const file = new File([new Uint8Array([1, 2, 3, 4])], "photo.png", { type: "image/png" });
    const input = document.querySelector<HTMLInputElement>("input[type=\"file\"]");
    if (input === null) throw new Error("file input missing");
    fireEvent.change(input, { target: { files: [file] } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(upload).toHaveBeenCalled();
    const firstCall = upload.mock.calls[0] as readonly unknown[] | undefined;
    const payload = firstCall?.[0] as { name?: string; declaredMime?: string; bytesBase64?: string } | undefined;
    expect(payload).toBeDefined();
    expect(payload?.name).toBe("photo.png");
    expect(payload?.declaredMime).toBe("image/png");
    expect(typeof payload?.bytesBase64).toBe("string");
    expect(editor.insertAtCursor).toHaveBeenCalledWith(expect.stringContaining("![photo\\.png](<../_assets/" + NOTE_ID + "/photo.png>)"));
    expect(onUploaded).toHaveBeenCalled();
  });

  it("surfaces upload errors via the onError callback", async () => {
    const editor = buildHandle();
    const client: AttachmentClient = {
      upload: vi.fn(() => Promise.reject(Object.assign(new Error("Too large"), { code: "TOO_LARGE" }))),
      trash: vi.fn(() => Promise.resolve())
    };
    const onError = vi.fn();
    render(
      <FormatToolbar
        noteId={NOTE_ID}
        notePath="a.md"
        editor={editor}
        attachmentClient={client}
        onError={onError}
      />
    );
    const file = new File([new Uint8Array([1])], "big.bin", { type: "application/octet-stream" });
    const input = document.querySelector<HTMLInputElement>("input[type=\"file\"]");
    if (input === null) throw new Error("file input missing");
    fireEvent.change(input, { target: { files: [file] } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onError).toHaveBeenCalledWith("Attachment exceeds the 20 MB limit.");
  });

  it("disables all actions when the toolbar is disabled", () => {
    const editor = buildHandle();
    render(<FormatToolbar noteId={NOTE_ID} notePath="a.md" editor={editor} disabled />);
    expect(screen.getByLabelText("Bold")).toBeDisabled();
    expect(screen.getByLabelText("Link")).toBeDisabled();
  });
});
