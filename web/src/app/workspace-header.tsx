import { Check, Command, Folder, PanelLeft } from "lucide-react";
import type { RefObject } from "react";
import type { SaveStatus } from "../editor/use-autosave";
import type { Destination } from "./mobile-destination-nav";
import type { WorkspaceLayout } from "./workspace-layout";
import { StatusCallout } from "./status-callout";

export type { Destination } from "./mobile-destination-nav";

export interface WorkspaceHeaderProps {
  readonly layout: WorkspaceLayout;
  readonly compactTablet: boolean;
  readonly activeDestination: Destination;
  readonly explorerOpen: boolean;
  readonly explorerTriggerRef: RefObject<HTMLButtonElement | null>;
  readonly noteTitle: string;
  readonly notePath: string;
  readonly saveStatus: SaveStatus;
  readonly attachmentAction: React.ReactNode;
  readonly publicationAction: React.ReactNode;
  readonly overflowAction: React.ReactNode;
  readonly onToggleExplorer: () => void;
  readonly onSelectDestination: (destination: Exclude<Destination, "files">) => void;
  readonly onOpenCommandPalette: () => void;
}

export const SaveStatusOutput = ({ status }: { readonly status: SaveStatus }): React.JSX.Element => (
  <output
    className={`save-status save-status-${status.toLowerCase().replace(" ", "-")}`}
    aria-label="Save status"
    aria-live="polite"
  >
    <span>{status}</span>
    {status === "Saved" ? (
      <span className="save-icon" aria-hidden>
        <Check size={13} strokeWidth={2.25} />
      </span>
    ) : null}
  </output>
);

export const ActiveNotePath = ({
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

const FilesToggle = ({
  explorerOpen,
  explorerTriggerRef,
  onToggleExplorer
}: Pick<WorkspaceHeaderProps, "explorerOpen" | "explorerTriggerRef" | "onToggleExplorer">): React.JSX.Element => (
  <button
    ref={explorerTriggerRef}
    className="files-toggle touch-target"
    type="button"
    aria-label={explorerOpen ? "Hide files" : "Show files"}
    aria-expanded={explorerOpen}
    onClick={onToggleExplorer}
  >
    <PanelLeft size={20} strokeWidth={1.75} aria-hidden />
    <span>Files</span>
  </button>
);

export const WorkspaceHeader = ({
  layout,
  compactTablet,
  activeDestination,
  explorerOpen,
  explorerTriggerRef,
  noteTitle,
  notePath,
  saveStatus,
  attachmentAction,
  publicationAction,
  overflowAction,
  onToggleExplorer,
  onSelectDestination,
  onOpenCommandPalette
}: WorkspaceHeaderProps): React.JSX.Element => {
  const filesToggle = (
    <FilesToggle
      explorerOpen={explorerOpen}
      explorerTriggerRef={explorerTriggerRef}
      onToggleExplorer={onToggleExplorer}
    />
  );
  const recoveryCallout = saveStatus === "Offline draft" || saveStatus === "Error" ? (
    <div className="workspace-recovery-callout">
      <StatusCallout tone={saveStatus === "Error" ? "error" : "warning"} persistent>
        Your local recovery draft remains available.
      </StatusCallout>
    </div>
  ) : null;
  const statusPresentation = recoveryCallout ?? <SaveStatusOutput status={saveStatus} />;

  if (layout === "mobile") {
    return (
      <header className="workspace-header" data-layout={layout}>
        <div className="workspace-title-row">
          {filesToggle}
          <span className="mobile-title">{noteTitle}</span>
          {overflowAction}
        </div>
        <div className="workspace-contextual-row" aria-label="Editor actions">
          {statusPresentation}
          {attachmentAction}
          {publicationAction}
        </div>
      </header>
    );
  }

  return (
    <header className="workspace-header" data-layout={layout} data-compact-tablet={compactTablet ? "true" : "false"}>
      <div className="workspace-header-explorer">
        <span className="brand shell-brand">NXT</span>
        {layout === "tablet" ? filesToggle : (
          <button className="command-action touch-target" type="button" onClick={onOpenCommandPalette}>
            <Command size={18} strokeWidth={1.75} aria-hidden />
            <span>Open commands</span>
          </button>
        )}
      </div>
      {layout === "tablet" ? (
        <nav className="tablet-destinations" aria-label="Tablet destinations">
          {(["editor", "preview", "info"] as const).map((destination) => (
            <button
              className="tablet-destination touch-target"
              type="button"
              aria-label={destination === "editor" ? "Editor" : destination === "preview" ? "Preview" : "Info"}
              aria-pressed={activeDestination === destination}
              onClick={() => onSelectDestination(destination)}
              key={destination}
            >
              {destination === "editor" ? "Editor" : destination === "preview" ? "Preview" : "Info"}
            </button>
          ))}
        </nav>
      ) : (
        <div className="workspace-header-center">
          <ActiveNotePath className="desktop-header-path" path={notePath} />
          {statusPresentation}
        </div>
      )}
      <div className="workspace-header-actions" aria-label="Editor actions">
        {attachmentAction}
        {publicationAction}
        <div className="workspace-header-overflow">{overflowAction}</div>
      </div>
      {layout === "tablet" ? statusPresentation : null}
    </header>
  );
};
