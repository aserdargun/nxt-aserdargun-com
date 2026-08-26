export interface TagSummary {
  readonly tag: string;
  readonly count: number;
}

export const TagsPanel = ({ tags, onSelect }: { readonly tags: readonly TagSummary[]; readonly onSelect: (tag: string) => void }): React.JSX.Element => (
  <section className="explorer-section" aria-labelledby="tags-heading">
    <h2 id="tags-heading">Tags</h2>
    {tags.map(({ tag, count }) => (
      <button className="tree-row touch-target" type="button" key={tag} onClick={() => onSelect(tag)}>
        <span>{tag}</span><small>{count}</small>
      </button>
    ))}
  </section>
);
