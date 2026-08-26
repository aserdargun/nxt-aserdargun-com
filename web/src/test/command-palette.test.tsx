import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommandPalette,
  APPROVED_COMMANDS,
  type CommandPaletteAction
} from "../explorer/command-palette";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const action = (
  id: CommandPaletteAction["id"],
  overrides: Partial<CommandPaletteAction> = {}
): CommandPaletteAction => ({ id, run: vi.fn(() => Promise.resolve()), disabledReason: null, ...overrides });

describe("command palette", () => {
  it("shows the exact command inventory and visible disabled reasons", async () => {
    const user = userEvent.setup();
    render(
      <CommandPalette
        open
        onOpenChange={vi.fn()}
        actions={APPROVED_COMMANDS.map((item) =>
          action(item.id, item.id === "publish" || item.id === "revoke" ? { disabledReason: "Available after publication is added." } : {})
        )}
      />
    );

    const dialog = screen.getByRole("dialog", { name: "Commands" });
    expect(within(dialog).getAllByRole("listitem").map((item) => item.textContent?.replace(/Available after publication is added\./u, "").trim())).toEqual(
      APPROVED_COMMANDS.map((item) => item.label)
    );
    expect(within(dialog).getAllByText("Available after publication is added.")).toHaveLength(2);
    expect(within(dialog).getByRole("button", { name: /Publish/u })).toBeDisabled();
    await user.keyboard("{Escape}");
  });

  it("restores focus and runs an applicable command keyboard-only", async () => {
    const user = userEvent.setup();
    const openNote = action("open-note");
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <>
        <button type="button">Origin</button>
        <CommandPalette open={false} onOpenChange={onOpenChange} actions={[openNote]} />
      </>
    );
    const origin = screen.getByRole("button", { name: "Origin" });
    origin.focus();
    rerender(
      <>
        <button type="button">Origin</button>
        <CommandPalette open onOpenChange={onOpenChange} actions={[openNote]} />
      </>
    );
    await user.keyboard("{Enter}");
    await waitFor(() => expect(openNote.run).toHaveBeenCalledOnce());
    rerender(
      <>
        <button type="button">Origin</button>
        <CommandPalette open={false} onOpenChange={onOpenChange} actions={[openNote]} />
      </>
    );
    await waitFor(() => expect(document.activeElement).toBe(origin));
  });
});
