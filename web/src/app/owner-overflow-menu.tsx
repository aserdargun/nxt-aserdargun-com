import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreVertical } from "lucide-react";
import { useMemo, useState } from "react";
import {
  APPROVED_COMMANDS,
  type CommandId,
  type CommandPaletteAction
} from "../explorer/command-catalog";
import { StatusCallout } from "./status-callout";

export interface OwnerOverflowMenuProps {
  readonly actions: readonly CommandPaletteAction[];
  readonly onOpenCommandPalette: () => void;
}

const OVERFLOW_ACTION_IDS = ["quick-note", "favorite", "toggle-theme", "rescan", "sign-out"] as const satisfies readonly CommandId[];
const commandById = new Map(APPROVED_COMMANDS.map((command) => [command.id, command]));

export const OwnerOverflowMenu = ({ actions, onOpenCommandPalette }: OwnerOverflowMenuProps): React.JSX.Element => {
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<CommandId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const overflowActions = useMemo(
    () => OVERFLOW_ACTION_IDS.flatMap((id) => {
      const action = actions.find((candidate) => candidate.id === id);
      const command = commandById.get(id);
      return action === undefined || command === undefined ? [] : [{ action, command }];
    }),
    [actions]
  );

  const activate = (action: CommandPaletteAction): void => {
    if (action.disabledReason !== null || busyId !== null) return;
    setBusyId(action.id);
    setError(null);
    void Promise.resolve(action.run()).then(() => {
      setOpen(false);
    }).catch(() => {
      setError("The action could not be completed.");
    }).finally(() => {
      setBusyId(null);
    });
  };

  return (
    <DropdownMenu.Root
      modal={false}
      open={open}
      onOpenChange={(next) => {
        if (busyId !== null) return;
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <DropdownMenu.Trigger className="mobile-more touch-target" type="button" aria-label="More actions">
        <MoreVertical size={23} strokeWidth={1.75} aria-hidden />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="owner-overflow-menu" aria-label="Owner actions">
          {overflowActions.map(({ action, command }) => (
            <DropdownMenu.Item
              key={action.id}
              className="owner-overflow-menu-item"
              disabled={action.disabledReason !== null || busyId !== null}
              onSelect={(event) => {
                event.preventDefault();
                activate(action);
              }}
            >
              <span>{command.label}</span>
              {action.disabledReason === null ? null : <small>{action.disabledReason}</small>}
            </DropdownMenu.Item>
          ))}
          <DropdownMenu.Separator className="owner-overflow-menu-separator" />
          <DropdownMenu.Item
            className="owner-overflow-menu-item"
            disabled={busyId !== null}
            onSelect={() => onOpenCommandPalette()}
          >
            Open command palette
          </DropdownMenu.Item>
          {error === null ? null : <StatusCallout tone="error" persistent>{error}</StatusCallout>}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
};
