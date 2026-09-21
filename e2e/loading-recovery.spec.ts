import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures";

test("a loading mobile toolbar remains keyboard-scrollable and passes accessibility checks", async ({ ownerPage: page }) => {
  await expect(page.getByLabel("Markdown editor")).toBeVisible();
  const noteId = new URL(page.url()).pathname.split("/").at(-1);
  await page.setViewportSize({ width: 390, height: 844 });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const pattern = `**/api/private/notes/${noteId}`;
  await page.route(pattern, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await held;
    await route.continue();
  });
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("navigation", { name: "Mobile destinations" })
      .getByRole("button", { name: "Editor", exact: true }).click();
    await expect(page.getByText("Loading note…", { exact: true })).toBeVisible();
    const toolbar = page.getByRole("toolbar", { name: "Format toolbar" });
    await expect(toolbar).toHaveAttribute("aria-disabled", "true");
    expect(await toolbar.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await page.getByRole("button", { name: "More actions" }).click();
    await expect(page.getByRole("menu", { name: "More actions" })).toBeVisible();
    const audit = await new AxeBuilder({ page }).analyze();
    expect(audit.violations.filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(toolbar).toHaveAttribute("tabindex", "0");
    await toolbar.focus();
    await expect(toolbar).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => toolbar.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  } finally { release(); }
  await expect(page.getByLabel("Markdown editor")).toBeEditable();
  await expect(page.getByRole("toolbar", { name: "Format toolbar" })).not.toHaveAttribute("tabindex", "0");
});

test("editor modules load while the authorized vault response is still pending", async ({ ownerPage: page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") errors.push(message.text());
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/private/vault?**", async (route) => {
    await held;
    await route.continue();
  });
  // Routing disables the HTTP cache: this proves that the code downloads do
  // not depend on the vault response on a fresh document load.
  const editorRequest = page.waitForRequest((request) => request.url().includes("/editor/markdown-editor.tsx"));
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("status", { name: "Loading vault" })).toBeVisible();
    await editorRequest;
    await expect(page.getByRole("status", { name: "Loading vault" })).toBeVisible();
  } finally { release(); }
  await expect(page.getByLabel("Markdown editor")).toBeVisible();
  await expect(page).toHaveTitle(/NXT/u);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a stalled initial note read times out, retries, and renders usable desktop and mobile views", async ({ ownerPage: page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const noteId = new URL(page.url()).pathname.split("/").at(-1);
  await expect(page.getByLabel("Markdown editor")).toBeVisible();
  await page.clock.install();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let blocked = false;
  const pattern = `**/api/private/notes/${noteId}`;
  await page.route(pattern, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    blocked = true;
    await held;
    // The application's deadline aborts this request. Handling it a second
    // time after cancellation would itself be a Playwright route error.
  });
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(() => blocked).toBe(true);
    await expect(page.getByText("Loading note…", { exact: true })).toBeVisible();
    const aborted = page.waitForEvent("requestfailed", {
      predicate: (request) => request.url().endsWith(`/api/private/notes/${noteId}`)
    });
    await page.clock.fastForward(30_001);
    await aborted;
    await expect(page.getByRole("alert").filter({ hasText: "The note could not be loaded." })).toBeVisible();
    await expect(page.locator(".real-editor-canvas")).toHaveAttribute("aria-busy", "false");
    await page.screenshot({ path: "/tmp/nxt-qa-load-recovery.png" });
  } finally {
    release();
    await page.unroute(pattern);
  }
  await page.getByRole("button", { name: "Retry note" }).click();
  await expect(page.getByLabel("Markdown editor")).toBeVisible();
  await expect(page.getByLabel("Save status")).toHaveText("Saved");
  await page.screenshot({ path: "/tmp/nxt-qa-desktop.png" });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const navigation = page.getByRole("navigation", { name: "Mobile destinations" });
    await navigation.getByRole("button", { name: "Editor", exact: true }).click();
    await expect(page.getByLabel("Markdown editor")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 390) await page.screenshot({ path: "/tmp/nxt-qa-mobile.png" });
  }
  expect(errors).toEqual([]);
});
