import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from "react";

export interface EditorDropzoneProps {
  readonly onFile: (file: File) => void;
  readonly disabled?: boolean;
  readonly children: ReactNode;
}

const hasFilePayload = (event: { dataTransfer?: DataTransfer | null } | null): boolean => {
  if (event === null || event === undefined) return false;
  const types = event.dataTransfer?.types;
  if (types === undefined) return false;
  for (let index = 0; index < types.length; index += 1) {
    if (types[index] === "Files") return true;
  }
  return false;
};

const firstFileFromClipboard = (event: ClipboardEvent): File | null => {
  const items = event.clipboardData?.items;
  if (items === undefined) return null;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item === undefined) continue;
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file !== null) return file;
  }
  return null;
};

/**
 * Wraps the editor area to accept files dropped from the OS or pasted from
 * the clipboard. Drop previews a translucent overlay; paste fires once per
 * file payload, ignoring the surrounding text-only paste.
 */
export const EditorDropzone = ({ onFile, disabled = false, children }: EditorDropzoneProps): React.JSX.Element => {
  const [isOver, setIsOver] = useState(false);
  const counterRef = useRef(0);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const onDragEnter = useCallback((event: DragEvent<HTMLDivElement>): void => {
    if (disabledRef.current) return;
    if (!hasFilePayload(event)) return;
    event.preventDefault();
    counterRef.current += 1;
    setIsOver(true);
  }, []);

  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>): void => {
    if (disabledRef.current) return;
    if (!hasFilePayload(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const onDragLeave = useCallback((event: DragEvent<HTMLDivElement>): void => {
    if (!hasFilePayload(event)) return;
    counterRef.current = Math.max(0, counterRef.current - 1);
    if (counterRef.current === 0) setIsOver(false);
  }, []);

  const onDrop = useCallback((event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    counterRef.current = 0;
    setIsOver(false);
    if (disabledRef.current) return;
    const file = event.dataTransfer?.files?.[0];
    if (file !== undefined) onFile(file);
  }, [onFile]);

  const onPaste = useCallback((event: ClipboardEvent<HTMLDivElement>): void => {
    if (disabledRef.current) return;
    const file = firstFileFromClipboard(event);
    if (file === null) return;
    event.preventDefault();
    onFile(file);
  }, [onFile]);

  useEffect(() => () => {
    counterRef.current = 0;
    setIsOver(false);
  }, []);

  return (
    <div
      className="editor-dropzone"
      data-drop-active={isOver}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onPaste={onPaste}
    >
      {children}
      {isOver ? <div className="editor-dropzone-overlay" role="status">Drop to attach</div> : null}
    </div>
  );
};
