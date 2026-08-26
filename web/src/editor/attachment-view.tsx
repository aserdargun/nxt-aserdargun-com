import * as Dialog from "@radix-ui/react-dialog";
import { OpaqueIdSchema, type VaultResponse } from "@nxt/contracts";
import { Download, Trash2, X } from "lucide-react";
import { useRef, useState } from "react";

type Attachment = VaultResponse["entries"][number]["attachments"][number];

export interface AttachmentViewProps {
  readonly attachment: Attachment;
  readonly onTrash: (assetId: string) => void | Promise<void>;
}

const INLINE_IMAGES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export const AttachmentView = ({ attachment, onTrash }: AttachmentViewProps): React.JSX.Element => {
  const parsedId = OpaqueIdSchema.safeParse(attachment.assetId);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  if (!parsedId.success) return <div role="status">Attachment unavailable</div>;
  const url = `/api/private/attachments/${parsedId.data}` as const;
  const inlineImage = attachment.disposition === "inline" && INLINE_IMAGES.has(attachment.mimeType);
  const inlinePdf = attachment.disposition === "inline" && attachment.mimeType === "application/pdf";

  const trash = (): void => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    void Promise.resolve(onTrash(parsedId.data)).then(() => setOpen(false)).catch(() => {
      setError("The attachment could not be moved to Trash.");
    }).finally(() => {
      busyRef.current = false;
      setBusy(false);
    });
  };

  return (
    <article className="attachment-card">
      {inlineImage ? <img src={url} alt={attachment.name} loading="lazy" /> : inlinePdf ? (
        <object data={url} type="application/pdf" aria-label={attachment.name} />
      ) : (
        <a className="attachment-download touch-target" href={url} download aria-label={`Download ${attachment.name}`}>
          <Download size={18} aria-hidden />
          <span>{attachment.name}</span>
        </a>
      )}
      <Dialog.Root open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <Dialog.Trigger className="attachment-trash touch-target" aria-label={`Trash ${attachment.name}`}>
          <Trash2 size={17} aria-hidden />
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="command-overlay" />
          <Dialog.Content className="command-dialog attachment-trash-dialog" aria-describedby="attachment-trash-description">
            <div className="command-header">
              <Dialog.Title>Move attachment to Trash</Dialog.Title>
              <Dialog.Close className="touch-target" aria-label="Close" disabled={busy}><X size={18} aria-hidden /></Dialog.Close>
            </div>
            <Dialog.Description id="attachment-trash-description">
              NXT will move {attachment.name} to Drive Trash only if the server confirms it is no longer referenced.
            </Dialog.Description>
            {error === null ? null : <p role="alert">{error}</p>}
            <div className="dialog-actions">
              <Dialog.Close className="secondary-action touch-target" disabled={busy}>Cancel</Dialog.Close>
              <button className="danger-action touch-target" type="button" disabled={busy} onClick={trash}>Move to Trash</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </article>
  );
};
