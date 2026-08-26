import * as Dialog from "@radix-ui/react-dialog";
import { Archive, FolderInput, MoreVertical, Pencil, Trash2, X } from "lucide-react";
import { useState } from "react";
import type { DeleteFolderRequest } from "@nxt/contracts";
import type { FolderExplorerNode } from "./file-tree";

export interface FolderActionsProps {
  readonly folder: FolderExplorerNode;
  readonly onRename?: ((folder: FolderExplorerNode) => void) | undefined;
  readonly onMove?: ((folder: FolderExplorerNode) => void) | undefined;
  readonly onArchive?: ((folder: FolderExplorerNode) => void) | undefined;
  readonly onTrash?: ((folder: FolderExplorerNode, input: DeleteFolderRequest) => Promise<void>) | undefined;
}

const projectedCounts = (folder: FolderExplorerNode): { readonly notes: number; readonly attachments: number } => {
  let notes = 0;
  let attachments = 0;
  const visit = (node: FolderExplorerNode["children"][number]): void => {
    if (node.kind === "note") {
      notes += 1;
      attachments += node.attachmentCount;
      return;
    }
    node.children.forEach(visit);
  };
  folder.children.forEach(visit);
  return { notes, attachments };
};

export const FolderActions = ({
  folder,
  onRename,
  onMove,
  onArchive,
  onTrash
}: FolderActionsProps): React.JSX.Element => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmation = folder.deleteConfirmation;
  const counts = projectedCounts(folder);

  const run = (action: (() => void) | undefined): void => {
    setMenuOpen(false);
    action?.();
  };

  return (
    <Dialog.Root open={trashOpen} onOpenChange={(open) => !busy && setTrashOpen(open)}>
      <div className="folder-actions">
        <button
          className="folder-actions-trigger touch-target"
          type="button"
          aria-label={`${folder.name} actions`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <MoreVertical size={16} strokeWidth={1.75} aria-hidden />
        </button>
        {menuOpen ? (
          <div className="folder-menu" role="menu" aria-label={`${folder.name} actions`}>
            {folder.protected ? (
              <p className="folder-menu-reason">Protected folders cannot be changed.</p>
            ) : (
              <>
                <button type="button" role="menuitem" onClick={() => run(onRename === undefined ? undefined : () => onRename(folder))}>
                  <Pencil size={15} aria-hidden /> Rename
                </button>
                <button type="button" role="menuitem" onClick={() => run(onMove === undefined ? undefined : () => onMove(folder))}>
                  <FolderInput size={15} aria-hidden /> Move
                </button>
                <button type="button" role="menuitem" onClick={() => run(onArchive === undefined ? undefined : () => onArchive(folder))}>
                  <Archive size={15} aria-hidden /> Archive
                </button>
                <Dialog.Trigger asChild>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={confirmation === null || onTrash === undefined}
                    aria-describedby={confirmation === null ? `${folder.id}-trash-reason` : undefined}
                    onClick={() => setMenuOpen(false)}
                  >
                    <Trash2 size={15} aria-hidden /> Move to Trash
                  </button>
                </Dialog.Trigger>
                {confirmation === null ? <p id={`${folder.id}-trash-reason`} className="folder-menu-reason">Refresh the vault before moving this folder to Trash.</p> : null}
              </>
            )}
          </div>
        ) : null}
      </div>

      <Dialog.Portal>
        <Dialog.Overlay className="explorer-dialog-overlay" />
        <Dialog.Content className="explorer-dialog" aria-describedby={`${folder.id}-trash-description`}>
          <div className="explorer-dialog-header">
            <Dialog.Title>Move {folder.name} to Trash</Dialog.Title>
            <Dialog.Close className="touch-target" aria-label="Close" disabled={busy}>
              <X size={18} aria-hidden />
            </Dialog.Close>
          </div>
          <Dialog.Description id={`${folder.id}-trash-description`}>
            The complete vault currently contains:
          </Dialog.Description>
          <ul className="folder-trash-counts">
            <li>{counts.notes} {counts.notes === 1 ? "note" : "notes"}</li>
            <li>{counts.attachments} {counts.attachments === 1 ? "attachment" : "attachments"}</li>
            <li>{confirmation?.descendantCount ?? 0} descendants reported by Drive</li>
          </ul>
          {error === null ? null : <p className="explorer-dialog-error" role="alert">{error}</p>}
          <div className="explorer-dialog-actions">
            <Dialog.Close className="secondary-action touch-target" disabled={busy}>Cancel</Dialog.Close>
            <button
              className="danger-action touch-target"
              type="button"
              disabled={busy || confirmation === null || onTrash === undefined}
              onClick={() => {
                if (confirmation === null || onTrash === undefined) return;
                setBusy(true);
                setError(null);
                void onTrash(folder, {
                  expectedTreeVersion: confirmation.treeVersion,
                  confirmationToken: confirmation.confirmationToken
                }).then(() => setTrashOpen(false)).catch(() => setError("The folder could not be moved to Trash.")).finally(() => setBusy(false));
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
