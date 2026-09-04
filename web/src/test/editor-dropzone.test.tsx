import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorDropzone } from "../editor/editor-dropzone";

afterEach(() => {
  cleanup();
});

const buildFile = (name: string, type: string, payload: readonly number[] = [1, 2, 3, 4]): File =>
  new File([new Uint8Array(payload)], name, { type });

describe("EditorDropzone", () => {
  it("forwards dropped files to the onFile callback", () => {
    const onFile = vi.fn();
    render(
      <EditorDropzone onFile={onFile}>
        <div>editor area</div>
      </EditorDropzone>
    );
    const zone = screen.getByText("editor area").parentElement!;
    const file = buildFile("dropped.png", "image/png");
    fireEvent.drop(zone, { dataTransfer: { files: [file], types: ["Files"] } });
    expect(onFile).toHaveBeenCalledWith(file);
  });

  it("shows the drop overlay only while a file drag is active", () => {
    const onFile = vi.fn();
    render(
      <EditorDropzone onFile={onFile}>
        <div>editor area</div>
      </EditorDropzone>
    );
    const zone = screen.getByText("editor area").parentElement!;
    fireEvent.dragEnter(zone, { dataTransfer: { types: ["Files"] } });
    expect(zone.getAttribute("data-drop-active")).toBe("true");
    expect(zone.querySelector(".editor-dropzone-overlay")).not.toBeNull();
    fireEvent.dragLeave(zone, { dataTransfer: { types: ["Files"] } });
    expect(zone.getAttribute("data-drop-active")).toBe("false");
    expect(zone.querySelector(".editor-dropzone-overlay")).toBeNull();
  });

  it("forwards pasted files (image clipboard) to the onFile callback", () => {
    const onFile = vi.fn();
    render(
      <EditorDropzone onFile={onFile}>
        <div>editor area</div>
      </EditorDropzone>
    );
    const zone = screen.getByText("editor area").parentElement!;
    const file = buildFile("pasted.png", "image/png");
    const clipboardData = {
      items: [
        { kind: "string", type: "text/plain", getAsFile: () => null },
        { kind: "file", type: "image/png", getAsFile: () => file }
      ]
    };
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: clipboardData });
    fireEvent(zone, paste);
    expect(onFile).toHaveBeenCalledWith(file);
  });

  it("does not forward plain text pastes", () => {
    const onFile = vi.fn();
    render(
      <EditorDropzone onFile={onFile}>
        <div>editor area</div>
      </EditorDropzone>
    );
    const zone = screen.getByText("editor area").parentElement!;
    const clipboardData = {
      items: [{ kind: "string", type: "text/plain", getAsFile: () => null }]
    };
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: clipboardData });
    fireEvent(zone, paste);
    expect(onFile).not.toHaveBeenCalled();
  });

  it("ignores drop events that do not carry a file payload", () => {
    const onFile = vi.fn();
    render(
      <EditorDropzone onFile={onFile}>
        <div>editor area</div>
      </EditorDropzone>
    );
    const zone = screen.getByText("editor area").parentElement!;
    fireEvent.dragEnter(zone, { dataTransfer: { types: ["text/plain"] } });
    expect(zone.getAttribute("data-drop-active")).toBe("false");
    fireEvent.drop(zone, { dataTransfer: { files: [], types: ["text/plain"] } });
    expect(onFile).not.toHaveBeenCalled();
  });

  it("does not call onFile when disabled", () => {
    const onFile = vi.fn();
    render(
      <EditorDropzone onFile={onFile} disabled>
        <div>editor area</div>
      </EditorDropzone>
    );
    const zone = screen.getByText("editor area").parentElement!;
    const file = buildFile("dropped.png", "image/png");
    fireEvent.drop(zone, { dataTransfer: { files: [file], types: ["Files"] } });
    expect(onFile).not.toHaveBeenCalled();
  });
});
