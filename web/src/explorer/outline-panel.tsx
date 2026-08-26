import { deriveMarkdownOutline } from "@nxt/domain";

export interface OutlineHeading {
  readonly id: string;
  readonly level: number;
  readonly label: string;
}

export const deriveOutline = (source: string): readonly OutlineHeading[] =>
  deriveMarkdownOutline(source).map(({ id, depth, text }) => ({ id, level: depth, label: text }));

export const OutlinePanel = ({ source, onNavigate }: { readonly source: string; readonly onNavigate?: (heading: OutlineHeading) => void }): React.JSX.Element => {
  const headings = deriveOutline(source);
  return (
    <nav className="outline-panel" aria-label="Outline">
      <h2>Outline</h2>
      {headings.map((heading) => (
        <button
          className="outline-link touch-target"
          style={{ "--outline-level": heading.level } as React.CSSProperties}
          type="button"
          key={heading.id}
          onClick={() => onNavigate?.(heading)}
        >
          {heading.label}
        </button>
      ))}
    </nav>
  );
};
