import * as Dialog from "@radix-ui/react-dialog";
import {
  Archive,
  Bookmark,
  ChevronRight,
  File,
  Folder,
  Inbox,
  Paperclip,
  Search,
  Tags,
  Upload
} from "lucide-react";
import {
  attachmentReferenceProjection,
  createPortableAttachmentMarkdown,
  parseNote,
  projectionReferencesAttachment,
  resolveWikiTarget,
  serializeNote,
  type WikiTargetResolution
} from "@nxt/domain";
import type { DeleteFolderRequest, PublicationStatus as PublicationStatusValue } from "@nxt/contracts";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { notesClient, type NotesClient } from "../api/notes";
import { attachmentClient, type AttachmentClient, type UploadedAttachment } from "../api/attachments";
import { publicationClient, type PublicationClient } from "../api/publications";
import {
  attachmentResolverForNote,
  exactFolderForNote,
  vaultClient,
  type VaultClient,
  type CompleteVault
} from "../api/vault";
import type { DraftStore } from "../editor/draft-store";
import type { AttachmentInsertion, EditorWorkspaceState } from "../editor/editor-workspace";
import { AttachmentPicker } from "../editor/attachment-picker";
import { AttachmentView } from "../editor/attachment-view";
import type { KnowledgeLink } from "../explorer/backlinks-panel";
import { useCommandPaletteShortcut } from "../explorer/command-palette-shortcut";
import type { CommandPaletteAction } from "../explorer/command-catalog";
import {
  ExplorerOperationDialog,
  type ExplorerOperation,
  type ExplorerOperationValue
} from "../explorer/explorer-operation-dialog";
import { FavoritesPanel } from "../explorer/favorites-panel";
import {
  buildExplorerTree,
  FileTree,
  type FileTreeProps,
  type FolderExplorerNode
} from "../explorer/file-tree";
import { TagsPanel } from "../explorer/tags-panel";
import { PublishDialog } from "../publication/publish-dialog";
import { PublicationStatus } from "../publication/publication-status";
import { MobileDestinationNav, type Destination } from "./mobile-destination-nav";
import { OwnerOverflowMenu } from "./owner-overflow-menu";
import { ActiveNotePath, WorkspaceHeader } from "./workspace-header";
import { useWorkspaceViewport } from "./workspace-layout";
import { StatusCallout } from "./status-callout";

const EditorWorkspace = lazy(async () => {
  const module = await import("../editor/editor-workspace");
  return { default: module.EditorWorkspace };
});

const SearchPanel = lazy(async () => {
  const module = await import("../explorer/search-panel");
  return { default: module.SearchPanel };
});

const CommandPalette = lazy(async () => {
  const module = await import("../explorer/command-palette");
  return { default: module.CommandPalette };
});

const EDITOR_LINES = [
  "# Plans",
  "",
  "Notes",
  "",
  "## Editor",
  "",
  "Preview",
  "",
  "## Outline",
  "",
  "Backlinks"
] as const;

const ACTIVE_NOTE = {
  path: "Notes / Plans",
  title: "Plans"
} as const;

const StaticExplorerRegion = ({ hidden }: { readonly hidden: boolean }): React.JSX.Element => (
  <section className="workspace-region explorer-region" role="region" aria-label="Files" hidden={hidden}>
    <div className="search-row">
      <Search size={18} strokeWidth={1.75} aria-hidden />
      <input aria-label="Files" placeholder="Files" />
    </div>
    <div className="explorer-scroll">
      <div className="explorer-section">
        <h2 id="files-heading">Files</h2>
        <button className="tree-row touch-target" type="button" aria-expanded="true">
          <ChevronRight className="disclosure disclosure-open" size={16} aria-hidden />
          <Folder size={18} strokeWidth={1.75} aria-hidden />
          <span>Notes</span>
        </button>
        <button className="tree-row tree-child selected touch-target" type="button">
          <File size={18} strokeWidth={1.75} aria-hidden />
          <span>Plans</span>
        </button>
        <button className="tree-row touch-target" type="button">
          <Inbox size={18} strokeWidth={1.75} aria-hidden />
          <span>Inbox</span>
        </button>
        <button className="tree-row touch-target" type="button">
          <Archive size={18} strokeWidth={1.75} aria-hidden />
          <span>Archive</span>
        </button>
      </div>
      <div className="explorer-section">
        <h2 id="favorites-heading">Favorites</h2>
        <button className="tree-row touch-target" type="button">
          <Bookmark size={18} strokeWidth={1.75} aria-hidden />
          <span>Plans</span>
        </button>
      </div>
      <div className="explorer-section">
        <h2 id="tags-heading">Tags</h2>
        <div className="tree-row static-row">
          <Tags size={18} strokeWidth={1.75} aria-hidden />
          <span>Notes</span>
        </div>
      </div>
    </div>
  </section>
);

const VaultExplorerRegion = ({
  hidden,
  vault,
  searchQuery,
  onSearchQueryChange,
  expandedFolderIds,
  onExpandedFolderIdsChange,
  selectedNoteId,
  onNavigateNote,
  onRenameFolder,
  onMoveFolder,
  onArchiveFolder,
  onTrashFolder,
  onCreateNoteInFolder,
  now
}: {
  readonly hidden: boolean;
  readonly vault: CompleteVault;
  readonly searchQuery: string;
  readonly onSearchQueryChange: (query: string) => void;
  readonly expandedFolderIds: ReadonlySet<string>;
  readonly onExpandedFolderIdsChange: (expandedIds: ReadonlySet<string>) => void;
  readonly selectedNoteId?: string | undefined;
  readonly onNavigateNote?: ((noteId: string) => void) | undefined;
  readonly onRenameFolder?: ((folder: FolderExplorerNode) => void) | undefined;
  readonly onMoveFolder?: ((folder: FolderExplorerNode) => void) | undefined;
  readonly onArchiveFolder?: ((folder: FolderExplorerNode) => void) | undefined;
  readonly onTrashFolder?: FileTreeProps["onTrashFolder"];
  readonly onCreateNoteInFolder?: FileTreeProps["onCreateNoteInFolder"];
  readonly now?: (() => Date) | undefined;
}): React.JSX.Element => {
  const tree = useMemo(() => buildExplorerTree(vault), [vault]);
  const favorites = useMemo(() => {
    const byId = new Map(vault.entries.map((entry) => [entry.id, entry]));
    return vault.preferences.favorites.flatMap((id) => {
      const entry = byId.get(id);
      return entry === undefined ? [] : [{ id: entry.id, title: entry.title }];
    });
  }, [vault]);
  const tags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of vault.entries) {
      for (const tag of entry.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts].map(([tag, count]) => ({ tag, count }))
      .sort((first, second) => first.tag.localeCompare(second.tag, "tr-TR"));
  }, [vault]);
  const searchRecords = useMemo(() => {
    const favoriteIds = new Set(vault.preferences.favorites);
    return vault.entries.map((entry) => {
      const parentPath = entry.path.slice(0, entry.path.lastIndexOf("/"));
      const folder = vault.folders.find((candidate) => candidate.path === parentPath);
      if (folder === undefined) throw new Error("A search record has no exact projected folder.");
      return {
        id: entry.id,
        title: entry.title,
        path: entry.path,
        folder: folder.name,
        tags: entry.tags,
        favorite: favoriteIds.has(entry.id),
        searchText: entry.searchText
      };
    });
  }, [vault]);

  return (
    <section className="workspace-region explorer-region" role="region" aria-label="Files" hidden={hidden}>
      <Suspense fallback={null}>
        <SearchPanel
          records={searchRecords}
          query={searchQuery}
          onQueryChange={onSearchQueryChange}
          onOpenNote={(id) => onNavigateNote?.(id)}
        />
      </Suspense>
      <div className="explorer-scroll">
        <section className="explorer-section" aria-labelledby="files-heading">
          <h2 id="files-heading">Files</h2>
          <FileTree
            tree={tree}
            selectedId={selectedNoteId}
            expandedIds={expandedFolderIds}
            onExpandedIdsChange={onExpandedFolderIdsChange}
            onSelect={(node) => {
              if (node.kind === "note") onNavigateNote?.(node.id);
            }}
            onRenameFolder={onRenameFolder}
            onMoveFolder={onMoveFolder}
            onArchiveFolder={onArchiveFolder}
            onTrashFolder={onTrashFolder}
            onCreateNoteInFolder={onCreateNoteInFolder}
            now={now}
          />
        </section>
        <FavoritesPanel items={favorites} onOpen={(id) => onNavigateNote?.(id)} />
        <TagsPanel tags={tags} onSelect={(tag) => onSearchQueryChange(`tag:${tag}`)} />
      </div>
    </section>
  );
};

const ExplorerRegion = ({
  hidden,
  vault,
  searchQuery,
  onSearchQueryChange,
  expandedFolderIds,
  onExpandedFolderIdsChange,
  selectedNoteId,
  onNavigateNote,
  onRenameFolder,
  onMoveFolder,
  onArchiveFolder,
  onTrashFolder,
  onCreateNoteInFolder,
  now
}: {
  readonly hidden: boolean;
  readonly vault?: CompleteVault | undefined;
  readonly searchQuery: string;
  readonly onSearchQueryChange: (query: string) => void;
  readonly expandedFolderIds: ReadonlySet<string>;
  readonly onExpandedFolderIdsChange: (expandedIds: ReadonlySet<string>) => void;
  readonly selectedNoteId?: string | undefined;
  readonly onNavigateNote?: ((noteId: string) => void) | undefined;
  readonly onRenameFolder?: ((folder: FolderExplorerNode) => void) | undefined;
  readonly onMoveFolder?: ((folder: FolderExplorerNode) => void) | undefined;
  readonly onArchiveFolder?: ((folder: FolderExplorerNode) => void) | undefined;
  readonly onTrashFolder?: FileTreeProps["onTrashFolder"];
  readonly onCreateNoteInFolder?: FileTreeProps["onCreateNoteInFolder"];
  readonly now?: (() => Date) | undefined;
}): React.JSX.Element => vault === undefined
  ? <StaticExplorerRegion hidden={hidden} />
  : (
    <VaultExplorerRegion
      hidden={hidden}
      vault={vault}
      searchQuery={searchQuery}
      onSearchQueryChange={onSearchQueryChange}
      expandedFolderIds={expandedFolderIds}
      onExpandedFolderIdsChange={onExpandedFolderIdsChange}
      selectedNoteId={selectedNoteId}
      onNavigateNote={onNavigateNote}
      onRenameFolder={onRenameFolder}
      onMoveFolder={onMoveFolder}
      onArchiveFolder={onArchiveFolder}
      onTrashFolder={onTrashFolder}
      onCreateNoteInFolder={onCreateNoteInFolder}
      now={now}
    />
  );

const EditorRegion = ({
  hidden,
  mobilePath
}: {
  readonly hidden: boolean;
  readonly mobilePath?: React.ReactNode;
}): React.JSX.Element => (
  <section className="workspace-region editor-region" role="region" aria-label="Editor" hidden={hidden}>
    <div className="region-toolbar">
      <ActiveNotePath className="desktop-path" path={ACTIVE_NOTE.path} />
      <span className="region-label">Editor</span>
    </div>
    <div
      className={`editor-canvas${mobilePath === undefined ? "" : " workspace-scroll-target"}`}
      aria-label="Editor"
    >
      {mobilePath}
      {EDITOR_LINES.map((line, index) => (
        <div className="editor-line" key={`${index}-${line}`}>
          <span className="line-number" aria-hidden>{index + 1}</span>
          <span className={line.startsWith("#") ? "source-heading" : "source-text"}>{line || "\u00a0"}</span>
        </div>
      ))}
    </div>
  </section>
);

const EmptyEditorRegion = ({
  hidden,
  disabledReason,
  onCreate,
  mobilePath
}: {
  readonly hidden: boolean;
  readonly disabledReason: string | null;
  readonly onCreate: () => void;
  readonly mobilePath?: React.ReactNode;
}): React.JSX.Element => (
  <section className="workspace-region editor-region" role="region" aria-label="Editor" hidden={hidden}>
    <div className="region-toolbar">
      <span className="region-label">Editor</span>
    </div>
    <div className={`empty-editor-state${mobilePath === undefined ? "" : " workspace-scroll-target"}`}>
      {mobilePath}
      <h1>No notes yet</h1>
      <p>Create your first Markdown note to start writing.</p>
      <button
        className="primary-action touch-target"
        type="button"
        disabled={disabledReason !== null}
        title={disabledReason ?? undefined}
        onClick={onCreate}
      >
        Create first note
      </button>
      {disabledReason === null ? null : (
        <StatusCallout tone="warning">{disabledReason}</StatusCallout>
      )}
    </div>
  </section>
);

const PreviewRegion = ({
  hidden,
  mobilePath
}: {
  readonly hidden: boolean;
  readonly mobilePath?: React.ReactNode;
}): React.JSX.Element => (
  <section className="context-region preview-region" role="region" aria-label="Preview" hidden={hidden}>
    <div className="context-tabs" role="tablist" aria-label="Preview">
      <button className="context-tab touch-target active" type="button" role="tab" aria-selected="true">Preview</button>
      <button className="context-tab touch-target" type="button" role="tab" aria-selected="false">Outline</button>
      <button className="context-tab touch-target" type="button" role="tab" aria-selected="false">Backlinks</button>
    </div>
    <div className={`preview-content${mobilePath === undefined ? "" : " workspace-scroll-target"}`}>
      {mobilePath}
      <h1>Plans</h1>
      <p>Notes</p>
      <section>
        <h2>Editor</h2>
        <p>Preview</p>
      </section>
      <section>
        <h2>Outline</h2>
        <p>Backlinks</p>
      </section>
    </div>
  </section>
);

const InfoRegion = ({
  hidden,
  attachments,
  publication,
  attachmentDisabledReason,
  publicationDisabledReason,
  publicationHeadingRef
}: {
  readonly hidden: boolean;
  readonly attachments?: React.ReactNode;
  readonly publication?: React.ReactNode;
  readonly attachmentDisabledReason?: string | null;
  readonly publicationDisabledReason?: string | null;
  readonly publicationHeadingRef?: React.RefObject<HTMLHeadingElement | null>;
}): React.JSX.Element => (
  <section className="context-region info-region" role="region" aria-label="Info" hidden={hidden}>
    <div className="region-toolbar"><span className="region-label">Info</span></div>
    <div className="info-content">
      <h1>Info</h1>
      {attachments === undefined ? null : (
        <section>
          <h2>Attachments</h2>
          {attachmentDisabledReason === null || attachmentDisabledReason === undefined ? null : (
            <p className="control-disabled-reason">{attachmentDisabledReason}</p>
          )}
          {attachments}
        </section>
      )}
      {publication === undefined ? null : (
        <section>
          <h2 ref={publicationHeadingRef} tabIndex={-1}>Publication</h2>
          {publicationDisabledReason === null || publicationDisabledReason === undefined ? null : (
            <p className="control-disabled-reason">{publicationDisabledReason}</p>
          )}
          {publication}
        </section>
      )}
    </div>
  </section>
);

export interface OwnerShellProps {
  readonly noteId?: string;
  readonly vault?: CompleteVault;
  readonly currentFolderId?: string;
  readonly notes?: NotesClient;
  readonly draftStore?: DraftStore;
  readonly resolveAttachment?: (canonicalReference: string) => string | undefined;
  readonly resolveWikiLink?: (target: string) => WikiTargetResolution;
  readonly onWikiNavigate?: (noteId: string) => void;
  readonly onNavigateNote?: (noteId: string) => void;
  readonly vaultApi?: VaultClient;
  readonly attachmentApi?: AttachmentClient;
  readonly publicationApi?: PublicationClient;
  readonly onRefreshVault?: () => void | Promise<void>;
  readonly onToggleTheme?: () => void;
  readonly onSignOut?: () => void;
  readonly now?: () => Date;
}

interface PendingExplorerOperation {
  readonly operation: ExplorerOperation;
  readonly target: { readonly id: string; readonly version: string } | null;
}

export const OwnerShell = ({
  noteId,
  vault,
  currentFolderId,
  notes,
  draftStore,
  resolveAttachment,
  resolveWikiLink,
  onWikiNavigate,
  onNavigateNote,
  vaultApi = vaultClient,
  attachmentApi = attachmentClient,
  publicationApi = publicationClient,
  onRefreshVault,
  onToggleTheme,
  onSignOut,
  now
}: OwnerShellProps = {}): React.JSX.Element => {
  const [activeDestination, setActiveDestination] = useState<Destination>("editor");
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [explorerSearchQuery, setExplorerSearchQuery] = useState("");
  const [expandedFolderIds, setExpandedFolderIds] = useState<ReadonlySet<string>>(() => new Set());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [pendingOperation, setPendingOperation] = useState<PendingExplorerOperation | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [editorState, setEditorState] = useState<EditorWorkspaceState>({
    noteId: noteId ?? "",
    title: noteId === undefined ? ACTIVE_NOTE.title : "",
    path: noteId === undefined ? ACTIVE_NOTE.path : "",
    status: noteId === undefined ? "Saved" : "Saving",
    version: null,
    source: null
  });
  const [publishOpen, setPublishOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [attachmentInsertion, setAttachmentInsertion] = useState<AttachmentInsertion | null>(null);
  const [publicationState, setPublicationState] = useState<{
    readonly noteId: string | null;
    readonly loading: boolean;
    readonly status: PublicationStatusValue | null;
    readonly error: boolean;
  }>({ noteId: null, loading: false, status: null, error: false });
  const insertionTokenRef = useRef(0);
  const publicationCheckRef = useRef(0);
  const publicationHeadingRef = useRef<HTMLHeadingElement>(null);
  const publishTriggerRef = useRef<HTMLButtonElement>(null);
  const explorerTriggerRef = useRef<HTMLButtonElement>(null);
  const { layout, compactTablet } = useWorkspaceViewport();
  const selectedEntry = useMemo(
    () => noteId === undefined || vault === undefined
      ? undefined
      : vault.entries.find((entry) => entry.id === noteId),
    [noteId, vault]
  );
  const selectedFolder = useMemo(
    () => selectedEntry === undefined || vault === undefined
      ? undefined
      : exactFolderForNote(selectedEntry, vault.folders),
    [selectedEntry, vault]
  );
  const selectedAttachmentResolver = useMemo(
    () => selectedEntry === undefined ? undefined : attachmentResolverForNote(selectedEntry),
    [selectedEntry]
  );
  const vaultWikiResolver = useMemo(() => {
    if (vault === undefined) return undefined;
    const targets = vault.entries.map(({ id, title, aliases }) => ({ id, title, aliases }));
    return (target: string): WikiTargetResolution => resolveWikiTarget(target, targets);
  }, [vault]);
  const knowledgeLinks = useMemo((): {
    readonly backlinks: readonly KnowledgeLink[];
    readonly wikiLinks: readonly KnowledgeLink[];
  } => {
    if (vault === undefined || selectedEntry === undefined || vaultWikiResolver === undefined) {
      return { backlinks: [], wikiLinks: [] };
    }
    const byId = new Map(vault.entries.map((entry) => [entry.id, entry]));
    const backlinks = selectedEntry.backlinks.flatMap((id) => {
      const entry = byId.get(id);
      return entry === undefined ? [] : [{
        key: `backlink:${id}`,
        label: entry.title,
        resolution: { kind: "resolved" as const, noteId: id }
      }];
    });
    const resolvedWikiLinks = selectedEntry.outboundNoteIds.flatMap((id) => {
      const entry = byId.get(id);
      return entry === undefined ? [] : [{
        key: `outbound:${id}`,
        label: entry.title,
        resolution: { kind: "resolved" as const, noteId: id }
      }];
    });
    const unresolvedWikiLinks = selectedEntry.unresolvedWikiTargets.map((target, index) => ({
      key: `unresolved:${index}:${target}`,
      label: target,
      resolution: vaultWikiResolver(target)
    }));
    return { backlinks, wikiLinks: [...resolvedWikiLinks, ...unresolvedWikiLinks] };
  }, [selectedEntry, vault, vaultWikiResolver]);
  const navigateWiki = onNavigateNote ?? onWikiNavigate;
  const notesApi = notes ?? notesClient;
  const tabletPrimaryDestination: Exclude<Destination, "files"> = activeDestination === "files"
    ? "editor"
    : activeDestination;
  const isHidden = (destination: Destination): boolean => {
    if (layout === "desktop") return false;
    if (destination === "files") {
      if (layout === "mobile") return activeDestination !== "files";
      return compactTablet ? false : !explorerOpen;
    }
    return (layout === "tablet" ? tabletPrimaryDestination : activeDestination) !== destination;
  };

  useEffect(() => {
    if (compactTablet) setExplorerOpen(false);
  }, [compactTablet]);

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  useCommandPaletteShortcut(openPalette);

  const inboxFolder = useMemo(() => {
    const matches = vault?.folders.filter((folder) => folder.name === "Inbox") ?? [];
    return matches.length === 1 ? matches[0] : undefined;
  }, [vault]);
  const plansFolder = useMemo(() => {
    const matches = vault?.folders.filter((folder) => folder.path === "Notes/Plans") ?? [];
    return matches.length === 1 ? matches[0] : undefined;
  }, [vault]);
  const archiveFolder = useMemo(() => {
    const matches = vault?.folders.filter((folder) => folder.name === "Archive") ?? [];
    return matches.length === 1 ? matches[0] : undefined;
  }, [vault]);

  const refreshVault = useCallback(async (): Promise<void> => {
    await onRefreshVault?.();
  }, [onRefreshVault]);

  const checkPublicationStatus = useCallback((): void => {
    const operation = ++publicationCheckRef.current;
    if (noteId === undefined) {
      setPublicationState({ noteId: null, loading: false, status: null, error: false });
      return;
    }
    setPublicationState({ noteId, loading: true, status: null, error: false });
    void publicationApi.getStatus(noteId).then((status) => {
      if (publicationCheckRef.current === operation) {
        setPublicationState({ noteId, loading: false, status, error: false });
      }
    }).catch(() => {
      if (publicationCheckRef.current === operation) {
        setPublicationState({ noteId, loading: false, status: null, error: true });
      }
    });
  }, [noteId, publicationApi]);

  useEffect(() => {
    setPublishOpen(false);
    setRevokeOpen(false);
    setAttachmentInsertion(null);
    checkPublicationStatus();
    return () => { publicationCheckRef.current += 1; };
  }, [checkPublicationStatus]);

  const currentPublication = publicationState.noteId === noteId ? publicationState.status : null;
  const retryPublicationStatus = useCallback((): void => {
    publicationHeadingRef.current?.focus({ preventScroll: true });
    checkPublicationStatus();
  }, [checkPublicationStatus]);
  const hasAuthoritativeEditorState = noteId !== undefined && selectedEntry !== undefined &&
    editorState.noteId === noteId && editorState.source !== null && editorState.path.length > 0 &&
    editorState.version !== null;
  const editorIsSaved = hasAuthoritativeEditorState && editorState.status === "Saved";
  const referencedAttachmentCount = useMemo(() => {
    if (!editorIsSaved || selectedEntry === undefined || editorState.source === null) return 0;
    const projection = attachmentReferenceProjection(editorState.source, editorState.path);
    return selectedEntry.attachments.filter((attachment) => projectionReferencesAttachment(projection, {
      noteId: selectedEntry.id,
      name: attachment.name,
      opaqueId: attachment.assetId
    })).length;
  }, [editorIsSaved, editorState.path, editorState.source, selectedEntry]);
  const publishDisabledReason = !hasAuthoritativeEditorState
    ? "Select a saved note first."
    : editorState.status !== "Saved"
      ? "Save the current note before publishing."
      : null;
  const attachmentDisabledReason = !hasAuthoritativeEditorState
    ? "Select a saved note first."
    : editorState.status !== "Saved"
      ? "Save the current note before adding an attachment."
      : null;
  const revokeDisabledReason = publicationState.noteId !== noteId || publicationState.loading
    ? "Checking publication status."
    : publicationState.error
      ? "Publication status could not be verified."
      : currentPublication === null
        ? "This note is not published."
        : null;

  const attachmentMarkdown = useCallback((attachment: UploadedAttachment): string => {
    if (!editorIsSaved || noteId === undefined) throw new Error("A saved note path is required.");
    const inlineImage = attachment.disposition === "inline" &&
      ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(attachment.mimeType);
    return createPortableAttachmentMarkdown({
      notePath: editorState.path,
      noteId,
      name: attachment.name,
      inlineImage
    });
  }, [editorIsSaved, editorState.path, noteId]);

  const completeAttachmentUpload = useCallback(async (attachment: UploadedAttachment): Promise<void> => {
    if (noteId === undefined) return;
    await refreshVault();
    setAttachmentInsertion({
      token: ++insertionTokenRef.current,
      noteId,
      markdown: attachmentMarkdown(attachment)
    });
  }, [attachmentMarkdown, noteId, refreshVault]);

  const openNoteOperation = useCallback((kind: "rename" | "move"): void => {
    if (selectedEntry === undefined || selectedFolder === undefined) return;
    setOperationError(null);
    setPendingOperation({
      operation: {
        kind,
        selectionKind: "note",
        initialName: selectedEntry.title,
        initialFolderId: selectedFolder.id
      },
      target: { id: selectedEntry.id, version: selectedEntry.driveVersion }
    });
  }, [selectedEntry, selectedFolder]);

  const openFolderOperation = useCallback((kind: "rename" | "move", folder: FolderExplorerNode): void => {
    if (folder.protected) return;
    const separator = folder.path.lastIndexOf("/");
    const parentPath = separator < 0 ? folder.path : folder.path.slice(0, separator);
    const parent = vault?.folders.find((candidate) => candidate.path === parentPath);
    setOperationError(null);
    setPendingOperation({
      operation: {
        kind,
        selectionKind: "folder",
        initialName: folder.name,
        initialFolderId: parent?.id ?? folder.id
      },
      target: { id: folder.id, version: folder.version }
    });
  }, [vault]);

  const runFolderArchive = useCallback(async (folder: FolderExplorerNode): Promise<void> => {
    if (folder.protected || archiveFolder === undefined) return;
    await vaultApi.updateFolder(folder.id, {
      expectedVersion: folder.version,
      parentId: archiveFolder.id
    });
    await refreshVault();
  }, [archiveFolder, refreshVault, vaultApi]);

  const runFolderTrash = useCallback(async (
    folder: FolderExplorerNode,
    input: DeleteFolderRequest
  ): Promise<void> => {
    if (folder.protected) return;
    try {
      await vaultApi.trashFolder(folder.id, input);
    } catch (error) {
      await refreshVault().catch(() => undefined);
      throw error;
    }
    await refreshVault();
  }, [refreshVault, vaultApi]);

  const newNoteFolder = selectedFolder ?? plansFolder ?? inboxFolder;
  const openNewNote = useCallback((): void => {
    if (newNoteFolder === undefined) return;
    setOperationError(null);
    setPendingOperation({
      operation: {
        kind: "new-note",
        selectionKind: "note",
        initialName: "",
        initialFolderId: newNoteFolder.id
      },
      target: null
    });
  }, [newNoteFolder]);
  const openNewNoteInFolder = useCallback((folder: FolderExplorerNode): void => {
    setOperationError(null);
    setPendingOperation({
      operation: {
        kind: "new-note",
        selectionKind: "note",
        initialName: "",
        initialFolderId: folder.id
      },
      target: null
    });
  }, []);

  const paletteActions = useMemo<readonly CommandPaletteAction[]>(() => {
    const noVault = "Open a complete vault first.";
    const noNote = "Select a note first.";
    return [
      {
        id: "new-note",
        disabledReason: newNoteFolder === undefined ? noVault : null,
        run: openNewNote
      },
      {
        id: "quick-note",
        disabledReason: inboxFolder === undefined ? "The exact Inbox folder is unavailable." : null,
        run: async () => {
          if (inboxFolder === undefined) return;
          const created = await notesApi.createNote({
            title: `Quick note ${(now?.() ?? new Date()).toISOString()}`,
            body: "",
            folderId: inboxFolder.id
          });
          await refreshVault();
          onNavigateNote?.(created.note.frontmatter.id);
        }
      },
      {
        id: "new-folder",
        disabledReason: selectedFolder === undefined ? noVault : null,
        run: () => {
          if (selectedFolder === undefined) return;
          setOperationError(null);
          setPendingOperation({
            operation: {
              kind: "new-folder",
              selectionKind: "folder",
              initialName: "",
              initialFolderId: selectedFolder.id
            },
            target: null
          });
        }
      },
      {
        id: "open-note",
        disabledReason: selectedEntry === undefined || onNavigateNote === undefined ? noNote : null,
        run: () => selectedEntry === undefined ? undefined : onNavigateNote?.(selectedEntry.id)
      },
      {
        id: "rename",
        disabledReason: selectedEntry === undefined ? noNote : null,
        run: () => openNoteOperation("rename")
      },
      {
        id: "move",
        disabledReason: selectedEntry === undefined ? noNote : null,
        run: () => openNoteOperation("move")
      },
      {
        id: "archive",
        disabledReason: selectedEntry === undefined ? noNote : null,
        run: async () => {
          if (selectedEntry === undefined) return;
          await notesApi.archiveNote(selectedEntry.id, { expectedVersion: selectedEntry.driveVersion });
          await refreshVault();
        }
      },
      {
        id: "favorite",
        disabledReason: selectedEntry === undefined || vault === undefined ? noNote : null,
        run: async () => {
          if (selectedEntry === undefined || vault === undefined) return;
          const favorites = vault.preferences.favorites.includes(selectedEntry.id)
            ? vault.preferences.favorites.filter((id) => id !== selectedEntry.id)
            : [...vault.preferences.favorites, selectedEntry.id];
          await vaultApi.updatePreferences({
            favorites,
            recent: [...vault.preferences.recent],
            theme: vault.preferences.theme,
            ...(vault.preferences.panelState === undefined ? {} : { panelState: vault.preferences.panelState })
          });
          await refreshVault();
        }
      },
      {
        id: "rescan",
        disabledReason: vault === undefined ? noVault : null,
        run: async () => {
          await vaultApi.rescanVault();
          await refreshVault();
        }
      },
      {
        id: "publish",
        disabledReason: publishDisabledReason,
        run: () => setPublishOpen(true)
      },
      {
        id: "revoke",
        disabledReason: revokeDisabledReason,
        run: () => setRevokeOpen(true)
      },
      {
        id: "toggle-theme",
        disabledReason: onToggleTheme === undefined ? "Theme controls are unavailable." : null,
        run: () => onToggleTheme?.()
      },
      {
        id: "sign-out",
        disabledReason: onSignOut === undefined ? "Sign out is unavailable." : null,
        run: () => onSignOut?.()
      }
    ];
  }, [
    inboxFolder,
    notesApi,
    now,
    onNavigateNote,
    onSignOut,
    onToggleTheme,
    openNewNote,
    openNoteOperation,
    publishDisabledReason,
    refreshVault,
    revokeDisabledReason,
    selectedEntry,
    selectedFolder,
    newNoteFolder,
    vault,
    vaultApi
  ]);

  const submitOperation = useCallback(async (value: ExplorerOperationValue): Promise<void> => {
    if (pendingOperation === null) return;
    setOperationBusy(true);
    setOperationError(null);
    try {
      const { operation, target } = pendingOperation;
      if (operation.kind === "new-note") {
        const created = await notesApi.createNote({ title: value.name, body: "", folderId: value.folderId });
        await refreshVault();
        setPendingOperation(null);
        onNavigateNote?.(created.note.frontmatter.id);
        return;
      }
      if (operation.kind === "new-folder") {
        await vaultApi.createFolder({ parentId: value.folderId, name: value.name });
      } else if (operation.kind === "move") {
        if (target === null) return;
        if (operation.selectionKind === "note") {
          await notesApi.moveNote(target.id, { expectedVersion: target.version, folderId: value.folderId });
        } else {
          await vaultApi.updateFolder(target.id, { expectedVersion: target.version, parentId: value.folderId });
        }
      } else if (target !== null && operation.selectionKind === "folder") {
        await vaultApi.updateFolder(target.id, { expectedVersion: target.version, name: value.name });
      } else if (target !== null) {
        const latest = await notesApi.getNote(target.id);
        const document = parseNote(latest.source);
        const source = serializeNote({
          ...document,
          frontmatter: {
            ...document.frontmatter,
            title: value.name,
            updated: (now?.() ?? new Date()).toISOString()
          }
        });
        await notesApi.updateNote(target.id, { expectedVersion: latest.version, source });
      }
      await refreshVault();
      setPendingOperation(null);
    } catch {
      setOperationError("The operation could not be completed.");
    } finally {
      setOperationBusy(false);
    }
  }, [notesApi, now, onNavigateNote, pendingOperation, refreshVault, vaultApi]);

  useEffect(() => {
    setEditorState({
      noteId: noteId ?? "",
      title: noteId === undefined ? ACTIVE_NOTE.title : "",
      path: noteId === undefined ? ACTIVE_NOTE.path : "",
      status: noteId === undefined ? "Saved" : "Saving",
      version: null,
      source: null
    });
  }, [noteId]);

  const attachmentAction = noteId === undefined ? (
    <button className="text-action touch-target" type="button" disabled title="Select a saved note first.">
      <Paperclip size={19} strokeWidth={1.75} aria-hidden />
      <span>Add attachment</span>
    </button>
  ) : (
    <AttachmentPicker
      noteId={noteId}
      client={attachmentApi}
      disabledReason={attachmentDisabledReason}
      onUploaded={completeAttachmentUpload}
    />
  );
  const publicationAction = (
    <button
      ref={publishTriggerRef}
      className="publish-action touch-target"
      type="button"
      disabled={publishDisabledReason !== null}
      title={publishDisabledReason ?? undefined}
      onClick={() => setPublishOpen(true)}
    >
      <Upload size={19} strokeWidth={1.75} aria-hidden />
      <span>Publish</span>
    </button>
  );
  const attachmentCards = selectedEntry === undefined || selectedEntry.attachments.length === 0 ? (
    <p className="empty-info">No attachments</p>
  ) : (
    <div className="attachment-list">
      {selectedEntry.attachments.map((attachment) => (
        <AttachmentView
          attachment={attachment}
          key={attachment.assetId}
          onTrash={async (assetId) => {
            await attachmentApi.trash(assetId);
            await refreshVault();
          }}
        />
      ))}
    </div>
  );
  const publicationPanel = publicationState.noteId !== noteId || publicationState.loading ? (
    <div role="status">Checking publication status</div>
  ) : publicationState.error ? (
    <StatusCallout tone="error">
      <span>Publication status could not be verified.</span>
      <button className="secondary-action touch-target" type="button" onClick={retryPublicationStatus}>
        Check again
      </button>
    </StatusCallout>
  ) : currentPublication === null ? (
    <p className="empty-info">Not published</p>
  ) : (
    <PublicationStatus
      status={currentPublication}
      client={publicationApi}
      revokeOpen={revokeOpen}
      onRevokeOpenChange={setRevokeOpen}
      onRevoked={async () => {
        await refreshVault();
        publishTriggerRef.current?.focus();
        setPublicationState({ noteId: noteId ?? null, loading: false, status: null, error: false });
      }}
    />
  );
  const explorerRegion = (
    <ExplorerRegion
      hidden={isHidden("files")}
      vault={vault}
      searchQuery={explorerSearchQuery}
      onSearchQueryChange={setExplorerSearchQuery}
      expandedFolderIds={expandedFolderIds}
      onExpandedFolderIdsChange={setExpandedFolderIds}
      selectedNoteId={noteId}
      onNavigateNote={onNavigateNote}
      onRenameFolder={(folder) => openFolderOperation("rename", folder)}
      onMoveFolder={(folder) => openFolderOperation("move", folder)}
      onArchiveFolder={archiveFolder === undefined ? undefined : (folder) => void runFolderArchive(folder)}
      onTrashFolder={runFolderTrash}
      onCreateNoteInFolder={openNewNoteInFolder}
      now={now}
    />
  );

  return (
    <div
      className="owner-shell"
      data-testid="owner-shell"
      data-mobile-destination={activeDestination}
      data-layout={layout}
      data-compact-tablet={compactTablet ? "true" : "false"}
      data-explorer-open={explorerOpen ? "true" : "false"}
    >
      <main className="workspace" aria-label="NXT workspace">
        {layout === "tablet" && compactTablet ? null : explorerRegion}
        {noteId === undefined ? (
          <>
            {vault !== undefined && vault.entries.length === 0 ? (
              <EmptyEditorRegion
                hidden={isHidden("editor")}
                disabledReason={newNoteFolder === undefined ? "The Plans or Inbox folder is unavailable." : null}
                onCreate={openNewNote}
                mobilePath={layout === "mobile" ? (
                  <ActiveNotePath className="mobile-content-path" path={editorState.path} withIcon />
                ) : undefined}
              />
            ) : (
              <EditorRegion
                hidden={isHidden("editor")}
                mobilePath={layout === "mobile" ? (
                  <ActiveNotePath className="mobile-content-path" path={editorState.path} withIcon />
                ) : undefined}
              />
            )}
            <div className="context-column">
              <PreviewRegion
                hidden={isHidden("preview")}
                mobilePath={layout === "mobile" ? (
                  <ActiveNotePath className="mobile-content-path" path={editorState.path} withIcon />
                ) : undefined}
              />
              <InfoRegion
                hidden={isHidden("info")}
                attachments={attachmentCards}
                publication={publicationPanel}
                attachmentDisabledReason={attachmentDisabledReason}
                publicationDisabledReason={publishDisabledReason}
                publicationHeadingRef={publicationHeadingRef}
              />
            </div>
          </>
        ) : (
          <Suspense fallback={null}>
            <EditorWorkspace
              noteId={noteId}
              hiddenEditor={isHidden("editor")}
              hiddenPreview={isHidden("preview")}
              notes={notes}
              draftStore={draftStore}
              currentFolderId={selectedFolder?.id ?? currentFolderId}
              resolveAttachment={selectedAttachmentResolver ?? resolveAttachment}
              resolveWikiLink={vaultWikiResolver ?? resolveWikiLink}
              onWikiNavigate={navigateWiki}
              backlinks={knowledgeLinks.backlinks}
              wikiLinks={knowledgeLinks.wikiLinks}
              now={now}
              showStatus={false}
              onStateChange={setEditorState}
              attachmentInsertion={attachmentInsertion}
              mobile={layout === "mobile"}
              mobilePath={layout === "mobile" ? (
                <ActiveNotePath className="mobile-content-path" path={editorState.path} withIcon />
              ) : undefined}
              infoRegion={(
                <InfoRegion
                  hidden={isHidden("info")}
                  attachments={attachmentCards}
                  publication={publicationPanel}
                  attachmentDisabledReason={attachmentDisabledReason}
                  publicationDisabledReason={publishDisabledReason}
                  publicationHeadingRef={publicationHeadingRef}
                />
              )}
            />
          </Suspense>
        )}
      </main>
      <WorkspaceHeader
        layout={layout}
        compactTablet={compactTablet}
        activeDestination={layout === "tablet" ? tabletPrimaryDestination : activeDestination}
        explorerOpen={layout === "mobile" ? activeDestination === "files" : explorerOpen}
        explorerTriggerRef={explorerTriggerRef}
        noteTitle={editorState.title}
        notePath={editorState.path}
        saveStatus={editorState.status}
        attachmentAction={attachmentAction}
        publicationAction={publicationAction}
        overflowAction={<OwnerOverflowMenu actions={paletteActions} onOpenCommandPalette={openPalette} />}
        onToggleExplorer={() => {
          if (layout === "mobile") {
            setActiveDestination((current) => current === "files" ? "editor" : "files");
          } else {
            setExplorerOpen((current) => !current);
          }
        }}
        onSelectDestination={setActiveDestination}
        onOpenCommandPalette={openPalette}
      />
      <footer className="shell-status" aria-label="Info">
        <span>Files</span>
        <span>Editor</span>
        <span>Info</span>
      </footer>
      {layout === "mobile" ? (
        <MobileDestinationNav activeDestination={activeDestination} onSelect={setActiveDestination} />
      ) : null}
      {layout === "tablet" && compactTablet ? (
        <Dialog.Root open={explorerOpen} onOpenChange={setExplorerOpen}>
          <Dialog.Portal>
            <Dialog.Overlay className="explorer-sheet-overlay" />
            <Dialog.Content
              className="explorer-sheet-content"
              aria-describedby={undefined}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                explorerTriggerRef.current?.focus();
              }}
            >
              <Dialog.Title className="sr-only">Files</Dialog.Title>
              {explorerRegion}
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      ) : null}
      <Suspense fallback={null}>
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          actions={paletteActions}
        />
      </Suspense>
      {!editorIsSaved || noteId === undefined || editorState.version === null ? null : (
        <PublishDialog
          open={publishOpen}
          onOpenChange={setPublishOpen}
          noteId={noteId}
          sourceVersion={editorState.version}
          attachmentCount={referencedAttachmentCount}
          client={publicationApi}
          onPublished={async (status) => {
            setPublicationState({ noteId, loading: false, status, error: false });
            await refreshVault();
            if (layout !== "desktop") setActiveDestination("info");
          }}
        />
      )}
      {pendingOperation === null || vault === undefined ? null : (
        <ExplorerOperationDialog
          operation={pendingOperation.operation}
          folders={vault.folders}
          busy={operationBusy}
          error={operationError}
          onCancel={() => {
            setOperationError(null);
            setPendingOperation(null);
          }}
          onSubmit={(value) => void submitOperation(value)}
        />
      )}
    </div>
  );
};
