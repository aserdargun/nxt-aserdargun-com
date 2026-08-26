import { expect, test as base, type Page } from "@playwright/test";

export const loginAs = async (page: Page, userDetails = "aserdargun"): Promise<void> => {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: "Continue with GitHub" }).click();
  await expect(page.getByRole("heading", { name: "Azure Static Web Apps Auth" })).toBeVisible();
  await expect(page.getByLabel("User ID")).not.toHaveValue("");
  await expect(page.getByLabel("User's claims")).toHaveValue("[]");
  const username = page.getByLabel("Username");
  await username.fill(userDetails);
  await username.press("End");
  await expect(username).toHaveValue(userDetails);
  const roles = page.getByLabel("User's roles");
  await roles.fill("authenticated");
  await roles.press("End");
  await username.press("Enter");
  await page.waitForFunction(() => window.location.pathname === "/app" || window.location.pathname.startsWith("/app/"));
};

export const test = base.extend<{ ownerPage: Page }>({
  ownerPage: async ({ page }, use) => {
    await loginAs(page);
    await expect(page.getByTestId("owner-shell")).toBeVisible();
    await use(page);
  }
});

export { expect } from "@playwright/test";
