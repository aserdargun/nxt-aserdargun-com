import type { Locator, Page } from "@playwright/test";

const fixtureRoot = `${process.cwd()}/.nxt-local/fixtures/playwright`;

const tabbableExclusions = ':not([disabled]):not([hidden]):not([inert]):not([tabindex="-1"])';
const tabbableSelector = [
  "a[href]",
  "area[href]",
  "button",
  'input:not([type="hidden"])',
  "select",
  "textarea",
  "iframe",
  "object",
  "embed",
  "audio[controls]",
  "video[controls]",
  "summary:first-of-type",
  "[tabindex]"
].map((selector) => `${selector}${tabbableExclusions}`).join(", ");

export const actualTabbableControls = async (container: Locator): Promise<readonly Locator[]> => {
  const candidates = container.locator(tabbableSelector).filter({ visible: true });
  const tabbable: Locator[] = [];
  for (let index = 0; index < await candidates.count(); index += 1) {
    const candidate = candidates.nth(index);
    const participatesInTabOrder = await candidate.evaluate((element) => {
      if (!(element instanceof HTMLElement) || element.tabIndex < 0) return false;
      if (element.closest("[hidden], [inert]") !== null || element.matches(":disabled")) return false;
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
    });
    if (participatesInTabOrder) tabbable.push(candidate);
  }
  return tabbable;
};

export const openConflictDialog = async (page: Page): Promise<Locator> => {
  const noteId = new URL(page.url()).pathname.split("/").at(-1);
  if (noteId === undefined) throw new Error("The selected fixture note ID is unavailable.");
  const { mutateLocalFixtureNote } = await import("../scripts/local-fixtures.mjs") as {
    mutateLocalFixtureNote(input: {
      checkoutPath: string;
      fixtureRoot: string;
      noteId: string;
      title: string;
      body: string;
    }): Promise<unknown>;
  };
  let releasedRealWrite = false;
  await page.route(`**/api/private/notes/${noteId}`, async (route, request) => {
    if (request.method() === "PUT" && !releasedRealWrite) {
      releasedRealWrite = true;
      await mutateLocalFixtureNote({
        checkoutPath: process.cwd(),
        fixtureRoot,
        noteId,
        title: "Task 8 external title",
        body: "# Task 8 external Drive version\n"
      });
    }
    await route.continue();
  });

  const editor = page.getByLabel("Markdown editor");
  await editor.click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.insertText("Task 8 local concurrent edit\n");
  const dialog = page.getByRole("dialog", { name: "Version conflict" });
  await dialog.waitFor({ state: "visible" });
  if (!releasedRealWrite) throw new Error("The real fixture write was not released.");
  return dialog;
};
