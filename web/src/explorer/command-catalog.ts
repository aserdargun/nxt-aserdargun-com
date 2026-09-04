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
