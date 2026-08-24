import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConflictDialog,
  type ConflictResolution,
  type EditorConflict
} from "../editor/conflict-dialog";

const fixtureConflict: EditorConflict = {
  noteId: "018f47d2-6a34-7b2a-9f21-8a7034963aef",
  title: "Plan",
  localSource: "# Local",
  localUpdatedAt: "2026-08-23T09:12:00.000Z",
  drive: {
    note: {
      frontmatter: {
        id: "018f47d2-6a34-7b2a-9f21-8a7034963aef",
        title: "Plan",
        created: "2026-08-23T09:00:00.000Z",
        updated: "2026-08-23T09:03:00.000Z",
        tags: [],
        aliases: []
      },
      body: "# Drive"
    },
    source: "# Drive",
    version: "8",
    path: "Notes/Plan.md",
    checksum: "0".repeat(64)
  }
};

afterEach(() => {
  cleanup();
  document.body.style.pointerEvents = "";
});

describe("version conflict dialog", () => {
  it("offers all conflict outcomes without a destructive default", () => {
    render(
      <ConflictDialog
        conflict={fixtureConflict}
        open
        busy={false}
        onOpenChange={vi.fn()}
        onMergeSourceChange={vi.fn()}
        onResolve={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Keep Drive version" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Save local as a new note" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Merge versions" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /overwrite/iu })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Version conflict" })).toBeVisible();
    expect(screen.getByText("This note changed in Drive while you were editing.")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Local draft" })).toHaveValue("# Local");
    expect(screen.getByRole("region", { name: "Drive version" })).toHaveTextContent("# Drive");
  });

  it("submits the editable merge source and keeps every choice explicit", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn<(resolution: ConflictResolution) => void>();
    const onMergeSourceChange = vi.fn();
    render(
      <ConflictDialog
        conflict={fixtureConflict}
        open
        busy={false}
        onOpenChange={vi.fn()}
        onMergeSourceChange={onMergeSourceChange}
        onResolve={onResolve}
      />
    );

    await user.clear(screen.getByRole("textbox", { name: "Local draft" }));
    await user.type(screen.getByRole("textbox", { name: "Local draft" }), "merged");
    expect(onMergeSourceChange).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Keep Drive version" }));
    await user.click(screen.getByRole("button", { name: "Save local as a new note" }));
    await user.click(screen.getByRole("button", { name: "Merge versions" }));

    expect(onResolve).toHaveBeenNthCalledWith(1, "keep-drive");
    expect(onResolve).toHaveBeenNthCalledWith(2, "save-new");
    expect(onResolve).toHaveBeenNthCalledWith(3, "merge");
  });

  it("traps focus in Radix content and restores it to the opener", async () => {
    const user = userEvent.setup();
    const Harness = (): React.JSX.Element => {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open conflict</button>
          <ConflictDialog
            conflict={fixtureConflict}
            open={open}
            busy={false}
            onOpenChange={setOpen}
            onMergeSourceChange={vi.fn()}
            onResolve={vi.fn()}
          />
        </>
      );
    };
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open conflict" });

    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Version conflict" });
    expect(within(dialog).getByRole("button", { name: "Merge versions" })).toHaveFocus();
    await user.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(opener).toHaveFocus());
  });
});
