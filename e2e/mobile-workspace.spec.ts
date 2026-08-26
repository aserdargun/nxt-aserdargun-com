import { expect, test } from "./fixtures";

test("mobile exposes every destination with usable targets and no horizontal overflow", async ({ ownerPage: page }) => {
  const navigation = page.getByRole("navigation", { name: "Mobile destinations" });
  for (const destination of ["Files", "Editor", "Preview", "Info"] as const) {
    const button = navigation.getByRole("button", { name: destination });
    await button.click();
    await expect(page.getByRole("region", { name: destination }).first()).toBeVisible();
    const box = await button.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  await navigation.getByRole("button", { name: "Editor" }).click();
  await expect(page.getByLabel("Markdown editor")).toBeEditable();
  expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({
    path: "test-results/playwright/task15-mobile-workspace.png",
    fullPage: true,
    animations: "disabled"
  });
});
