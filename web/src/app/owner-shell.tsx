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
import { useState, useSyncExternalStore, type ComponentType } from "react";

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

const SaveStatus = (): React.JSX.Element => (
  <output className="save-status" aria-label="Save status" aria-live="polite">
    <span>Saved</span>
    <span className="save-icon" aria-hidden>
      <Check size={13} strokeWidth={2.25} />
    </span>
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
  onSelect
}: {
  readonly activeDestination: Destination;
  readonly onSelect: (destination: Destination) => void;
}): React.JSX.Element => (
  <header className="shell-header">
    <div className="shell-header-explorer">
      <span className="brand shell-brand">NXT</span>
      <DestinationNavigation
        label="Desktop destinations"
        activeDestination={activeDestination}
        onSelect={onSelect}
      />
    </div>
    <span className="mobile-title">{ACTIVE_NOTE.title}</span>
    <button className="mobile-more touch-target" type="button" aria-label="Info" onClick={() => onSelect("info")}>
      <MoreVertical size={23} strokeWidth={1.75} aria-hidden />
    </button>
    <div className="shell-actions" aria-label="Editor actions">
      <button className="text-action touch-target" type="button">
        <Paperclip size={19} strokeWidth={1.75} aria-hidden />
        <span>Add attachment</span>
      </button>
      <button className="publish-action touch-target" type="button">
        <Upload size={19} strokeWidth={1.75} aria-hidden />
        <span>Publish</span>
      </button>
    </div>
    <ActiveNotePath className="mobile-path" path={ACTIVE_NOTE.path} withIcon />
    <SaveStatus />
  </header>
);

const ExplorerRegion = ({ hidden }: { readonly hidden: boolean }): React.JSX.Element => (
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

const InfoRegion = ({ hidden }: { readonly hidden: boolean }): React.JSX.Element => (
  <section className="context-region info-region" role="region" aria-label="Info" hidden={hidden}>
    <div className="region-toolbar"><span className="region-label">Info</span></div>
    <div className="info-content">
      <h1>Info</h1>
      <section><h2>Outline</h2></section>
      <section><h2>Backlinks</h2></section>
    </div>
  </section>
);

export const OwnerShell = (): React.JSX.Element => {
  const [activeDestination, setActiveDestination] = useState<Destination>("editor");
  const isMobileViewport = useMobileViewport();
  const isHidden = (destination: Destination): boolean =>
    isMobileViewport && activeDestination !== destination;

  return (
    <div
      className="owner-shell"
      data-testid="owner-shell"
      data-mobile-destination={activeDestination}
    >
      <ShellHeader activeDestination={activeDestination} onSelect={setActiveDestination} />
      <main className="workspace" aria-label="NXT workspace">
        <ExplorerRegion hidden={isHidden("files")} />
        <EditorRegion hidden={isHidden("editor")} />
        <div className="context-column">
          <PreviewRegion hidden={isHidden("preview")} />
          <InfoRegion hidden={isHidden("info")} />
        </div>
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
    </div>
  );
};
