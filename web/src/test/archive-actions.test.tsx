import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FolderActions } from "../explorer/folder-actions";
import { NoteActions } from "../explorer/note-actions";
import type { FolderExplorerNode, NoteExplorerNode } from "../explorer/file-tree";

const note: NoteExplorerNode = { kind: "note", id: "note", name: "Plan", path: "Notes/Plan.md", version: "1", attachmentCount: 0 };
const folder: FolderExplorerNode = { kind: "folder", id: "folder", name: "Plans", path: "Notes/Plans", version: "1", protected: false, children: [], deleteConfirmation: null };

afterEach(cleanup);

for (const kind of ["note", "folder"] as const) {
  const mount = (onArchive?: () => void | Promise<void>): void => {
    if (kind === "note") render(<NoteActions note={note} onArchive={onArchive} />);
    else render(<FolderActions folder={folder} onArchive={onArchive} />);
    fireEvent.click(screen.getByRole("button", { name: `${kind === "note" ? "Plan" : "Plans"} actions` }));
  };

  describe(`${kind} archive feedback`, () => {
    it("reports a rejected archive and permits retry", async () => {
      const onArchive = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
      mount(onArchive);
      fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(`The ${kind} could not be archived.`);
      await waitFor(() => expect(screen.getByRole("menuitem", { name: "Archive" })).toBeEnabled());
      fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
      await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(onArchive).toHaveBeenCalledTimes(2);
    });

    it("blocks duplicate archive requests until the first finishes", async () => {
      let finish!: () => void;
      const onArchive = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
      mount(onArchive);
      const archive = screen.getByRole("menuitem", { name: "Archive" });
      fireEvent.click(archive);
      fireEvent.click(archive);
      await waitFor(() => expect(onArchive).toHaveBeenCalledOnce());
      expect(screen.getByRole("menuitem", { name: "Archiving…" })).toBeDisabled();
      finish();
      await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    });

    it("disables unavailable menu actions", () => {
      mount();
      for (const name of ["Archive", "Rename", "Move", "Move to Trash"]) {
        expect(screen.getByRole("menuitem", { name })).toBeDisabled();
      }
    });
  });
}
