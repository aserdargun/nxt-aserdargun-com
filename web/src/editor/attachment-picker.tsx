import { MAX_ATTACHMENT_UPLOAD_BYTES } from "@nxt/contracts";
import { Paperclip } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  attachmentClient,
  type AttachmentClient,
  type UploadedAttachment
} from "../api/attachments";

export interface AttachmentPickerProps {
  readonly noteId: string;
  readonly client?: AttachmentClient;
  readonly disabledReason?: string | null;
  readonly onUploaded: (attachment: UploadedAttachment) => void | Promise<void>;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const MAX_BLOCK_BYTES = 24 * 1024;

export const encodeBase64 = (bytes: Uint8Array): string => {
  const blocks: string[] = [];
  for (let blockStart = 0; blockStart < bytes.length; blockStart += MAX_BLOCK_BYTES) {
    const blockEnd = Math.min(bytes.length, blockStart + MAX_BLOCK_BYTES);
    let block = "";
    for (let index = blockStart; index < blockEnd; index += 3) {
      const first = bytes[index] as number;
      const hasSecond = index + 1 < bytes.length;
      const hasThird = index + 2 < bytes.length;
      const second = hasSecond ? bytes[index + 1] as number : 0;
      const third = hasThird ? bytes[index + 2] as number : 0;
      block += BASE64_ALPHABET[first >> 2];
      block += BASE64_ALPHABET[((first & 3) << 4) | (second >> 4)];
      block += hasSecond ? BASE64_ALPHABET[((second & 15) << 2) | (third >> 6)] : "=";
      block += hasThird ? BASE64_ALPHABET[third & 63] : "=";
    }
    blocks.push(block);
  }
  return blocks.join("");
};

const controlledError = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "TOO_LARGE") return "Attachments must be 20 MB or smaller.";
    if (code === "UNSAFE_FILE") return "This attachment cannot be uploaded safely.";
    if (code === "CONFLICT") return "Refresh the vault before adding this attachment.";
  }
  return "The attachment could not be uploaded.";
};

export const AttachmentPicker = ({
  noteId,
  client = attachmentClient,
  disabledReason = null,
  onUploaded
}: AttachmentPickerProps): React.JSX.Element => {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const mountedRef = useRef(true);
  const noteRef = useRef(noteId);
  const operationRef = useRef(0);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    noteRef.current = noteId;
    operationRef.current += 1;
    busyRef.current = false;
    setBusy(false);
    setMessage(null);
    if (inputRef.current !== null) inputRef.current.value = "";
  }, [noteId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationRef.current += 1;
    };
  }, []);

  const handleFile = useCallback(async (file: File): Promise<void> => {
    if (disabledReason !== null || busyRef.current) return;
    if (file.size > MAX_ATTACHMENT_UPLOAD_BYTES) {
      setMessage("Attachments must be 20 MB or smaller.");
      return;
    }
    const operation = ++operationRef.current;
    const selectedNoteId = noteRef.current;
    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!mountedRef.current || operationRef.current !== operation || noteRef.current !== selectedNoteId) return;
      if (bytes.byteLength !== file.size || bytes.byteLength > MAX_ATTACHMENT_UPLOAD_BYTES) {
        setMessage("Attachments must be 20 MB or smaller.");
        return;
      }
      const response = await client.upload({
        noteId: selectedNoteId,
        name: file.name,
        declaredMime: file.type,
        bytesBase64: encodeBase64(bytes)
      });
      if (!mountedRef.current || operationRef.current !== operation || noteRef.current !== selectedNoteId) return;
      await onUploaded(response.asset);
    } catch (error) {
      if (mountedRef.current && operationRef.current === operation && noteRef.current === selectedNoteId) {
        setMessage(controlledError(error));
      }
    } finally {
      if (mountedRef.current && operationRef.current === operation && noteRef.current === selectedNoteId) {
        busyRef.current = false;
        setBusy(false);
      }
      if (inputRef.current !== null) inputRef.current.value = "";
    }
  }, [client, disabledReason, onUploaded]);

  const acceptOne = useCallback((files: FileList | readonly File[]): void => {
    if (files.length !== 1) {
      setMessage("Add one file at a time.");
      return;
    }
    const file = files[0];
    if (file !== undefined) void handleFile(file);
  }, [handleFile]);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      const files = [...(event.clipboardData?.files ?? [])];
      if (files.length === 0 || !files.every((file) => file.type.startsWith("image/"))) return;
      event.preventDefault();
      acceptOne(files);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [acceptOne]);

  const disabled = disabledReason !== null || busy;
  return (
    <div className="attachment-picker">
      <button
        className="text-action touch-target"
        type="button"
        data-testid="attachment-drop-target"
        disabled={disabled}
        title={disabledReason ?? undefined}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          acceptOne([...event.dataTransfer.files]);
        }}
      >
        <Paperclip size={19} strokeWidth={1.75} aria-hidden />
        <span>{busy ? "Uploading" : "Add attachment"}</span>
      </button>
      <input
        ref={inputRef}
        className="attachment-input"
        type="file"
        aria-label="Add attachment"
        aria-hidden="true"
        hidden
        tabIndex={-1}
        disabled={disabled}
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = "";
          acceptOne(files);
        }}
      />
      {busy ? <span className="sr-only" role="status">Uploading attachment</span> : null}
      {disabledReason === null ? null : <span className="sr-only">{disabledReason}</span>}
      {message === null ? null : <span className="attachment-message" role="alert">{message}</span>}
    </div>
  );
};
