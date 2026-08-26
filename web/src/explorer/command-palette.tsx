import * as Dialog from "@radix-ui/react-dialog";
import { Search, X } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

export type CommandId =
  | "new-note"
  | "quick-note"
  | "new-folder"
  | "open-note"
  | "rename"
  | "move"
  | "archive"
  | "favorite"
  | "rescan"
  | "publish"
  | "revoke"
  | "toggle-theme"
  | "sign-out";

export interface ApprovedCommand {
  readonly id: CommandId;
  readonly label: string;
}

export const APPROVED_COMMANDS: readonly ApprovedCommand[] = [
  { id: "new-note", label: "New note" },
  { id: "quick-note", label: "Quick note in Inbox" },
  { id: "new-folder", label: "New folder" },
  { id: "open-note", label: "Open note" },
  { id: "rename", label: "Rename" },
  { id: "move", label: "Move" },
  { id: "archive", label: "Archive" },
  { id: "favorite", label: "Favorite/Unfavorite" },
  { id: "rescan", label: "Rescan vault" },
  { id: "publish", label: "Publish" },
  { id: "revoke", label: "Revoke" },
  { id: "toggle-theme", label: "Toggle theme" },
  { id: "sign-out", label: "Sign out" }
];

export interface CommandPaletteAction {
  readonly id: CommandId;
  readonly run: () => void | Promise<void>;
  readonly disabledReason: string | null;
}

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly actions: readonly CommandPaletteAction[];
}

const commandById = new Map(APPROVED_COMMANDS.map((command) => [command.id, command]));

export const CommandPalette = ({ open, onOpenChange, actions }: CommandPaletteProps): React.JSX.Element => {
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<CommandId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const deferredQuery = useDeferredValue(query);
  const visible = useMemo(() => {
    const normalized = deferredQuery.trim().toLocaleLowerCase("tr-TR");
    return actions.flatMap((action) => {
      const command = commandById.get(action.id);
      if (command === undefined || (normalized.length > 0 && !command.label.toLocaleLowerCase("tr-TR").includes(normalized))) return [];
      return [{ command, action }];
    });
  }, [actions, deferredQuery]);

  useEffect(() => {
    if (open && !wasOpen.current) {
      restoreFocus.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    }
    wasOpen.current = open;
    if (!open) {
      setQuery("");
      setError(null);
      setBusyId(null);
    }
  }, [open]);

  const activate = (action: CommandPaletteAction): void => {
    if (action.disabledReason !== null || busyId !== null) return;
    setBusyId(action.id);
    setError(null);
    void Promise.resolve(action.run()).then(() => onOpenChange(false)).catch(() => {
      setError("The command could not be completed.");
      setBusyId(null);
    });
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => busyId === null && onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Overlay className="command-overlay" />
        <Dialog.Content
          className="command-dialog"
          aria-describedby="command-description"
          onCloseAutoFocus={(event) => {
            const target = restoreFocus.current;
            if (target === null || !target.isConnected) return;
            event.preventDefault();
            target.focus();
          }}
        >
          <div className="command-header">
            <Dialog.Title>Commands</Dialog.Title>
            <Dialog.Description id="command-description" className="sr-only">Search and run NXT commands.</Dialog.Description>
            <Dialog.Close className="touch-target" aria-label="Close commands" disabled={busyId !== null}>
              <X size={18} aria-hidden />
            </Dialog.Close>
          </div>
          <div className="command-search">
            <Search size={17} aria-hidden />
            <input
              autoFocus
              aria-label="Search commands"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                const first = visible.find(({ action }) => action.disabledReason === null);
                if (first === undefined) return;
                event.preventDefault();
                activate(first.action);
              }}
            />
          </div>
          <div className="command-list" role="list" aria-label="Commands">
            {visible.map(({ command, action }) => (
              <div role="listitem" key={command.id}>
                <button
                  type="button"
                  disabled={action.disabledReason !== null || busyId !== null}
                  onClick={() => activate(action)}
                >
                  <span>{command.label}</span>
                  {action.disabledReason === null ? null : <small>{action.disabledReason}</small>}
                </button>
              </div>
            ))}
          </div>
          {error === null ? null : <p className="command-error" role="alert">{error}</p>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
