import {
  Bold,
  Code,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  List as ListIcon,
  ListOrdered,
  Paperclip,
  Quote
} from "lucide-react";
import { useCallback, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { createPortableAttachmentMarkdown, type WikiTargetResolution } from "@nxt/domain";
import { attachmentClient, type AttachmentClient, type UploadedAttachment } from "../api/attachments";
import { formatAttachmentError, readFileAsBase64 } from "./attachment-helpers";
import type { MarkdownEditorHandle } from "./markdown-editor";

export interface FormatToolbarProps {
  readonly noteId: string;
  readonly notePath: string;
  readonly editor: MarkdownEditorHandle | null;
  readonly disabled?: boolean;
  readonly attachmentClient?: AttachmentClient;
  readonly wikiLinkTarget?: ((target: string) => WikiTargetResolution) | undefined;
  readonly onAttachmentUploaded?: ((attachment: UploadedAttachment) => void | Promise<void>) | undefined;
  readonly onError?: ((message: string) => void) | undefined;
}

interface ToolbarAction {
  readonly id: string;
  readonly label: string;
  readonly shortcut: string;
  readonly run: () => void;
}

/**
 * Sticky Obsidian-style toolbar that wraps the current selection in the
 * editor with inline/block Markdown markers. The attachment button uploads
 * via the same private API the toolbar picker already uses, then inserts a
 * portable Markdown reference at the cursor.
 */
export const FormatToolbar = ({
  noteId,
  notePath,
  editor,
  disabled = false,
  attachmentClient: attachment = attachmentClient,
  onAttachmentUploaded,
  onError
}: FormatToolbarProps): React.JSX.Element => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [linkInputOpen, setLinkInputOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");

  const run = useCallback((action: () => void) => {
    if (disabled) return;
    action();
  }, [disabled]);

  const actions: readonly ToolbarAction[] = [
    { id: "bold", label: "Bold", shortcut: "B", run: () => editor?.wrapSelection("**", "**", "bold text") },
    { id: "italic", label: "Italic", shortcut: "I", run: () => editor?.wrapSelection("*", "*", "italic text") },
    { id: "h1", label: "Heading 1", shortcut: "H1", run: () => editor?.prefixLine("# ") },
    { id: "h2", label: "Heading 2", shortcut: "H2", run: () => editor?.prefixLine("## ") },
    { id: "h3", label: "Heading 3", shortcut: "H3", run: () => editor?.prefixLine("### ") },
    { id: "ul", label: "Bulleted list", shortcut: "L", run: () => editor?.prefixLine("- ") },
    { id: "ol", label: "Numbered list", shortcut: "1.", run: () => editor?.prefixLine("1. ") },
    { id: "quote", label: "Blockquote", shortcut: '"', run: () => editor?.prefixLine("> ") },
    { id: "code", label: "Inline code", shortcut: "`", run: () => editor?.wrapSelection("`", "`", "code") },
    { id: "codeblock", label: "Code block", shortcut: "```", run: () => editor?.wrapSelection("\n```\n", "\n```\n", "code") },
    { id: "link", label: "Link", shortcut: "Link", run: () => { setLinkValue(""); setLinkInputOpen(true); } },
    { id: "attachment", label: "Attachment", shortcut: "Attach", run: () => fileInputRef.current?.click() }
  ];

  const commitLink = (): void => {
    const target = linkValue.trim();
    setLinkInputOpen(false);
    setLinkValue("");
    if (target.length === 0) return;
    editor?.wrapSelection("[", `](${target})`, "link text");
  };

  const onLinkKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitLink();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setLinkInputOpen(false);
      setLinkValue("");
    }
  };

  const onAttachmentSelected = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    event.target.value = "";
    if (uploading) return;
    setUploading(true);
    try {
      const bytesBase64 = await readFileAsBase64(file);
      const response = await attachment.upload({
        noteId,
        name: file.name,
        declaredMime: file.type.length > 0 ? file.type : "application/octet-stream",
        bytesBase64
      });
      const markdown = createPortableAttachmentMarkdown({
        notePath,
        noteId,
        name: response.asset.name,
        inlineImage: response.asset.disposition === "inline" && response.asset.mimeType.startsWith("image/")
      });
      editor?.insertAtCursor(markdown);
      await onAttachmentUploaded?.(response.asset);
    } catch (error) {
      onError?.(formatAttachmentError(error));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="format-toolbar" role="toolbar" aria-label="Format toolbar" aria-disabled={disabled}>
      <div className="format-toolbar-group">
        <button
          type="button"
          className="format-toolbar-button touch-target"
          onClick={() => run(actions[0]!.run)}
          disabled={disabled}
          aria-label="Bold"
          title="Bold (Ctrl+B)"
        >
          <Bold size={17} strokeWidth={1.75} aria-hidden />
        </button>
        <button
          type="button"
          className="format-toolbar-button touch-target"
          onClick={() => run(actions[1]!.run)}
          disabled={disabled}
          aria-label="Italic"
          title="Italic (Ctrl+I)"
        >
          <Italic size={17} strokeWidth={1.75} aria-hidden />
        </button>
        <span className="format-toolbar-sep" aria-hidden />
        <button type="button" className="format-toolbar-button touch-target" onClick={() => run(actions[2]!.run)} disabled={disabled} aria-label="Heading 1" title="Heading 1">
          <Heading1 size={17} strokeWidth={1.75} aria-hidden />
        </button>
        <button type="button" className="format-toolbar-button touch-target" onClick={() => run(actions[3]!.run)} disabled={disabled} aria-label="Heading 2" title="Heading 2">
          <Heading2 size={17} strokeWidth={1.75} aria-hidden />
        </button>
        <button type="button" className="format-toolbar-button touch-target" onClick={() => run(actions[4]!.run)} disabled={disabled} aria-label="Heading 3" title="Heading 3">
          <Heading3 size={17} strokeWidth={1.75} aria-hidden />
        </button>
        <span className="format-toolbar-sep" aria-hidden />
        <button type="button" className="format-toolbar-button touch-target" onClick={() => run(actions[5]!.run)} disabled={disabled} aria-label="Bulleted list" title="Bulleted list">
          <ListIcon size={17} strokeWidth={1.75} aria-hidden />
        </button>
        <button type="button" className="format-toolbar-button touch-target" onClick={() => run(actions[6]!.run)} disabled={disabled} aria-label="Numbered list" title="Numbered list">
          <ListOrdered size={17} strokeWidth={1.75} aria-hidden />
        </button>
        <button type="button" className="format-toolbar-button touch-target" onClick={() => run(actions[7]!.run)} disabled={disabled} aria-label="Blockquote" title="Blockquote">
          <Quote size={17} strokeWidth={1.75} aria-hidden />
        </button>
        <span className="format-toolbar-sep" aria-hidden />
        <button type="button" className="format-toolbar-button touch-target" onClick={() => run(actions[8]!.run)} disabled={disabled} aria-label="Inline code" title="Inline code">
          <Code size={17} strokeWidth={1.75} aria-hidden />
        </button>
        <button type="button" className="format-toolbar-button touch-target" onClick={() => run(actions[9]!.run)} disabled={disabled} aria-label="Code block" title="Code block">
          <Code2 size={17} strokeWidth={1.75} aria-hidden />
        </button>
        <span className="format-toolbar-sep" aria-hidden />
        <button
          type="button"
          className="format-toolbar-button touch-target"
          onClick={() => run(actions[10]!.run)}
          disabled={disabled}
          aria-label="Link"
          aria-expanded={linkInputOpen}
          title="Insert link"
        >
          <LinkIcon size={17} strokeWidth={1.75} aria-hidden />
        </button>
        {linkInputOpen ? (
          <span className="format-toolbar-link">
            <input
              className="format-toolbar-link-input"
              type="url"
              value={linkValue}
              placeholder="https://…"
              aria-label="Link URL"
              autoFocus
              onChange={(event) => setLinkValue(event.target.value)}
              onKeyDown={onLinkKeyDown}
              onBlur={commitLink}
            />
          </span>
        ) : null}
        <span className="format-toolbar-sep" aria-hidden />
        <button
          type="button"
          className="format-toolbar-button touch-target"
          onClick={() => run(actions[11]!.run)}
          disabled={disabled || uploading}
          aria-busy={uploading}
          aria-label={uploading ? "Uploading attachment" : "Insert attachment"}
          title="Insert attachment"
        >
          <Paperclip size={17} strokeWidth={1.75} aria-hidden />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          className="visually-hidden"
          onChange={(event) => { void onAttachmentSelected(event); }}
          aria-hidden
          tabIndex={-1}
        />
      </div>
    </div>
  );
};
