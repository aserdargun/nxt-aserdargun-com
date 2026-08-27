import { execFile } from "node:child_process";
import { readFile, readdir, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import YAML from "yaml";

const run = promisify(execFile);
const expected = Object.freeze({
  repository: "nxt-aserdargun-com",
  workflow: "deploy-swa-nxt-aserdargun-com.yml",
  resourceGroup: "rg-nxt-aserdargun-com",
  staticWebApp: "swa-nxt-aserdargun-com",
  secret: "AZURE_STATIC_WEB_APPS_API_TOKEN_SWA_NXT_ASERDARGUN_COM"
});
const checkoutAction = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const setupNodeAction = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const deployAction = "Azure/static-web-apps-deploy@4d27395796ac319302594769cfe812bd207490b1";
const exactOrigins = new Set([
  "https://github.com/aserdargun/nxt-aserdargun-com.git",
  "git@github.com:aserdargun/nxt-aserdargun-com.git"
]);

const refuse = (message) => new Error(`Refusing deployment contract: ${message}.`);
const readWorkflow = async (checkout, name) => YAML.parse(await readFile(join(checkout, ".github", "workflows", name), "utf8"));
const workflowUses = (workflow) => Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? [])
  .flatMap((step) => typeof step.uses === "string" ? [step.uses] : []);
const assertPinnedUses = (workflow) => {
  const uses = workflowUses(workflow);
  if (uses.length === 0 || !uses.every((value) => [checkoutAction, setupNodeAction, deployAction].includes(value))) {
    throw refuse("workflow action pin mismatch");
  }
};
const assertReadOnly = (workflow) => {
  if (JSON.stringify(workflow.permissions) !== JSON.stringify({ contents: "read" })) throw refuse("workflow permissions mismatch");
  if (/id-token|github_id_token/u.test(JSON.stringify(workflow))) throw refuse("OIDC input is forbidden");
};
const commands = (job) => (job?.steps ?? []).map((step) => step.run ?? "").join("\n");

export const verifySourceContract = async ({ checkoutPath }) => {
  const checkout = await realpath(resolve(checkoutPath));
  const ci = await readWorkflow(checkout, "ci.yml");
  const deploy = await readWorkflow(checkout, expected.workflow);
  if (JSON.stringify(Object.keys(ci.on ?? {}).sort()) !== JSON.stringify(["pull_request", "workflow_dispatch"])) throw refuse("PR trigger mismatch");
  if (JSON.stringify(Object.keys(deploy.on ?? {}).sort()) !== JSON.stringify(["push", "workflow_dispatch"]) ||
      JSON.stringify(deploy.on.push?.branches) !== JSON.stringify(["main"])) throw refuse("deployment trigger mismatch");
  assertReadOnly(ci);
  assertReadOnly(deploy);
  assertPinnedUses(ci);
  assertPinnedUses(deploy);
  if (workflowUses(ci).includes(deployAction)) throw refuse("PR workflow cannot deploy");
  const workflowDirectory = join(checkout, ".github", "workflows");
  const azureWorkflows = [];
  for (const entry of await readdir(workflowDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$/u.test(entry.name)) continue;
    const candidate = await readWorkflow(checkout, entry.name);
    if (workflowUses(candidate).includes(deployAction)) azureWorkflows.push(entry.name);
  }
  if (JSON.stringify(azureWorkflows) !== JSON.stringify([expected.workflow])) throw refuse("exactly one authoritative Azure deployment workflow is required");
  if (ci.jobs?.portable?.["runs-on"] !== "ubuntu-latest" || ci.jobs?.macos_acceptance?.["runs-on"] !== "macos-latest") throw refuse("CI platform split mismatch");
  const macosCommands = commands(ci.jobs.macos_acceptance);
  if (!macosCommands.includes("azure-functions-core-tools@4.13.0") || !macosCommands.includes("func --version") || !macosCommands.includes("pnpm validate:macos")) throw refuse("macOS acceptance gate mismatch");
  if (deploy.concurrency?.group !== "swa-nxt-aserdargun-com-production" || deploy.concurrency?.["cancel-in-progress"] !== false) throw refuse("deployment concurrency mismatch");
  if (JSON.stringify(deploy.jobs?.deploy?.needs) !== JSON.stringify(["portable", "macos_acceptance"])) throw refuse("deployment prerequisite mismatch");
  if (deploy.jobs?.deploy?.if !== "github.ref == 'refs/heads/main'") throw refuse("deployment main-ref gate mismatch");
  const upload = deploy.jobs?.deploy?.steps?.find((step) => step.name === "Deploy prebuilt artifacts");
  if (upload?.uses !== deployAction || upload.with?.azure_static_web_apps_api_token !== "${{ secrets.AZURE_STATIC_WEB_APPS_API_TOKEN_SWA_NXT_ASERDARGUN_COM }}" ||
      upload.with?.action !== "upload" || upload.with?.app_location !== "web/dist" || upload.with?.api_location !== "api-dist" ||
      upload.with?.output_location !== "" || upload.with?.skip_app_build !== true ||
      ![undefined, false].includes(upload.with?.skip_api_build)) {
    throw refuse("prebuilt Azure upload mismatch");
  }
  return { ...expected };
};

const runGit = async (checkout, args) => {
  try {
    const result = await run("git", args, { cwd: checkout, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    return result.stdout.trim();
  } catch {
    throw refuse("git release identity could not be verified");
  }
};

export const verifyReleaseIdentity = async ({ checkoutPath }) => {
  const checkout = await realpath(resolve(checkoutPath));
  if (basename(checkout) !== expected.repository) throw refuse("exact release checkout basename is required");
  const topLevel = await runGit(checkout, ["rev-parse", "--show-toplevel"]);
  if (await realpath(topLevel) !== checkout) throw refuse("exact release checkout root is required");
  await verifySourceContract({ checkoutPath: checkout });
  if (await runGit(checkout, ["branch", "--show-current"]) !== "main") throw refuse("release branch main is required");
  if (!exactOrigins.has(await runGit(checkout, ["remote", "get-url", "origin"]))) throw refuse("exact aserdargun origin is required");
  if (await runGit(checkout, ["status", "--porcelain=v1"]) !== "") throw refuse("clean exact release checkout is required");
  return { checkout, ...expected };
};

export const runDeploymentContractCli = async ({ cwd = process.cwd(), argv = process.argv.slice(2), log = console.log }) => {
  if (argv.length !== 1 || !["source", "release"].includes(argv[0])) throw new Error("Usage: verify-deployment-contract.mjs <source|release>");
  const result = argv[0] === "source" ? await verifySourceContract({ checkoutPath: cwd }) : await verifyReleaseIdentity({ checkoutPath: cwd });
  log(`Deployment contract ${argv[0]} verified for ${result.repository}.`);
  return result;
};

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runDeploymentContractCli({}).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Deployment contract failed."}\n`);
    process.exitCode = 1;
  });
}
