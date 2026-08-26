import type { WikiTargetResolution } from "@nxt/domain";

export interface KnowledgeLink {
  readonly key: string;
  readonly label: string;
  readonly resolution: WikiTargetResolution;
}

const stateLabel = (resolution: WikiTargetResolution): string =>
  resolution.kind === "unresolved" ? "Unresolved" : resolution.kind === "ambiguous" ? "Ambiguous" : "Resolved";

const KnowledgeLinkRow = ({ link, onNavigate }: { readonly link: KnowledgeLink; readonly onNavigate: (noteId: string) => void }): React.JSX.Element => {
  const resolution = link.resolution;
  return resolution.kind === "resolved" ? (
    <button
      className="knowledge-link touch-target"
      type="button"
      data-state="resolved"
      aria-label={`${link.label}, Resolved`}
      onClick={() => onNavigate(resolution.noteId)}
    >
      <span>{link.label}</span><small>Resolved</small>
    </button>
  ) : (
    <span
      className="knowledge-link knowledge-link-inert touch-target"
      data-state={resolution.kind}
      aria-disabled="true"
      aria-label={`${link.label}, ${stateLabel(resolution)}`}
    >
      <span>{link.label}</span><small>{stateLabel(resolution)}</small>
    </span>
  );
};

export const BacklinksPanel = ({
  backlinks,
  wikiLinks,
  onNavigate
}: {
  readonly backlinks: readonly KnowledgeLink[];
  readonly wikiLinks: readonly KnowledgeLink[];
  readonly onNavigate: (noteId: string) => void;
}): React.JSX.Element => (
  <div className="knowledge-panel">
    <section aria-labelledby="backlinks-panel-heading">
      <h2 id="backlinks-panel-heading">Backlinks</h2>
      {[...backlinks, ...wikiLinks].map((link) => <KnowledgeLinkRow key={link.key} link={link} onNavigate={onNavigate} />)}
    </section>
  </div>
);
