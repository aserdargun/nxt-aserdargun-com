import { NoteIdSchema, isOpaqueId } from "@nxt/contracts";
import {
  canonicalAttachmentReference,
  renderMarkdown,
  type WikiTargetResolution
} from "@nxt/domain";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface MarkdownPreviewProps {
  readonly source: string;
  readonly notePath: string;
  readonly resolveAttachment?: ((canonicalReference: string) => string | undefined) | undefined;
  readonly resolveWikiLink?: ((target: string) => WikiTargetResolution) | undefined;
  readonly onWikiNavigate?: ((noteId: string) => void) | undefined;
}

interface RenderState {
  readonly html: string;
  readonly source: string;
}

interface ParsedWikiText {
  readonly before: string;
  readonly target: string;
  readonly label: string;
  readonly after: string;
}

const firstWikiText = (value: string): ParsedWikiText | null => {
  const opening = value.indexOf("[[");
  if (opening < 0) return null;
  const closing = value.indexOf("]]", opening + 2);
  if (closing < 0) return null;
  const raw = value.slice(opening + 2, closing);
  const separator = raw.indexOf("|");
  const target = (separator < 0 ? raw : raw.slice(0, separator)).trim();
  const label = (separator < 0 ? target : raw.slice(separator + 1)).trim();
  if (target.length === 0 || label.length === 0) return null;
  return {
    before: value.slice(0, opening),
    target,
    label,
    after: value.slice(closing + 2)
  };
};

const transformWikiText = (
  root: HTMLElement,
  resolveWikiLink: MarkdownPreviewProps["resolveWikiLink"]
): void => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!(node instanceof Text)) continue;
    if (node.parentElement?.closest("pre, code, a, button, [data-nxt-wiki]") !== null) continue;
    if (node.data.includes("[[")) textNodes.push(node);
  }

  for (const textNode of textNodes) {
    const fragment = document.createDocumentFragment();
    let remaining = textNode.data;
    let parsed = firstWikiText(remaining);
    while (parsed !== null) {
      fragment.append(document.createTextNode(parsed.before));
      const resolution = resolveWikiLink?.(parsed.target) ?? { kind: "unresolved" as const };
      if (
        resolution.kind === "resolved" &&
        NoteIdSchema.safeParse(resolution.noteId).success
      ) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "wiki-link";
        button.dataset.nxtWiki = "resolved";
        button.dataset.noteId = resolution.noteId;
        button.textContent = parsed.label;
        fragment.append(button);
      } else {
        const inert = document.createElement("span");
        inert.className = "wiki-link wiki-link-inert";
        inert.dataset.nxtWiki = resolution.kind;
        inert.setAttribute("aria-disabled", "true");
        inert.textContent = parsed.label;
        fragment.append(inert);
      }
      remaining = parsed.after;
      parsed = firstWikiText(remaining);
    }
    fragment.append(document.createTextNode(remaining));
    textNode.replaceWith(fragment);
  }
};

export const MarkdownPreview = ({
  source,
  notePath,
  resolveAttachment,
  resolveWikiLink,
  onWikiNavigate
}: MarkdownPreviewProps): React.JSX.Element => {
  const root = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState<RenderState | null>(null);

  useEffect(() => {
    let active = true;
    void renderMarkdown(source, {
      rewriteUrl(value) {
        const canonical = canonicalAttachmentReference(value, notePath);
        if (canonical === undefined) return value;
        if (canonical.startsWith("/api/private/attachments/")) return canonical;
        const opaqueId = resolveAttachment?.(canonical);
        return isOpaqueId(opaqueId) ? `/api/private/attachments/${opaqueId}` : undefined;
      }
    }).then((result) => {
      if (active) setRendered({ html: result.html, source });
    });
    return () => {
      active = false;
    };
  }, [notePath, resolveAttachment, source]);

  useLayoutEffect(() => {
    if (root.current === null || rendered === null || rendered.source !== source) return;
    root.current.innerHTML = rendered.html;
    transformWikiText(root.current, resolveWikiLink);
  }, [rendered, resolveWikiLink, source]);

  return (
    <div
      ref={root}
      className="markdown-preview"
      aria-busy={rendered === null || rendered.source !== source}
      onClick={(event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const button = target.closest<HTMLButtonElement>("button[data-nxt-wiki='resolved']");
        const noteId = button?.dataset.noteId;
        if (NoteIdSchema.safeParse(noteId).success) onWikiNavigate?.(noteId as string);
      }}
    />
  );
};
