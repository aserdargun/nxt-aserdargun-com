import { EditorView } from "@uiw/react-codemirror";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
  localBaseVersion: "7",
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
    expect(screen.getByRole("textbox", { name: "Local draft" })).toHaveTextContent("# Local");
    expect(screen.getByRole("region", { name: "Drive version" })).toHaveTextContent("# Drive");
  });

  it("shows changed-line markers, an exact accessible summary, and truthful timestamps", () => {
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

    const dialog = screen.getByRole("dialog", { name: "Version conflict" });
    const summary = within(dialog).getByText("1 added line, 1 removed line.");
    expect(summary).toBeVisible();
    expect(within(dialog).getByRole("textbox", { name: "Local draft" })).toHaveAttribute("aria-describedby", summary.id);
    expect(within(dialog).getByRole("textbox", { name: "Drive version source" })).toHaveAttribute("aria-describedby", summary.id);
    expect(dialog.getAttribute("aria-describedby")?.split(/\s+/u)).toContain(summary.id);
    expect(dialog.querySelector('.local-pane .cm-gutterElement [data-diff-marker="removal"]')).toHaveTextContent("−");
    expect(dialog.querySelector('.drive-pane .cm-gutterElement [data-diff-marker="addition"]')).toHaveTextContent("+");
    expect(dialog.querySelector('.local-pane .cm-line[data-diff-state="removal"]')).not.toBeNull();
    expect(dialog.querySelector('.drive-pane .cm-line[data-diff-state="addition"]')).not.toBeNull();

    const localTime = within(dialog).getByText("Local draft updated", { exact: false }).querySelector("time");
    const metadataTime = within(dialog).getByText("Drive note updated", { exact: false }).querySelector("time");
    expect(localTime).toHaveAttribute("datetime", fixtureConflict.localUpdatedAt);
    expect(metadataTime).toHaveAttribute("datetime", fixtureConflict.drive.note.frontmatter.updated);
    expect(dialog.querySelectorAll("time")).toHaveLength(2);
    expect(dialog).not.toHaveTextContent(/Drive (?:storage )?modified/iu);
  });

  it("places CRLF diff decorations and markers on the exact changed logical line", () => {
    render(
      <ConflictDialog
        conflict={{
          ...fixtureConflict,
          localSource: "same\r\nlocal only\r\nend",
          drive: {
            ...fixtureConflict.drive,
            source: "same\r\ndrive only\r\nend"
          }
        }}
        open
        busy={false}
        onOpenChange={vi.fn()}
        onMergeSourceChange={vi.fn()}
        onResolve={vi.fn()}
      />
    );

    const dialog = screen.getByRole("dialog", { name: "Version conflict" });
    const localChangedLines = dialog.querySelectorAll('.local-pane .cm-line[data-diff-state="removal"]');
    const driveChangedLines = dialog.querySelectorAll('.drive-pane .cm-line[data-diff-state="addition"]');
    expect(localChangedLines).toHaveLength(1);
    expect(localChangedLines[0]).toHaveTextContent("local only");
    expect(driveChangedLines).toHaveLength(1);
    expect(driveChangedLines[0]).toHaveTextContent("drive only");
    expect(dialog.querySelectorAll('.local-pane [data-diff-marker="removal"]')).toHaveLength(1);
    expect(dialog.querySelectorAll('.drive-pane [data-diff-marker="addition"]')).toHaveLength(1);
    expect(within(dialog).getByText("1 added line, 1 removed line.")).toBeVisible();
  });

  it("submits the editable merge source and keeps every choice explicit", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn<(resolution: ConflictResolution) => void>();
    const onMergeSourceChange = vi.fn();
    const Harness = (): React.JSX.Element => {
      const [localSource, setLocalSource] = useState(fixtureConflict.localSource);
      return (
        <ConflictDialog
          conflict={{ ...fixtureConflict, localSource }}
          open
          busy={false}
          onOpenChange={vi.fn()}
          onMergeSourceChange={(source) => {
            onMergeSourceChange(source);
            setLocalSource(source);
          }}
          onResolve={onResolve}
        />
      );
    };
    render(<Harness />);

    const localSource = screen.getByRole("textbox", { name: "Local draft" });
    const localView = EditorView.findFromDOM(localSource);
    if (localView === null) throw new Error("Local conflict editor is unavailable.");
    expect(localView.state.readOnly).toBe(false);
    act(() => {
      localView.dispatch({ changes: { from: 0, to: localView.state.doc.length, insert: "merged" } });
    });
    expect(onMergeSourceChange).toHaveBeenLastCalledWith("merged");
    const driveSource = screen.getByRole("textbox", { name: "Drive version source" });
    const driveView = EditorView.findFromDOM(driveSource);
    if (driveView === null) throw new Error("Drive conflict editor is unavailable.");
    expect(driveView.state.readOnly).toBe(true);
    expect(driveSource).toHaveAttribute("aria-readonly", "true");
    expect(driveSource).toHaveAttribute("contenteditable", "false");
    expect(driveSource).toHaveAttribute("tabindex", "0");
    await user.click(screen.getByRole("button", { name: "Keep Drive version" }));
    await user.click(screen.getByRole("button", { name: "Save local as a new note" }));
    await user.click(screen.getByRole("button", { name: "Merge versions" }));

    expect(onResolve).toHaveBeenNthCalledWith(1, "keep-drive");
    expect(onResolve).toHaveBeenNthCalledWith(2, "save-new");
    expect(onResolve).toHaveBeenNthCalledWith(3, "merge");
  });

  it("starts mobile recovery at the title and lets users jump to either pane heading", async () => {
    const user = userEvent.setup();
    render(
      <ConflictDialog
        conflict={fixtureConflict}
        open
        busy={false}
        mobile
        onOpenChange={vi.fn()}
        onMergeSourceChange={vi.fn()}
        onResolve={vi.fn()}
      />
    );

    const dialog = screen.getByRole("dialog", { name: "Version conflict" });
    expect(within(dialog).getByRole("heading", { name: "Version conflict" })).toHaveFocus();
    const navigation = within(dialog).getByRole("navigation", { name: "Conflict sections" });
    const localHeading = within(dialog).getByRole("heading", { name: "Local draft" });
    const driveHeading = within(dialog).getByRole("heading", { name: "Drive version" });

    await user.click(within(navigation).getByRole("button", { name: "Local draft" }));
    expect(localHeading).toHaveFocus();
    await user.click(within(navigation).getByRole("button", { name: "Drive version" }));
    expect(driveHeading).toHaveFocus();

    const footer = dialog.querySelector(".conflict-actions");
    expect(footer).not.toBeNull();
    for (const name of ["Keep Drive version", "Save local as a new note", "Merge versions"]) {
      expect(within(footer as HTMLElement).getByRole("button", { name })).toBeVisible();
    }
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
