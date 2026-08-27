import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=", "base64");
const expectNoSeriousViolations = async (page: Parameters<typeof AxeBuilder>[0]["page"], include?: string): Promise<void> => {
  const builder = new AxeBuilder({ page });
  const results = await (include === undefined ? builder : builder.include(include)).analyze();
  expect(results.violations.filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual([]);
};

test("persisted raster publishes as an unlisted snapshot and revoke makes it generic 404", async ({ ownerPage: page }) => {
  await page.keyboard.press("Meta+K");
  await page.getByLabel("Search commands").fill("New note");
  await page.getByRole("button", { name: "New note" }).click();
  await page.getByLabel("Title").fill("Publication proof");
  await page.getByRole("button", { name: "Create" }).click();
  const editor = page.getByLabel("Markdown editor");
  await editor.click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText("# Public proof\n");
  await expect(page.getByLabel("Save status")).toHaveText("Saved");
  await page.getByLabel("Add attachment").setInputFiles({ name: "browser-proof.png", mimeType: "image/png", buffer: png });
  await expect(page.getByRole("region", { name: "Preview" }).getByAltText("browser-proof.png")).toBeVisible();
  await expect(editor).toContainText("browser-proof.png");
  await expect(page.getByLabel("Save status")).toHaveText("Saved");
  await page.getByRole("button", { name: "Publish" }).click();
  const publishDialog = page.getByRole("dialog", { name: "Publish note" });
  await expect(publishDialog).toHaveCSS("opacity", "1");
  await expectNoSeriousViolations(page, ".publish-dialog");
  await publishDialog.getByRole("button", { name: "Publish snapshot" }).click();
  const publicLink = page.getByRole("link", { name: "Open link" });
  await expect(publicLink).toBeVisible();
  const publicPath = await publicLink.getAttribute("href");
  expect(publicPath).toMatch(/^\/p\/[A-Za-z0-9_-]{22}$/u);

  const browser = page.context().browser();
  expect(browser).not.toBeNull();
  const publicContext = await browser!.newContext({
    baseURL: "http://127.0.0.1:4280",
    viewport: { width: 1440, height: 1000 }
  });
  const publicPage = await publicContext.newPage();
  const privateRequests: string[] = [];
  try {
    publicPage.on("request", (request) => { if (request.url().includes("/api/private/") || request.url().includes("/.auth/me")) privateRequests.push(request.url()); });
    await publicPage.goto(publicPath as string, { waitUntil: "domcontentloaded" });
    await expect(publicPage.getByRole("heading", { level: 1, name: "Publication proof" })).toBeVisible();
    const publicImage = publicPage.locator(".rendered-markdown").getByAltText("browser-proof.png");
    await expect(publicImage).toBeVisible();
    expect(privateRequests).toEqual([]);
    await expect(publicPage.getByTestId("owner-shell")).toHaveCount(0);
    expect(await publicPage.locator('meta[name="robots"]').getAttribute("content")).toBe("noindex,nofollow");
    const imageResponse = await publicPage.request.get(await publicImage.getAttribute("src") as string);
    expect(imageResponse.status()).toBe(200);
    expect(imageResponse.headers()["content-type"]).toBe("image/png");
    await expectNoSeriousViolations(publicPage);
    await publicPage.screenshot({
      path: "test-results/playwright/task15-public-note.png",
      fullPage: true,
      animations: "disabled"
    });
  } finally {
    await publicContext.close();
  }

  await page.getByRole("button", { name: "Revoke" }).click();
  const revokeDialog = page.getByRole("dialog", { name: "Revoke publication" });
  await expect(revokeDialog).toHaveCSS("opacity", "1");
  await expectNoSeriousViolations(page, ".revoke-dialog");
  await revokeDialog.getByRole("button", { name: "Confirm revoke" }).click();
  await expect(publicLink).toHaveCount(0);
  const anonymousVerifier = await browser!.newContext({ baseURL: "http://127.0.0.1:4280" });
  const revoked = await anonymousVerifier.request.get(publicPath as string);
  expect(revoked.status()).toBe(200);
  const publicId = (publicPath as string).split("/").at(-1) as string;
  try {
    let revokedApi = await anonymousVerifier.request.get(`/api/public/notes/${publicId}`);
    await expect.poll(async () => {
      revokedApi = await anonymousVerifier.request.get(`/api/public/notes/${publicId}`, {
        headers: { "cache-control": "no-cache", pragma: "no-cache" }
      });
      return revokedApi.status();
    }, { timeout: 10_000, intervals: [250, 500, 1_000] }).toBe(404);
    expect(await revokedApi.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  } finally {
    await anonymousVerifier.close();
  }
});
