import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import YAML from "yaml";

const run = promisify(execFile);
const checkout = process.cwd();
const checkoutSha = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const setupNodeSha = "820762786026740c76f36085b0efc47a31fe5020";
const deploySha = "4d27395796ac319302594769cfe812bd207490b1";

const loadContract = () => import("../scripts/verify-deployment-contract.mjs");

test("pure source verification accepts the intentionally named implementation worktree", async () => {
  const { verifySourceContract } = await loadContract();
  const result = await verifySourceContract({ checkoutPath: checkout });
  assert.deepEqual(result, {
    repository: "nxt-aserdargun-com",
    workflow: "deploy-swa-nxt-aserdargun-com.yml",
    resourceGroup: "rg-nxt-aserdargun-com",
    staticWebApp: "swa-nxt-aserdargun-com",
    secret: "AZURE_STATIC_WEB_APPS_API_TOKEN_SWA_NXT_ASERDARGUN_COM"
  });
});

test("PR and deployment workflows pin permissions, platforms, gates, and prebuilt upload", async () => {
  const ci = YAML.parse(await readFile(".github/workflows/ci.yml", "utf8"));
  const deploy = YAML.parse(await readFile(".github/workflows/deploy-swa-nxt-aserdargun-com.yml", "utf8"));
  assert.deepEqual(Object.keys(ci.on).sort(), ["pull_request", "workflow_dispatch"]);
  assert.deepEqual(ci.permissions, { contents: "read" });
  assert.equal(ci.jobs.portable["runs-on"], "ubuntu-latest");
  assert.deepEqual(ci.jobs.portable.env, { NXT_VITEST_MAX_WORKERS: "1" });
  assert.equal(ci.jobs.macos_acceptance["runs-on"], "macos-latest");
  assert.deepEqual(ci.jobs.macos_acceptance.env, {
    NODE_OPTIONS: "--max-old-space-size=4096",
    NXT_VITEST_TEST_TIMEOUT_MS: "15000",
    NXT_VITEST_MAX_WORKERS: "1"
  });
  assert.match(ci.jobs.macos_acceptance.steps.map((step) => step.run ?? "").join("\n"), /azure-functions-core-tools@4\.13\.0/u);
  assert.match(ci.jobs.macos_acceptance.steps.map((step) => step.run ?? "").join("\n"), /func --version/u);
  assert.match(ci.jobs.macos_acceptance.steps.map((step) => step.run ?? "").join("\n"), /pnpm validate:macos/u);

  assert.deepEqual(Object.keys(deploy.on).sort(), ["push", "workflow_dispatch"]);
  assert.deepEqual(deploy.on.push.branches, ["main"]);
  assert.deepEqual(deploy.permissions, { contents: "read" });
  assert.deepEqual(deploy.concurrency, { group: "swa-nxt-aserdargun-com-production", "cancel-in-progress": false });
  assert.deepEqual(deploy.jobs.portable.env, { NXT_VITEST_MAX_WORKERS: "1" });
  assert.deepEqual(deploy.jobs.deploy.needs, ["portable", "macos_acceptance"]);
  assert.deepEqual(deploy.jobs.macos_acceptance.env, {
    NODE_OPTIONS: "--max-old-space-size=4096",
    NXT_VITEST_TEST_TIMEOUT_MS: "15000",
    NXT_VITEST_MAX_WORKERS: "1"
  });
  assert.equal(deploy.jobs.deploy.if, "github.ref == 'refs/heads/main'");
  assert.deepEqual(deploy.jobs.deploy.env, { NXT_VITEST_MAX_WORKERS: "1" });
  const upload = deploy.jobs.deploy.steps.find((step) => step.name === "Deploy prebuilt artifacts");
  assert.deepEqual(upload.with, {
    azure_static_web_apps_api_token: "${{ secrets.AZURE_STATIC_WEB_APPS_API_TOKEN_SWA_NXT_ASERDARGUN_COM }}",
    action: "upload",
    app_location: "web/dist",
    api_location: "api-dist",
    output_location: "",
    skip_app_build: true,
    skip_api_build: true
  });

  const allUses = [ci, deploy].flatMap((workflow) => Object.values(workflow.jobs))
    .flatMap((job) => job.steps).flatMap((step) => step.uses === undefined ? [] : [step.uses]);
  assert.ok(allUses.length > 0);
  assert.ok(allUses.every((value) => [
    `actions/checkout@${checkoutSha}`,
    `actions/setup-node@${setupNodeSha}`,
    `Azure/static-web-apps-deploy@${deploySha}`
  ].includes(value)), `unexpected floating action: ${allUses.join(",")}`);
  assert.doesNotMatch(JSON.stringify([ci, deploy]), /id-token|github_id_token/u);
});

test("release identity accepts only a clean exact main checkout and exact origin", async (context) => {
  const { verifyReleaseIdentity } = await loadContract();
  const parent = await mkdtemp(join(tmpdir(), "nxt-release-identity-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const exact = join(parent, "nxt-aserdargun-com");
  await mkdir(exact);
  await mkdir(join(exact, ".github", "workflows"), { recursive: true });
  const ciSource = await readFile(join(checkout, ".github", "workflows", "ci.yml"), "utf8");
  const deploySource = await readFile(join(checkout, ".github", "workflows", "deploy-swa-nxt-aserdargun-com.yml"), "utf8");
  await writeFile(join(exact, ".github", "workflows", "ci.yml"), ciSource);
  await writeFile(join(exact, ".github", "workflows", "deploy-swa-nxt-aserdargun-com.yml"), deploySource);
  await run("git", ["init", "-b", "main"], { cwd: exact });
  await run("git", ["config", "user.email", "test@example.invalid"], { cwd: exact });
  await run("git", ["config", "user.name", "NXT test"], { cwd: exact });
  await writeFile(join(exact, "tracked.txt"), "tracked\n");
  await run("git", ["add", "."], { cwd: exact });
  await run("git", ["commit", "-m", "fixture"], { cwd: exact });
  await run("git", ["remote", "add", "origin", "https://github.com/aserdargun/nxt-aserdargun-com.git"], { cwd: exact });
  assert.equal((await verifyReleaseIdentity({ checkoutPath: exact })).repository, "nxt-aserdargun-com");

  await writeFile(join(exact, ".github", "workflows", "ci.yml"), ciSource.replace("pull_request:", "push:"));
  await assert.rejects(verifyReleaseIdentity({ checkoutPath: exact }), /PR trigger mismatch/u);
  await writeFile(join(exact, ".github", "workflows", "ci.yml"), ciSource);

  await writeFile(join(exact, ".github", "workflows", "deploy-swa-nxt-aserdargun-com.yml"), deploySource.replace("    if: github.ref == 'refs/heads/main'\n", "    if: github.ref != 'refs/heads/main'\n"));
  await assert.rejects(verifyReleaseIdentity({ checkoutPath: exact }), /main-ref gate/u);
  await writeFile(join(exact, ".github", "workflows", "deploy-swa-nxt-aserdargun-com.yml"), deploySource);

  await writeFile(join(exact, "untracked.txt"), "dirty\n");
  await assert.rejects(verifyReleaseIdentity({ checkoutPath: exact }), /clean exact release checkout/u);
  await assert.rejects(
    verifyReleaseIdentity({ checkoutPath: join(exact, ".github") }),
    /exact release checkout/u
  );
});
