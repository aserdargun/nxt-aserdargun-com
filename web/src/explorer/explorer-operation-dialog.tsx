import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import type { CompleteVault } from "../api/vault";

export type ExplorerOperationKind = "new-note" | "new-folder" | "rename" | "move";

export interface ExplorerOperation {
  readonly kind: ExplorerOperationKind;
  readonly selectionKind: "note" | "folder";
  readonly initialName: string;
  readonly initialFolderId: string;
}

export interface ExplorerOperationValue {
  readonly name: string;
  readonly folderId: string;
}

const titleFor = (operation: ExplorerOperation): string => {
  if (operation.kind === "new-note") return "New note";
  if (operation.kind === "new-folder") return "New folder";
  if (operation.kind === "move") return operation.selectionKind === "note" ? "Move note" : "Move folder";
  return operation.selectionKind === "note" ? "Rename note" : "Rename folder";
};

const submitLabelFor = (operation: ExplorerOperation): string =>
  operation.kind === "move" ? "Move" : operation.kind === "rename" ? "Rename" : "Create";

export const ExplorerOperationDialog = ({
  operation,
  folders,
  busy,
  error,
  onCancel,
  onSubmit
}: {
  readonly operation: ExplorerOperation;
  readonly folders: CompleteVault["folders"];
  readonly busy: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onSubmit: (value: ExplorerOperationValue) => void;
}): React.JSX.Element => {
  const [name, setName] = useState(operation.initialName);
  const [folderId, setFolderId] = useState(operation.initialFolderId);
  const needsName = operation.kind !== "move";
  const needsFolder = operation.kind !== "rename";

  useEffect(() => {
    setName(operation.initialName);
    setFolderId(operation.initialFolderId);
  }, [operation]);

  return (
    <Dialog.Root open onOpenChange={(open) => !open && !busy && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="explorer-dialog-overlay" />
        <Dialog.Content className="explorer-dialog operation-dialog" aria-describedby="operation-description">
          <div className="explorer-dialog-header">
            <Dialog.Title>{titleFor(operation)}</Dialog.Title>
            <Dialog.Close className="touch-target" aria-label="Close" disabled={busy}>
              <X size={18} aria-hidden />
            </Dialog.Close>
          </div>
          <Dialog.Description id="operation-description" className="sr-only">
            Enter the required values and confirm the operation.
          </Dialog.Description>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (busy || (needsName && name.trim().length === 0) || (needsFolder && folderId.length === 0)) return;
              onSubmit({ name: name.trim(), folderId });
            }}
          >
            {needsName ? (
              <label className="operation-field">
                <span>{operation.kind === "new-note" ? "Title" : "Name"}</span>
                <input
                  autoFocus
                  maxLength={operation.kind === "new-note" || operation.selectionKind === "note" ? 160 : 255}
                  value={name}
                  onChange={(event) => setName(event.currentTarget.value)}
                />
              </label>
            ) : null}
            {needsFolder ? (
              <label className="operation-field">
                <span>{operation.kind === "move" ? "Destination" : operation.kind === "new-folder" ? "Parent" : "Folder"}</span>
                <select
                  autoFocus={!needsName}
                  value={folderId}
                  onChange={(event) => setFolderId(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                    const index = folders.findIndex((folder) => folder.id === folderId);
                    const offset = event.key === "ArrowDown" ? 1 : -1;
                    const next = folders[Math.max(0, Math.min(folders.length - 1, index + offset))];
                    if (next === undefined) return;
                    event.preventDefault();
                    setFolderId(next.id);
                  }}
                >
                  {folders.map((folder) => <option value={folder.id} key={folder.id}>{folder.path}</option>)}
                </select>
              </label>
            ) : null}
            {error === null ? null : <p className="explorer-dialog-error" role="alert">{error}</p>}
            <div className="explorer-dialog-actions">
              <button className="secondary-action touch-target" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
              <button className="primary-action touch-target" type="submit" disabled={busy}>{submitLabelFor(operation)}</button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
