import { expect, test } from "./fixtures";

test("configured viewport is overflow-free and honors reduced motion", async ({ ownerPage: page }, testInfo) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true);
  if (testInfo.project.name === "reduced-motion-chromium") {
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  }
});
