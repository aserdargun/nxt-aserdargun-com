# Task 10 fix round 1 report — shell review findings

## Status

DONE

All five Important findings are fixed with focused component, stylesheet, and real Vite preview-plugin tests. Existing routing, session/error handling, API validation, security boundaries, and accepted Task-10 shell constraints remain green. The Task 14 Azure navigation-fallback artifact and the two controller-deferred Minor findings were intentionally left out of scope.

## Commits

- Review-fix base: `53f0bb9` (`docs: open gruvbox shell review fixes`)
- Fix implementation: `d7bd16b` (`fix: close gruvbox shell review findings`)
- This report: committed separately as `docs: report Task 10 fix round one`

## Files

- `web/vite.config.ts`
- `web/src/app/owner-shell.tsx`
- `web/src/theme/gruvbox.css`
- `web/src/theme/layout.css`
- `web/src/test/owner-shell.test.tsx`
- `web/src/test/vite-config.test.ts`
- `.superpowers/sdd/2026-08-23-nxt-markdown-vault/task-10-fix-1-report.md`

`web/tsconfig.tsbuildinfo` was mechanically touched by the build, then restored byte-for-byte to the review base. It is not part of either commit, honoring the controller ruling that its Minor finding is deferred. `web/public/staticwebapp.config.json` remains absent because navigation fallback belongs to Task 14.

## Finding-to-fix map

### 1. Fail-closed local visual-QA session

Implementation in `web/vite.config.ts`:

- Pins version-controlled preview settings to host `127.0.0.1`, port `5173`, and `strictPort: true`.
- Installs the synthetic session middleware only when `NXT_VISUAL_QA_SESSION=1`.
- Refuses middleware activation unless the resolved preview binding exactly matches those three invariants.
- Answers only `GET /api/private/session`; every other method/path passes through.
- Requires a loopback remote address and the exact Host header `127.0.0.1:5173` before returning the synthetic principal; invalid clients/hosts receive `403 Forbidden` without principal data.
- Defines no proxy and remains inactive for normal builds and previews.

Load-bearing tests in `web/src/test/vite-config.test.ts` invoke the real exported Vite config and actual plugin hook. They cover the absent flag, exact local success, wildcard/non-loopback binding rejection, wrong port, disabled strict-port rejection, non-loopback remote rejection, invalid Host rejection, wrong method/path pass-through, and the pinned preview artifact.

Runtime checks also proved that an opt-in `--port 5174` preview exits with the binding guard error and that POST does not receive a synthetic session. An invalid Host was rejected with 403 by Vite's earlier allowed-host layer; direct plugin tests independently prove the plugin's own Host/client guard.

### 2. Semantic color lock

Implementation in `web/src/theme/gruvbox.css` and `web/src/theme/layout.css`:

- Every dark, light, system-dark, and system-light branch maps `--focus` to `var(--yellow)` and `--code` to `var(--orange)`.
- All eight accent tokens and their exact palette values remain present.
- Brand, action, selection, heading, and active-indicator selectors use `var(--yellow)` rather than the bright accent-yellow token.
- Preview inline code uses the semantic `var(--code)` token.

CSSOM-based tests resolve each named theme branch and each relevant layout selector rather than relying on loose text occurrence checks.

### 3. Desktop toolbar geometry

Implementation in `web/src/app/owner-shell.tsx` and `web/src/theme/layout.css`:

- The header now shares the workspace's `23fr 47fr 30fr` tracks.
- Brand and destination navigation occupy the explorer track.
- Add attachment and Publish are keyboard-ordered and right-aligned in the editor track.
- Save status is right-aligned in the context track.

The 1505 × 1045 browser measurement was:

```text
explorer/editor/context widths: 346.140625 / 707.359375 / 451.5 px
editor track: x=346.140625 through x=1053.5
action group: x=778.03125 through x=1039.5
action-group right inset from editor track: 14 px
save status: x=1393 through x=1505
```

The corresponding artifact test asserts the track, column, and alignment declarations by selector.

### 4. Mobile chrome and single-surface behavior

Implementation in `web/src/app/owner-shell.tsx` and `web/src/theme/layout.css`:

- A `matchMedia` subscription distinguishes the mobile breakpoint without changing the desktop's concurrently exposed regions.
- Mobile renders exactly one unhidden destination region at a time; Files, Editor, Preview, and Info each become the sole exposed interactive surface when selected.
- Search height is 44 px; action/path/explorer icons are 22 px; bottom-nav and more icons are 24 px; bottom labels are 13 px.
- Direct attachment/publish actions and all bottom destinations retain minimum 44 px targets.
- The active bottom destination uses transparent background, semantic-yellow text, and a semantic-yellow underline rather than a brown tile.
- Header/path/save continuity, visible focus, and no-horizontal-overflow behavior remain intact.

Component tests click all four destinations and query actual exposed regions; they do not merely inspect state attributes. Selector-scoped CSSOM tests assert every required mobile size and treatment.

Measured at 390 × 844:

```text
search input height: 44 px
action/path/explorer icons: 22 × 22 px
bottom-navigation icons: 24 × 24 px
bottom-navigation label: 13 px
smallest visible interactive target: 44 × 44 px
header / bottom navigation: 140 / 68 px
active background: transparent
active text and underline: rgb(215, 153, 33)
keyboard focus: 2 px solid rgb(215, 153, 33)
horizontal overflow: none
exposed surfaces after clicks: Editor; Files; Preview; Info, one at a time
```

### 5. Accessible full path

`ACTIVE_NOTE.path` is the single source for both desktop and mobile path renderings. `ActiveNotePath` derives visible text, `title`, and the complete accessible label from that value. The production-component test discovers both instances by the exact accessible name `Active note path: Notes / Plans` and confirms the visible/title values match.

## TDD evidence

All Node and pnpm commands used:

```text
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH
```

The focused tests were added before any production edit in this fix round. Initial command:

```sh
pnpm --filter @nxt/web test -- owner-shell vite-config
```

Hard RED:

```text
Test Files  2 failed | 1 passed (3)
Tests       14 failed | 24 passed (38)
Exit status 1
```

The 14 failures covered all five findings: eight real Vite-config/plugin-boundary assertions and six shell/theme/layout/accessibility assertions.

Final focused GREEN with the same command:

```text
Test Files  3 passed (3)
Tests       38 passed (38)
Exit status 0
```

## Full offline validation

All live and local-bypass settings were explicitly unset:

```text
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REFRESH_TOKEN
NXT_ALLOWED_GITHUB_USER
NXT_ALLOWED_GOOGLE_EMAIL
NXT_ARCHIVE_DRIVE_FOLDER_ID
NXT_ASSETS_DRIVE_FOLDER_ID
NXT_DRIVE_INTEGRATION
NXT_INBOX_DRIVE_FOLDER_ID
NXT_INTEGRATION_TEST_DRIVE_FOLDER_ID
NXT_LOCAL_AUTH_BYPASS
NXT_NOTES_DRIVE_FOLDER_ID
NXT_PLANS_DRIVE_FOLDER_ID
NXT_PREFERENCES_DRIVE_FILE_ID
NXT_PRIVATE_DRIVE_FOLDER_ID
NXT_PUBLICATION_MANIFEST_DRIVE_FILE_ID
NXT_PUBLISHED_DRIVE_FOLDER_ID
NXT_VAULT_DRIVE_FOLDER_ID
NXT_VAULT_INDEX_DRIVE_FILE_ID
NXT_VISUAL_QA_SESSION
```

Toolchain:

```text
node v22.23.1
pnpm 11.22.0
```

Fresh final commands and outcomes:

```sh
pnpm --filter @nxt/web test -- owner-shell vite-config
pnpm test
pnpm project:test
pnpm lint
pnpm typecheck
pnpm build
git diff --check
```

```text
focused web: 3 files passed; 38 tests passed
contracts: 11 tests passed
domain: 19 tests passed
web: 38 tests passed
api: 391 tests passed, 1 opt-in live test skipped
full total: 26 files passed, 1 skipped; 459 tests passed, 1 skipped
project contract: 2/2 passed
lint: PASS
typecheck: all 4 applicable workspace projects passed
build: all 4 applicable workspace projects passed
web output: HTML 0.46 kB (0.28 gzip), CSS 12.31 kB (2.97 gzip), JS 413.01 kB (125.10 gzip)
git diff --check: PASS
```

Security/artifact checks:

```sh
rg 'GOOGLE_CLIENT_SECRET|GOOGLE_REFRESH_TOKEN|NXT_PRIVATE_DRIVE_FOLDER_ID' web/dist
rg 'drive\.googleapis\.com|googleapis' web/src --glob '!**/*.test.*'
test ! -e web/public/staticwebapp.config.json
```

```text
production bundle forbidden-marker scan: no matches
production browser-source Google API scan: no matches
Task 14 navigation-fallback artifact: absent
```

The existing session 200/401/403/storage-error tests, route/not-found tests, typed response-validation tests, bundle-boundary test, desktop/mobile destination parity, semantic/live labels, theme-mode tests, focus/reduced-motion/overflow contracts, and exact login copy all remained green.

## Visual QA

### Method and lifecycle

- Built the fresh production web output before starting the preview.
- Started only `NXT_VISUAL_QA_SESSION=1 pnpm exec vite preview`, with all live settings unset and no CLI host/port override. Vite reported only `http://127.0.0.1:5173/`.
- Attempted the required in-app browser first. It returned the exact blocker `Browser is not available: iab`; the runtime list exposed only the user's external signed-in Chrome extension, which was not substituted.
- Used the smallest safe local fallback: the already-installed Playwright 1.62.1 library and matching cached headless Chromium from another local checkout, read-only. No package install, network request, or repository mutation was needed.
- Captured browser-computed metrics, interactions, focus, overflow, console results, and the two screenshots below.
- Inspected all three accepted concepts and both new renders with `view_image` in the same comparison pass.
- Closed Chromium, stopped the Vite process, and verified both ports 5173 and 5174 have no listener.

### Screenshots

- New desktop, 1505 × 1045: `/Users/aserdargun/.codex/visualizations/2026/08/23/01a02e13-724b-7750-8202-cb4bc4a4da0f/task-10-fix-1-desktop.png`
- New mobile, 390 × 844: `/Users/aserdargun/.codex/visualizations/2026/08/23/01a02e13-724b-7750-8202-cb4bc4a4da0f/task-10-fix-1-mobile.png`
- Accepted desktop primary: `docs/design/concepts/nxt-desktop-primary.png`
- Accepted desktop conflict: `docs/design/concepts/nxt-desktop-conflict.png`
- Accepted mobile primary: `docs/design/concepts/nxt-mobile-primary.png`

### `view_image` comparison ledger

| Point | Accepted concept | Fix-round render and disposition |
| --- | --- | --- |
| Desktop container geometry | Open, concurrent explorer/editor/context panels at narrow/dominant/medium proportions | Exact 23/47/30 measurements; crisp continuous separators and no floating-card reinterpretation |
| Desktop action placement | Add attachment and Publish sit toward the editor track's right edge; save state belongs at context right | Action group ends 14 px before editor-track right edge; save state is independently right-aligned in context |
| Shared primary/conflict chrome | Both desktop concepts use the same header, tracks, warm palette, and separator language | Fix render matches that shared chrome; the conflict dialog itself remains correctly assigned to Task 11 |
| Semantic Gruvbox emphasis | Muted warm surfaces with restrained locked yellow for headings, active states, and actions | Render retains exact warm Gruvbox colors; no bright accent-yellow drift, gradients, glass, art, shadows, or card grids |
| Mobile chrome | Title, direct actions, path/save, one content surface, and compact bottom navigation | Same three-row continuation; 22/24 px icon hierarchy, 13 px labels, 44 px minimum targets, and no overflow |
| Mobile active destination | Yellow text/underline without a full brown selected tile | Computed background is transparent; text and underline resolve to exact locked yellow `rgb(215, 153, 33)` |
| Mobile surface parity | Files, Editor, Preview, and Info are equivalent destinations, one active surface at a time | Browser clicks exposed exactly one matching region for all four destinations; component tests prove the same behavior |
| Typography and copy | Compact system/mono type and the approved copy inventory | No visible-copy addition in this fix; only the accessible path name became complete |

No screenshot-driven production change was needed after these five review findings were implemented: the final captures confirmed the intended corrections. Console warning/error arrays were empty at both viewports, the full accessible path appeared twice as expected, and overlay/overflow counts were zero.

### Copy diff and Task-10-only deviations

Visible copy is unchanged. The only copy-level change is nonvisual accessibility metadata: generic `Active note path` is now `Active note path: Notes / Plans`. No marketing copy, badges, pills, metrics, raw identifiers, OAuth values, or private configuration was added.

The sparse explorer/editor/preview/info content remains intentionally replaceable by Tasks 11–13. The accepted conflict modal remains Task 11, complete editor/explorer behavior remains Tasks 11–12, and public surfaces remain Task 13. No final full-app fidelity claim is made.

## Port closure

```text
127.0.0.1:5173 listener: none
127.0.0.1:5174 listener: none
```

The 5174 check covers the deliberately refused invalid-binding runtime attempt as well as the approved 5173 preview.

## Concerns

- No implementation blocker remains.
- The one skipped full-suite test is the existing opt-in live Google Drive integration and correctly stayed disabled.
- The in-app browser runtime was unavailable, so the permitted smallest local Playwright fallback supplied the visual evidence.
- Azure navigation fallback, the generated TypeScript build-info Minor, and generic Headers normalization remain explicitly deferred by controller ruling.

## External state

No live Google Drive or OAuth credential/service was read or changed. `.env.local`, GitHub, Azure, DNS, deployment, remotes, custom domains, and every other external mutable system were not accessed or mutated. No dependency was installed, no push or deployment occurred, and visual QA used only the fail-closed deterministic local preview session.
