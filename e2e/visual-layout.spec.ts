import { expect, test } from "./fixtures";

test("configured viewport is overflow-free and honors reduced motion", async ({ ownerPage: page }, testInfo) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true);
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
        transition: parse(getComputedStyle(document.querySelector(".destination-button") as Element).transitionDuration)
      };
    });
    expect(durations.animation).toEqual([0.01]);
    expect(durations.transition.every((duration) => duration === 0.01)).toBe(true);
  }
});
