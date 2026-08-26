import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileTree, type ExplorerNode, type FolderExplorerNode, type NoteExplorerNode } from "../explorer/file-tree";

const noteFixture: NoteExplorerNode = {
  kind: "note",
  id: "018f47d2-6a34-7b2a-9f21-8a7034963aef",
  name: "2026 Planı",
  path: "Notes/Plans/2026 Planı.md",
  version: "7",
  attachmentCount: 2
};

const plansFixture: FolderExplorerNode = {
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
  children: [noteFixture]
};

const notesFixture: FolderExplorerNode = {
  kind: "folder",
  id: "notes",
  name: "Notes",
  path: "Notes",
  version: "1",
  protected: true,
  deleteConfirmation: null,
  children: [plansFixture]
};

const treeFixture: readonly ExplorerNode[] = [notesFixture];

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

  it("keeps one composite tab stop and selects folders with Enter and Space", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<>
      <button type="button">Before tree</button>
      <FileTree tree={treeFixture} selectedId={plansFixture.id} onSelect={onSelect} />
      <button type="button">After tree</button>
    </>);

    const notes = screen.getByRole("treeitem", { name: "Notes" });
    screen.getByRole("button", { name: "Before tree" }).focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("treeitem", { name: "Plans" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "After tree" }));

    notes.focus();
    await user.keyboard("{Enter}");
    expect(notes).toHaveAttribute("aria-selected", "true");
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "folder", id: "notes" }));

    const plans = screen.getByRole("treeitem", { name: "Plans" });
    plans.focus();
    await user.keyboard(" ");
    expect(plans).toHaveAttribute("aria-selected", "true");
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "folder", id: "plans" }));

    expect(screen.getByRole("button", { name: "Notes actions" })).toHaveAttribute("tabindex", "-1");
    expect(screen.getAllByRole("treeitem").filter((item) => item.tabIndex === 0)).toHaveLength(1);

    plans.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rename" }));
  });

  it("keeps folder actions outside the owned tree semantics and restores treeitem focus", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    render(<FileTree tree={treeFixture} selectedId={noteFixture.id} onRenameFolder={onRename} />);

    const tree = screen.getByRole("tree", { name: "Files" });
    const plans = within(tree).getByRole("treeitem", { name: "Plans" });
    const actions = screen.getByRole("button", { name: "Plans actions" });
    expect(tree).not.toContainElement(actions);

    plans.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));

    expect(onRename).toHaveBeenCalledWith(expect.objectContaining({ id: "plans" }));
    await waitFor(() => expect(document.activeElement).toBe(plans));
  });

  it("does not move to a sibling when ArrowRight is pressed on an expanded empty folder", async () => {
    const user = userEvent.setup();
    const emptyTree: readonly ExplorerNode[] = [
      { kind: "folder", id: "empty", name: "Empty", path: "Empty", version: "1", protected: false, deleteConfirmation: null, children: [] },
      { kind: "folder", id: "sibling", name: "Sibling", path: "Sibling", version: "1", protected: false, deleteConfirmation: null, children: [] }
    ];
    render(<FileTree tree={emptyTree} />);
    const empty = screen.getByRole("treeitem", { name: "Empty" });
    empty.focus();

    await user.keyboard("{ArrowRight}{ArrowRight}");

    expect(empty).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(empty);
  });

  it("reconciles focus when the focused visible item disappears on a tree update", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<FileTree tree={treeFixture} />);
    const notes = screen.getByRole("treeitem", { name: "Notes" });
    notes.focus();
    await user.keyboard("{ArrowRight}{ArrowDown}{ArrowRight}{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("treeitem", { name: "2026 Planı" }));

    const withoutFocusedNote: readonly ExplorerNode[] = [{
      ...notesFixture,
      children: [{ ...plansFixture, children: [] }]
    }];
    rerender(<FileTree tree={withoutFocusedNote} />);

    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("treeitem", { name: "Notes" })));
    expect(screen.getByRole("treeitem", { name: "Notes" })).toHaveAttribute("tabindex", "0");
  });

  it("shows live projected counts and submits the exact server confirmation", async () => {
    const user = userEvent.setup();
    const onTrashFolder = vi.fn(() => Promise.resolve());
    render(<FileTree tree={treeFixture} onTrashFolder={onTrashFolder} now={() => new Date("2026-08-25T12:04:00.000Z")} />);

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

  it("disables an expired confirmation, explains the refresh requirement, and never calls Trash", async () => {
    const user = userEvent.setup();
    const onTrashFolder = vi.fn(() => Promise.resolve());
    const { rerender } = render(<FileTree
      tree={treeFixture}
      onTrashFolder={onTrashFolder}
      now={() => new Date("2026-08-25T12:05:00.000Z")}
    />);

    const notes = screen.getByRole("treeitem", { name: "Notes" });
    notes.focus();
    await user.keyboard("{ArrowRight}");
    await user.click(screen.getByRole("button", { name: "Plans actions" }));
    const trash = screen.getByRole("menuitem", { name: "Move to Trash" });

    expect(trash).toBeDisabled();
    expect(screen.getByText("Refresh the vault before moving this folder to Trash.")).toBeVisible();
    await user.click(trash);
    expect(onTrashFolder).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Move Plans to Trash" })).not.toBeInTheDocument();

    const refreshedTree: readonly ExplorerNode[] = [{
      ...notesFixture,
      children: [{
        ...plansFixture,
        deleteConfirmation: {
          ...plansFixture.deleteConfirmation!,
          expiresAt: "2026-08-25T12:10:00.000Z",
          confirmationToken: `c1.${"d".repeat(120)}.${"e".repeat(43)}`
        }
      }]
    }];
    rerender(<FileTree
      tree={refreshedTree}
      onTrashFolder={onTrashFolder}
      now={() => new Date("2026-08-25T12:05:00.000Z")}
    />);
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Move to Trash" })).toBeEnabled());
  });

  it("explains the refresh requirement when confirmation expires in an open Trash dialog", async () => {
    vi.useFakeTimers();
    try {
      const onTrashFolder = vi.fn(() => Promise.resolve());
      render(<FileTree
        tree={treeFixture}
        selectedId={noteFixture.id}
        onTrashFolder={onTrashFolder}
        now={() => new Date("2026-08-25T12:04:59.000Z")}
      />);

      fireEvent.click(screen.getByRole("button", { name: "Plans actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Move to Trash" }));

      const dialog = screen.getByRole("dialog", { name: "Move Plans to Trash" });
      expect(within(dialog).queryByText("Refresh the vault before moving this folder to Trash.")).not.toBeInTheDocument();

      await act(() => vi.advanceTimersByTimeAsync(1_000));

      expect(within(dialog).getByRole("button", { name: "Move to Trash" })).toBeDisabled();
      expect(within(dialog).getByText("Refresh the vault before moving this folder to Trash.")).toBeVisible();
      expect(onTrashFolder).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears stale Trash feedback when a fresh confirmation arrives and submits its token", async () => {
    const user = userEvent.setup();
    const now = (): Date => new Date("2026-08-25T12:04:00.000Z");
    const onTrashFolder = vi.fn()
      .mockRejectedValueOnce(new Error("stale confirmation"))
      .mockResolvedValueOnce(undefined);
    const { rerender } = render(<FileTree
      tree={treeFixture}
      selectedId={noteFixture.id}
      onTrashFolder={onTrashFolder}
      now={now}
    />);

    await user.click(screen.getByRole("button", { name: "Plans actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Move to Trash" }));
    const dialog = screen.getByRole("dialog", { name: "Move Plans to Trash" });
    await user.click(within(dialog).getByRole("button", { name: "Move to Trash" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("confirmation is stale");

    rerender(<FileTree
      tree={[{ ...notesFixture, children: [plansFixture] }]}
      selectedId={noteFixture.id}
      onTrashFolder={onTrashFolder}
      now={now}
    />);
    expect(within(dialog).getByRole("alert")).toHaveTextContent("confirmation is stale");

    const refreshedToken = `c1.${"d".repeat(120)}.${"e".repeat(43)}`;
    const refreshedTreeVersion = "b".repeat(64);
    const refreshedTree: readonly ExplorerNode[] = [{
      ...notesFixture,
      children: [{
        ...plansFixture,
        deleteConfirmation: {
          ...plansFixture.deleteConfirmation!,
          treeVersion: refreshedTreeVersion,
          expiresAt: "2026-08-25T12:10:00.000Z",
          confirmationToken: refreshedToken
        }
      }]
    }];
    rerender(<FileTree
      tree={refreshedTree}
      selectedId={noteFixture.id}
      onTrashFolder={onTrashFolder}
      now={now}
    />);

    await waitFor(() => {
      expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Move to Trash" })).toBeEnabled();
    });
    await user.click(within(dialog).getByRole("button", { name: "Move to Trash" }));

    await waitFor(() => expect(onTrashFolder).toHaveBeenCalledTimes(2));
    expect(onTrashFolder).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "plans" }),
      {
        expectedTreeVersion: refreshedTreeVersion,
        confirmationToken: refreshedToken
      }
    );
  });
});
