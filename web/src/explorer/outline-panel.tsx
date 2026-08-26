export interface OutlineHeading {
  readonly id: string;
  readonly level: number;
  readonly label: string;
  readonly line: number;
}

const headingId = (label: string, index: number): string =>
  `${label.normalize("NFKD").toLocaleLowerCase("tr-TR").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/gu, "") || "section"}-${index}`;

export const deriveOutline = (source: string): readonly OutlineHeading[] => {
  const headings: OutlineHeading[] = [];
  let fence: { marker: string; length: number } | null = null;
  source.split(/\r?\n/u).forEach((line, index) => {
    if (fence !== null) {
      const close = /^ {0,3}(`{3,}|~{3,})[\t ]*$/u.exec(line)?.[1];
      if (close?.[0] === fence.marker && close.length >= fence.length) fence = null;
      return;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (opening !== undefined) {
      fence = { marker: opening[0]!, length: opening.length };
      return;
    }
    const match = /^(#{1,6})[\t ]+(.+?)[\t ]*#*[\t ]*$/u.exec(line);
    if (match === null) return;
    const label = match[2]?.trim() ?? "";
    if (label.length === 0) return;
    headings.push({ id: headingId(label, headings.length + 1), level: match[1]!.length, label, line: index + 1 });
  });
  return headings;
};

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
          key={`${heading.id}:${heading.line}`}
          onClick={() => onNavigate?.(heading)}
        >
          {heading.label}
        </button>
      ))}
    </nav>
  );
};
