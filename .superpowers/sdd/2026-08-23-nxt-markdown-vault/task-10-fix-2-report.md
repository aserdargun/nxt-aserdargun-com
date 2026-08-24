# Task 10 fix round 2 report — narrow-desktop header containment

## Status

DONE

The redundant desktop destination controls are now omitted while the 23% explorer header track cannot contain them. They return at the measured wide-desktop transition. The three desktop workspace panels, primary actions, save state, path, keyboard order, mobile behavior, loopback-only preview boundary, semantic colors, and large-desktop accepted chrome remain intact.

## Commits

- Fix-round base: `c9c1d98` (`docs: record gruvbox shell fix round one`)
- Implementation: `4f4e589` (`fix: contain shell header at medium widths`)
- This report: committed separately as `docs: report Task 10 fix round two`

## Files

- `web/src/app/owner-shell.tsx`
- `web/src/test/owner-shell.test.tsx`
- `.superpowers/sdd/2026-08-23-nxt-markdown-vault/task-10-fix-2-report.md`

The controller progress ledger was not edited. The build mechanically touched `web/tsconfig.tsbuildinfo`; it was restored byte-for-byte to the base and is not committed. The Task 14 navigation-fallback artifact remains absent.

## Root cause and containment strategy

The header and workspace correctly share `23fr 47fr 30fr`, but `.shell-header-explorer` previously always rendered:

- a measured 93.1875 px NXT brand box, including its padding; and
- four 44 px desktop destination targets, totaling 176 px.

Their measured min-content total is 269.1875 px. The explorer track is only 176.625 px at a 768 px viewport and 235.515625 px at 1024 px. The initially estimated 1157 px transition was also insufficient: its 23% track measured 266.109375 px.

The owner shell now subscribes to a derived `min-width: 1171px` media-query boolean. It does not render the redundant desktop header navigation below that boundary. At 1171 px, the explorer track measures 269.328125 px, so the final destination edge at 269.1875 px remains inside it. This is a documented, measured min-content threshold rather than clipping or an arbitrary overflow mask.

At 768–1170 px:

- no redundant desktop header destination button exists or can receive focus;
- NXT remains contained in the explorer track;
- Files, Editor, and Preview remain concurrently visible;
- Add attachment and Publish remain directly visible in the editor track;
- Saved remains visible in the context track;
- the complete desktop note path remains visible; and
- no control wraps, shrinks below 44 px, scrolls horizontally, or changes keyboard order.

At 1171 px and 1505 px, all four accepted large-desktop destination icons are restored. The header/workspace CSS geometry was not changed, preserving the approved large-desktop primary and conflict chrome.

## TDD evidence

All Node and pnpm commands used:

```text
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH
```

All live Drive/OAuth and local-bypass settings were unset.

### Initial RED

The component behavior tests were added before the production component edit. They exercise the real owner shell through a width-aware `matchMedia` test boundary and assert that medium widths do not render the focusable desktop destination navigation while panels/actions/save remain exposed.

```sh
pnpm --filter @nxt/web test -- owner-shell
```

```text
Test Files  1 failed | 2 passed (3)
Tests       3 failed | 40 passed (43)
Failed widths: 768, 1024, 1156
Exit status 1
```

The failure was the exact regression: `Desktop destinations` and its four real buttons were still in the production component.

### First GREEN and measured correction

The initial estimate used 1157 px from the approximate 90 + 176 px calculation.

```text
Test Files  3 passed (3)
Tests       43 passed (43)
Exit status 0
```

Browser-computed QA then caught that approximation as insufficient. At 1157 px, the real 93.1875 px brand plus 176 px navigation ended at x=269.1875 while the explorer track ended at x=266.109375.

The exact measured transition was fed back through another test-first cycle before changing production:

```text
Test Files  1 failed | 2 passed (3)
Tests       2 failed | 43 passed (45)
Failed widths: 1157, 1170
Exit status 1
```

### Final focused GREEN

After moving the production media-query boundary to 1171 px:

```text
Test Files  3 passed (3)
Tests       45 passed (45)
Exit status 0
```

The transition tests now protect all of 768, 1024, 1156, 1157, and 1170 as contained medium desktop, plus 1171 and 1505 as large desktop with the destination controls restored. A wrong lower threshold, wrong higher threshold, always-rendered nav, or never-rendered nav fails at least one case.

## Full offline validation

Settings removed from the final command environment:

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

Fresh commands:

```sh
pnpm test
pnpm project:test
pnpm lint
pnpm typecheck
pnpm build
git diff --check
```

Results:

```text
contracts: 1 file, 11 tests passed
domain: 4 files, 19 tests passed
web: 3 files, 45 tests passed
api: 18 files passed, 1 skipped; 391 tests passed, 1 skipped
full total: 26 files passed, 1 skipped; 466 tests passed, 1 skipped
project contract: 2/2 passed
lint: PASS
typecheck: all 4 applicable workspace projects passed
build: all 4 applicable workspace projects passed
web output: HTML 0.46 kB (0.29 gzip), CSS 12.31 kB (2.97 gzip), JS 413.43 kB (125.16 gzip)
git diff --check: PASS
```

Security/artifact checks:

```sh
rg 'GOOGLE_CLIENT_SECRET|GOOGLE_REFRESH_TOKEN|NXT_PRIVATE_DRIVE_FOLDER_ID' web/dist
rg 'drive\.googleapis\.com|googleapis' web/src --glob '!**/*.test.*'
test ! -e web/public/staticwebapp.config.json
```

```text
production forbidden-secret scan: no matches
production browser-source Google API scan: no matches
Task 14 navigation-fallback artifact: absent
```

The round-1 preview-plugin boundary tests, exact theme branch/selector tests, mobile sizing/single-surface tests, accessible full-path test, session 200/401/403/storage behavior, typed response validation, routes/not-found, reduced motion, focus, overflow, and production-bundle boundary all remain included in the 45 passing web tests.

## Visual and computed QA

### Method and lifecycle

- Built fresh production output.
- Started only `NXT_VISUAL_QA_SESSION=1 pnpm exec vite preview`, with live settings unset and no host/port CLI override. The guarded config bound exactly to `127.0.0.1:5173` with strict port.
- Tried the in-app browser first. It returned `Browser is not available: iab`; troubleshooting listed only the user's signed-in external Chrome, which was not used.
- Used the explicitly permitted fallback: existing local Playwright 1.62.1 and matching cached headless Chromium, read-only. No install, network access, or repository mutation occurred.
- Resized one page instance across 768, 1024, 1156, 1157, 1170, 1171, and 1505 px, proving the media-query subscription transitions during a live session.
- Captured geometry, visibility, focus order, target size, overflow, overlay, console, path, and screenshots.
- Inspected the accepted desktop primary/conflict concepts, the 1505 render, and intermediate renders directly with `view_image`.
- Closed Chromium, stopped Vite, deleted the temporary QA script, and verified ports 5173 and 5174 closed.

### Screenshot paths

- 768 × 844: `/Users/aserdargun/.codex/visualizations/2026/08/23/01a02e13-724b-7750-8202-cb4bc4a4da0f/task-10-fix-2-768.png`
- 1024 × 844: `/Users/aserdargun/.codex/visualizations/2026/08/23/01a02e13-724b-7750-8202-cb4bc4a4da0f/task-10-fix-2-1024.png`
- 1156 × 844: `/Users/aserdargun/.codex/visualizations/2026/08/23/01a02e13-724b-7750-8202-cb4bc4a4da0f/task-10-fix-2-1156.png`
- 1157 × 844: `/Users/aserdargun/.codex/visualizations/2026/08/23/01a02e13-724b-7750-8202-cb4bc4a4da0f/task-10-fix-2-1157.png`
- 1170 × 844: `/Users/aserdargun/.codex/visualizations/2026/08/23/01a02e13-724b-7750-8202-cb4bc4a4da0f/task-10-fix-2-1170.png`
- 1171 × 844: `/Users/aserdargun/.codex/visualizations/2026/08/23/01a02e13-724b-7750-8202-cb4bc4a4da0f/task-10-fix-2-1171.png`
- 1505 × 1045: `/Users/aserdargun/.codex/visualizations/2026/08/23/01a02e13-724b-7750-8202-cb4bc4a4da0f/task-10-fix-2-desktop.png`

Accepted references:

- `docs/design/concepts/nxt-desktop-primary.png`
- `docs/design/concepts/nxt-desktop-conflict.png`

### Computed geometry

| Viewport | Explorer header/track right | Desktop destinations | Editor action bounds | Context save bounds | Minimum visible touch target |
| --- | ---: | --- | --- | --- | --- |
| 768 × 844 | 176.625 / 176.625 | omitted | 176.625–537.594 | 655.984–767.984 | 64.781 × 44 |
| 1024 × 844 | 235.516 / 235.516 | omitted | 235.516–716.797 | 911.984–1023.984 | 69.328 × 44 |
| 1156 × 844 | 265.875 / 265.875 | omitted | 265.875–809.188 | 1044–1156 | 69.328 × 44 |
| 1157 × 844 | 266.109 / 266.109 | omitted | 266.109–809.891 | 1044.984–1156.984 | 69.328 × 44 |
| 1170 × 844 | 269.094 / 269.094 | omitted | 269.094–819 | 1058–1170 | 69.328 × 44 |
| 1171 × 844 | 269.328 / 269.328 | 4, final edge 269.188 | 269.328–819.688 | 1058.984–1170.984 | 44 × 44 |
| 1505 × 1045 | 346.141 / 346.141 | 4, final edge 269.188 | 346.141–1053.5 | 1393–1505 | 44 × 44 |

At every viewport:

- explorer children remained at or left of the explorer track's right edge;
- the action group stayed at or right of the editor track's left edge and at or left of its right edge;
- explorer/action collision was false;
- save stayed within the context track;
- Files, Editor, and Preview were concurrently visible;
- the desktop path, both primary actions, and save state were visible;
- `scrollWidth === clientWidth`;
- the full accessible path count was two;
- no framework overlay, console error, or console warning appeared.

Keyboard order was `Add attachment → Publish → Files search` at medium widths. At 1171 and 1505 it was `Files → Editor → Preview → Info → Add attachment → Publish`, preserving source order when the redundant controls return.

### `view_image` comparison ledger

| Point | Accepted concepts | Final render and disposition |
| --- | --- | --- |
| Large desktop geometry | 23/47/30 open-panel shell with three concurrent regions | 1505 remained exactly 346.141 / 707.359 / 451.5 px; no CSS geometry change |
| Large desktop header chrome | NXT and destination icons at explorer left, actions toward editor right, Saved at context right | 1505 render remains visually unchanged from round 1 and directly matches the primary/conflict shared chrome |
| Medium explorer containment | Header children must respect the explorer/editor separator | 768–1170 show only the NXT brand in the explorer header; no clipping, invisible focusable control, or separator crossing |
| Primary action availability | Add attachment/Publish remain direct and do not wrap | Both remain one row, 44 px high, right-aligned inside the editor track at every tested width |
| Transition behavior | Large icons should return when they fit | 1170 omits them; 1171 restores all four with a measured 0.140625 px containment margin |
| Surface and palette | Warm flat Gruvbox, crisp separators, restrained radii, no decorative reinterpretation | All screenshots preserve the accepted color, line, typography, and icon language; no gradient, glass, cards, pills, badges, or art added |
| Conflict continuation | Conflict concept shares underlying desktop chrome | Shared 1505 shell remains compatible; Task 11 still owns the conflict surface itself |

The first 1505 capture retained the last keyboard focus outline on Publish. The QA harness was corrected to clear focus after recording keyboard order, and every screenshot was recaptured. This was evidence cleanup, not a production change.

### Copy diff and Task boundaries

Visible and accessible copy is unchanged. No marketing copy, placeholder metric, raw Drive ID, OAuth value, or private configuration was added.

Tasks 11–13 still own complete explorer/editor/conflict/public feature fidelity. Task 14 still owns Azure navigation fallback. This fix assesses only Task 10 shell containment and shared chrome.

## Port closure

```text
127.0.0.1:5173 listener: none
127.0.0.1:5174 listener: none
```

## Concerns

- No blocker remains.
- The 1171 px boundary is intentionally documented from measured min-content geometry; large-desktop icons remain available at the accepted 1505 px viewport.
- The one skipped repository test is the existing opt-in live Google Drive integration and remained disabled.
- The in-app browser was unavailable, so the permitted safe local Playwright fallback supplied the rendered evidence.

## External state

No live Google Drive/OAuth credential or service was read or changed. `.env.local`, GitHub, Azure, DNS, deployment, remotes, custom domains, and all other external mutable systems were not accessed or mutated. No dependency was installed, no push/deploy occurred, and the visual session existed only on the guarded project-local loopback preview.
