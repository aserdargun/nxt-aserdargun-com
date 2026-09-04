import * as Dialog from "@radix-ui/react-dialog";
import type { NoteResponse } from "@nxt/contracts";
import { Cloud, FileText, X } from "lucide-react";
import { useId, useMemo, useRef } from "react";
import { projectConflictDiff } from "./conflict-diff";
import { ConflictSourceEditor } from "./conflict-source-editor";

export interface EditorConflict {
  readonly noteId: string;
  readonly title: string;
  readonly localSource: string;
  readonly localBaseVersion: string;
  readonly localUpdatedAt: string;
  readonly drive: NoteResponse;
}

export type ConflictResolution = "keep-drive" | "save-new" | "merge";

export interface ConflictDialogProps {
  readonly conflict: EditorConflict;
  readonly open: boolean;
  readonly busy: boolean;
  readonly mobile?: boolean | undefined;
  readonly error?: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onMergeSourceChange: (source: string) => void;
  readonly onResolve: (resolution: ConflictResolution) => void;
}

const formatConflictTimestamp = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
};

const countLabel = (count: number, kind: "added" | "removed"): string => (
  `${count} ${kind} ${count === 1 ? "line" : "lines"}`
);

export const ConflictDialog = ({
  conflict,
  open,
  busy,
  mobile = false,
  error = null,
  onOpenChange,
  onMergeSourceChange,
  onResolve
}: ConflictDialogProps): React.JSX.Element => {
  const mergeButton = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const localHeadingRef = useRef<HTMLHeadingElement>(null);
  const driveHeadingRef = useRef<HTMLHeadingElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const summaryId = useId();
  const diff = useMemo(
    () => projectConflictDiff(conflict.localSource, conflict.drive.source),
    [conflict.drive.source, conflict.localSource]
  );
  const diffSummary = `${countLabel(diff.counts.additions, "added")}, ${countLabel(diff.counts.removals, "removed")}.`;
  const focusHeading = (heading: React.RefObject<HTMLHeadingElement | null>): void => {
    heading.current?.focus({ preventScroll: false });
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="conflict-overlay" />
        <Dialog.Content
          className="conflict-dialog"
          data-mobile={mobile}
          aria-describedby={`version-conflict-description ${summaryId}`}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            previousFocus.current = document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
            if (mobile) titleRef.current?.focus();
            else mergeButton.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            previousFocus.current?.focus();
            previousFocus.current = null;
          }}
        >
          <header className="conflict-header">
            <div>
              <Dialog.Title ref={titleRef} tabIndex={-1}>Version conflict</Dialog.Title>
              <Dialog.Description id="version-conflict-description">
                This note changed in Drive while you were editing.
              </Dialog.Description>
              <p id={summaryId} className="conflict-diff-summary">{diffSummary}</p>
            </div>
            <Dialog.Close className="conflict-close touch-target" aria-label="Close" disabled={busy}>
              <X size={19} strokeWidth={1.75} aria-hidden />
            </Dialog.Close>
          </header>

          {mobile ? (
            <nav className="conflict-section-nav" aria-label="Conflict sections">
              <button type="button" className="touch-target" onClick={() => focusHeading(localHeadingRef)}>
                Local draft
              </button>
              <button type="button" className="touch-target" onClick={() => focusHeading(driveHeadingRef)}>
                Drive version
              </button>
            </nav>
          ) : null}

          <div className="conflict-panes">
            <section className="conflict-pane local-pane" aria-labelledby="local-draft-heading">
              <h2 ref={localHeadingRef} id="local-draft-heading" tabIndex={-1}>
                <FileText size={18} strokeWidth={1.75} aria-hidden />
                Local draft
              </h2>
              <p className="conflict-pane-time">
                Local draft updated{" "}
                <time dateTime={conflict.localUpdatedAt}>{formatConflictTimestamp(conflict.localUpdatedAt)}</time>
              </p>
              <ConflictSourceEditor
                value={conflict.localSource}
                lines={diff.local}
                label="Local draft"
                summaryId={summaryId}
                readOnly={busy}
                onChange={onMergeSourceChange}
              />
            </section>
            <section className="conflict-pane drive-pane" role="region" aria-labelledby="drive-version-heading">
              <h2 ref={driveHeadingRef} id="drive-version-heading" tabIndex={-1}>
                <Cloud size={18} strokeWidth={1.75} aria-hidden />
                Drive version
              </h2>
              <p className="conflict-pane-time">
                Drive note updated{" "}
                <time dateTime={conflict.drive.note.frontmatter.updated}>
                  {formatConflictTimestamp(conflict.drive.note.frontmatter.updated)}
                </time>
              </p>
              <ConflictSourceEditor
                value={conflict.drive.source}
                lines={diff.drive}
                label="Drive version source"
                summaryId={summaryId}
                readOnly
              />
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
