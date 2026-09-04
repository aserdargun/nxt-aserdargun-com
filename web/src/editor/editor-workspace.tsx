import type { WikiTargetResolution } from "@nxt/domain";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortableAttachmentMarkdown } from "@nxt/domain";
import { notesClient, type NotesClient } from "../api/notes";
import { attachmentClient, type AttachmentClient, type UploadedAttachment } from "../api/attachments";
import { BacklinksPanel, type KnowledgeLink } from "../explorer/backlinks-panel";
import { OutlinePanel, type OutlineHeading } from "../explorer/outline-panel";
import { ConflictDialog } from "./conflict-dialog";
import { browserDraftStore, type DraftStore } from "./draft-store";
import { EditorStatsBar } from "./editor-stats-bar";
import { computeNoteStats } from "./note-stats";
import { EditorDropzone } from "./editor-dropzone";
import { FormatToolbar } from "./format-toolbar";
import { formatAttachmentError, readFileAsBase64 } from "./attachment-helpers";
import { type MarkdownEditorHandle } from "./markdown-editor";
import { buildDefaultSlashMenuItems } from "./slash-menu-items";
import { SlashMenu } from "./slash-menu";
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
  readonly noteId: string;
  readonly title: string;
  readonly path: string;
  readonly status: SaveStatus;
  readonly version: string | null;
  readonly source: string | null;
}

export interface AttachmentInsertion {
  readonly token: number;
  readonly noteId: string;
  readonly markdown: string;
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
  readonly attachmentInsertion?: AttachmentInsertion | null | undefined;
  readonly onAttachmentUploaded?: ((attachment: UploadedAttachment) => void | Promise<void>) | undefined;
  readonly attachmentApi?: AttachmentClient | undefined;
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
  infoRegion,
  attachmentInsertion,
  onAttachmentUploaded,
  attachmentApi = attachmentClient
}: EditorWorkspaceProps): React.JSX.Element => {
  const [contextTab, setContextTab] = useState<"preview" | "outline" | "backlinks">("preview");
  const [pendingOutlineId, setPendingOutlineId] = useState<string | null>(null);
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
  const handledInsertionRef = useRef<number | null>(null);
  const editorRef = useRef<MarkdownEditorHandle | null>(null);
  const [toolbarError, setToolbarError] = useState<string | null>(null);
  const [dropBusy, setDropBusy] = useState(false);
  const stats = useMemo(
    () => state.source === null ? null : computeNoteStats(state.source, state.path),
    [state.path, state.source]
  );
  const slashMenuItems = useMemo(() => buildDefaultSlashMenuItems(), []);
  const [slashController, setSlashController] = useState<ReturnType<NonNullable<MarkdownEditorHandle["getSlashMenu"]>> | null>(null);
  useEffect(() => {
    const interval = setInterval(() => {
      const next = editorRef.current?.getSlashMenu() ?? null;
      setSlashController((current) => (current === next ? current : next));
    }, 250);
    return () => clearInterval(interval);
  }, []);

  const uploadAndInsertFile = useCallback(async (file: File): Promise<void> => {
    if (state.source === null) return;
    setToolbarError(null);
    setDropBusy(true);
    try {
      const bytesBase64 = await readFileAsBase64(file);
      const response = await attachmentApi.upload({
        noteId,
        name: file.name,
        declaredMime: file.type.length > 0 ? file.type : "application/octet-stream",
        bytesBase64
      });
      const markdown = createPortableAttachmentMarkdown({
        notePath: state.path,
        noteId,
        name: response.asset.name,
        inlineImage: response.asset.disposition === "inline" && response.asset.mimeType.startsWith("image/")
      });
      editorRef.current?.insertAtCursor(markdown);
      await onAttachmentUploaded?.(response.asset);
    } catch (error) {
      setToolbarError(formatAttachmentError(error));
    } finally {
      setDropBusy(false);
    }
  }, [attachmentApi, noteId, onAttachmentUploaded, state.path, state.source]);

  useEffect(() => {
    onStateChange?.({
      noteId,
      title: state.title,
      path: state.path,
      status: state.status,
      version: state.version,
      source: state.source
    });
  }, [noteId, onStateChange, state.path, state.source, state.status, state.title, state.version]);

  useEffect(() => {
    if (
      attachmentInsertion === null || attachmentInsertion === undefined ||
      attachmentInsertion.noteId !== noteId || state.source === null ||
      handledInsertionRef.current === attachmentInsertion.token
    ) return;
    handledInsertionRef.current = attachmentInsertion.token;
    const separator = state.source.endsWith("\n") ? "\n" : "\n\n";
    onSourceChange(`${state.source}${separator}${attachmentInsertion.markdown}\n`);
  }, [attachmentInsertion, noteId, onSourceChange, state.source]);

  useEffect(() => {
    setContextTab("preview");
    setPendingOutlineId(null);
    handledInsertionRef.current = null;
  }, [noteId]);

  useEffect(() => setPendingOutlineId(null), [state.source]);

  const navigateOutline = (heading: OutlineHeading): void => {
    setPendingOutlineId(heading.id);
    setContextTab("preview");
  };
  const completeOutlineNavigation = useCallback((headingId: string): void => {
    setPendingOutlineId((current) => current === headingId ? null : current);
  }, []);

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
        <FormatToolbar
          noteId={noteId}
          notePath={state.path}
          editor={editorRef.current}
          disabled={state.source === null}
          onAttachmentUploaded={onAttachmentUploaded}
          onError={setToolbarError}
        />
        {toolbarError === null ? null : (
          <p role="alert" className="format-toolbar-error">{toolbarError}</p>
        )}
        <div className="editor-canvas real-editor-canvas" aria-busy={state.source === null}>
          {state.source === null ? null : (
            <EditorDropzone onFile={(file) => { void uploadAndInsertFile(file); }} disabled={dropBusy}>
              <Suspense fallback={null}>
                <MarkdownEditor
                  ref={editorRef}
                  value={state.source}
                  onChange={onSourceChange}
                  onLimitExceeded={onLimitExceeded}
                  slashMenuItems={slashMenuItems}
                />
              </Suspense>
            </EditorDropzone>
          )}
        </div>
        {stats === null ? null : <EditorStatsBar stats={stats} />}
        {slashController === null ? null : <SlashMenu controller={slashController} />}
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
            {state.source === null ? null : (
              <div hidden={contextTab !== "preview"}>
                <Suspense fallback={null}>
                  <MarkdownPreview
                    source={state.source}
                    notePath={state.path}
                    resolveAttachment={resolveAttachment}
                    resolveWikiLink={resolveWikiLink}
                    onWikiNavigate={onWikiNavigate}
                    scrollTargetId={pendingOutlineId}
                    onScrollComplete={completeOutlineNavigation}
                  />
                </Suspense>
              </div>
            )}
            {state.source !== null && contextTab === "outline" ? (
              <OutlinePanel source={state.source} onNavigate={navigateOutline} />
            ) : state.source !== null && contextTab === "backlinks" ? (
              <BacklinksPanel backlinks={backlinks} wikiLinks={wikiLinks} onNavigate={(id) => onWikiNavigate?.(id)} />
            ) : null}
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
