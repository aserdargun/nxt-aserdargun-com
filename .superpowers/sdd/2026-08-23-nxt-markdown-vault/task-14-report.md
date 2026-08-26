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

## Review fix round 1

Independent review found five Important and two Minor lifecycle gaps. Commit `2f0612737d6b142eab78c3597dfb0b5e66096530` (`fix: harden local lifecycle ownership`) closes them without changing the approved Azure policy or macOS Functions sandbox boundary:

- Artifact verification now `lstat`s the exact checkout-owned `web/dist` and `api-dist` roots, rejects root symlinks/non-directories/redirects, and revalidates root device/inode identities immediately before success.
- Run acquires a mode-0600 atomic `wx` startup lease before port probes, cleanup, or builds. The lease binds checkout, nonce, and full coordinator PID/start-time/cwd/executable/command/PGID identity. Only that owner may replace provisional control state or clean a failed startup.
- Control state is persisted atomically as `starting` immediately after lease acquisition, again after every spawn, observed same-process exec transition, and listener identity update, then as `ready`. Stop claims the lease and recovers recorded partial services after launcher SIGKILL.
- Rollback and Stop no longer send negative-PID process-group signals. They repeatedly enumerate descendants and recorded PGIDs, require checkout ownership, capture each full identity, and revalidate PID, start time, cwd, executable, command, and PGID before every individual TERM/KILL.
- Child enumeration propagates every error except exact `pgrep` no-child exit 1. TERM/KILL phases repeat discovery until two verified empty passes, so late forks and non-listening descendants cannot escape. Enumeration/refusal errors retain control ownership state.
- Caller-provided `NXT_LOCAL_AUTH_BYPASS` is deleted from build, Vite, and SWA environments; only the non-production Functions child receives exact value `1`.
- The Codex Validate action is named `Validate bounded lifecycle (leaves stack stopped)` because it runs real bounded lifecycle integration and cleans all services.

The controller's IAB observation that SWA CLI proxy responses omit configured `globalHeaders` is recorded as an emulator-evidence limitation, not a source-policy defect. The exact `staticwebapp.config.json` global headers and artifact verifier remain unchanged and fail closed. No local workaround weakens the CSP or other headers; Azure production header evidence remains a later deployment-validation responsibility.

### Fix-round RED → GREEN evidence

Focused RED, exact Node 22 command before lifecycle production edits:

```sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH node --test --test-concurrency=1 tools/static-security.test.mjs tools/artifact-contract.test.mjs tools/local-lifecycle.integration.test.mjs
```

```text
30 tests: 20 passed, 10 failed, 0 skipped
expected failures: artifact-root symlinks; missing/mismatched PGID; suppressed enumeration error; surviving late fork; absent startup lease; absent provisional Vite/Functions state after launcher SIGKILL; inherited auth bypass; inaccurate Validate label
exit 1
```

Focused GREEN used the same command:

```text
30 tests: 30 passed, 0 failed, 0 skipped, 0 cancelled
duration: 95.34 seconds
exit 0
```

Full validation explicitly removed every live Drive key and ran `pnpm validate:codex` under Node `22.23.1`:

```text
lint: PASS
typecheck: PASS
API/web builds: PASS
artifact verifier: 13 web files, 3 API files, PASS
contracts: 14 passed
domain: 29 passed
web: 169 passed
API: 394 passed, 1 opt-in live Drive test skipped
repository total: 606 passed, 1 skipped
project contract: 2 passed
focused Task 14: 30 passed
git diff --check: PASS
exit 0
```

The real simultaneous-launch barrier, Vite/Functions launcher-SIGKILL recovery, partial rollback, full stack, auth-environment scope, late fork, forced escalation, and refusal fixtures all completed bounded cleanup. Ports 4280, 5173, and 7071 are closed; `.nxt-local` is absent; generated artifacts remain ignored; `web/tsconfig.tsbuildinfo` was restored. Fix round 1 made no network request and did not access or mutate Drive, GitHub, Azure, DNS, remotes, workflows, deployment state, or secrets. Browser IAB remains with the controller.

## Review fix round 2

Independent review found one remaining Important coordinator-crash window and one Minor Stop/Stop/Run ownership race. Commit `591bbdcc8e6d89e704e15f1ba1a2a273d7fbecdb` (`fix: close lifecycle crash windows`) closes both without changing Azure policy, local authentication scope, or the corrected macOS Functions host-local sandbox ruling.

- Every service now starts behind checkout-owned `service-supervisor.mjs`. Run first persists a `planned` gate, then persists the supervisor's complete OS-observed PID/start-time/cwd/executable/command/PGID identity as `gated`, and only then atomically creates the nonce-bound release file. The supervisor cannot spawn or exec Vite, Functions, or SWA before release.
- A coordinator SIGKILL immediately before Vite release leaves only the durably recorded gated supervisor. Stop writes the exact cancel gate, revalidates the supervisor identity, terminates only that checkout-owned process, proves all three ports closed, and removes the exact gate/control/log artifacts. No port-based or broad process cleanup was added.
- Every non-idle Stop now obtains a mode-0600 atomic `wx` `stop.lock` bound to checkout realpath, control nonce, a fresh Stop nonce, and the stopper's complete OS process identity. A concurrent Stop is refused while the exact owner is active; Run also refuses the claim even after process/control/log cleanup and cannot start until the owner removes its own claim last.
- Gate registration/release/cancel paths are exact checkout children with closed names. Stop understands `planned`, `gated`, and `ready` records, preserves full identity checks through cleanup, and removes only record-owned gate files and logs.
- The prior host-local Functions sandbox remains exact: macOS may admit same-machine interface aliases classified as `localhost`, other machines are denied, and Vite/SWA remain literal `127.0.0.1`. No SWA CLI global-header workaround or policy weakening was introduced; the emulator header-evidence gap remains documented for later Azure validation.

### Fix-round-2 RED → GREEN evidence

The three new regressions ran before production edits under exact Node 22 with all live Drive keys unset:

```sh
node --test --test-concurrency=1 \
  --test-name-pattern='concurrent Stops|before Vite release|ready Stop keeps Run' \
  tools/local-lifecycle.integration.test.mjs
```

```text
RED: 0 passed, 3 failed, 0 skipped; 66.05 seconds
missing behavior: no exclusive Stop claim; service released before its gate; Run not held behind final Stop cleanup
GREEN: 3 passed, 0 failed, 0 skipped; 46.67 seconds
```

The complete focused security/artifact/lifecycle run then passed `33/33` in `143.92` seconds. It includes simultaneous Run, concurrent Stop, ready Stop/Run, exact pre-release coordinator SIGKILL, post-Vite and post-Functions coordinator SIGKILL, partial rollback, late fork, forced escalation, foreign/stale/reused identities, auth-environment scope, deterministic API hashes, and artifact-root symlink refusal.

The first full run exposed a test-diagnostic timeout in the existing post-Functions crash fixture after all 606 repository tests had passed. The same exact crash test immediately passed `1/1` in `17.32` seconds. Its wait was narrowed to surface an early launcher result instead of hiding it behind a 90-second marker timeout; no production behavior changed. The final fresh full run was:

```sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH \
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
typecheck: PASS
API/web builds: PASS
artifact verifier: 13 web files, 3 API files, PASS
contracts: 14 passed
domain: 29 passed
web: 169 passed
API: 394 passed, 1 opt-in live Drive test skipped
repository total: 606 passed, 1 skipped
project contract: 2 passed
focused Task 14: 33 passed in 145.98 seconds
git diff --check: PASS
exit 0
```

Tool evidence was Node `22.23.1`, pnpm `11.22.0`, and the Core Tools banner `4.13.0`. Final checks found no listeners on 4280/5173/7071, no `.nxt-local`, no surviving launcher/supervisor/test process, restored tracked `web/tsconfig.tsbuildinfo`, ignored/uncommitted build output, and a clean implementation commit. No browser IAB was opened for this lifecycle-only fix. No live Drive, GitHub, Azure, DNS, remote, workflow, deployment, push, or external mutable service access occurred; the root checkout and INF project were untouched.
