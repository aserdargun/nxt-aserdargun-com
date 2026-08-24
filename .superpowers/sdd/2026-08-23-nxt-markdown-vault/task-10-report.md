# Task 10 report — authenticated React shell and Gruvbox design system

## Status

DONE

Task 10 now supplies the reusable Vite/React entrypoint, typed application-API client, deterministic routing and session gate, dark-first semantic Gruvbox theme, concurrent desktop shell, and single-surface mobile shell. Editor, explorer, conflict, and public feature depth remains assigned to Tasks 11–13.

## Commits

- Base: `b4d230224a830c251c5216d8a841f0d5b4be6cbb`
- Task 10 implementation: `8439236` (`feat: add responsive gruvbox shell`)
- This report: committed separately as `docs: report Task 10`

## Files

Created the pinned web package and shell architecture:

- `web/package.json`
- `web/tsconfig.json`
- `web/tsconfig.tsbuildinfo`
- `web/vite.config.ts`
- `web/index.html`
- `web/src/main.tsx`
- `web/src/api/client.ts`
- `web/src/api/session.ts`
- `web/src/app/providers.tsx`
- `web/src/app/router.tsx`
- `web/src/app/login-page.tsx`
- `web/src/app/not-found-page.tsx`
- `web/src/app/owner-shell.tsx`
- `web/src/theme/gruvbox.css`
- `web/src/theme/layout.css`
- `web/src/test/setup.ts`
- `web/src/test/login-page.test.tsx`
- `web/src/test/owner-shell.test.tsx`

Updated `pnpm-lock.yaml` for the exact pinned web dependencies. The generated `web/dist/` build remained ignored by repository policy. `ATTRIBUTIONS.md` already contained the required MIT attribution to `insanum/obsidian_gruvbox`; it was verified and preserved without a content change.

## Implementation contracts

- `getSession()` makes exactly one same-origin browser request: `GET /api/private/session`. Browser production source contains no Google API endpoint or Google API client reference.
- `requestJson()` accepts only `/api/${string}` paths, validates successful JSON with the supplied shared schema, validates every non-2xx JSON body with `ApiErrorSchema`, and exposes typed status/code/request-ID errors. Invalid or non-JSON bodies fail as `ApiContractError`.
- `/` redirects deterministically to the visible `/login` route. `/login` exposes exactly `Continue with GitHub` at `/.auth/login/github?post_login_redirect_uri=/app`. Unknown routes keep their path and render a proper `Not found` page.
- `/app/*` renders the owner shell only after a schema-valid 200 session. A typed 401 redirects to `/login`; a typed 403 remains visible with the safe Azure logout path `/.auth/logout?post_logout_redirect_uri=/login`; storage/service errors remain at `/app` and do not offer sign-out.
- The shell is componentized into providers, routing/gate, API boundary, header/navigation, explorer, editor, preview, info, theme tokens, and layout rules. Skeleton copy is intentionally replaceable by Tasks 11–13.
- Desktop keeps explorer/editor/context simultaneously visible at measured 23/47/30 proportions. Mobile keeps one active surface and equivalent Files, Editor, Preview, and Info destinations in a persistent bottom navigation.
- Save status is a polite live `output`; the shell uses banner/main/navigation/region landmarks and explicit labels. Direct Add attachment and Publish actions do not depend on hover.
- Touch targets are at least 44 CSS px, keyboard focus is a visible 2 px Gruvbox yellow outline, reduced motion is honored, and the document has no horizontal overflow.
- Dark is the initial mode. Light and system modes use the same semantic token interface. Tokens include background, surface/panel, text, muted text, border, focus, selection, error, warning, success, link, code, and all eight Gruvbox accents.
- Fonts are local/system-only. Lucide icons use a restrained 1.75 px stroke. No marketing copy, hero content, pills, badges, fake metrics, gradients, glass, decorative art, shadows, or card grids were introduced.

## RED evidence

The required login/shell test files were written before any production `web/src` source existed.

Initial required command with the package still absent:

```sh
pnpm --filter @nxt/web test -- login-page owner-shell
```

```text
No projects matched the filters in the workspace.
Exit status 0
```

`pnpm` 11.22.0 treats a missing filter as a successful no-op, so this did not provide a hard failing process. Only the pinned package/test configuration was then added; no production source existed. The same required command produced the hard RED:

```text
FAIL src/test/login-page.test.tsx
Error: Failed to resolve import "../api/client"

FAIL src/test/owner-shell.test.tsx
Error: Failed to resolve import "../app/owner-shell"

Test Files 2 failed (2)
Tests 0
Exit status 1
```

During focused convergence, semantic assertions independently caught duplicate banner and Files-region semantics at 19/20 before their fixes. Screenshot review then identified a duplicate mobile editor toolbar; an artifact regression test was added first and observed RED:

```sh
pnpm --filter @nxt/web test -- owner-shell
```

```text
Test Files 1 failed | 1 passed (2)
Tests 1 failed | 20 passed (21)
Exit status 1
```

The mobile CSS fix then restored 21/21.

## Focused GREEN evidence

All Node and pnpm commands used `PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH`. All live Drive/OAuth/runtime settings listed below were explicitly unset.

```sh
pnpm --filter @nxt/web test -- login-page owner-shell
```

```text
Test Files 2 passed (2)
Tests 21 passed (21)
Exit status 0
```

The final implementation also passed the brief's complete focused sequence: focused tests, `pnpm --filter @nxt/web typecheck`, and `pnpm --filter @nxt/web build`.

## Full validation

Environment removed for every final validation command:

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

Full repository tests:

```sh
pnpm test
```

```text
contracts: 1 file passed; 11 tests passed
domain: 4 files passed; 19 tests passed
web: 2 files passed; 21 tests passed
api: 18 files passed, 1 skipped; 391 tests passed, 1 skipped
Total: 25 files passed, 1 skipped; 442 tests passed, 1 skipped
Exit status 0
```

Repository contract, lint, typecheck, and build:

```sh
pnpm project:test
pnpm lint
pnpm typecheck
pnpm build
```

```text
project contract: 2/2 passed
eslint: PASS
typecheck: all 4 applicable workspace projects passed
build: all 4 applicable workspace projects passed
web output: HTML 0.46 kB (0.28 gzip), CSS 11.87 kB (2.87 gzip), JS 412.33 kB (124.83 gzip)
```

Artifact/security checks:

```sh
rg 'GOOGLE_CLIENT_SECRET|GOOGLE_REFRESH_TOKEN|NXT_PRIVATE_DRIVE_FOLDER_ID' web/dist
rg 'drive\.googleapis\.com|googleapis' web/src --glob '!**/*.test.*'
git diff --check
lsof -nP -iTCP:5173 -sTCP:LISTEN
```

```text
Production bundle forbidden-marker scan: no matches
Production browser-source Google API scan: no matches
git diff --check: PASS
Port 5173: no listener
```

## Visual QA

### Method

- Started one bounded Vite preview on `127.0.0.1:5173` with `--strictPort`, all live settings unset, and only `NXT_VISUAL_QA_SESSION=1` enabled.
- The env-gated preview middleware answered only `GET /api/private/session` with a schema-valid deterministic local owner. It cannot call Drive, OAuth, Google APIs, or another host and is inactive in normal builds/previews unless explicitly opted in.
- Used the in-app browser for rendering, metrics, interaction, keyboard focus, console/log inspection, and screenshots. The temporary browser viewport override was reset afterward.
- Inspected the three accepted concepts and both rendered screenshots directly with `view_image` in the same final comparison pass.
- Closed the browser tab, interrupted the project-local preview, and verified port 5173 had no listener.

### Screenshots and viewports

- Accepted desktop: `docs/design/concepts/nxt-desktop-primary.png`
- Accepted mobile: `docs/design/concepts/nxt-mobile-primary.png`
- Accepted conflict: `docs/design/concepts/nxt-desktop-conflict.png`
- Rendered desktop, 1505 × 1045: `/Users/aserdargun/.codex/visualizations/2026/08/23/01a02e13-724b-7750-8202-cb4bc4a4da0f/task-10-desktop.png`
- Rendered mobile, 390 × 844: `/Users/aserdargun/.codex/visualizations/2026/08/23/01a02e13-724b-7750-8202-cb4bc4a4da0f/task-10-mobile.png`

### Comparison ledger

| Comparison point | Accepted concept | Rendered Task 10 result | Fix or disposition |
| --- | --- | --- | --- |
| Desktop region geometry | Narrow explorer, dominant editor, medium context in one open-panel container | Browser measurement was exactly 23% / 47% / 30%; all three regions remain concurrently visible | No geometry fix required |
| Warm Gruvbox palette | Warm near-black canvas, slightly raised chrome, beige text, yellow selection/action accent | Exact measured `#282828` background, `#32302f` surface, `#504945` border, `#ebdbb2` text, and Gruvbox yellow accents | Preserved through semantic tokens for dark/light/system |
| Separators and surface language | Crisp thin dividers, restrained radii, no floating card grid | 1 px separators, 4–5 px control radii, flat open panels, no gradients/glass/shadows/cards | Kept flat; the concept's subtle rendered texture was not recreated as decorative art |
| Typography and icons | Compact UI type, readable mono editor, thin outline icons | 12–14 px UI type, 15 px desktop/16 px mobile mono editor, 29 px preview title, Lucide icons at 1.75 px | Save indicator changed from an outline mark to the accepted filled green circle/check treatment |
| Mobile chrome continuity | Title, attachment/publish row, path/save row, editor directly below, bottom destinations | One active surface with the same three-row flow and fixed Files/Editor/Preview/Info navigation | Removed a duplicate editor toolbar; added the missing Folder icon; compacted header 168→140 px and nav 76→68 px while retaining 44 px targets |
| Mobile interaction and accessibility | Active destination is obvious and destinations remain equivalent | Preview and Info clicks switched the sole visible surface; keyboard focus measured solid 2 px `rgb(250, 189, 47)`; minimum target 44 × 44; no horizontal overflow | No remaining shell interaction mismatch |
| Conflict continuation | Same desktop shell/chrome beneath a centered conflict surface | Shared desktop geometry, palette, dividers, type, and icon language match the accepted conflict concept | Conflict modal/content is intentionally deferred to Task 11, not claimed as Task 10 fidelity |

Console error and warning arrays were empty at both viewports. The final mobile metrics were header 140 px, bottom navigation 68 px, minimum interactive target 44 × 44, duplicate editor toolbar `display: none`, and `scrollWidth === clientWidth`.

### Visible-copy comparison

The rendered shell uses only the approved inventory: NXT, Files, Notes, Plans, Inbox, Archive, Favorites, Tags, Editor, Preview, Info, Outline, Backlinks, Add attachment, Publish, and Saved. The search placeholder is `Files`; no unapproved `Search files...` copy was introduced. The accepted concepts' example note prose and Turkish file/content strings were replaced with the sparse `Plans` skeleton because Tasks 11–13 own full explorer/editor/public content and the Task 10 copy inventory is intentionally narrower.

Route-only copy remains the required functional inventory: Continue with GitHub, Not found, Error, Sign out, and typed safe API messages. No raw Drive ID, OAuth value, email allowlist, owner configuration, or private folder configuration is rendered.

The browser capture excludes native iOS status/home-indicator chrome. This does not change the measured 390 × 844 web viewport or shell geometry.

### Intentional Task-10-only deviations

- Explorer/editor/preview contents are sparse replaceable skeletons, not the complete note workflow from the concepts; Tasks 11–13 own those features.
- The accepted conflict modal is not implemented; Task 11 owns conflict behavior and presentation.
- No public-page fidelity is claimed; Task 13 owns public views.
- Full editor content, explorer operations, and information panels are not simulated with fake metrics or unapproved sample copy.

## Concerns

No blocker. The one skipped API test is the existing opt-in live Google Drive integration test and remained intentionally disabled. The initial missing-package RED command's exit-zero behavior is a pnpm filter no-op; the subsequent pre-production-source run supplied the required hard RED evidence. Visual fidelity is assessed only for Task 10 shell geometry, theme, and chrome.

## External state

No live Google Drive/OAuth credential or service was read or changed. `.env.local`, GitHub, Azure, DNS, deployment, remotes, custom domains, and all other external mutable state were not accessed or mutated. No push or deploy occurred. Visual QA used only a deterministic project-local session response, and its server was stopped with port closure verified.
