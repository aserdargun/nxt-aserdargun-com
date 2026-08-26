import { expect, loginAs, test } from "./fixtures";

const redacted = async (response: { text(): Promise<string> }, forbidden: RegExp): Promise<void> => {
  expect(await response.text()).not.toMatch(forbidden);
};

test("anonymous and wrong-owner private access fail closed", async ({ page }) => {
  const anonymous = await page.request.get("/api/private/session");
  expect(anonymous.status()).toBe(401);
  await loginAs(page, "not-aserdargun");
  const forbidden = await page.request.get("/api/private/session");
  expect(forbidden.status()).toBe(403);
  await redacted(forbidden, /not-aserdargun|StaticWebAppsAuthCookie|file_/u);
});

test("hostile identifiers, traversal, size, and active content uploads stay redacted", async ({ ownerPage: page }) => {
  const noteId = page.url().split("/").at(-1) as string;
  const arbitrary = await page.request.get("/api/private/attachments/raw-drive-id");
  expect(arbitrary.status()).toBe(400);
  await redacted(arbitrary, /raw-drive-id|file_/u);
  expect((await page.request.get("/api/public/notes/not-valid")).status()).toBe(404);
  expect((await page.request.get("/api/public/assets/AAAAAAAAAAAAAAAAAAAAAA/%2e%2e%2fsecret")).status()).toBe(404);
  const note = await (await page.request.get(`/api/private/notes/${noteId}`)).json();
  const oversized = await page.request.put(`/api/private/notes/${noteId}`, {
    data: { expectedVersion: note.version, source: `---\nid: "${noteId}"\ntitle: "Large"\ncreated: "2026-08-23T12:00:00.000Z"\nupdated: "2026-08-23T12:00:00.000Z"\ntags: []\naliases: []\n---\n\n${"x".repeat(100_100)}` }
  });
  expect(oversized.status()).toBe(413);
  for (const [name, mime, bytes] of [["attack.svg", "image/svg+xml", "<svg onload=alert(1) />"], ["attack.html", "text/html", "<script>alert(1)</script>"]] as const) {
    const upload = await page.request.post("/api/private/attachments", {
      data: { noteId, name, declaredMime: mime, bytesBase64: Buffer.from(bytes).toString("base64") }
    });
    expect(upload.status()).toBe(201);
    expect(await upload.json()).toMatchObject({
      asset: { name, mimeType: "application/octet-stream", disposition: "download" }
    });
    await redacted(upload, /alert\(1\)|file_|drive/u);
  }
});

test("corrupt publication manifest remains a generic public 404", async ({ page }) => {
  // @ts-expect-error This is a local-only locked adapter fixture controller.
  const { corruptLocalFixtureManifest } = await import("../scripts/local-fixtures.mjs") as {
    corruptLocalFixtureManifest(input: { checkoutPath: string; fixtureRoot: string }): Promise<void>;
  };
  await corruptLocalFixtureManifest({ checkoutPath: process.cwd(), fixtureRoot: `${process.cwd()}/.nxt-local/fixtures/playwright` });
  const response = await page.request.get("/api/public/notes/AAAAAAAAAAAAAAAAAAAAAA");
  expect(response.status()).toBe(404);
  await redacted(response, /must-not-leak|schemaVersion|file_/u);
});
