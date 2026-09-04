import {
  Archive,
  Bookmark,
  Check,
  ChevronRight,
  Eye,
  File,
  FilePenLine,
  Folder,
  Info,
  Inbox,
  MoreVertical,
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
  useState,
  useSyncExternalStore,
  type ComponentType
} from "react";
import { notesClient, type NotesClient } from "../api/notes";
import type { ArchiveNoteRequest } from "@nxt/contracts";
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
import type { SaveStatus } from "../editor/use-autosave";
import type { KnowledgeLink } from "../explorer/backlinks-panel";
import { useCommandPaletteShortcut } from "../explorer/command-palette-shortcut";
import type { CommandPaletteAction } from "../explorer/command-palette";
import type {
  ExplorerOperation,
  ExplorerOperationValue
} from "../explorer/explorer-operation-dialog";
import { ExplorerOperationDialog } from "../explorer/explorer-operation-dialog";
import { FavoritesPanel } from "../explorer/favorites-panel";
import { NoteStatsCard } from "../explorer/note-stats-card";
import { computeNoteStats } from "../editor/note-stats";
import {
  buildExplorerTree,
  FileTree,
  type FileTreeProps,
  type FolderExplorerNode,
  type NoteExplorerNode
} from "../explorer/file-tree";
import { TagsPanel } from "../explorer/tags-panel";

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

const AttachmentPicker = lazy(async () => {
  const module = await import("../editor/attachment-picker");
  return { default: module.AttachmentPicker };
});

const AttachmentView = lazy(async () => {
  const module = await import("../editor/attachment-view");
  return { default: module.AttachmentView };
});

const PublishDialog = lazy(async () => {
  const module = await import("../publication/publish-dialog");
  return { default: module.PublishDialog };
});

const PublicationStatus = lazy(async () => {
  const module = await import("../publication/publication-status");
  return { default: module.PublicationStatus };
});

type Destination = "files" | "editor" | "preview" | "info";

interface DestinationItem {
  readonly id: Destination;
  readonly label: "Files" | "Editor" | "Preview" | "Info";
  readonly icon: ComponentType<{ readonly size?: number; readonly strokeWidth?: number; readonly "aria-hidden"?: boolean }>;
}

const DESTINATIONS: readonly DestinationItem[] = [
  { id: "files", label: "Files", icon: Folder },
  { id: "editor", label: "Editor", icon: FilePenLine },
  { id: "preview", label: "Preview", icon: Eye },
  { id: "info", label: "Info", icon: Info }
];

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

const MOBILE_MEDIA_QUERY = "(max-width: 767px)";
// The 23% explorer track first fits the measured 93.1875px brand plus 4 × 44px targets at 1171px.
const WIDE_DESKTOP_MEDIA_QUERY = "(min-width: 1171px)";

const mobileViewportSnapshot = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia(MOBILE_MEDIA_QUERY).matches;

const subscribeToMobileViewport = (onChange: () => void): (() => void) => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(MOBILE_MEDIA_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};

const useMobileViewport = (): boolean =>
  useSyncExternalStore(subscribeToMobileViewport, mobileViewportSnapshot, () => false);

const wideDesktopViewportSnapshot = (): boolean =>
  typeof window === "undefined" || typeof window.matchMedia !== "function"
    ? true
    : window.matchMedia(WIDE_DESKTOP_MEDIA_QUERY).matches;

const subscribeToWideDesktopViewport = (onChange: () => void): (() => void) => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(WIDE_DESKTOP_MEDIA_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};

const useWideDesktopViewport = (): boolean =>
  useSyncExternalStore(
    subscribeToWideDesktopViewport,
    wideDesktopViewportSnapshot,
    () => true
  );

interface DestinationNavigationProps {
  readonly label: "Desktop destinations" | "Mobile destinations";
  readonly activeDestination: Destination;
  readonly onSelect: (destination: Destination) => void;
  readonly mobile?: boolean;
}

const DestinationNavigation = ({
  label,
  activeDestination,
  onSelect,
  mobile = false
}: DestinationNavigationProps): React.JSX.Element => (
  <nav className={mobile ? "mobile-destinations" : "desktop-destinations"} aria-label={label}>
    {DESTINATIONS.map(({ id, label: destinationLabel, icon: Icon }) => (
      <button
        className="destination-button touch-target"
        type="button"
        aria-label={destinationLabel}
        aria-pressed={activeDestination === id}
        onClick={() => onSelect(id)}
        key={id}
      >
        <Icon size={mobile ? 24 : 19} strokeWidth={1.75} aria-hidden />
        {mobile ? <span>{destinationLabel}</span> : null}
      </button>
    ))}
  </nav>
);

const SaveStatusOutput = ({ status }: { readonly status: SaveStatus }): React.JSX.Element => (
  <output className={`save-status save-status-${status.toLowerCase().replace(" ", "-")}`} aria-label="Save status" aria-live="polite">
    <span>{status}</span>
    {status === "Saved" ? (
      <span className="save-icon" aria-hidden>
        <Check size={13} strokeWidth={2.25} />
      </span>
    ) : null}
  </output>
);

const ActiveNotePath = ({
  className,
  path,
  withIcon = false
}: {
  readonly className: string;
  readonly path: string;
  readonly withIcon?: boolean;
}): React.JSX.Element => (
  <div className={className} aria-label={`Active note path: ${path}`} title={path}>
    {withIcon ? <Folder size={18} strokeWidth={1.75} aria-hidden /> : null}
    <span>{path}</span>
  </div>
);

const ShellHeader = ({
  activeDestination,
  onSelect,
  showDesktopDestinations,
  noteTitle,
  notePath,
  saveStatus,
  attachmentAction,
  publicationAction
}: {
  readonly activeDestination: Destination;
  readonly onSelect: (destination: Destination) => void;
  readonly showDesktopDestinations: boolean;
  readonly noteTitle: string;
  readonly notePath: string;
  readonly saveStatus: SaveStatus;
  readonly attachmentAction: React.ReactNode;
  readonly publicationAction: React.ReactNode;
}): React.JSX.Element => (
  <header className="shell-header">
    <div className="shell-header-explorer">
      <span className="brand shell-brand">NXT</span>
      {showDesktopDestinations ? (
        <DestinationNavigation
          label="Desktop destinations"
          activeDestination={activeDestination}
          onSelect={onSelect}
        />
      ) : null}
    </div>
    <span className="mobile-title">{noteTitle}</span>
    <button className="mobile-more touch-target" type="button" aria-label="Info" onClick={() => onSelect("info")}>
      <MoreVertical size={23} strokeWidth={1.75} aria-hidden />
    </button>
    <div className="shell-actions" aria-label="Editor actions">
      {attachmentAction}
      {publicationAction}
    </div>
    <ActiveNotePath className="mobile-path" path={notePath} withIcon />
    <SaveStatusOutput status={saveStatus} />
  </header>
);

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
  selectedNoteId,
  onNavigateNote,
  onRenameFolder,
  onMoveFolder,
  onArchiveFolder,
  onTrashFolder,
  onRenameNote,
  onMoveNote,
  onArchiveNote,
  onTrashNote,
  onNewNote,
  onNewFolder,
  newActionsDisabledReason,
  now
}: {
  readonly hidden: boolean;
  readonly vault: CompleteVault;
  readonly selectedNoteId?: string | undefined;
  readonly onNavigateNote?: ((noteId: string) => void) | undefined;
  readonly onRenameFolder?: ((folder: FolderExplorerNode) => void) | undefined;
  readonly onMoveFolder?: ((folder: FolderExplorerNode) => void) | undefined;
  readonly onArchiveFolder?: ((folder: FolderExplorerNode) => void) | undefined;
  readonly onTrashFolder?: FileTreeProps["onTrashFolder"];
  readonly onRenameNote?: ((note: NoteExplorerNode) => void) | undefined;
  readonly onMoveNote?: ((note: NoteExplorerNode) => void) | undefined;
  readonly onArchiveNote?: ((note: NoteExplorerNode) => void) | undefined;
  readonly onTrashNote?: FileTreeProps["onTrashNote"];
  readonly onNewNote?: ((parentId: string | null) => void) | undefined;
  readonly onNewFolder?: ((parentId: string | null) => void) | undefined;
  readonly newActionsDisabledReason?: string | null | undefined;
  readonly now?: (() => Date) | undefined;
}): React.JSX.Element => {
  const [requestedSearch, setRequestedSearch] = useState<string | undefined>();
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
          requestedQuery={requestedSearch}
          onOpenNote={(id) => onNavigateNote?.(id)}
        />
      </Suspense>
      <div className="explorer-scroll">
        <section className="explorer-section" aria-labelledby="files-heading">
          <h2 id="files-heading">Files</h2>
          <FileTree
            tree={tree}
            selectedId={selectedNoteId}
            onSelect={(node) => {
              if (node.kind === "note") onNavigateNote?.(node.id);
            }}
            onRenameFolder={onRenameFolder}
            onMoveFolder={onMoveFolder}
            onArchiveFolder={onArchiveFolder}
            onTrashFolder={onTrashFolder}
            onRenameNote={onRenameNote}
            onMoveNote={onMoveNote}
            onArchiveNote={onArchiveNote}
            onTrashNote={onTrashNote}
            onNewNote={onNewNote}
            onNewFolder={onNewFolder}
            newActionsDisabledReason={newActionsDisabledReason}
            now={now}
          />
        </section>
        <FavoritesPanel items={favorites} onOpen={(id) => onNavigateNote?.(id)} />
        <TagsPanel tags={tags} onSelect={(tag) => setRequestedSearch(`tag:${tag}`)} />
      </div>
    </section>
  );
};

const ExplorerRegion = ({
  hidden,
  vault,
  selectedNoteId,
  onNavigateNote,
  onRenameFolder,
  onMoveFolder,
  onArchiveFolder,
  onTrashFolder,
  onRenameNote,
  onMoveNote,
  onArchiveNote,
  onTrashNote,
  onNewNote,
  onNewFolder,
  newActionsDisabledReason,
  now
}: {
  readonly hidden: boolean;
  readonly vault?: CompleteVault | undefined;
  readonly selectedNoteId?: string | undefined;
  readonly onNavigateNote?: ((noteId: string) => void) | undefined;
  readonly onRenameFolder?: ((folder: FolderExplorerNode) => void) | undefined;
  readonly onMoveFolder?: ((folder: FolderExplorerNode) => void) | undefined;
  readonly onArchiveFolder?: ((folder: FolderExplorerNode) => void) | undefined;
  readonly onTrashFolder?: FileTreeProps["onTrashFolder"];
  readonly onRenameNote?: ((note: NoteExplorerNode) => void) | undefined;
  readonly onMoveNote?: ((note: NoteExplorerNode) => void) | undefined;
  readonly onArchiveNote?: ((note: NoteExplorerNode) => void) | undefined;
  readonly onTrashNote?: FileTreeProps["onTrashNote"];
  readonly onNewNote?: ((parentId: string | null) => void) | undefined;
  readonly onNewFolder?: ((parentId: string | null) => void) | undefined;
  readonly newActionsDisabledReason?: string | null | undefined;
  readonly now?: (() => Date) | undefined;
}): React.JSX.Element => vault === undefined
  ? <StaticExplorerRegion hidden={hidden} />
  : (
    <VaultExplorerRegion
      hidden={hidden}
      vault={vault}
      selectedNoteId={selectedNoteId}
      onNavigateNote={onNavigateNote}
      onRenameFolder={onRenameFolder}
      onMoveFolder={onMoveFolder}
      onArchiveFolder={onArchiveFolder}
      onTrashFolder={onTrashFolder}
      onRenameNote={onRenameNote}
      onMoveNote={onMoveNote}
      onArchiveNote={onArchiveNote}
      onTrashNote={onTrashNote}
      onNewNote={onNewNote}
      onNewFolder={onNewFolder}
      newActionsDisabledReason={newActionsDisabledReason}
      now={now}
    />
  );

const EditorRegion = ({ hidden }: { readonly hidden: boolean }): React.JSX.Element => (
  <section className="workspace-region editor-region" role="region" aria-label="Editor" hidden={hidden}>
    <div className="region-toolbar">
      <ActiveNotePath className="desktop-path" path={ACTIVE_NOTE.path} />
      <span className="region-label">Editor</span>
    </div>
    <div className="editor-canvas" aria-label="Editor">
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
  onCreate
}: {
  readonly hidden: boolean;
  readonly disabledReason: string | null;
  readonly onCreate: () => void;
}): React.JSX.Element => (
  <section className="workspace-region editor-region" role="region" aria-label="Editor" hidden={hidden}>
    <div className="region-toolbar">
      <span className="region-label">Editor</span>
    </div>
    <div className="empty-editor-state">
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
    </div>
  </section>
);

const PreviewRegion = ({ hidden }: { readonly hidden: boolean }): React.JSX.Element => (
  <section className="context-region preview-region" role="region" aria-label="Preview" hidden={hidden}>
    <div className="context-tabs" role="tablist" aria-label="Preview">
      <button className="context-tab touch-target active" type="button" role="tab" aria-selected="true">Preview</button>
      <button className="context-tab touch-target" type="button" role="tab" aria-selected="false">Outline</button>
      <button className="context-tab touch-target" type="button" role="tab" aria-selected="false">Backlinks</button>
    </div>
    <div className="preview-content">
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
  statsCard
}: {
  readonly hidden: boolean;
  readonly attachments?: React.ReactNode;
  readonly publication?: React.ReactNode;
  readonly statsCard?: React.ReactNode;
}): React.JSX.Element => (
  <section className="context-region info-region" role="region" aria-label="Info" hidden={hidden}>
    <div className="region-toolbar"><span className="region-label">Info</span></div>
    <div className="info-content">
      <h1>Info</h1>
      {statsCard === undefined ? null : statsCard}
      <section><h2>Outline</h2></section>
      <section><h2>Backlinks</h2></section>
      {attachments === undefined ? null : <section><h2>Attachments</h2>{attachments}</section>}
      {publication === undefined ? null : <section><h2>Publication</h2>{publication}</section>}
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
  const publishTriggerRef = useRef<HTMLButtonElement>(null);
  const isMobileViewport = useMobileViewport();
  const isWideDesktopViewport = useWideDesktopViewport();
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
  const isHidden = (destination: Destination): boolean =>
    isMobileViewport && activeDestination !== destination;

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

  useEffect(() => {
    setPublishOpen(false);
    setRevokeOpen(false);
    setAttachmentInsertion(null);
    if (noteId === undefined) {
      setPublicationState({ noteId: null, loading: false, status: null, error: false });
      return;
    }
    let active = true;
    setPublicationState({ noteId, loading: true, status: null, error: false });
    void publicationApi.getStatus(noteId).then((status) => {
      if (active) setPublicationState({ noteId, loading: false, status, error: false });
    }).catch(() => {
      if (active) setPublicationState({ noteId, loading: false, status: null, error: true });
    });
    return () => { active = false; };
  }, [noteId, publicationApi]);

  const currentPublication = publicationState.noteId === noteId ? publicationState.status : null;
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

  const refreshAfterAttachment = useCallback(async (): Promise<void> => {
    await refreshVault();
  }, [refreshVault]);

  const openNoteOperation = useCallback((kind: "rename" | "move", source?: NoteExplorerNode): void => {
    const target = source === null
      ? undefined
      : (source ?? (selectedEntry === undefined ? undefined : {
          id: selectedEntry.id,
          name: selectedEntry.title,
          path: selectedEntry.path,
          version: selectedEntry.driveVersion
        }));
    if (target === undefined) return;
    const parentPath = target.path.slice(0, target.path.lastIndexOf("/"));
    const parentFolder = vault?.folders.find((candidate) => candidate.path === parentPath) ?? selectedFolder;
    if (parentFolder === undefined) return;
    setOperationError(null);
    setPendingOperation({
      operation: {
        kind,
        selectionKind: "note",
        initialName: target.name,
        initialFolderId: parentFolder.id
      },
      target: { id: target.id, version: target.version }
    });
  }, [selectedEntry, selectedFolder, vault]);

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

  const runNoteArchive = useCallback(async (note: NoteExplorerNode): Promise<void> => {
    await notesApi.archiveNote(note.id, { expectedVersion: note.version });
    await refreshVault();
    if (note.id === noteId) {
      const remaining = vault?.entries.filter((entry) => entry.id !== note.id) ?? [];
      const fallback = remaining[0]?.id;
      if (fallback !== undefined) onNavigateNote?.(fallback);
    }
  }, [notesApi, noteId, onNavigateNote, refreshVault, vault]);

  const runNoteTrash = useCallback(async (
    note: NoteExplorerNode,
    input: ArchiveNoteRequest
  ): Promise<void> => {
    try {
      await notesApi.trashNote(note.id, input);
    } catch (error) {
      await refreshVault().catch(() => undefined);
      throw error;
    }
    await refreshVault();
    if (note.id === noteId) {
      const remaining = vault?.entries.filter((entry) => entry.id !== note.id) ?? [];
      const fallback = remaining[0]?.id;
      if (fallback !== undefined) onNavigateNote?.(fallback);
    }
  }, [notesApi, noteId, onNavigateNote, refreshVault, vault]);

  const requestNewNote = useCallback((parentId: string | null): void => {
    const folder = parentId !== null
      ? vault?.folders.find((candidate) => candidate.id === parentId)
      : newNoteFolder;
    if (folder === undefined) return;
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
  }, [newNoteFolder, vault]);

  const requestNewFolder = useCallback((parentId: string | null): void => {
    const folder = parentId !== null
      ? vault?.folders.find((candidate) => candidate.id === parentId)
      : selectedFolder ?? plansFolder ?? inboxFolder;
    if (folder === undefined) return;
    setOperationError(null);
    setPendingOperation({
      operation: {
        kind: "new-folder",
        selectionKind: "folder",
        initialName: "",
        initialFolderId: folder.id
      },
      target: null
    });
  }, [inboxFolder, plansFolder, selectedFolder, vault]);

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
    <Suspense fallback={
      <button className="text-action touch-target" type="button" disabled aria-busy="true" title="Loading attachment picker">
        <Paperclip size={19} strokeWidth={1.75} aria-hidden />
        <span>Add attachment</span>
      </button>
    }>
      <AttachmentPicker
        noteId={noteId}
        client={attachmentApi}
        disabledReason={attachmentDisabledReason}
        onUploaded={completeAttachmentUpload}
      />
    </Suspense>
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
  const noteStatsCard = editorState.source === null ? null : (
    <NoteStatsCard stats={computeNoteStats(editorState.source, editorState.path)} />
  );
  const attachmentCards = selectedEntry === undefined || selectedEntry.attachments.length === 0 ? (
    <p className="empty-info">No attachments</p>
  ) : (
    <div className="attachment-list">
      {selectedEntry.attachments.map((attachment) => (
        <Suspense
          key={attachment.assetId}
          fallback={<div className="attachment-card-skeleton" aria-busy="true" />}
        >
          <AttachmentView
            attachment={attachment}
            onTrash={async (assetId) => {
              await attachmentApi.trash(assetId);
              await refreshVault();
            }}
          />
        </Suspense>
      ))}
    </div>
  );
  const publicationPanel = publicationState.noteId !== noteId || publicationState.loading ? (
    <div role="status">Checking publication status</div>
  ) : publicationState.error ? (
    <p role="alert">Publication status could not be verified.</p>
  ) : currentPublication === null ? (
    <p className="empty-info">Not published</p>
  ) : (
    <Suspense fallback={<div className="publication-status-skeleton" aria-busy="true" />}>
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
    </Suspense>
  );

  return (
    <div
      className="owner-shell"
      data-testid="owner-shell"
      data-mobile-destination={activeDestination}
    >
      <ShellHeader
        activeDestination={activeDestination}
        onSelect={setActiveDestination}
        showDesktopDestinations={!isMobileViewport && isWideDesktopViewport}
        noteTitle={editorState.title}
        notePath={editorState.path}
        saveStatus={editorState.status}
        attachmentAction={attachmentAction}
        publicationAction={publicationAction}
      />
      <main className="workspace" aria-label="NXT workspace">
        <ExplorerRegion
          hidden={isHidden("files")}
          vault={vault}
          selectedNoteId={noteId}
          onNavigateNote={onNavigateNote}
          onRenameFolder={(folder) => openFolderOperation("rename", folder)}
          onMoveFolder={(folder) => openFolderOperation("move", folder)}
          onArchiveFolder={archiveFolder === undefined ? undefined : (folder) => void runFolderArchive(folder)}
          onTrashFolder={runFolderTrash}
          onRenameNote={(note) => openNoteOperation("rename", note)}
          onMoveNote={(note) => openNoteOperation("move", note)}
          onArchiveNote={(note) => void runNoteArchive(note)}
          onTrashNote={runNoteTrash}
          onNewNote={requestNewNote}
          onNewFolder={requestNewFolder}
          newActionsDisabledReason={vault === undefined ? "The vault is loading." : null}
          now={now}
        />
        {noteId === undefined ? (
          <>
            {vault !== undefined && vault.entries.length === 0 ? (
              <EmptyEditorRegion
                hidden={isHidden("editor")}
                disabledReason={newNoteFolder === undefined ? "The Plans or Inbox folder is unavailable." : null}
                onCreate={openNewNote}
              />
            ) : (
              <EditorRegion hidden={isHidden("editor")} />
            )}
            <div className="context-column">
              <PreviewRegion hidden={isHidden("preview")} />
              <InfoRegion hidden={isHidden("info")} attachments={attachmentCards} publication={publicationPanel} statsCard={noteStatsCard} />
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
              infoRegion={<InfoRegion hidden={isHidden("info")} attachments={attachmentCards} publication={publicationPanel} statsCard={noteStatsCard} />}
              onAttachmentUploaded={refreshAfterAttachment}
            />
          </Suspense>
        )}
      </main>
      <footer className="shell-status" aria-label="Info">
        <span>Files</span>
        <span>Editor</span>
        <span>Info</span>
      </footer>
      <DestinationNavigation
        label="Mobile destinations"
        activeDestination={activeDestination}
        onSelect={setActiveDestination}
        mobile
      />
      <Suspense fallback={null}>
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          actions={paletteActions}
        />
      </Suspense>
      {!editorIsSaved || noteId === undefined || editorState.version === null ? null : (
        <Suspense fallback={null}>
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
              setActiveDestination("info");
            }}
          />
        </Suspense>
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
