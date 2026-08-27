import { build } from "esbuild";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const moduleCheckout = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactPackage = {
  name: "nxt-api-artifact",
  private: true,
  type: "module",
  main: "index.js",
  dependencies: {
    "@azure/functions": "4.16.2",
    "file-type": "22.0.2",
    "googleapis": "176.0.0"
  }
};

export const assertSafeApiDistTarget = async (checkoutPath, targetPath) => {
  const checkout = await realpath(resolve(checkoutPath));
  const target = resolve(targetPath);
  if (target === checkout || dirname(target) !== checkout || target !== join(checkout, "api-dist")) {
    throw new Error("Refusing unsafe api-dist target.");
  }
  let metadata;
  try {
    metadata = await lstat(target);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (metadata?.isSymbolicLink()) throw new Error("Refusing symlink api-dist target.");
  if (metadata !== undefined) {
    const resolvedTarget = await realpath(target);
    const child = relative(checkout, resolvedTarget);
    if (child !== "api-dist" || child.startsWith(`..${sep}`) || resolve(resolvedTarget) === checkout) {
      throw new Error("Refusing foreign api-dist target.");
    }
  }
  return { checkout, target };
};

export const buildApi = async ({ checkoutPath = moduleCheckout } = {}) => {
  if (process.versions.node.split(".")[0] !== "22") throw new Error("API artifacts require Node 22.");
  const { checkout, target } = await assertSafeApiDistTarget(checkoutPath, join(checkoutPath, "api-dist"));
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: false, mode: 0o755 });
  await build({
    absWorkingDir: checkout,
    entryPoints: ["api/src/functions/index.ts"],
    outfile: join(target, "index.js"),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    packages: "bundle",
    external: ["@azure/functions", "file-type", "googleapis"],
    banner: {
      js: 'import { createRequire as __nxtCreateRequire } from "node:module"; const require = __nxtCreateRequire(import.meta.url);'
    },
    sourcemap: false,
    legalComments: "none",
    charset: "utf8",
    treeShaking: true,
    logLevel: "silent"
  });
  await writeFile(join(target, "host.json"), await readFile(join(checkout, "api", "host.json")), { mode: 0o644 });
  await writeFile(join(target, "package.json"), `${JSON.stringify(artifactPackage, null, 2)}\n`, { mode: 0o644 });
  return target;
};

const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  await buildApi();
  process.stdout.write("Built deterministic API artifact in api-dist.\n");
}
