import * as Dialog from "@radix-ui/react-dialog";
import { Archive, FolderInput, MoreVertical, Pencil, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ArchiveNoteRequest } from "@nxt/contracts";
import type { NoteExplorerNode } from "./file-tree";

export interface NoteActionsProps {
  readonly note: NoteExplorerNode;
  readonly onRename?: ((note: NoteExplorerNode) => void) | undefined;
  readonly onMove?: ((note: NoteExplorerNode) => void) | undefined;
  readonly onArchive?: ((note: NoteExplorerNode) => void) | undefined;
  readonly onTrash?: ((note: NoteExplorerNode, input: ArchiveNoteRequest) => Promise<void>) | undefined;
  readonly menuOpen?: boolean | undefined;
  readonly onMenuOpenChange?: ((open: boolean) => void) | undefined;
}

export const NoteActions = ({
  note,
  onRename,
  onMove,
  onArchive,
  onTrash,
  menuOpen: controlledMenuOpen,
  onMenuOpenChange
}: NoteActionsProps): React.JSX.Element => {
  const [localMenuOpen, setLocalMenuOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuOpen = controlledMenuOpen ?? localMenuOpen;

  const setMenuOpen = (open: boolean): void => {
    setLocalMenuOpen(open);
    onMenuOpenChange?.(open);
  };

  useEffect(() => {
    if (!menuOpen) return;
    menu.current?.querySelector<HTMLElement>("[role='menuitem']:not(:disabled)")?.focus();
  }, [menuOpen]);

  const run = (action: (() => void) | undefined): void => {
    setMenuOpen(false);
    action?.();
  };

  return (
    <Dialog.Root open={trashOpen} onOpenChange={(open) => !busy && setTrashOpen(open)}>
      <div className="note-actions">
        <button
          className="note-actions-trigger touch-target"
          type="button"
          tabIndex={-1}
          aria-label={`${note.name} actions`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <MoreVertical size={16} strokeWidth={1.75} aria-hidden />
        </button>
        {menuOpen ? (
          <div ref={menu} className="note-menu" role="menu" aria-label={`${note.name} actions`}>
            <button type="button" role="menuitem" onClick={() => run(onRename === undefined ? undefined : () => onRename(note))}>
              <Pencil size={15} aria-hidden /> Rename
            </button>
            <button type="button" role="menuitem" onClick={() => run(onMove === undefined ? undefined : () => onMove(note))}>
              <FolderInput size={15} aria-hidden /> Move
            </button>
            <button type="button" role="menuitem" onClick={() => run(onArchive === undefined ? undefined : () => onArchive(note))}>
              <Archive size={15} aria-hidden /> Archive
            </button>
            <Dialog.Trigger asChild>
              <button
                type="button"
                role="menuitem"
                disabled={onTrash === undefined}
                onClick={() => setMenuOpen(false)}
              >
                <Trash2 size={15} aria-hidden /> Move to Trash
              </button>
            </Dialog.Trigger>
          </div>
        ) : null}
      </div>

      <Dialog.Portal>
        <Dialog.Overlay className="explorer-dialog-overlay" />
        <Dialog.Content className="explorer-dialog" aria-describedby={`${note.id}-trash-description`}>
          <div className="explorer-dialog-header">
            <Dialog.Title>Move {note.name} to Trash</Dialog.Title>
            <Dialog.Close className="touch-target" aria-label="Close" disabled={busy}>
              <X size={18} aria-hidden />
            </Dialog.Close>
          </div>
          <Dialog.Description id={`${note.id}-trash-description`}>
            The note will be removed from your vault and can be restored from Trash within the grace period.
          </Dialog.Description>
          {error === null ? null : <p className="explorer-dialog-error" role="alert">{error}</p>}
          <div className="explorer-dialog-actions">
            <Dialog.Close className="secondary-action touch-target" disabled={busy}>Cancel</Dialog.Close>
            <button
              className="danger-action touch-target"
              type="button"
              disabled={busy || onTrash === undefined}
              onClick={() => {
                if (onTrash === undefined) return;
                setBusy(true);
                setError(null);
                void onTrash(note, { expectedVersion: note.version }).then(() => setTrashOpen(false)).catch(() => {
                  setError("The note could not be moved to Trash. Refresh the vault and try again.");
                }).finally(() => setBusy(false));
              }}
            >
              Move to Trash
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
