### Task 15: Add full browser, mobile, accessibility, and security regression coverage

**Planned files:**
- Create: `playwright.config.ts`
- Create: `e2e/fixtures.ts`
- Create: `e2e/owner-workspace.spec.ts`
- Create: `e2e/mobile-workspace.spec.ts`
- Create: `e2e/drafts-conflicts.spec.ts`
- Create: `e2e/publication.spec.ts`
- Create: `e2e/security.spec.ts`
- Create: `e2e/accessibility.spec.ts`
- Create: `e2e/visual-layout.spec.ts`
- Create only if required: a narrow local-fixture bootstrap/control helper below `scripts/` and its focused tests below `tools/`
- Modify only as required for the local simulator composition: `api/src/services/runtime-services.ts`, affected handler dependency types/calls, their exact unit tests, `scripts/local-dev.mjs`, `scripts/stop-local-core.mjs`, `package.json`, `pnpm-lock.yaml`, and tracked build artifacts

**Interfaces:**
- Consumes: the complete Task 14 local SWA stack, the Task 4 filesystem Drive simulator, and the finished owner/public UI.
- Produces: deterministic local-only Chromium acceptance evidence at 1440x1000, 390x844, and reduced-motion desktop contexts.

## Frozen acceptance contract

- Use Node 22.23.1 and pnpm 11.22.0. Pin exactly `@playwright/test@1.62.1` and `@axe-core/playwright@4.13.0`. Chromium is the only browser required. Do not add a hosted test service.
- Begin with focused RED evidence for the missing local runtime/fixture path and at least one representative owner journey. Do not manufacture RED by weakening an existing assertion.
- `pnpm e2e` must own one complete `pnpm dev:codex` lifecycle, wait on `domcontentloaded`, and always invoke `pnpm stop:codex` in teardown, including failure and interruption paths. It must verify 4280/5173/7071 are closed and remove only its exact verified fixture subtree. Never kill by port or leave a server/control/log process behind.
- All browser state must use `LocalDriveAdapter` rooted at an exact canonical non-symlink directory below this checkout's `.nxt-local/fixtures`; never read Google credentials, `.env.local`, live Drive IDs, GitHub, Azure, DNS, deployment state, remotes, or external mutable services. Explicitly unset all Google/Drive integration variables in the e2e launcher.
- Task 15 may add the minimum local-runtime composition required to make the already planned simulator reachable through the real Functions/SWA path. The Google production composition remains the default and must not become async-unsafe or accept a local filesystem path in production. Local mode is admitted only when all existing local auth bypass guards hold, Functions is Development/non-production, and the trusted launcher supplies a canonical checkout-owned fixture root. Caller-provided local backend/root/fixture variables must be removed from build/Vite/SWA environments and replaced only in the Functions child.
- If runtime service resolution becomes asynchronous for `LocalDriveAdapter.create`, update every affected handler dependency contract deliberately and preserve existing synchronous test injection compatibility with `await Promise.resolve(...)`; add focused API tests for production default, local-mode guard rejection, canonical root enforcement, and shared Task 7/Task 9 local storage composition.
- Seed a fresh deterministic vault before the Functions service starts: exact `vault`/`private` roots, Notes/Inbox/Plans/Archive/_assets/published folders, valid empty vault index/preferences/publication manifest, and bounded representative Markdown/image fixtures. Persist only synthetic local IDs. The seed/bootstrap must refuse symlinks, traversal, unexpected pre-existing roots, live Drive configuration, and paths outside `.nxt-local/fixtures`.
- Fixture reset/mutation must be serialization-safe. Use one Playwright worker unless an independently isolated per-worker stack is proven. External-write/conflict simulation must use the same locked `LocalDriveAdapter` semantics or an equally narrow local-only fixture mechanism; do not add a production or anonymously reachable test-control HTTP endpoint.
- Desktop owner journey must authenticate through the SWA local GitHub emulator, enter as exact owner `aserdargun`, create a note, edit title/body, observe durable `Saved`, navigate wiki/search/tag paths, move/archive/Trash/recover as the implemented UI actually supports, and verify reload-safe state. Tests must use accessible roles/labels and may adapt the illustrative plan wording to the shipped controls without weakening the outcome.
- Mobile parity must prove every desktop destination is reachable at 390x844, editor interaction is usable, no horizontal overflow exists, and touch targets for interactive controls are at least 44x44 CSS pixels unless an accessible text-inline exception is explicitly documented.
- Draft/conflict coverage must prove offline edits produce `Offline draft`, reload restores them, and a serialized external local-adapter write opens the three-choice conflict dialog without overwriting either version. Browser context offline mode must be restored in teardown.
- Attachment/publication coverage must prove a pasted or selected allowlisted raster is persisted before its portable reference appears; public route is route-split, has no owner controls/private-session request, includes `noindex,nofollow`, serves only snapshotted allowlisted assets, and becomes generic 404 immediately after revoke. Do not introduce an SVG/HTML inline render path.
- Security browser/API scenarios cover anonymous and wrong-owner private access, malformed principal, arbitrary opaque/Drive identifiers, traversal, oversize note/upload, SVG/HTML upload, malformed public IDs, manifest corruption, and redacted fail-closed bodies. Never print fixture secrets or raw backing IDs. Global SWA response headers that the local SWA CLI devserver proxy omits remain an emulator evidence gap; source/config assertions must still enforce them and the browser suite must not weaken policy.
- Axe must report zero serious/critical violations on login, owner explorer/editor/preview, conflict or confirmation dialog, and public note pages. Prove keyboard-only tree and command-palette navigation, focus restoration, live save status semantics, and reduced-motion behavior.
- Visual-layout assertions must verify `document.documentElement.scrollWidth === document.documentElement.clientWidth` at desktop and mobile sizes and capture deterministic failure artifacts only under ignored Playwright output directories. No screenshot baselines are required unless they are stable and materially useful.
- Keep tests bounded and deterministic. Prefer explicit response/UI state waits to fixed sleeps. Use `domcontentloaded`, never `networkidle`. On failure, preserve useful Playwright trace/screenshot evidence without secrets, then still stop the stack.
- Run exact focused RED/GREEN tests, `pnpm exec playwright install chromium`, `pnpm e2e`, and the full live-Drive-unset `pnpm validate:codex`. Rebuild tracked API output as required, restore `web/tsconfig.tsbuildinfo`, run `git diff --check`, and return a clean worktree with ports/state/processes closed.
- The Task 14 lifecycle safety contract is frozen: no kill-by-port, broad process enumeration, unsafe recursive deletion, ownership weakening, wildcard expansion beyond the existing sandbox ruling, or caller-controlled auth bypass. Task 15 must add no GitHub workflow, Azure/Google resource, deployment, DNS, secret, remote, push, or custom-domain work.
- Commit implementation/tests as `test: cover nxt owner and public journeys`; commit the forced-added Task 15 report/progress separately. Record exact project/test counts, browser version, skips, any justified coverage deviation, teardown evidence, and remaining emulator-only evidence gaps.

## Review priorities

- The browser suite must exercise the real SWA/Functions/Vite path, not mock application APIs in-page.
- Local mode must be structurally unreachable in production and must not leak into generated artifacts or non-Functions children.
- Fixture mutation/reset must not race the Functions process or delete anything outside the exact checkout fixture root.
- Authentication setup must use only SWA's local emulator and the existing narrowly guarded bypass; no real GitHub OAuth.
- Tests must assert meaningful outcomes rather than merely presence of generic text or status codes.
- Teardown must be independently proven after both green and intentionally failing test paths.
