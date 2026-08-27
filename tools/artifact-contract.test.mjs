import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { assertSafeApiDistTarget, buildApi } from "../scripts/build-api.mjs";
import { verifyArtifacts } from "../scripts/verify-artifacts.mjs";

const checkout = process.cwd();
const run = promisify(execFile);

const hashTree = async (root) => {
  const hash = createHash("sha256");
  const visit = async (directory, prefix = "") => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = join(prefix, entry.name);
      hash.update(relative);
      assert.equal(entry.isSymbolicLink(), false, `${relative} must not be a symlink`);
      if (entry.isDirectory()) await visit(join(directory, entry.name), relative);
      else hash.update(await readFile(join(directory, entry.name)));
    }
  };
  await visit(root);
  return hash.digest("hex");
};

test("API build is deterministic and emits the minimal Functions v4 artifact", async () => {
  await buildApi({ checkoutPath: checkout });
  const first = await hashTree(join(checkout, "api-dist"));
  await buildApi({ checkoutPath: checkout });
  const second = await hashTree(join(checkout, "api-dist"));
  assert.equal(second, first);

  const files = (await readdir(join(checkout, "api-dist"))).sort();
  assert.deepEqual(files, ["host.json", "index.js", "package.json"]);
  const pkg = JSON.parse(await readFile(join(checkout, "api-dist/package.json"), "utf8"));
  assert.deepEqual(pkg, {
    name: "nxt-api-artifact",
    private: true,
    type: "module",
    main: "index.js",
    dependencies: {
      "@azure/functions": "4.16.2",
      "file-type": "22.0.2",
      "googleapis": "176.0.0"
    }
  });
  assert.doesNotMatch(await readFile(join(checkout, "api-dist/index.js"), "utf8"), /sourceMappingURL/u);
});

test("API artifact starts from an isolated deployment root after runtime dependencies are installed", async (t) => {
  await buildApi({ checkoutPath: checkout });
  const temporary = await mkdtemp(join(tmpdir(), "nxt-api-runtime-"));
  t.after(async () => rm(temporary, { recursive: true, force: true }));
  await cp(join(checkout, "api-dist"), temporary, { recursive: true });
  await mkdir(join(temporary, "node_modules", "@azure"), { recursive: true });
  for (const dependency of ["@azure/functions", "file-type", "googleapis"]) {
    const source = await realpath(join(checkout, "api", "node_modules", dependency));
    await symlink(source, join(temporary, "node_modules", dependency));
  }

  await assert.doesNotReject(
    run(process.execPath, ["index.js"], { cwd: temporary, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })
  );
});

test("API build target guard refuses symlinks, checkout roots, and foreign paths", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "nxt-api-target-"));
  t.after(async () => import("node:fs/promises").then(({ rm }) => rm(temporary, { recursive: true, force: true })));
  await mkdir(join(temporary, "checkout"));
  await mkdir(join(temporary, "foreign"));
  await symlink(join(temporary, "foreign"), join(temporary, "checkout", "api-dist"));
  await assert.rejects(assertSafeApiDistTarget(join(temporary, "checkout"), join(temporary, "checkout", "api-dist")), /refus/i);
  await assert.rejects(assertSafeApiDistTarget(join(temporary, "checkout"), join(temporary, "checkout")), /refus/i);
  await assert.rejects(assertSafeApiDistTarget(join(temporary, "checkout"), join(temporary, "foreign")), /refus/i);
});

test("artifact verifier accepts the production trees and never reports secret values", async () => {
  await buildApi({ checkoutPath: checkout });
  await assert.doesNotReject(verifyArtifacts({ checkoutPath: checkout }));

  const entry = join(checkout, "api-dist", "index.js");
  const original = await readFile(entry, "utf8");
  const secret = `secret-${crypto.randomUUID()}`;
  process.env.GOOGLE_CLIENT_SECRET = secret;
  await writeFile(entry, `${original}\n/* ${secret} */\n`);
  try {
    await assert.rejects(
      verifyArtifacts({ checkoutPath: checkout }),
      (error) => error instanceof Error && error.message.includes("GOOGLE_CLIENT_SECRET") && !error.message.includes(secret)
    );
  } finally {
    delete process.env.GOOGLE_CLIENT_SECRET;
    await writeFile(entry, original);
  }
});

test("artifact verifier refuses extra API files and artifact symlinks", async () => {
  await buildApi({ checkoutPath: checkout });
  const extra = join(checkout, "api-dist", "unexpected.txt");
  await writeFile(extra, "unexpected");
  await assert.rejects(verifyArtifacts({ checkoutPath: checkout }), /structure/u);
  await rm(extra);

  const link = join(checkout, "web", "dist", "unsafe-link.txt");
  await symlink(join(checkout, "web", "dist", "index.html"), link);
  try {
    await assert.rejects(verifyArtifacts({ checkoutPath: checkout }), /symlink/u);
  } finally {
    await rm(link);
  }
});

test("artifact verifier refuses symlinked web and API artifact roots", async (t) => {
  await buildApi({ checkoutPath: checkout });
  const temporary = await mkdtemp(join(tmpdir(), "nxt-artifact-roots-"));
  t.after(async () => rm(temporary, { recursive: true, force: true }));

  const webLinkCheckout = join(temporary, "web-link");
  await mkdir(join(webLinkCheckout, "web"), { recursive: true });
  await cp(join(checkout, "api-dist"), join(webLinkCheckout, "api-dist"), { recursive: true });
  await symlink(join(checkout, "web", "dist"), join(webLinkCheckout, "web", "dist"));
  await assert.rejects(verifyArtifacts({ checkoutPath: webLinkCheckout }), /symlink|root/u);

  const apiLinkCheckout = join(temporary, "api-link");
  await mkdir(join(apiLinkCheckout, "web"), { recursive: true });
  await cp(join(checkout, "web", "dist"), join(apiLinkCheckout, "web", "dist"), { recursive: true });
  await symlink(join(checkout, "api-dist"), join(apiLinkCheckout, "api-dist"));
  await assert.rejects(verifyArtifacts({ checkoutPath: apiLinkCheckout }), /symlink|root/u);
});
