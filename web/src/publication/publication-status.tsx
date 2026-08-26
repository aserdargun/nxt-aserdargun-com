import * as Dialog from "@radix-ui/react-dialog";
import type { PublicationStatus as PublicationStatusValue } from "@nxt/contracts";
import { Clipboard, ExternalLink, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { publicationClient, type PublicationClient } from "../api/publications";

export interface PublicationStatusProps {
  readonly status: PublicationStatusValue;
  readonly client?: PublicationClient;
  readonly onRevoked: () => void | Promise<void>;
  readonly revokeOpen?: boolean | undefined;
  readonly onRevokeOpenChange?: ((open: boolean) => void) | undefined;
}

export const PublicationStatus = ({
  status,
  client = publicationClient,
  onRevoked,
  revokeOpen,
  onRevokeOpenChange
}: PublicationStatusProps): React.JSX.Element => {
  const [internalOpen, setInternalOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const operationRef = useRef(0);
  const path = `/p/${status.publicId}`;
  const publicUrl = new URL(path, window.location.origin).toString();
  const open = revokeOpen ?? internalOpen;
  const setOpen = (next: boolean): void => {
    if (onRevokeOpenChange !== undefined) onRevokeOpenChange(next);
    else setInternalOpen(next);
  };

  useEffect(() => {
    operationRef.current += 1;
    busyRef.current = false;
    setBusy(false);
    setError(null);
    setCopyStatus(null);
  }, [status.publicId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationRef.current += 1;
    };
  }, []);

  const copy = (): void => {
    setCopyStatus(null);
    const clipboard = navigator.clipboard;
    if (clipboard === undefined) {
      setCopyStatus("Copy is unavailable.");
      return;
    }
    void clipboard.writeText(publicUrl).then(() => setCopyStatus("Link copied.")).catch(() => {
      setCopyStatus("Copy is unavailable.");
    });
  };

  const revoke = (): void => {
    if (busyRef.current) return;
    const operation = ++operationRef.current;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    void client.revoke(status.publicId).then(async () => {
      if (!mountedRef.current || operationRef.current !== operation) return;
      setOpen(false);
      await onRevoked();
    }).catch(() => {
      if (mountedRef.current && operationRef.current === operation) {
        setError("Revocation could not be verified. The publication remains visible here.");
      }
    }).finally(() => {
      if (mountedRef.current && operationRef.current === operation) {
        busyRef.current = false;
        setBusy(false);
      }
    });
  };

  return (
    <div className="publication-status" role="status" aria-label="Publication status">
      <a className="publication-link touch-target" href={path} target="_blank" rel="noopener noreferrer">
        <ExternalLink size={17} aria-hidden />
        <span>Open link</span>
      </a>
      <button className="secondary-action touch-target" type="button" onClick={copy}>
        <Clipboard size={17} aria-hidden />
        <span>Copy link</span>
      </button>
      <Dialog.Root open={open} onOpenChange={(next) => !busyRef.current && setOpen(next)}>
        <Dialog.Trigger className="danger-action touch-target">Revoke</Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="command-overlay" />
          <Dialog.Content className="command-dialog revoke-dialog" aria-describedby="revoke-description">
            <div className="command-header">
              <Dialog.Title>Revoke publication</Dialog.Title>
              <Dialog.Close className="touch-target" aria-label="Close revoke dialog" disabled={busy}>
                <X size={18} aria-hidden />
              </Dialog.Close>
            </div>
            <Dialog.Description id="revoke-description">
              The unlisted public URL must return Not found before NXT reports success.
            </Dialog.Description>
            {error === null ? null : <p role="alert">{error}</p>}
            <div className="dialog-actions">
              <Dialog.Close className="secondary-action touch-target" disabled={busy}>Cancel</Dialog.Close>
              <button className="danger-action touch-target" type="button" disabled={busy} onClick={revoke}>
                {busy ? "Revoking" : "Confirm revoke"}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {copyStatus === null ? null : <span className="sr-only" aria-live="polite">{copyStatus}</span>}
    </div>
  );
};
