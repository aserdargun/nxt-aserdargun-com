import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { mutateLocalFixtureNote, seedLocalFixtures } from "../scripts/local-fixtures.mjs";

const makeCheckout = async () => {
  const checkout = await realpath(await mkdtemp(join(tmpdir(), "nxt-e2e-fixtures-")));
  await mkdir(join(checkout, ".nxt-local", "fixtures"), { recursive: true });
  return checkout;
};

test("seeds one exact checkout-owned LocalDriveAdapter fixture and serializes an external write", async (context) => {
  const checkout = await makeCheckout();
  context.after(() => rm(checkout, { recursive: true, force: true }));
  const fixtureRoot = join(checkout, ".nxt-local", "fixtures", "playwright");

  const seeded = await seedLocalFixtures({ checkoutPath: checkout, fixtureRoot, environment: {} });
  assert.equal(seeded.fixtureRoot, fixtureRoot);
  assert.deepEqual(Object.keys(seeded.ids).sort(), [
    "archive", "assets", "inbox", "index", "manifest", "notes", "plans", "preferences", "published", "seedImage", "seedNote"
  ]);
  assert.match(await readFile(join(fixtureRoot, ".fixture.json"), "utf8"), /"seedNote"/u);

  const changed = await mutateLocalFixtureNote({
    checkoutPath: checkout,
    fixtureRoot,
    noteId: "018f47d2-6a34-7b2a-9f21-8a7034963aef",
    title: "External title",
    body: "# External body\n"
  });
  assert.equal(changed.title, "External title");
  assert.notEqual(changed.previousVersion, changed.version);
});

test("refuses traversal, symlink, pre-existing, and live Drive fixture roots", async (context) => {
  const checkout = await makeCheckout();
  context.after(() => rm(checkout, { recursive: true, force: true }));
  const fixtures = join(checkout, ".nxt-local", "fixtures");
  const outside = await mkdtemp(join(tmpdir(), "nxt-outside-fixture-"));
  context.after(() => rm(outside, { recursive: true, force: true }));

  await assert.rejects(seedLocalFixtures({ checkoutPath: checkout, fixtureRoot: outside, environment: {} }), /Refusing unsafe local fixture root/u);
  await mkdir(join(fixtures, "existing"));
  await assert.rejects(seedLocalFixtures({ checkoutPath: checkout, fixtureRoot: join(fixtures, "existing"), environment: {} }), /Refusing pre-existing local fixture root/u);
  await symlink(outside, join(fixtures, "linked"));
  await assert.rejects(seedLocalFixtures({ checkoutPath: checkout, fixtureRoot: join(fixtures, "linked"), environment: {} }), /Refusing unsafe local fixture root/u);
  await assert.rejects(seedLocalFixtures({
    checkoutPath: checkout,
    fixtureRoot: join(fixtures, "live"),
    environment: { GOOGLE_REFRESH_TOKEN: "must-not-be-read" }
  }), /Refusing live Drive environment key GOOGLE_REFRESH_TOKEN/u);
});
