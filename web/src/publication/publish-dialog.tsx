import * as Dialog from "@radix-ui/react-dialog";
import type { PublicationStatus } from "@nxt/contracts";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { publicationClient, type PublicationClient } from "../api/publications";

export interface PublishDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly noteId: string;
  readonly sourceVersion: string;
  readonly attachmentCount: number;
  readonly client?: PublicationClient;
  readonly onPublished: (status: PublicationStatus) => void | Promise<void>;
}

export const PublishDialog = ({
  open,
  onOpenChange,
  noteId,
  sourceVersion,
  attachmentCount,
  client = publicationClient,
  onPublished
}: PublishDialogProps): React.JSX.Element => {
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const operationRef = useRef(0);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    operationRef.current += 1;
    busyRef.current = false;
    setBusy(false);
    setError(null);
  }, [noteId, open, sourceVersion]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationRef.current += 1;
    };
  }, []);

  const publish = (): void => {
    if (busyRef.current) return;
    const operation = ++operationRef.current;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    void client.publish(noteId, sourceVersion).then(async (status) => {
      if (!mountedRef.current || operationRef.current !== operation) return;
      await onPublished(status);
      if (!mountedRef.current || operationRef.current !== operation) return;
      onOpenChange(false);
    }).catch(() => {
      if (mountedRef.current && operationRef.current === operation) {
        setError("The publication could not be verified.");
      }
    }).finally(() => {
      if (mountedRef.current && operationRef.current === operation) {
        busyRef.current = false;
        setBusy(false);
      }
    });
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !busyRef.current && onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Overlay className="command-overlay" />
        <Dialog.Content
          className="command-dialog publish-dialog"
          aria-describedby="publish-description"
          onOpenAutoFocus={() => {
            previousFocusRef.current = document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
          }}
          onCloseAutoFocus={(event) => {
            const target = previousFocusRef.current;
            previousFocusRef.current = null;
            if (target === null || !target.isConnected) return;
            event.preventDefault();
            target.focus();
          }}
        >
          <div className="command-header">
            <Dialog.Title>Publish note</Dialog.Title>
            <Dialog.Close className="touch-target" aria-label="Close publish dialog" disabled={busy}>
              <X size={18} aria-hidden />
            </Dialog.Close>
          </div>
          <Dialog.Description id="publish-description">
            Publish an immutable, unlisted snapshot with <code>noindex</code>.
          </Dialog.Description>
          <dl className="publication-facts">
            <div><dt>Source</dt><dd>Version {sourceVersion}</dd></div>
            <div><dt>Attachments</dt><dd>{attachmentCount} referenced attachments</dd></div>
          </dl>
          {error === null ? null : <p role="alert">{error}</p>}
          <div className="dialog-actions">
            <Dialog.Close className="secondary-action touch-target" disabled={busy}>Cancel</Dialog.Close>
            <button className="primary-action touch-target" type="button" disabled={busy} onClick={publish}>
              {busy ? "Publishing" : "Publish snapshot"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
