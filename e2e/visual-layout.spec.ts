import { actualTabbableControls, openConflictDialog } from "./acceptance-helpers";
import { expect, test } from "./fixtures";

test("configured viewport is overflow-free and honors reduced motion", async ({ ownerPage: page }, testInfo) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true);
  if (testInfo.project.name === "mobile-chromium") {
    const navigation = page.getByRole("navigation", { name: "Mobile destinations" });
    await navigation.getByRole("button", { name: "Files" }).click();
    const workspaceActions = await actualTabbableControls(page.getByRole("region", { name: "Files", exact: true }));
    const lastWorkspaceAction = workspaceActions.at(-1);
    if (lastWorkspaceAction === undefined) throw new Error("The Files surface does not expose a final tab stop.");
    expect(await lastWorkspaceAction.evaluate((element) => element.tabIndex)).toBeGreaterThanOrEqual(0);
    await lastWorkspaceAction.focus();
    const mobileOverlap = await lastWorkspaceAction.evaluate((element) => {
      const navigationElement = document.querySelector<HTMLElement>(".mobile-destinations");
      if (navigationElement === null) throw new Error("Mobile destination navigation is unavailable.");
      const target = element.getBoundingClientRect();
      const navigation = navigationElement.getBoundingClientRect();
      const coveredHeight = Math.max(0, Math.min(target.bottom, navigation.bottom) - Math.max(target.top, navigation.top));
      return { coveredHeight, targetHeight: target.height };
    });
    expect(mobileOverlap.coveredHeight).toBeLessThan(mobileOverlap.targetHeight);

    await navigation.getByRole("button", { name: "Editor" }).click();
    const conflict = await openConflictDialog(page);
    const footer = conflict.locator(".conflict-actions");
    await expect(footer).toHaveCSS("position", "sticky");
    const conflictPaneTargets = await actualTabbableControls(conflict.locator(".conflict-panes"));
    const lastFocusTargetAboveFooter = conflictPaneTargets.at(-1);
    if (lastFocusTargetAboveFooter === undefined) throw new Error("The conflict panes do not expose a final tab stop.");
    expect(await lastFocusTargetAboveFooter.evaluate((element) => element.tabIndex)).toBeGreaterThanOrEqual(0);
    await lastFocusTargetAboveFooter.focus();
    const dialogOverlap = await lastFocusTargetAboveFooter.evaluate((element) => {
      const footerElement = element.closest("[role=dialog]")?.querySelector<HTMLElement>(".conflict-actions");
      if (footerElement === undefined || footerElement === null) throw new Error("Sticky conflict footer is unavailable.");
      const target = element.getBoundingClientRect();
      const stickyFooter = footerElement.getBoundingClientRect();
      const coveredHeight = Math.max(0, Math.min(target.bottom, stickyFooter.bottom) - Math.max(target.top, stickyFooter.top));
      return { coveredHeight, targetHeight: target.height };
    });
    expect(dialogOverlap.coveredHeight).toBeLessThan(dialogOverlap.targetHeight);
  }
  if (testInfo.project.name === "reduced-motion-chromium") {
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
    await page.keyboard.press("Meta+K");
    const durations = await page.getByRole("dialog", { name: "Commands" }).evaluate((dialog) => {
      const parse = (value: string): number[] => value.split(",").map((part) => {
        const normalized = part.trim();
        return normalized.endsWith("ms") ? Number.parseFloat(normalized) : Number.parseFloat(normalized) * 1_000;
      });
      return {
        animation: parse(getComputedStyle(dialog).animationDuration),
        transition: parse(getComputedStyle(dialog).transitionDuration)
      };
    });
    expect(durations.animation).toEqual([0.01]);
    expect(durations.transition.every((duration) => duration === 0.01)).toBe(true);
  }
});
