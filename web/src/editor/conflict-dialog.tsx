import * as Dialog from "@radix-ui/react-dialog";
import type { NoteResponse } from "@nxt/contracts";
import { Cloud, FileText, X } from "lucide-react";
import { useRef } from "react";

export interface EditorConflict {
  readonly noteId: string;
  readonly title: string;
  readonly localSource: string;
  readonly localUpdatedAt: string;
  readonly drive: NoteResponse;
}

export type ConflictResolution = "keep-drive" | "save-new" | "merge";

export interface ConflictDialogProps {
  readonly conflict: EditorConflict;
  readonly open: boolean;
  readonly busy: boolean;
  readonly error?: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onMergeSourceChange: (source: string) => void;
  readonly onResolve: (resolution: ConflictResolution) => void;
}

export const ConflictDialog = ({
  conflict,
  open,
  busy,
  error = null,
  onOpenChange,
  onMergeSourceChange,
  onResolve
}: ConflictDialogProps): React.JSX.Element => {
  const mergeButton = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="conflict-overlay" />
        <Dialog.Content
          className="conflict-dialog"
          aria-describedby="version-conflict-description"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            previousFocus.current = document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
            mergeButton.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            previousFocus.current?.focus();
            previousFocus.current = null;
          }}
        >
          <header className="conflict-header">
            <div>
              <Dialog.Title>Version conflict</Dialog.Title>
              <Dialog.Description id="version-conflict-description">
                This note changed in Drive while you were editing.
              </Dialog.Description>
            </div>
            <Dialog.Close className="conflict-close touch-target" aria-label="Close" disabled={busy}>
              <X size={19} strokeWidth={1.75} aria-hidden />
            </Dialog.Close>
          </header>

          <div className="conflict-panes">
            <section className="conflict-pane local-pane" aria-labelledby="local-draft-heading">
              <h2 id="local-draft-heading">
                <FileText size={18} strokeWidth={1.75} aria-hidden />
                Local draft
              </h2>
              <textarea
                className="conflict-source"
                aria-label="Local draft"
                value={conflict.localSource}
                readOnly={busy}
                spellCheck={false}
                onChange={(event) => onMergeSourceChange(event.currentTarget.value)}
              />
            </section>
            <section className="conflict-pane drive-pane" role="region" aria-label="Drive version">
              <h2>
                <Cloud size={18} strokeWidth={1.75} aria-hidden />
                Drive version
              </h2>
              <pre className="conflict-source" tabIndex={0}>{conflict.drive.source}</pre>
            </section>
          </div>

          {error === null ? null : <p className="conflict-error" role="alert">{error}</p>}

          <footer className="conflict-actions">
            <button
              type="button"
              className="conflict-action touch-target"
              disabled={busy}
              onClick={() => onResolve("keep-drive")}
            >
              Keep Drive version
            </button>
            <button
              type="button"
              className="conflict-action touch-target"
              disabled={busy}
              onClick={() => onResolve("save-new")}
            >
              Save local as a new note
            </button>
            <button
              ref={mergeButton}
              type="button"
              className="conflict-action primary touch-target"
              disabled={busy}
              onClick={() => onResolve("merge")}
            >
              Merge versions
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
