import { expect, test } from "./fixtures";

test("owner creates, edits, finds, archives, and reloads a note", async ({ ownerPage: page }) => {
  await page.keyboard.press("Meta+K");
  await page.getByLabel("Search commands").fill("New note");
  await page.getByRole("button", { name: "New note" }).click();
  await page.getByLabel("Title").fill("2026 Planı");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("region", { name: "Editor" }).getByLabel("Active note path: Notes/Inbox/2026 Planı.md")).toBeVisible();
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

  const search = page.getByLabel("Search files");
  await search.fill("2026 Planı");
  const titleResult = page.getByLabel("Search results").getByRole("button", { name: /2026 Planı/u });
  await expect(titleResult).toBeVisible();
  await titleResult.click();

  const wiki = page.getByRole("region", { name: "Preview" }).getByRole("button", { name: "Welcome" });
  await expect(wiki).toBeVisible();
  await wiki.click();
  await expect(page.getByRole("region", { name: "Editor" }).getByLabel("Active note path: Notes/Inbox/Welcome to NXT.md")).toBeVisible();
  await page.getByRole("region", { name: "Tags" }).getByRole("button", { name: /^welcome\s+1$/u }).click();
  await expect(search).toHaveValue("tag:welcome");
  await expect(page.getByLabel("Search results").getByRole("button", { name: /Welcome to NXT/u })).toBeVisible();
  await search.fill("");
  await search.fill("2026 Planı");
  await page.getByLabel("Search results").getByRole("button", { name: /2026 Planı/u }).click();

  await page.keyboard.press("Meta+K");
  await page.getByLabel("Search commands").fill("Archive");
  await page.getByRole("button", { name: "Archive" }).click();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("region", { name: "Editor" }).getByLabel(/Active note path: Notes\/Archive\/2026 Planı\.md/u)).toBeVisible();
  await page.keyboard.press("Meta+K");
  await page.getByLabel("Search commands").fill("Move");
  await page.getByRole("button", { name: "Move" }).click();
  const move = page.getByRole("dialog", { name: "Move note" });
  await move.getByLabel("Destination").selectOption({ label: "Notes/Plans" });
  await move.getByRole("button", { name: "Move" }).click();
  await expect(move).toBeHidden();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("region", { name: "Editor" }).getByLabel(/Active note path: Notes\/Plans\/2026 Planı\.md/u)).toBeVisible();
});
