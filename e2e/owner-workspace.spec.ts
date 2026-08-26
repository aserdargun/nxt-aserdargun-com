import { expect, test } from "./fixtures";

test("owner creates, edits, finds, archives, and reloads a note", async ({ ownerPage: page }) => {
  await page.keyboard.press("Meta+K");
  await page.getByLabel("Search commands").fill("New note");
  await page.getByRole("button", { name: "New note" }).click();
  await page.getByLabel("Title").fill("2026 Planı");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByLabel("Markdown editor")).toBeVisible();
  const editor = page.getByLabel("Markdown editor");
  await editor.click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText("# Plan\n\n[[Welcome]]\n\n#2026\n");
  await expect(editor).toContainText("#2026");
  await expect(page.getByLabel("Save status")).toHaveText("Saved");
  await expect(page.getByRole("heading", { name: "Plan", level: 1 })).toBeVisible();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Markdown editor")).toContainText("#2026");
  await page.keyboard.press("Meta+K");
  await page.getByLabel("Search commands").fill("Archive");
  await page.getByRole("button", { name: "Archive" }).click();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("region", { name: "Editor" }).getByLabel(/Active note path: Notes\/Archive\/2026 Planı\.md/u)).toBeVisible();
});
