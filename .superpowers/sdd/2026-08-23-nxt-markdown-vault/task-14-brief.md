### Task 14: Add Azure routing, deterministic builds, and checkout-scoped local lifecycle

**Planned files:**
- Create: `web/public/staticwebapp.config.json`
- Create: `scripts/build-api.mjs`
- Create: `scripts/verify-artifacts.mjs`
- Create: `scripts/local-dev.mjs`
- Create: `scripts/stop-local-core.mjs`
- Create: `scripts/stop-local.mjs`
- Create: `tools/static-security.test.mjs`
- Create: `tools/artifact-contract.test.mjs`
- Create: `tools/local-lifecycle.integration.test.mjs`
- Create: `.codex/environments/environment.toml`
- Modify: `package.json`
- Modify: `api/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: the completed web/API applications from Tasks 5-13, Node 22, Azure Functions Core Tools v4, and the local-only exact-owner bypass already constrained by the auth layer.
- Produces: deterministic ignored `web/dist` and `api-dist` artifacts, Azure Static Web Apps route/security policy, a loopback-only local SWA stack, and checkout-owned Setup/Run/Validate/Stop actions.

## Frozen acceptance contract

- Begin with focused RED tests for the exact SWA policy, generated artifact contract, and lifecycle ownership/refusal behavior. Do not manufacture RED by weakening an existing assertion. Keep all prior tests green and keep the live Drive test unset/skipped.
- Create the exact Task 14 `staticwebapp.config.json`: block `/.auth/login/aad` with `404`; protect `/api/private/*` and `/app/*` with only `authenticated`; do not add a `/login` platform role rule; set SPA fallback to `/index.html` while excluding `/api/*` and `/.auth/*`; install the specified CSP, referrer, permissions, and nosniff headers; set `{ "apiRuntime": "node:22" }`. Test route uniqueness/order and fallback behavior so a broad rule cannot shadow a protected route.
- Add exactly `@azure/static-web-apps-cli@2.0.10` and `esbuild@0.28.2` as pinned root development dependencies. Require Node 22 and Functions Core Tools v4 >= `4.0.5382`; the current read-only preflight observed `func 4.13.0`. No package installation hook may access Drive, GitHub, Azure resources, or DNS.
- Bundle `api/src/functions/index.ts` as Node 22 ESM into `api-dist/index.js` with source maps disabled and `@azure/functions` external. Copy `api/host.json` and write a stable minimal `api-dist/package.json` with `main: "index.js"`, `type: "module"`, and only the runtime dependencies required by the bundle, including exact `@azure/functions: 4.16.2`. Builds from an unchanged checkout must produce byte-identical file trees.
- Before deleting `api-dist`, resolve both the checkout and target: target must be an exact direct child named `api-dist`, not a symlink, not the checkout root, and not outside the checkout. Refuse every ambiguous or foreign target. Generated artifacts remain ignored/uncommitted.
- `verify-artifacts.mjs` must fail closed on missing/extra unsafe structure, symlinks, an invalid API entrypoint/config/routes/headers/runtime, excessive file counts, or web artifacts totaling 250 MiB or more. Recursively inspect bounded text artifacts for non-empty values of backend-only keys: `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, and every `NXT_*_DRIVE_FOLDER_ID` / `NXT_*_DRIVE_FILE_ID` used by the API. Never emit a matching value; errors name only the key. Do not scan arbitrary environment values or interpolate secrets into reports.
- A verified artifact tree includes `web/dist/staticwebapp.config.json`, `web/dist/index.html`, `api-dist/index.js`, `api-dist/host.json`, and `api-dist/package.json`; it contains no source maps, credentials, local control files, raw Drive identifiers, or committed build output. Test two consecutive API builds by hashing paths and bytes.
- `local-dev.mjs` is checkout-scoped and loopback-only. It verifies ports 4280, 5173, and 7071 before launch, builds required artifacts, starts Vite, Functions, and SWA CLI on `127.0.0.1`, waits with bounded readiness deadlines, and records only after trustworthy process identity is available. A partial startup failure must synchronously roll back every child it started.
- `.nxt-local/control.json` is written atomically with restrictive permissions and contains the checkout realpath, an unpredictable nonce, each child PID, its OS-observed start time, current working directory, executable/command identity, expected port, and log location. Refuse an existing live/foreign/corrupt control record. Never claim a port merely because it is occupied.
- `stop-local-core.mjs` and `stop-local.mjs` read only this checkout's exact control file and validate schema, checkout realpath, PID start time, cwd, command/executable identity, nonce ownership, and expected listener before signaling. Send bounded `SIGTERM`, then `SIGKILL` only to still-live identities that pass the same verification again. Never enumerate or kill arbitrary OS listeners/processes, process by port alone, or trust a stale/reused PID.
- Stop is idempotent when no valid control record/process remains. A stale, corrupt, or foreign record is refused without signaling; tests use harmless child fixtures and must prove they survive refusal. Successful Stop removes only its verified control record, confirms its three listeners are gone, and leaves no descendants. Signal interruption and early-exit paths perform the same checkout-owned cleanup.
- Local auth bypass may be supplied only to the loopback non-production Functions child through the local launcher. Do not persist it, broaden its existing origin/client/port checks, or weaken Azure authenticated routes. Public `/p/*` and `/api/public/*` remain anonymous; owner/private paths remain exact-owner gated in production.
- `.codex/environments/environment.toml` exposes Setup (`pnpm install --frozen-lockfile` plus tool/version preflight), Run (`pnpm dev:codex`), Validate (`pnpm validate:codex`), and Stop (`pnpm stop:codex`) with project-scoped descriptions. Run returns a useful readiness URL/log path; Validate does not start or leave a server.
- Lifecycle tests cover clean start/stop, repeated stop, occupied foreign port refusal, corrupt/stale/foreign checkout/PID-start-time/cwd/command/nonce records, concurrent starts, partial-start rollback, graceful and forced termination, child crash, process-tree cleanup, and all three listener closures. They must be bounded, deterministic, and leave no process/control/log artifacts.
- Target IAB flow after GREEN: use the real local stack at `http://127.0.0.1:4280`; verify `/login`, the local-only `/app` owner path/private API behavior, anonymous `/p/<valid-shaped-id>` generic-not-found behavior, and a fresh SPA deep route/fallback with clean console and no framework overlay. Then run Stop and independently confirm 4280/5173/7071 are closed. Browser fixtures remain local/read-only.
- Validate focused RED/GREEN, full live-Drive-unset lint/typecheck/build/tests/project/static scans, artifact verification, source/dist contract parity, `git diff --check`, and clean status after restoring tracked `web/tsconfig.tsbuildinfo`. Close only checkout-owned ports.
- The current worktree basename is intentionally `codex-nxt-markdown-vault`; the read-only deployment contract maps approved code `nxt` to repository `nxt-aserdargun-com`, resource group `rg-nxt-aserdargun-com`, SWA `swa-nxt-aserdargun-com`, workflow `.github/workflows/deploy-swa-nxt-aserdargun-com.yml`, and token secret name `AZURE_STATIC_WEB_APPS_API_TOKEN_SWA_NXT_ASERDARGUN_COM`. Task 14 must create no workflow and perform no GitHub/Azure/Drive/DNS/deployment/push/remote mutation. Tasks 17/18 must revalidate the real repository basename/remote and obtain explicit action-time authorization.
- Node 22 only. Commit implementation and a separate forced-added Task 14 report, return a clean worktree, and record exact commands/counts/skips/ports. Custom-domain work is out of scope.

## Planned RED examples

```js
test("private routes precede fallback and AAD sign-in is disabled", async () => {
  const config = JSON.parse(await readFile("web/public/staticwebapp.config.json", "utf8"));
  assert.deepEqual(config.platform, { apiRuntime: "node:22" });
  assert.deepEqual(config.routes.find((route) => route.route === "/api/private/*")?.allowedRoles, ["authenticated"]);
  assert.deepEqual(config.routes.find((route) => route.route === "/app/*")?.allowedRoles, ["authenticated"]);
  assert.equal(config.routes.find((route) => route.route === "/.auth/login/aad")?.statusCode, 404);
  assert.equal(config.routes.some((route) => route.route === "/login"), false);
});
```

```js
test("foreign control records are refused without signaling their process", async () => {
  const foreign = await startHarmlessFixture();
  await writeControl({ checkoutRealpath: "/tmp/foreign", pid: foreign.pid });
  await assert.rejects(stopLocal(), /refus/i);
  assert.equal(isAlive(foreign.pid), true);
});
```
