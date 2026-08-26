import { expect, test } from "./fixtures";

test("mobile exposes every destination with usable targets and no horizontal overflow", async ({ ownerPage: page }) => {
  const navigation = page.getByRole("navigation", { name: "Mobile destinations" });
  const audited = new Set<string>();
  for (const destination of ["Files", "Editor", "Preview", "Info"] as const) {
    const button = navigation.getByRole("button", { name: destination });
    await button.click();
    await expect(page.getByRole("region", { name: destination }).first()).toBeVisible();
    const box = await button.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    const audit = await page.evaluate(() => {
      const selector = 'button, a[href], input:not([type="hidden"]), select, textarea, [role="treeitem"], [contenteditable="true"]';
      const failures: string[] = [];
      const exceptions: string[] = [];
      for (const element of document.querySelectorAll<HTMLElement>(selector)) {
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        if (style.visibility === "hidden" || style.display === "none" || bounds.width === 0 || bounds.height === 0) continue;
        const label = element.getAttribute("aria-label") ?? element.textContent?.trim().replace(/\s+/gu, " ") ?? element.tagName;
        if (element.matches("button.wiki-link") && style.display === "inline") {
          exceptions.push(`inline-wiki:${label}`);
          continue;
        }
        if (bounds.width < 44 || bounds.height < 44) failures.push(`${element.tagName}:${label}:${bounds.width}x${bounds.height}`);
      }
      return { failures, exceptions };
    });
    expect(audit.failures, `${destination} has undersized visible controls`).toEqual([]);
    for (const exception of audit.exceptions) audited.add(exception);
  }
  expect([...audited].every((item) => item.startsWith("inline-wiki:"))).toBe(true);
  await navigation.getByRole("button", { name: "Editor" }).click();
  await expect(page.getByLabel("Markdown editor")).toBeEditable();
  expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({
    path: "test-results/playwright/task15-mobile-workspace.png",
    fullPage: true,
    animations: "disabled"
  });
});
