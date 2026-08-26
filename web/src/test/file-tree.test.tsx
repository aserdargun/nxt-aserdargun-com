import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileTree, type ExplorerNode } from "../explorer/file-tree";

const treeFixture: readonly ExplorerNode[] = [
  {
    kind: "folder",
    id: "notes",
    name: "Notes",
    path: "Notes",
    version: "1",
    protected: true,
    deleteConfirmation: null,
    children: [
      {
        kind: "folder",
        id: "plans",
        name: "Plans",
        path: "Notes/Plans",
        version: "2",
        protected: false,
        deleteConfirmation: {
          descendantCount: 3,
          treeVersion: "a".repeat(64),
          expiresAt: "2026-08-25T12:05:00.000Z",
          confirmationToken: `c1.${"b".repeat(120)}.${"c".repeat(43)}`
        },
        children: [
          {
            kind: "note",
            id: "018f47d2-6a34-7b2a-9f21-8a7034963aef",
            name: "2026 Planı",
            path: "Notes/Plans/2026 Planı.md",
            version: "7",
            attachmentCount: 2
          }
        ]
      }
    ]
  }
];

afterEach(cleanup);

describe("accessible file tree", () => {
  it("reveals the selected deep note and expands its ancestor folders", () => {
    render(<FileTree tree={treeFixture} selectedId="018f47d2-6a34-7b2a-9f21-8a7034963aef" />);

    expect(screen.getByRole("treeitem", { name: "Notes" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("treeitem", { name: "Plans" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("treeitem", { name: "2026 Planı" })).toHaveAttribute("aria-selected", "true");
  });

  it("does not allow protected folder deletion", async () => {
    const user = userEvent.setup();
    render(<FileTree tree={treeFixture} />);

    await user.click(screen.getByRole("button", { name: "Notes actions" }));

    expect(screen.queryByRole("menuitem", { name: "Move to Trash" })).not.toBeInTheDocument();
    expect(screen.getByText("Protected folders cannot be changed.")).toBeVisible();
  });

  it("implements roving tree keyboard navigation and selection", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<FileTree tree={treeFixture} onSelect={onSelect} />);

    const tree = screen.getByRole("tree", { name: "Files" });
    const notes = within(tree).getByRole("treeitem", { name: "Notes" });
    notes.focus();
    await user.keyboard("{ArrowRight}{ArrowDown}{ArrowRight}{ArrowDown}{Enter}");

    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "note", name: "2026 Planı" }));
    expect(document.activeElement).toBe(within(tree).getByRole("treeitem", { name: "2026 Planı" }));
    expect(within(tree).getAllByRole("treeitem").filter((item) => item.tabIndex === 0)).toHaveLength(1);
  });

  it("shows live projected counts and submits the exact server confirmation", async () => {
    const user = userEvent.setup();
    const onTrashFolder = vi.fn(() => Promise.resolve());
    render(<FileTree tree={treeFixture} onTrashFolder={onTrashFolder} />);

    await user.click(screen.getByRole("treeitem", { name: "Notes" }));
    screen.getByRole("treeitem", { name: "Notes" }).focus();
    await user.keyboard("{ArrowRight}");
    await user.click(screen.getByRole("button", { name: "Plans actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Move to Trash" }));

    const dialog = screen.getByRole("dialog", { name: "Move Plans to Trash" });
    expect(within(dialog).getByText("1 note")).toBeVisible();
    expect(within(dialog).getByText("2 attachments")).toBeVisible();
    expect(within(dialog).getByText("3 descendants reported by Drive")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Move to Trash" }));

    expect(onTrashFolder).toHaveBeenCalledWith(
      expect.objectContaining({ id: "plans" }),
      {
        expectedTreeVersion: "a".repeat(64),
        confirmationToken: `c1.${"b".repeat(120)}.${"c".repeat(43)}`
      }
    );
  });
});
