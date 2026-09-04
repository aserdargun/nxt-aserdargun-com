import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { openConflictDialog } from "./acceptance-helpers";
import { effectiveColorPair, parseRgbColor } from "./color-contrast";
import { expect, test } from "./fixtures";

const expectNoSeriousViolations = async (page: Page): Promise<void> => {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual([]);
};

const luminance = ([red, green, blue]: readonly number[]): number => {
  const [r, g, b] = [red, green, blue].map((channel) => {
    const normalized = (channel ?? 0) / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
};

const contrast = (foreground: readonly number[], background: readonly number[]): number => {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
};

const rgb = (value: string): readonly number[] => parseRgbColor(value).slice(0, 3);

const computedColorPair = async (locator: Locator): Promise<{
  readonly foreground: readonly number[];
  readonly background: readonly number[];
}> => {
  const { foreground, backgroundLayers } = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const layers: string[] = [];
    for (let layer: Element | null = element; layer !== null; layer = layer.parentElement) {
      layers.push(getComputedStyle(layer).backgroundColor);
    }
    return { foreground: style.color, backgroundLayers: layers };
  });
  return effectiveColorPair(foreground, backgroundLayers);
};

const setTheme = async (page: Page, theme: "dark" | "light"): Promise<void> => {
  if (await page.locator("html").getAttribute("data-theme") === theme) return;
  const editor = page.getByLabel("Markdown editor");
  await editor.focus();
  await page.keyboard.press("Meta+K");
  await page.getByLabel("Search commands").fill("Toggle theme");
  await page.getByLabel("Search commands").press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(editor).toBeFocused();
};

test("login, owner workspace, and command dialog have no serious axe violations", async ({ ownerPage: page }) => {
  const tree = page.getByRole("tree", { name: "Files" });
  await expect(tree.locator('button[aria-label$=" actions"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Notes actions" })).toBeAttached();
  const inbox = tree.getByRole("treeitem", { name: "Inbox" });
  const welcome = tree.getByRole("treeitem", { name: "Welcome to NXT" });
  await expect(page.getByLabel("Save status")).toHaveText("Saved");
  await expectNoSeriousViolations(page);
  await welcome.focus();
  await expect(welcome).toBeFocused();
  await welcome.press("ArrowUp");
  await expect(inbox).toBeFocused();
  await inbox.press("ArrowDown");
  await expect(welcome).toBeFocused();
  const editor = page.getByLabel("Markdown editor");
  await editor.focus();
  await page.keyboard.press("Meta+K");
  const dialog = page.getByRole("dialog", { name: "Commands" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS("opacity", "1");
  const palette = await dialog.evaluate((element) => {
    const values = (selector: string): number[] => {
      const value = getComputedStyle(element.querySelector(selector) as Element).color;
      return [...value.matchAll(/\d+/gu)].slice(0, 3).map(([channel]) => Number(channel));
    };
    const background = [...getComputedStyle(element).backgroundColor.matchAll(/\d+/gu)]
      .slice(0, 3).map(([channel]) => Number(channel));
    return { background, heading: values("h2"), text: values(".command-list button span") };
  });
  expect(contrast(palette.heading, palette.background)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(palette.text, palette.background)).toBeGreaterThanOrEqual(4.5);
  const enabled = dialog.locator(".command-list button:not(:disabled)").first();
  const disabled = dialog.locator(".command-list button:disabled").first();
  await expect(disabled).toHaveCSS("opacity", "0.72");
  await enabled.focus();
  expect(await enabled.evaluate((button) => getComputedStyle(button).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  expect(await disabled.evaluate((button) => getComputedStyle(button).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  await expectNoSeriousViolations(page);
  await page.screenshot({
    path: "test-results/playwright/task-nxt-1-1-command-dialog.png",
    fullPage: true,
    animations: "disabled"
  });
  await page.keyboard.press("Escape");
  await expect(editor).toBeFocused();
  const theme = await page.locator("html").getAttribute("data-theme");
  await page.keyboard.press("Meta+K");
  await page.getByLabel("Search commands").fill("Toggle theme");
  await page.getByLabel("Search commands").press("Enter");
  await expect(page.getByRole("dialog", { name: "Commands" })).toBeHidden();
  await expect(editor).toBeFocused();
  expect(await page.locator("html").getAttribute("data-theme")).not.toBe(theme);
  expect(await page.getByLabel("Save status").getAttribute("aria-live")).toBe("polite");
});

test("login route has no serious axe violations", async ({ page }) => {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await expectNoSeriousViolations(page);
});

test("mobile overflow menu passes axe and restores focus to its exact trigger", async ({ ownerPage: page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("owner-shell")).toHaveAttribute("data-layout", "mobile");
  const trigger = page.getByRole("button", { name: "More actions" });
  await trigger.click();
  const menu = page.getByRole("menu", { name: "More actions" });
  await expect(menu).toBeVisible();
  await expectNoSeriousViolations(page);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("owner route error state has no serious axe violations", async ({ ownerPage: page }) => {
  await page.route("**/api/private/vault?*", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "DRIVE_UNAVAILABLE",
          message: "The service is temporarily unavailable.",
          requestId: "task-8-route-error"
        }
      })
    });
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "The vault could not be loaded safely" })).toBeVisible();
  await expectNoSeriousViolations(page);
});

test("publish dialog and the resulting public note have no serious axe violations", async ({ ownerPage: page }) => {
  await page.getByRole("button", { name: "Publish" }).click();
  const dialog = page.getByRole("dialog", { name: "Publish note" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS("opacity", "1");
  await expectNoSeriousViolations(page);
  await dialog.getByRole("button", { name: "Publish snapshot" }).click();
  const publicLink = page.getByRole("link", { name: "Open link" });
  await expect(publicLink).toBeVisible();
  const publicPath = await publicLink.getAttribute("href");
  expect(publicPath).toMatch(/^\/p\/[A-Za-z0-9_-]{22}$/u);
  await page.goto(publicPath as string, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1, name: "Welcome to NXT" })).toBeVisible();
  await expectNoSeriousViolations(page);
});

test("conflict dialog has no serious axe violations", async ({ ownerPage: page }) => {
  const dialog = await openConflictDialog(page);
  await expectNoSeriousViolations(page);
  const activeGutter = page.locator(".cm-activeLineGutter").first();
  await expect(activeGutter).toBeVisible();
  const activeGutterColors = await computedColorPair(activeGutter);
  expect(contrast(activeGutterColors.foreground, activeGutterColors.background)).toBeGreaterThanOrEqual(4.5);
  await expect(dialog.getByRole("button", { name: "Merge versions" })).toBeVisible();
});

for (const theme of ["dark", "light"] as const) {
  test(`${theme} theme preserves operation, callout, and focus contrast`, async ({ ownerPage: page, context }) => {
    await setTheme(page, theme);
    await page.keyboard.press("Meta+K");
    await page.getByLabel("Search commands").fill("New note");
    await page.getByRole("button", { name: "New note" }).click();
    const operationDialog = page.getByRole("dialog", { name: "New note" });
    const operationInput = operationDialog.getByLabel("Title");
    await operationInput.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(operationInput).toBeFocused();
    const operationColors = await operationInput.evaluate((element) => {
      const style = getComputedStyle(element);
      const adjacent = element.closest(".operation-dialog");
      if (adjacent === null) throw new Error("Operation dialog surface is unavailable.");
      return {
        border: style.borderTopColor,
        inputBackground: style.backgroundColor,
        focusRing: style.outlineColor,
        focusRingStyle: style.outlineStyle,
        focusRingWidth: Number.parseFloat(style.outlineWidth),
        adjacentBackground: getComputedStyle(adjacent).backgroundColor
      };
    });
    expect(contrast(rgb(operationColors.border), rgb(operationColors.adjacentBackground))).toBeGreaterThanOrEqual(3);
    expect(contrast(rgb(operationColors.border), rgb(operationColors.inputBackground))).toBeGreaterThanOrEqual(3);
    expect(operationColors.focusRingStyle).toBe("solid");
    expect(operationColors.focusRingWidth).toBeGreaterThanOrEqual(2);
    expect(contrast(rgb(operationColors.focusRing), rgb(operationColors.adjacentBackground))).toBeGreaterThanOrEqual(3);
    await operationDialog.getByRole("button", { name: "Cancel" }).click();

    await context.setOffline(true);
    try {
      const editor = page.getByLabel("Markdown editor");
      await editor.click();
      await page.keyboard.press("Meta+ArrowDown");
      await page.keyboard.insertText(`Task 8 ${theme} warning contrast\n`);
      const warning = page.locator('.status-callout[data-tone="warning"]');
      await expect(warning).toBeVisible();
      const colors = await computedColorPair(warning);
      expect(contrast(colors.foreground, colors.background)).toBeGreaterThanOrEqual(4.5);
    } finally {
      await context.setOffline(false);
    }

    await page.route("**/api/private/notes/*/publication", async (route, request) => {
      if (request.method() !== "GET") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "DRIVE_UNAVAILABLE",
            message: "The service is temporarily unavailable.",
            requestId: `task-8-${theme}-publication-error`
          }
        })
      });
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("owner-shell")).toBeVisible();
    await setTheme(page, theme);
    const error = page.locator('.status-callout[data-tone="error"]');
    await expect(error).toBeVisible();
    const colors = await computedColorPair(error);
    expect(contrast(colors.foreground, colors.background)).toBeGreaterThanOrEqual(4.5);
  });
}
