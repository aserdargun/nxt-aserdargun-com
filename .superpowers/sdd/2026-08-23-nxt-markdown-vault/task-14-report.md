# Task 14 Report — Azure Artifacts and Checkout-Scoped Lifecycle

## Status

DONE

Task 14 is implemented in commit `193dba9` (`chore: add secure local and azure lifecycle`). The report and progress-ledger entry are committed separately.

The repository now produces deterministic prebuilt web/API trees, carries the exact Azure Static Web Apps route and security policy, verifies generated artifacts fail-closed, and exposes checkout-owned Setup/Run/Validate/Stop actions. Run starts Vite, the real Functions Core Tools host, and SWA CLI; Stop signals only identities proved by the atomic checkout control record.

## Delivered contract

- Added `web/public/staticwebapp.config.json` with the exact ordered AAD-disabled/private-owner routes, anonymous public paths, SPA fallback exclusions, security headers, and Node 22 runtime.
- Pinned `@azure/static-web-apps-cli@2.0.10` and `esbuild@0.28.2`. pnpm permits only esbuild's required install build and explicitly denies optional keytar's build.
- Added a safe `api-dist` builder. It refuses checkout-root, foreign, and symlink targets; emits Node 22 ESM without source maps; externalizes only exact runtime packages; and writes stable `index.js`, `host.json`, and minimal `package.json` files.
- Added an artifact verifier for exact required files, closed API shape, no symlinks/special files/source maps/credential filenames/control files, bounded text inspection, fewer than 250 MiB of web content, exact SWA policy/runtime, and backend-only value detection. Findings name only the key, never its value.
- Added atomic mode-0600 `.nxt-local/control.json` under a mode-0700 directory. It records checkout realpath, random nonce, listener-owning PID, OS-observed start time, cwd, executable/command identity, expected port, log, and a distinct launcher identity where needed.
- Added fail-closed Stop. It revalidates every live identity and checkout-owned descendant before TERM, repeats identity checks before KILL, refuses corrupt/foreign/reused/mismatched records without signaling, never kills by port, confirms listeners closed, removes only known artifacts, and is idempotent after success.
- Added partial-start rollback, signal fencing, concurrent-start and occupied-port refusal, Drive-environment refusal, and local-only child auth bypass. The bypass is supplied only to the development Functions child; it is neither written to disk nor supplied to Vite/SWA.
- Added Codex Setup/Run/Validate/Stop actions. Validate completes with no remaining server or control/log directory.
- Added `api/local.settings.json` to ignored secret paths. Generated `web/dist`, `api-dist`, and `.nxt-local` remain ignored and uncommitted.

## RED → GREEN evidence

The first Node 22 focused run preceded production changes:

```sh
node --test tools/static-security.test.mjs tools/artifact-contract.test.mjs tools/local-lifecycle.integration.test.mjs
```

```text
0 passed; 4 top-level failures
missing: web/public/staticwebapp.config.json
missing: scripts/build-api.mjs
missing: scripts/verify-artifacts.mjs
missing: scripts/stop-local-core.mjs
exit 1
```

Final focused live-unset run:

```sh
node --test --test-concurrency=1 tools/static-security.test.mjs tools/artifact-contract.test.mjs tools/local-lifecycle.integration.test.mjs
```

```text
20/20 passed
duration 28.84 s
exit 0
```

Coverage includes:

- byte-identical hashes across consecutive API builds;
- target-root/foreign/symlink deletion refusal;
- exact API package and three-file tree;
- missing/extra/symlink/secret artifact refusal with value redaction;
- exact route order, uniqueness, fallback exclusions, CSP, headers, and Node runtime;
- mode-restricted atomic control records;
- valid Stop, repeated Stop, stubborn TERM→KILL escalation, descendant cleanup, and SWA listener crash cleanup;
- foreign checkout, corrupt record, stale start time, cwd, command, nonce, and occupied-port refusal while harmless fixtures remain alive;
- sandbox profile equality and deny-all enforcement control;
- Drive configuration and existing corrupt-start refusal;
- injected partial-start rollback with 4280/5173/7071 reusable;
- real three-service start, concurrent-start refusal, local owner session, crash-safe Stop, and all listener closures.

## Fresh full validation

Every Drive/Google runtime key was explicitly unset. The exact command was:

```sh
env -u GOOGLE_CLIENT_ID -u GOOGLE_CLIENT_SECRET -u GOOGLE_REFRESH_TOKEN \
  -u NXT_VAULT_DRIVE_FOLDER_ID -u NXT_PRIVATE_DRIVE_FOLDER_ID \
  -u NXT_NOTES_DRIVE_FOLDER_ID -u NXT_INBOX_DRIVE_FOLDER_ID \
  -u NXT_PLANS_DRIVE_FOLDER_ID -u NXT_ARCHIVE_DRIVE_FOLDER_ID \
  -u NXT_ASSETS_DRIVE_FOLDER_ID -u NXT_PUBLISHED_DRIVE_FOLDER_ID \
  -u NXT_VAULT_INDEX_DRIVE_FILE_ID -u NXT_PREFERENCES_DRIVE_FILE_ID \
  -u NXT_PUBLICATION_MANIFEST_DRIVE_FILE_ID pnpm validate:codex
```

```text
lint: PASS
typecheck: contracts, domain, web, API PASS
API artifact: PASS
web build: PASS
artifact verifier: 13 web files, 3 API files, PASS
contracts: 14 passed
domain: 29 passed
web: 169 passed
API: 394 passed, 1 skipped
repository total: 606 passed, 1 skipped
project contract: 2/2 passed
focused Task 14: 20/20 passed
git diff --check: PASS
exit 0
```

The only skip is the existing opt-in live Google Drive integration test. Vite retained its known non-failing large-chunk warning. The tracked `web/tsconfig.tsbuildinfo` was restored after validation.

## Local stack evidence

Toolchain:

```text
Node 22.23.1
pnpm 11.22.0
esbuild 0.28.2
Static Web Apps CLI 2.0.10
Functions Core Tools 4.13.0+dd0daba7f6fc9380ab5a74c37ad1c372740bee2e (64-bit)
Functions runtime 4.1051.300.26316
```

The real stack produced exact listener ownership records and these checks:

```text
127.0.0.1:5173 Vite: listening
127.0.0.1:4280 SWA: listening
Functions listener PID: exact real bin/func identity on 7071
GET http://127.0.0.1:4280/login: 200
GET http://127.0.0.1:4280/app: 401 (platform protected)
GET http://127.0.0.1:4280/p/<valid-shaped-id>: 200 SPA/public surface
GET http://127.0.0.1:7071/api/private/session: 200, exact local owner
Stop: stopped
repeated Stop: already stopped
4280/5173/7071 after Stop: no listeners
.nxt-local after Stop: absent
```

Browser IAB work remains with the controller as requested; Task 14 supplied the real stack and HTTP/identity evidence without opening a fallback browser.

## macOS Functions host-local boundary

The installed signed Core Tools binary ignores the documented `--address 127.0.0.1`, `ASPNETCORE_URLS`, `Host__LocalHttpAddress`, `AzureFunctionsJobHost__Host__LocalHttpAddress`, and ignored local-settings `Host.LocalHttpAddress` attempts. `lsof` reports `*:7071`, and a same-machine request through this Mac's `en0` address connects. This is not described as literal loopback.

Under the controller's corrected ruling, Run resolves and launches the real signed `bin/func` directly inside this child-scoped macOS profile:

```text
(version 1) (allow default) (deny network-inbound (require-all (remote ip "*:*") (require-not (remote ip "localhost:*"))))
```

macOS classifies every address owned by this same Mac as `localhost` for that predicate. Therefore another process on this Mac may reach port 7071 through a non-127 local interface alias; other machines are denied by the host-local sandbox rule. The API's existing loopback-host check still refuses the local auth bypass for a non-loopback Host header. Vite and SWA bind literally to `127.0.0.1`. Setup and Run fail closed if `sandbox-exec`, the direct real Functions binary, or a deny-all sandbox enforcement control is unavailable. This host-local/deprecated-sandbox dependency is explicitly disclosed in `.codex/environments/environment.toml`.

## Boundaries

- No live Drive request or provisioning occurred; the live integration remained skipped.
- No GitHub repository/remote/workflow, Azure resource/deployment, DNS, custom domain, push, or secret was read or mutated.
- The only external package activity was pnpm resolution/install for the two approved pinned development dependencies; no external mutable service state was changed.
- No deployment workflow was created. Tasks 17/18 must revalidate the real `nxt-aserdargun-com` repository identity/remote and receive explicit action-time authorization.
- The root checkout was not edited. Implementation stayed in the approved worktree and branch.
- Built artifacts and local lifecycle files are ignored/uncommitted. Ports 4280, 5173, and 7071 are closed, `.nxt-local` is absent, and implementation commit `193dba9` contains no build output.
