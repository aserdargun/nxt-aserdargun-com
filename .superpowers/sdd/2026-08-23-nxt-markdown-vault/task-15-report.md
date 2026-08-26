# Task 15 Report — Real Browser Acceptance

## Status

DONE

Task 15 was initially implemented in commit `cde52276e8f3a30bd408561384d4729103ad1daf` (`test: cover nxt owner and public journeys`). Review fix round 1 is implemented in commit `8ab05f4` (`fix: harden browser acceptance harness`). The updated report and progress-ledger entry are committed separately.

The suite drives the real Vite → Azure Functions Core Tools → SWA CLI stack with Chromium. It uses SWA CLI's local GitHub-provider emulator, an exact checkout-owned filesystem fixture, production handlers, and real browser requests; no application API is mocked in the page.

## Delivered contract

- Pinned `@playwright/test@1.62.1` and `@axe-core/playwright@4.13.0`; configured Chromium-only desktop `1440x1000`, mobile `390x844`, and reduced-motion desktop projects with one worker.
- Added a failure-safe `pnpm e2e` owner that scrubs every Google/Drive/local/auth key, starts `dev:codex -- --e2e`, runs Playwright, always calls checkout-scoped Stop, then independently proves ports `4280`, `5173`, and `7071` are closed and `.nxt-local` is absent. SIGINT/SIGTERM paths are converted to failure after bounded child completion and still execute the same teardown.
- Added a strict fixture bootstrap under only the canonical checkout child `.nxt-local/fixtures/playwright`. It refuses symlinks, traversal, foreign/pre-existing roots, and live Drive configuration; seeds deterministic vault/private folders, system files, Markdown, and a bounded PNG; and mutates external revisions through the same locked `LocalDriveAdapter`.
- Added async-safe runtime composition. Google remains the default. Filesystem mode requires exact Development, local-auth-bypass, checkout, canonical-root, descriptor, and absent-Google-credential guards. Task 7 and Task 9 share one raw local adapter. Existing injected synchronous test dependencies remain supported through `await Promise.resolve(...)`.
- Corrected local authentication so bypass applies only when the SWA principal header is absent. Any present malformed, wrong, or correct principal follows the exact existing GitHub-owner verification path.
- Moved folder-action buttons outside the semantic `role=tree` owned subtree while preserving direct `treeitem` children, roving focus, keyboard selection/expansion, context-menu reachability, and focus restoration.
- Added meaningful browser journeys for owner create/edit/save/search/tag/archive/reload, offline draft restoration, three-way conflict resolution, persisted raster publication, anonymous public rendering and revocation, wrong-owner and malformed/private/public security boundaries, mobile reachability/touch sizing, reduced motion, overflow, keyboard/focus behavior, and axe.

## RED → GREEN evidence

Focused RED preceded the relevant production behavior:

```text
local fixture helper: module missing
local runtime composition: filesystem mode unavailable
representative real owner journey: local backend/fixture unavailable
auth focused RED: 76 passed, 2 failed (wrong supplied principal was bypassed)
file-tree focused RED: 10 passed, 1 failed (folder actions remained inside role=tree)
```

Focused GREEN:

```text
local fixture helper: 2/2 passed
runtime service composition: 3/3 passed
auth: 78/78 passed
file tree: 11/11 passed
representative real owner journey: 1/1 passed
```

The focused tests prove production-default refusal without Google configuration, guarded local admission, exact canonical fixture-root enforcement, shared Task 7/Task 9 persistence, malformed/wrong/right owner behavior, and the corrected tree ownership/focus contract.

## Chromium acceptance

Installation and final exact run used Node 22 with every live integration key explicitly unset:

```sh
pnpm exec playwright install chromium
env -u GOOGLE_CLIENT_ID -u GOOGLE_CLIENT_SECRET -u GOOGLE_REFRESH_TOKEN \
  -u NXT_VAULT_DRIVE_FOLDER_ID -u NXT_PRIVATE_DRIVE_FOLDER_ID \
  -u NXT_NOTES_DRIVE_FOLDER_ID -u NXT_INBOX_DRIVE_FOLDER_ID \
  -u NXT_PLANS_DRIVE_FOLDER_ID -u NXT_ARCHIVE_DRIVE_FOLDER_ID \
  -u NXT_ASSETS_DRIVE_FOLDER_ID -u NXT_PUBLISHED_DRIVE_FOLDER_ID \
  -u NXT_VAULT_INDEX_DRIVE_FILE_ID -u NXT_PREFERENCES_DRIVE_FILE_ID \
  -u NXT_PUBLICATION_MANIFEST_DRIVE_FILE_ID \
  -u NXT_LOCAL_STORAGE_MODE -u NXT_LOCAL_FIXTURE_ROOT \
  -u NXT_LOCAL_CHECKOUT_ROOT -u NXT_LOCAL_AUTH_BYPASS pnpm e2e
```

```text
desktop Chromium: 9 passed
mobile Chromium: 2 passed
reduced-motion Chromium: 1 passed
total: 12/12 passed, one worker, 29.1 seconds
Stop: checkout-owned stack stopped
4280/5173/7071: closed
.nxt-local: absent
checkout Playwright/Vite/Functions/SWA processes: none
exit 0
```

Toolchain:

```text
Node 22.23.1
pnpm 11.22.0
Playwright 1.62.1
Google Chrome for Testing 151.0.7922.34
SWA CLI 2.0.10
```

The SWA local emulator requires a genuine key event before it persists its username/role form state; the fixture supplies that event and then submits exact owner `aserdargun`. The wrong-user browser scenario goes through the same emulator and receives the expected fail-closed result. No real GitHub OAuth occurs.

## Accessibility and visual evidence

Axe reported zero serious/critical violations on login, owner workspace/tree/editor/preview, the settled command dialog, and the public note. The command dialog is awaited by computed `opacity: 1`, without a fixed sleep. At that final state the computed Gruvbox colors were:

```text
dialog background: rgb(60, 56, 54)
heading: rgb(215, 153, 33), contrast 4.676:1
command text: rgb(235, 219, 178), contrast 8.452:1
focused enabled command: non-transparent selection background
disabled Revoke: transparent background and opacity 0.72
```

Because the settled values and axe result pass, no command-palette color or global palette override was added. The earlier contrast report was the transient composited animation frame, not the final UI.

Three deterministic, ignored, uncommitted screenshots were captured by the final green run and inspected at original resolution:

- `/Users/aserdargun/Documents/ChatGPT/nxt-aserdargun-com/.worktrees/codex-nxt-markdown-vault/test-results/playwright/task15-command-dialog.png`: centered settled dialog, readable Gruvbox labels, distinct focused command, visibly muted disabled Revoke, no clipping.
- `/Users/aserdargun/Documents/ChatGPT/nxt-aserdargun-com/.worktrees/codex-nxt-markdown-vault/test-results/playwright/task15-mobile-workspace.png`: `390x844` editor, all four bottom destinations visible, 44px targets, no horizontal overflow.
- `/Users/aserdargun/Documents/ChatGPT/nxt-aserdargun-com/.worktrees/codex-nxt-markdown-vault/test-results/playwright/task15-public-note.png`: owner chrome absent, title/content readable, and the allowlisted snapshotted raster contained in the public surface. The large white panel is the deterministic fixture's `1x1` white PNG expanded by the existing intentional responsive attachment rule (`width: 100%`, `max-height: 620px`, `object-fit: contain`), not missing content; Task 15 did not redesign asset sizing.

## Fresh full validation

The fresh `pnpm validate:codex` used Node `22.23.1` with the same live Drive/Google/local variables unset:

```text
lint: PASS
typecheck: contracts, domain, web, API PASS
deterministic API artifact: PASS
web build: PASS (known non-failing >500 kB chunk warning)
artifact verifier: 13 web files, 3 API files, PASS
contracts: 14 passed
domain: 29 passed
web: 170 passed
API: 399 passed, 1 skipped
repository total: 612 passed, 1 skipped
project contract: 2/2 passed
focused static/artifact/lifecycle: 37/37 passed in 183.5 seconds
git diff --check: PASS
exit 0
```

The only skip is the existing opt-in live Google Drive integration. `web/tsconfig.tsbuildinfo` was restored after validation. A final post-screenshot lint and `git diff --check` also passed.

## Justified adaptations and emulator gaps

- The shipped owner UI supports archive but not a separate Trash recovery journey, so the acceptance proves archive plus reload-safe persistence rather than inventing an unavailable control.
- The allowed attachment path uses the shipped file picker. SVG and HTML are accepted only as download-only `application/octet-stream` with `Content-Disposition: attachment`; neither is rendered inline.
- `/p/<id>` remains a static SPA-shell HTTP 200 after revocation, while its anonymous public-note API converges to the required generic redacted 404 and the UI has no snapshot. The SWA CLI can briefly cache a previously read public GET despite the API's `no-store`; the test uses a bounded 10-second no-cache poll and a fresh anonymous context. This is retained as an emulator cache gap, not a production-policy change.
- SWA CLI `2.0.10` locally omits configured `globalHeaders` from proxied responses. Static config/artifact tests continue to enforce CSP and every required header; the browser suite does not weaken or work around the policy. Azure-hosted response-header evidence remains a later authorized deployment check.
- The SWA CLI-local auth page references Microsoft CDN-hosted static styling/scripts. No live GitHub OAuth, Azure resource/control-plane API, Google/Drive API, DNS, deployment, workflow, remote, secret, or external mutable service state was read or mutated.
- Task 14's disclosed Functions host-local macOS sandbox boundary is unchanged. Vite and SWA remain literal `127.0.0.1`; the Functions child remains under the approved host-local sandbox profile.

## Final boundaries

All work remained inside the approved worktree. No root checkout, Git remote, workflow, push, deployment, Azure/Google resource, Drive data, DNS, custom domain, or secret was changed. Generated `web/dist`, `api-dist`, Playwright traces/screenshots, and `.nxt-local` state remain ignored and uncommitted. Ports `4280`, `5173`, and `7071` are closed, `.nxt-local` is absent, no checkout-owned service/test process remains, `git diff --check` passes, and the implementation commit contains no ignored browser artifacts.

## Review fix round 1 closure

Commit `8ab05f4` closes all four review findings without relaxing the approved Task 14 sandbox or adding a production test endpoint:

- The E2E runner now owns an `AbortController` for each active child. SIGINT/SIGTERM aborts the active command immediately, preserves captured stdout/stderr, reports failure, then enters the same bounded Stop/teardown path. A leading pnpm `--` is stripped before Playwright filters are forwarded.
- Local filesystem mode is bound to a launcher-generated random nonce, exact canonical regular `control.json`, exact ready Functions service identity, and an atomically linked regular `functions.attestation.json`. The attestation must agree byte-for-byte with PID, PGID, full start time, cwd, executable, command, port, and log path in control. The sandboxed worker must have `process.ppid` exactly equal to the live attested Functions PID; self, stale, missing, corrupt, wrong-nonce, symlink, foreign, and non-descendant invocation fail closed. The launcher writes the attestation outside the existing host-local sandbox after observing the final listener owner and before declaring the full stack ready. A Core Tools topology change therefore refuses local mode. Stop validates and removes only the canonical owned attestation. Production still defaults to Google.
- Every Playwright test now starts from the same deterministic IDs under the exact canonical fixture root. Reset waits for the `LocalDriveAdapter` mutation lock to become quiescent, atomically quarantines the old exact root, seeds the replacement, and safely removes the quarantine. A controlled late-write regression proves reset never replaces storage while a request mutation remains in flight. One worker remains enforced.
- Publication creates and archives its own note and passes alone through `pnpm e2e -- e2e/publication.spec.ts`. Owner acceptance now proves title search, tag-filter results, wiki-link navigation, persisted archive, and move-based archive recovery. The shipped UI has no restore-from-Trash action, so the test does not invent one. Conflict uses a Playwright request barrier only to serialize an external locked fixture write before continuing the unchanged real SWA/Functions PUT; it does not mock an API response. Axe covers conflict, publish, and revoke dialogs. Keyboard-only tree movement and command-palette selection/Escape focus restoration are asserted. Reduced motion requires computed animation and transition durations of exactly `0.01ms`. Mobile audits every visible interactive control at `>=44x44`, with one explicit inline rendered wiki-link exception class.
- Caller local/runtime/auth keys, including `NXT_LOCAL_CONTROL_NONCE`, are deleted from runner/build/Vite/SWA base environments. Only the Functions child receives exact launcher values.
- Dialog-only Gruvbox contrast corrections remain scoped to publication fact labels and the revoke danger action; no global palette or layout redesign was made.

### Fix-round RED and focused GREEN

The focused regressions were added before the relevant production fixes. Representative RED evidence included the runner waiting on its controlled long child, missing runtime ownership/attestation admission, filtered publication state dependence, the fixture late-write test failing with `Missing expected rejection`, and the first full suite exposing the active mutation-lock reset race. The first expanded E2E run was `4 passed, 8 failed`; after the primary corrections it was `10 passed, 2 failed`, which isolated the quiescence and dynamic-index test issues before the final green.

Final focused evidence under Node `22.23.1`:

```text
node --test tools/e2e-runner.integration.test.mjs: 2/2 passed
node --test tools/local-fixtures.test.mjs: 4/4 passed
API local ownership + runtime composition: 8/8 passed
static security contract: 3/3 passed
real Task 14 lifecycle env/stack evidence: included in 44/44 final focused run
pnpm e2e -- e2e/publication.spec.ts: 1/1 passed independently
pnpm e2e -- e2e/owner-workspace.spec.ts: 1/1 passed independently
```

The real lifecycle acceptance observed exactly one Functions Node worker whose PPID equaled the attested Core Tools listener PID, then received HTTP 200 from the local vault route. The direct self-PID topology is explicitly rejected. The interrupt fixture completed in less than one second, retained its stdout/stderr, returned nonzero, and recorded that Stop ran.

### Final browser and repository validation after the fixes

The final browser command used Node `22.23.1`, pnpm `11.22.0`, Playwright `1.62.1`, Chromium `151.0.7922.34`, one worker, and every live Google/Drive key explicitly unset:

```text
pnpm e2e
desktop Chromium: 9 passed
mobile Chromium: 2 passed
reduced-motion Chromium: 1 passed
total: 12/12 passed in 35.0 seconds
Stop: PASS; ports 4280/5173/7071 closed; .nxt-local absent
```

The final post-change repository gate was:

```text
env -u <all live Google/Drive keys> PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm validate:codex
lint/typecheck: PASS
API artifact + web build + artifact verifier: PASS (13 web files, 3 API files)
contracts: 14 passed
domain: 29 passed
web: 170 passed
API: 404 passed, 1 skipped
repository test total: 617 passed, 1 skipped
project contract: 2/2 passed
static/artifact/fixture/runner/lifecycle: 44/44 passed in 168.127 seconds
git diff --check: PASS
exit 0
```

The sole skip remains the existing opt-in live Google Drive integration. `web/tsconfig.tsbuildinfo` was restored after the gate. The final screenshots at the three absolute paths listed above were re-inspected at original resolution: the settled command dialog is legible with visible focus, the `390x844` workspace has no horizontal overflow and reachable actions, and the public page contains no owner chrome. Its large white responsive panel is still the intentional deterministic `1x1` white PNG fixture, not a missing asset. Screenshots remain ignored and uncommitted.

No browser mock response, live Drive/Google/GitHub OAuth, Azure control plane, DNS, remote, workflow, deployment, push, or external mutable state was accessed or changed. The SWA CLI global-header omission remains an emulator evidence gap; static configuration and artifact checks remain strict. The emulator-auth page's own Microsoft CDN references remain the previously disclosed CLI behavior.
