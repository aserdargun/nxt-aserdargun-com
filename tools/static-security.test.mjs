import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const expectedCsp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

const readConfig = async () => JSON.parse(await readFile("web/public/staticwebapp.config.json", "utf8"));

test("private routes precede fallback and Entra sign-in is disabled", async () => {
  const config = await readConfig();
  assert.deepEqual(config.platform, { apiRuntime: "node:22" });
  assert.deepEqual(config.routes, [
    { route: "/.auth/login/aad", statusCode: 404 },
    { route: "/api/private/*", allowedRoles: ["authenticated"] },
    { route: "/app/*", allowedRoles: ["authenticated"] }
  ]);
  assert.equal(new Set(config.routes.map(({ route }) => route)).size, config.routes.length);
  assert.equal(config.routes.some(({ route }) => route === "/login"), false);
  assert.deepEqual(config.navigationFallback, {
    rewrite: "/index.html",
    exclude: ["/api/*", "/.auth/*"]
  });
});

test("static policy installs the exact security headers", async () => {
  const { globalHeaders } = await readConfig();
  assert.deepEqual(globalHeaders, {
    "Content-Security-Policy": expectedCsp,
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "X-Content-Type-Options": "nosniff"
  });
});

test("toolchain and Codex actions pin the secure local lifecycle", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(pkg.devDependencies["@azure/static-web-apps-cli"], "2.0.10");
  assert.equal(pkg.devDependencies.esbuild, "0.28.2");
  assert.match(pkg.scripts["validate:codex"], /local-lifecycle\.integration\.test\.mjs/u);
  assert.doesNotMatch(pkg.scripts["validate:codex"], /\be2e\b/u);

  const workspace = await readFile("pnpm-workspace.yaml", "utf8");
  assert.match(workspace, /allowBuilds:\n {2}esbuild: true\n {2}keytar: false/u);
  const environment = await readFile(".codex/environments/environment.toml", "utf8");
  assert.match(environment, /pnpm install --frozen-lockfile && node scripts\/local-dev\.mjs --check/u);
  for (const command of ["pnpm dev:codex", "pnpm validate:codex", "pnpm stop:codex"]) assert.match(environment, new RegExp(command, "u"));
  assert.match(environment, /same-machine interface aliases as localhost/u);
});
