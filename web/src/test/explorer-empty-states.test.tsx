import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BacklinksPanel } from "../explorer/backlinks-panel";
import { FavoritesPanel } from "../explorer/favorites-panel";
import { OutlinePanel } from "../explorer/outline-panel";
import { TagsPanel } from "../explorer/tags-panel";

describe("explorer empty states", () => {
  it("explains every empty explorer and note-context section", () => {
    render(
      <>
        <FavoritesPanel items={[]} onOpen={vi.fn()} />
        <TagsPanel tags={[]} onSelect={vi.fn()} />
        <OutlinePanel source="Plain text without headings" />
        <BacklinksPanel backlinks={[]} wikiLinks={[]} onNavigate={vi.fn()} />
      </>
    );

    expect(screen.getByText("No favorites yet")).toBeVisible();
    expect(screen.getByText("No tags yet")).toBeVisible();
    expect(screen.getByText("No headings in this note")).toBeVisible();
    expect(screen.getByText("No links to show")).toBeVisible();
  });
});
