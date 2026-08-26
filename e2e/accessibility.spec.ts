import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures";

const expectNoSeriousViolations = async (page: Parameters<typeof AxeBuilder>[0]["page"]): Promise<void> => {
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

test("login, owner workspace, and command dialog have no serious axe violations", async ({ ownerPage: page }) => {
  const tree = page.getByRole("tree", { name: "Files" });
  await expect(tree.locator('button[aria-label$=" actions"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Notes actions" })).toBeAttached();
  await expectNoSeriousViolations(page);
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
    path: "test-results/playwright/task15-command-dialog.png",
    fullPage: true,
    animations: "disabled"
  });
  await page.keyboard.press("Escape");
  await expect(editor).toBeFocused();
  expect(await page.getByLabel("Save status").getAttribute("aria-live")).toBe("polite");
});

test("login route has no serious axe violations", async ({ page }) => {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await expectNoSeriousViolations(page);
});
