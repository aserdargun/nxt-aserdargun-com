import { Bookmark } from "lucide-react";

export interface FavoriteItem {
  readonly id: string;
  readonly title: string;
}

export const FavoritesPanel = ({ items, onOpen }: { readonly items: readonly FavoriteItem[]; readonly onOpen: (noteId: string) => void }): React.JSX.Element => (
  <section className="explorer-section" aria-labelledby="favorites-heading">
    <h2 id="favorites-heading">Favorites</h2>
    {items.length === 0 ? <p className="empty-info">No favorites yet</p> : null}
    {items.map((item) => (
      <button className="tree-row touch-target" type="button" key={item.id} onClick={() => onOpen(item.id)}>
        <Bookmark size={17} strokeWidth={1.75} aria-hidden /><span>{item.title}</span>
      </button>
    ))}
  </section>
);
