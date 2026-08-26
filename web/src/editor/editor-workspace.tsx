import type { WikiTargetResolution } from "@nxt/domain";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { notesClient, type NotesClient } from "../api/notes";
import { BacklinksPanel, type KnowledgeLink } from "../explorer/backlinks-panel";
import { deriveOutline, OutlinePanel, type OutlineHeading } from "../explorer/outline-panel";
import { ConflictDialog } from "./conflict-dialog";
import { browserDraftStore, type DraftStore } from "./draft-store";
import { useAutosave, type SaveStatus } from "./use-autosave";

const MarkdownEditor = lazy(async () => {
  const module = await import("./markdown-editor");
  return { default: module.MarkdownEditor };
});

const MarkdownPreview = lazy(async () => {
  const module = await import("./markdown-preview");
  return { default: module.MarkdownPreview };
});

export interface EditorWorkspaceState {
  readonly title: string;
  readonly path: string;
  readonly status: SaveStatus;
}

export interface EditorWorkspaceProps {
  readonly noteId: string;
  readonly hiddenEditor: boolean;
  readonly hiddenPreview: boolean;
  readonly notes?: NotesClient | undefined;
  readonly draftStore?: DraftStore | undefined;
  readonly currentFolderId?: string | undefined;
  readonly resolveAttachment?: ((canonicalReference: string) => string | undefined) | undefined;
  readonly resolveWikiLink?: ((target: string) => WikiTargetResolution) | undefined;
  readonly onWikiNavigate?: ((noteId: string) => void) | undefined;
  readonly backlinks?: readonly KnowledgeLink[] | undefined;
  readonly wikiLinks?: readonly KnowledgeLink[] | undefined;
  readonly now?: (() => Date) | undefined;
  readonly showStatus?: boolean | undefined;
  readonly onStateChange?: ((state: EditorWorkspaceState) => void) | undefined;
  readonly infoRegion?: ReactNode | undefined;
}

const systemNow = (): Date => new Date();

const EditorPath = ({ path }: { readonly path: string }): React.JSX.Element => (
  <div
    className="desktop-path"
    aria-label={path.length > 0 ? `Active note path: ${path}` : undefined}
    title={path.length > 0 ? path : undefined}
  >
    <span>{path}</span>
  </div>
);

export const EditorWorkspace = ({
  noteId,
  hiddenEditor,
  hiddenPreview,
  notes = notesClient,
  draftStore = browserDraftStore,
  currentFolderId,
  resolveAttachment,
  resolveWikiLink,
  onWikiNavigate,
  backlinks = [],
  wikiLinks = [],
  now = systemNow,
  showStatus = true,
  onStateChange,
  infoRegion
}: EditorWorkspaceProps): React.JSX.Element => {
  const [contextTab, setContextTab] = useState<"preview" | "outline" | "backlinks">("preview");
  const {
    state,
    onSourceChange,
    onMergeSourceChange,
    onResolveConflict,
    onConflictOpenChange,
    onLimitExceeded
  } = useAutosave({
    noteId,
    notes,
    drafts: draftStore,
    currentFolderId,
    now
  });

  useEffect(() => {
    onStateChange?.({ title: state.title, path: state.path, status: state.status });
  }, [onStateChange, state.path, state.status, state.title]);

  useEffect(() => setContextTab("preview"), [noteId]);

  const navigateOutline = (heading: OutlineHeading): void => {
    if (state.source === null) return;
    const index = deriveOutline(state.source).findIndex((candidate) => candidate.line === heading.line);
    if (index < 0) return;
    const rendered = document.querySelectorAll<HTMLElement>(".markdown-preview h1, .markdown-preview h2, .markdown-preview h3, .markdown-preview h4, .markdown-preview h5, .markdown-preview h6")[index];
    if (rendered === undefined) return;
    if (typeof rendered.scrollIntoView === "function") rendered.scrollIntoView({ block: "start" });
  };

  return (
    <>
      <section
        className="workspace-region editor-region"
        role="region"
        aria-label="Editor"
        hidden={hiddenEditor}
      >
        <div className="region-toolbar">
          <EditorPath path={state.path} />
          <span className="region-label">Editor</span>
          {showStatus ? (
            <output className="workspace-save-status" aria-label="Save status" aria-live="polite">
              {state.status}
            </output>
          ) : null}
        </div>
        <div className="editor-canvas real-editor-canvas" aria-busy={state.source === null}>
          {state.source === null ? null : (
            <Suspense fallback={null}>
              <MarkdownEditor
                value={state.source}
                onChange={onSourceChange}
                onLimitExceeded={onLimitExceeded}
              />
            </Suspense>
          )}
        </div>
      </section>

      <div className="context-column">
        <section
          className="context-region preview-region"
          role="region"
          aria-label="Preview"
          hidden={hiddenPreview}
        >
          <div className="context-tabs" role="tablist" aria-label="Preview">
            {(["preview", "outline", "backlinks"] as const).map((tab) => (
              <button
                className={`context-tab touch-target${contextTab === tab ? " active" : ""}`}
                type="button"
                role="tab"
                aria-selected={contextTab === tab}
                onClick={() => setContextTab(tab)}
                key={tab}
              >
                {tab === "preview" ? "Preview" : tab === "outline" ? "Outline" : "Backlinks"}
              </button>
            ))}
          </div>
          <div className="preview-content" aria-busy={state.source === null}>
            {state.source === null ? null : contextTab === "preview" ? (
              <Suspense fallback={null}>
                <MarkdownPreview
                  source={state.source}
                  notePath={state.path}
                  resolveAttachment={resolveAttachment}
                  resolveWikiLink={resolveWikiLink}
                  onWikiNavigate={onWikiNavigate}
                />
              </Suspense>
            ) : contextTab === "outline" ? (
              <OutlinePanel source={state.source} onNavigate={navigateOutline} />
            ) : (
              <BacklinksPanel backlinks={backlinks} wikiLinks={wikiLinks} onNavigate={(id) => onWikiNavigate?.(id)} />
            )}
          </div>
        </section>
        {infoRegion}
      </div>

      {state.conflict === null ? null : (
        <ConflictDialog
          conflict={state.conflict}
          open
          busy={state.conflictBusy}
          error={state.conflictError}
          onOpenChange={onConflictOpenChange}
          onMergeSourceChange={onMergeSourceChange}
          onResolve={onResolveConflict}
        />
      )}
    </>
  );
};
