import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnerOverflowMenu } from "../app/owner-overflow-menu";
import type { CommandPaletteAction } from "../explorer/command-palette";
import layoutCss from "../theme/layout.css?raw";

const action = (
  id: CommandPaletteAction["id"],
  overrides: Partial<CommandPaletteAction> = {}
): CommandPaletteAction => ({ id, disabledReason: null, run: vi.fn(), ...overrides });

const menuActions = (): CommandPaletteAction[] => [
  action("quick-note"),
  action("favorite", { disabledReason: "Select a note first." }),
  action("toggle-theme"),
  action("rescan"),
  action("sign-out")
];

const openMenu = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
  await user.click(screen.getByRole("button", { name: "More actions" }));
  expect(screen.getByRole("menu")).toBeVisible();
};

const stylesheetRule = (selector: string): CSSStyleRule | undefined => {
  const style = document.createElement("style");
  style.textContent = layoutCss;
  document.head.append(style);
  const rule = Array.from(style.sheet?.cssRules ?? []).find(
    (candidate): candidate is CSSStyleRule => candidate.type === CSSRule.STYLE_RULE && (candidate as CSSStyleRule).selectorText === selector
  );
  style.remove();
  return rule;
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("owner overflow menu", () => {
  it("provides a semantic 44px menu surface for every selectable item", () => {
    const content = stylesheetRule(".owner-overflow-menu");
    const item = stylesheetRule(".owner-overflow-menu-item");

    expect(content).toBeDefined();
    expect(content?.style.getPropertyValue("background").trim()).toBe("var(--surface)");
    expect(content?.style.getPropertyValue("border").trim()).toBe("1px solid var(--border)");
    expect(content?.style.getPropertyValue("box-shadow").trim()).toBe("0 12px 34px var(--bg)");
    expect(item).toBeDefined();
    expect(item?.style.getPropertyValue("min-height").trim()).toBe("44px");
  });

  it("filters to approved overflow actions and exposes disabled reasons", async () => {
    const user = userEvent.setup();
    const actions = [...menuActions(), action("new-note")];
    render(<OwnerOverflowMenu actions={actions} onOpenCommandPalette={vi.fn()} />);

    await openMenu(user);

    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual([
      "Quick note in Inbox",
      "Favorite/UnfavoriteSelect a note first.",
      "Toggle theme",
      "Rescan vault",
      "Sign out",
      "Open command palette"
    ]);
    expect(screen.getByText("Select a note first.")).toBeVisible();
    expect(screen.getByRole("menuitem", { name: /Favorite\/Unfavorite/u })).toHaveAttribute("aria-disabled", "true");

    await user.click(screen.getByRole("menuitem", { name: /Favorite\/Unfavorite/u }));
    expect(actions[1]?.run).not.toHaveBeenCalled();
  });

  it("moves focus with ArrowDown and restores the trigger after Escape", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Sibling control</button>
        <OwnerOverflowMenu actions={menuActions()} onOpenCommandPalette={vi.fn()} />
      </>
    );
    const sibling = screen.getByRole("button", { name: "Sibling control" });
    const trigger = screen.getByRole("button", { name: "More actions" });

    await user.click(trigger);
    expect(screen.getByRole("menu")).toHaveFocus();
    expect(sibling.closest('[aria-hidden="true"]')).toBeNull();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Quick note in Inbox" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Toggle theme" })).toHaveFocus();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("runs an enabled action once while busy", async () => {
    const user = userEvent.setup();
    let complete: (() => void) | undefined;
    const quickNote = action("quick-note", {
      run: vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }))
    });
    render(<OwnerOverflowMenu actions={[quickNote]} onOpenCommandPalette={vi.fn()} />);

    await openMenu(user);
    const quickNoteItem = screen.getByRole("menuitem", { name: "Quick note in Inbox" });
    await user.click(quickNoteItem);
    await waitFor(() => expect(quickNote.run).toHaveBeenCalledOnce());
    await user.click(quickNoteItem);
    expect(quickNote.run).toHaveBeenCalledOnce();
    complete?.();
  });

  it("keeps an async rejection visible as feedback", async () => {
    const user = userEvent.setup();
    const quickNote = action("quick-note", { run: vi.fn(() => Promise.reject(new Error("nope"))) });
    render(<OwnerOverflowMenu actions={[quickNote]} onOpenCommandPalette={vi.fn()} />);

    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Quick note in Inbox" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The action could not be completed.");
  });

  it("opens the shared command palette through its callback", async () => {
    const user = userEvent.setup();
    const onOpenCommandPalette = vi.fn();
    render(<OwnerOverflowMenu actions={menuActions()} onOpenCommandPalette={onOpenCommandPalette} />);

    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Open command palette" }));

    expect(onOpenCommandPalette).toHaveBeenCalledOnce();
  });
});
