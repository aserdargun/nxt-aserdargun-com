import * as Dialog from "@radix-ui/react-dialog";
import { Archive, FolderInput, MoreVertical, Pencil, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DeleteFolderRequest } from "@nxt/contracts";
import type { FolderExplorerNode } from "./file-tree";

export interface FolderActionsProps {
  readonly folder: FolderExplorerNode;
  readonly onRename?: ((folder: FolderExplorerNode) => void) | undefined;
  readonly onMove?: ((folder: FolderExplorerNode) => void) | undefined;
  readonly onArchive?: ((folder: FolderExplorerNode) => void) | undefined;
  readonly onTrash?: ((folder: FolderExplorerNode, input: DeleteFolderRequest) => Promise<void>) | undefined;
  readonly now?: (() => Date) | undefined;
  readonly menuOpen?: boolean | undefined;
  readonly onMenuOpenChange?: ((open: boolean) => void) | undefined;
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

const systemNow = (): Date => new Date();

export const FolderActions = ({
  folder,
  onRename,
  onMove,
  onArchive,
  onTrash,
  now = systemNow,
  menuOpen: controlledMenuOpen,
  onMenuOpenChange
}: FolderActionsProps): React.JSX.Element => {
  const [localMenuOpen, setLocalMenuOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmationStale, setConfirmationStale] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const menuOpen = controlledMenuOpen ?? localMenuOpen;
  const confirmation = folder.deleteConfirmation;
  const expiration = confirmation === null ? Number.NaN : Date.parse(confirmation.expiresAt);
  const confirmationUnavailable = confirmation === null || confirmationStale || !Number.isFinite(expiration) || expiration <= now().getTime();
  const counts = projectedCounts(folder);

  const setMenuOpen = (open: boolean): void => {
    setLocalMenuOpen(open);
    onMenuOpenChange?.(open);
  };

  useEffect(() => {
    setConfirmationStale(false);
    if (confirmation === null) return;
    const delay = Date.parse(confirmation.expiresAt) - now().getTime();
    if (!Number.isFinite(delay) || delay <= 0) {
      setConfirmationStale(true);
      return;
    }
    const timer = window.setTimeout(() => setConfirmationStale(true), Math.min(delay, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [confirmation?.confirmationToken, confirmation?.expiresAt, now]);

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
      <div className="folder-actions">
        <button
          className="folder-actions-trigger touch-target"
          type="button"
          tabIndex={-1}
          aria-label={`${folder.name} actions`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <MoreVertical size={16} strokeWidth={1.75} aria-hidden />
        </button>
        {menuOpen ? (
          <div ref={menu} className="folder-menu" role="menu" aria-label={`${folder.name} actions`}>
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
                    disabled={confirmationUnavailable || onTrash === undefined}
                    aria-describedby={confirmationUnavailable ? `${folder.id}-trash-reason` : undefined}
                    onClick={() => setMenuOpen(false)}
                  >
                    <Trash2 size={15} aria-hidden /> Move to Trash
                  </button>
                </Dialog.Trigger>
                {confirmationUnavailable ? <p id={`${folder.id}-trash-reason`} className="folder-menu-reason">Refresh the vault before moving this folder to Trash.</p> : null}
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
          {confirmationUnavailable ? (
            <p id={`${folder.id}-dialog-trash-reason`} className="folder-menu-reason">
              Refresh the vault before moving this folder to Trash.
            </p>
          ) : null}
          {error === null ? null : <p className="explorer-dialog-error" role="alert">{error}</p>}
          <div className="explorer-dialog-actions">
            <Dialog.Close className="secondary-action touch-target" disabled={busy}>Cancel</Dialog.Close>
            <button
              className="danger-action touch-target"
              type="button"
              disabled={busy || confirmationUnavailable || onTrash === undefined}
              aria-describedby={confirmationUnavailable ? `${folder.id}-dialog-trash-reason` : undefined}
              onClick={() => {
                if (
                  confirmation === null || onTrash === undefined ||
                  !Number.isFinite(Date.parse(confirmation.expiresAt)) ||
                  Date.parse(confirmation.expiresAt) <= now().getTime()
                ) {
                  setConfirmationStale(true);
                  setError("The confirmation expired. Refresh the vault and try again.");
                  return;
                }
                setBusy(true);
                setError(null);
                void onTrash(folder, {
                  expectedTreeVersion: confirmation.treeVersion,
                  confirmationToken: confirmation.confirmationToken
                }).then(() => setTrashOpen(false)).catch(() => {
                  setConfirmationStale(true);
                  setError("The confirmation is stale. Refresh the vault and try again.");
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
