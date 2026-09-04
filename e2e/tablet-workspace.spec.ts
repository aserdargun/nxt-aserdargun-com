import type { Page } from "@playwright/test";
import { actualTabbableControls } from "./acceptance-helpers";
import { expect, test } from "./fixtures";

const primaryDestinations = ["Editor", "Preview", "Info"] as const;

const expectOnlyPrimarySurface = async (
  page: Page,
  expected: (typeof primaryDestinations)[number]
): Promise<void> => {
  await expect(page.getByRole("region", { name: expected, exact: true })).toBeVisible();
  const visible: string[] = [];
  for (const destination of primaryDestinations) {
    if (await page.getByRole("region", { name: destination, exact: true }).isVisible()) {
      visible.push(destination);
    }
  }
  expect(visible).toEqual([expected]);
};

test("tablet preserves note context, explorer state, focus containment, and layout", async ({ ownerPage: page }) => {
  const shell = page.getByTestId("owner-shell");
  await expect(shell).toHaveAttribute("data-layout", "tablet");
  await expect(shell).toHaveAttribute("data-compact-tablet", "false");
  await expectOnlyPrimarySurface(page, "Editor");

  const initialUrl = page.url();
  const selectedNote = page.getByRole("tree", { name: "Files" })
    .getByRole("treeitem", { name: "Welcome to NXT" });
  await expect(selectedNote).toHaveAttribute("aria-selected", "true");

  const destinations = page.getByRole("navigation", { name: "Tablet destinations" });
  for (const destination of primaryDestinations) {
    await destinations.getByRole("button", { name: destination }).click();
    await expectOnlyPrimarySurface(page, destination);
    expect(page.url()).toBe(initialUrl);
    await expect(selectedNote).toHaveAttribute("aria-selected", "true");
  }
  await destinations.getByRole("button", { name: "Editor" }).click();

  const filesRegion = page.locator('section.workspace-region[aria-label="Files"]');
  await page.getByRole("button", { name: "Hide files" }).click();
  await expect(shell).toHaveAttribute("data-explorer-open", "false");
  await expect(filesRegion).toBeHidden();
  await page.getByRole("button", { name: "Show files" }).click();
  await expect(shell).toHaveAttribute("data-explorer-open", "true");
  await expect(filesRegion).toBeVisible();

  await page.setViewportSize({ width: 820, height: 768 });
  await expect(shell).toHaveAttribute("data-layout", "tablet");
  await expect(shell).toHaveAttribute("data-compact-tablet", "true");
  const showFiles = page.getByRole("button", { name: "Show files" });
  await expect(showFiles).toBeVisible();
  await showFiles.click();
  const explorerSheet = page.getByRole("dialog", { name: "Files" });
  await expect(explorerSheet).toBeVisible();

  const focusable = await actualTabbableControls(explorerSheet);
  expect(focusable.length).toBeGreaterThan(1);
  const firstFocusable = focusable[0];
  const lastFocusable = focusable.at(-1);
  if (firstFocusable === undefined || lastFocusable === undefined) {
    throw new Error("The compact explorer does not expose tab boundaries.");
  }
  expect(await firstFocusable.evaluate((element) => element.tabIndex)).toBeGreaterThanOrEqual(0);
  expect(await lastFocusable.evaluate((element) => element.tabIndex)).toBeGreaterThanOrEqual(0);
  await firstFocusable.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(lastFocusable).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(firstFocusable).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(explorerSheet).toBeHidden();
  await expect(showFiles).toBeFocused();

  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(shell).toHaveAttribute("data-compact-tablet", "false");
  const reopenFiles = page.getByRole("button", { name: "Show files" });
  await reopenFiles.click();
  await expect(filesRegion).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({
    path: "test-results/playwright/task-nxt-1-1-tablet-workspace.png",
    fullPage: true,
    animations: "disabled"
  });
});
