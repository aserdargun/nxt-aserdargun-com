import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures";

const fixtureRoot = `${process.cwd()}/.nxt-local/fixtures/playwright`;

test("offline draft survives reload and returns online cleanly", async ({ ownerPage: page, context }) => {
  const editor = page.getByLabel("Markdown editor");
  await editor.click();
  await page.keyboard.press("Meta+ArrowDown");
  await context.setOffline(true);
  try {
    await page.keyboard.insertText("Offline draft marker\n");
    await expect(page.getByLabel("Save status")).toHaveText("Offline draft");
  } finally {
    await context.setOffline(false);
  }
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Markdown editor")).toContainText("Offline draft marker");
});

test("serialized external write opens the three-choice conflict without losing either version", async ({ ownerPage: page }) => {
  const noteId = page.url().split("/").at(-1);
  expect(noteId).toBe("018f47d2-6a34-7b2a-9f21-8a7034963aef");
  // @ts-expect-error The fixture mutation controller is a local-only Node module outside the web bundle.
  const { mutateLocalFixtureNote } = await import("../scripts/local-fixtures.mjs") as {
    mutateLocalFixtureNote(input: { checkoutPath: string; fixtureRoot: string; noteId: string; title: string; body: string }): Promise<unknown>;
  };
  const editor = page.getByLabel("Markdown editor");
  let releasedRealWrite = false;
  await page.route(`**/api/private/notes/${noteId}`, async (route, request) => {
    if (request.method() === "PUT" && !releasedRealWrite) {
      releasedRealWrite = true;
      await mutateLocalFixtureNote({
        checkoutPath: process.cwd(), fixtureRoot, noteId: noteId as string,
        title: "External title", body: "# External Drive version\n"
      });
    }
    // This is only a concurrency barrier: the request and response remain the real SWA/Functions exchange.
    await route.continue();
  });
  await editor.click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.insertText("Local concurrent edit\n");
  const dialog = page.getByRole("dialog", { name: "Version conflict" });
  await expect(dialog).toBeVisible();
  expect(releasedRealWrite).toBe(true);
  await expect(dialog).toHaveCSS("opacity", "1");
  await expect(dialog.getByText("External Drive version")).toBeVisible();
  await expect(dialog.getByText("Local concurrent edit")).toBeVisible();
  for (const choice of ["Keep Drive version", "Save local as a new note", "Merge versions"]) {
    await expect(dialog.getByRole("button", { name: choice })).toBeVisible();
  }
  const axe = await new AxeBuilder({ page }).include(".conflict-dialog").analyze();
  expect(axe.violations.filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual([]);
});
