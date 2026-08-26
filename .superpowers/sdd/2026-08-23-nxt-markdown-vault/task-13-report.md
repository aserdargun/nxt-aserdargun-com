# Task 13 Report — Attachments, Publication Controls, and Public Notes

## Status

DONE

Task 13 is implemented in commit `988ec48` (`feat: add attachments and public note view`). This report and the progress-ledger update are committed separately.

The authenticated owner journey now uploads, renders, and trashes bounded attachments; publishes and revokes a version-fenced immutable snapshot with reload-safe status; and opens a route-split anonymous note that exposes only the frozen public projection and exact allowlisted assets.

## Scope delivered

- Added closed shared upload, publication-status, revoke, and public-note contracts. The 20 MiB byte boundary and exact base64 ceiling are shared by source and generated artifacts.
- Added the minimum exact-owner `GET /api/private/notes/{noteId}/publication` route. Status is resolved by stable note ID plus `activeRevisionId` and returns only `{ publicId, publishedAt, sourceVersion, attachmentCount }` or `null`.
- Added typed fail-closed browser clients for attachment upload/Trash, private publish/status/revoke, and anonymous public note reads.
- Publish is accepted only after the private status read and anonymous public read both confirm the requested public ID/source version. Revoke is accepted only after a cache-bypassed anonymous read returns the exact generic `404` contract.
- Wired the owner header and Task 12 palette to current note/save/publication state. Status is re-read after reload and fenced across note changes.
- Added one-file picker, drag/drop, and image paste upload. More than exactly 20 MiB is rejected before any byte read/base64/fetch; multi-file drops fail visibly; same-file input can be reused; concurrent, note-change, and unmount completions are fenced.
- Added stack-safe byte encoding. Upload success refreshes the complete vault before inserting one percent-encoded relative `_assets/<note-id>/<server-name>` Markdown reference into the autosaved source.
- Added same-origin safe attachment cards. Only server-classified PNG/JPEG/WebP/GIF and PDF render inline; other types download. Persisted assets never use `blob:`, `data:`, external, or raw Drive URLs.
- Added explicit Radix publish/revoke dialogs with double-submit fencing, controlled errors, focus trap/restoration, 44 px controls, and successful focus fallback when the Revoke trigger is removed.
- Added the route-level lazy `/p/:publicId` surface. It validates the route ID before fetch, calls only `/api/public/*`, renders the server-sanitized projection, maintains exactly one `noindex,nofollow` meta value through loading/success/not-found, and restores prior metadata on unmount.
- Kept Task 10–12 autosave, offline/conflict recovery, explorer, search, tree, wiki navigation, and command-palette behavior green. Task 14 artifacts and Task 15 Playwright/axe suites were not absorbed.

## TDD and regression coverage

The initial hard RED runs happened before production edits:

```text
contracts: exit 1; 3 failed, 11 passed
API: exit 1; 3 failed, 391 passed, 1 skipped
web: exit 1; 3 new suites failed at missing modules, 140 existing tests passed
```

The browser later exposed a missing successful-publish focus restoration path. A focused regression reproduced it before the fix:

```text
web: exit 1; 1 failed, 159 passed
reason: dialog close left document.activeElement on BODY instead of Publish
```

The committed tests cover:

- exact 20 MiB acceptance and 20 MiB + 1 rejection before `arrayBuffer()` or fetch;
- stack-safe base64 length, typed request/response parsing, input reset, multi-file rejection, ordinary text-paste preservation, and async/note/unmount/concurrent fencing;
- portable insertion only after persistence plus complete vault refresh;
- private durable status, stable-note lookup, active-revision consistency, safe nullable projection, and no manifest/Drive identifiers;
- publish private/anonymous dual readback, source-version mismatch rejection, double-submit fencing, and focus restoration;
- revoke exact no-store public `404` verification and fail-closed behavior for `200`, malformed `404`, or any other status;
- public-ID validation before fetch, public-only URLs, exact asset allowlisting, cross-public-ID/query/fragment/external URL rejection, owner-free not-found behavior, and metadata cleanup/restoration;
- OwnerShell/editor/palette integration without weakening Task 10–12 autosave, conflict, search, tree, or route behavior.

Final focused Task 13 web run:

```text
Test Files 3 passed (3)
Tests 20 passed (20)
Exit status 0
```

## Fresh validation evidence

All validation used Node `v22.23.1` and pnpm `11.22.0`. Google/Drive variables were explicitly unset; no live integration was enabled.

### Quality and build gates

```sh
pnpm lint
pnpm typecheck
pnpm build
pnpm project:test
git diff --check
```

```text
eslint: PASS
typecheck: contracts, domain, API, and web PASS
build: contracts, domain, API, and web PASS
project contract: 2/2 passed
git diff --check: PASS
Exit status 0
```

The production build emitted a dedicated lazy public chunk, `public-note-page-C_Zy9XcT.js`, at 2.62 kB (1.04 kB gzip). Vite retained its non-failing warning for the existing large CodeMirror and main chunks: 616.75 kB and 838.42 kB before gzip.

### Full live-unset repository tests

```text
contracts: 2 files passed; 14 tests passed
domain: 4 files passed; 20 tests passed
web: 14 files passed; 160 tests passed
API: 18 files passed, 1 skipped; 394 tests passed, 1 skipped
Total: 38 files passed, 1 skipped; 588 tests passed, 1 skipped
Exit status 0
```

The only skip is the existing opt-in live Google Drive integration test.

### Known Task 14 baseline

```sh
pnpm artifact:verify
```

```text
Error: Cannot find module '.../scripts/verify-artifacts.mjs'
code: MODULE_NOT_FOUND
Exit status 1
```

This is the frozen Task 14 baseline. Task 13 did not add or bypass the missing verifier.

### Static and artifact checks

- Production web source scan for `driveId`, snapshot/folder/revision internals, Google credential/config keys, and `refresh_token`: no matches.
- Dedicated anonymous chunk scan for private/session routes, owner/editor/palette names, Drive identifiers, and Google credential/config keys: no matches.
- Shared contract source/dist and API function/service source/dist contain the new upload/status/source-version symbols; generated artifacts were rebuilt from source.
- `web/tsconfig.tsbuildinfo` was restored to the pre-task tracked version after validation.
- Ports 5173 and 5174 were verified closed after browser QA.

## Browser and visual QA

### Environment

- Codex in-app Browser used first and exclusively; no standalone Playwright or fallback browser.
- Fresh `web/dist` served through a temporary checkout-owned loopback fixture on `127.0.0.1:5173`.
- Owner route: `/app/notes/018f47d2-6a34-7b2a-9f21-8a7034963aef`.
- Public route: `/p/AAAAAAAAAAAAAAAAAAAAAA`.
- Desktop viewport: 1505×1045. Mobile viewport: 390×844.
- Fixture APIs were deterministic and same-origin; they had no Google, Drive, OAuth, credential, or external-network access.

### Owner flow

1. Loaded the exact deep note route with title `NXT`, zero framework overlays, zero document overflow, and an empty warn/error console.
2. Used the real browser file chooser with a 203-byte PNG. The app posted one private upload, refreshed the complete vault, inserted `![browser fixture.png](_assets/018f47d2-6a34-7b2a-9f21-8a7034963aef/browser%20fixture.png)`, rendered the preview/card, and autosaved to `Saved`.
3. Opened Publish. The dialog showed `Version 8`, `1 referenced attachments`, immutable/unlisted language, and `noindex`; one confirmation produced reload-safe Open link, Copy link, and Revoke controls.
4. Reloaded the owner route and confirmed the private status projection persisted.
5. Publish Cancel and verified publish both restored focus to `Publish`.
6. Confirmed Revoke; the client performed the exact cache-bypassed public `404` verification, status changed to `Not published`, and focus moved to the still-connected `Publish` action.

### Anonymous and network boundary

The published public request delta was limited to:

```text
GET /p/AAAAAAAAAAAAAAAAAAAAAA
GET /assets/<hashed-main-js>
GET /assets/<hashed-css>
GET /assets/<jsx-runtime>
GET /assets/<contracts-chunk>
GET /assets/public-note-page-C_Zy9XcT.js
GET /favicon.ico
GET /api/public/notes/AAAAAAAAAAAAAAAAAAAAAA
GET /api/public/assets/AAAAAAAAAAAAAAAAAAAAAA/BBBBBBBBBBBBBBBBBBBBBB
```

There were zero `/api/private/*` requests. The page contained no owner shell, Drive/edit/publish/revoke/sign-in control, public directory, or arbitrary link. The single image used the exact root-relative allowlisted public asset path and loaded successfully.

After revoke, the request delta remained public-only and ended at `GET /api/public/notes/AAAAAAAAAAAAAAAAAAAAAA`. The DOM was exactly the generic `NXT` / `Not found` surface; robots metadata remained `noindex,nofollow`; owner controls remained absent.

### Responsive measurements

| Check | Desktop 1505×1045 | Mobile 390×844 |
| --- | --- | --- |
| document/body/inner width | 1505 / 1505 / 1505 | 390 / 390 / 390 |
| visible owner primary surface | desktop concurrent panels | exactly one destination |
| framework/dialog overlay after flow | 0 | 0 |
| console warn/error | `[]` | `[]` |
| public owner/private markers | 0 | 0 |
| robots values | exactly `noindex,nofollow` | exactly `noindex,nofollow` |

Mobile owner controls measured at least 44 px: Add attachment 157.19×44, Publish 150×44, header Info 44×44, four destination targets 97.5×67, and Trash 44×44. The mobile publish dialog was 358 px wide at 16 px side insets; Close/Cancel/Confirm were all 44 px high. Editor and Info each rendered as the sole visible primary surface, with path and `Saved` state retained.

### Visual comparison and screenshots

The accepted desktop primary, mobile primary, and conflict concepts plus the Task 13 captures were inspected at original resolution. The implementation preserves the Gruvbox panel rhythm, yellow focus/selection/primary action, restrained Radix dialog geometry, Lucide outlines, dominant desktop editor, and mobile one-surface/bottom-navigation composition. The fixture image is intentionally a very short horizontal strip, so its intrinsic aspect ratio is fixture evidence rather than a product-layout deviation.

Screenshots are intentionally outside committed source:

- `/tmp/nxt-task13-browser-shots/desktop-owner-before-upload.png`
- `/tmp/nxt-task13-browser-shots/desktop-owner-published.png`
- `/tmp/nxt-task13-browser-shots/desktop-public.png`
- `/tmp/nxt-task13-browser-shots/desktop-public-revoked.png`
- `/tmp/nxt-task13-browser-shots/mobile-owner-editor-viewport.png`
- `/tmp/nxt-task13-browser-shots/mobile-owner-info.png`
- `/tmp/nxt-task13-browser-shots/mobile-public.png`

The Browser full-page capture path showed a backend scale anomaly after changing from desktop to mobile, while DOM geometry remained exact. Acceptance therefore used the Browser viewport capture at the required 390×844 size; it was inspected at original resolution and matched the measured DOM.

## Boundaries and remaining risk

- Live Drive was not exercised; the opt-in integration test remains skipped.
- Task 14 still owns `scripts/verify-artifacts.mjs`, Static Web Apps navigation/artifact wiring, and lifecycle scripts.
- Task 15 still owns automated Playwright/axe/reduced-motion/security acceptance. This task supplies direct IAB interaction, network, metadata, focus, responsive, and screenshot evidence.
- The Vite large-chunk warning remains visible and non-failing. The anonymous page itself is route-split into a 2.62 kB chunk.
- No Google Drive provisioning/access, GitHub, Azure, DNS, custom domain, deployment, push, remote, secret, or external mutable state was accessed or changed.
- Implementation commit: `988ec48`; push: none; deploy: none.

## Review fix round 1 — 2026-08-26

Independent review found three Important defects and no Critical or Minor defects. Commit `39ada26` (`fix: harden attachment publication workflow`) closes all three without widening Task 13 into Task 14:

- The attachment picker now rearms its mounted generation during React StrictMode effect replay. A real `<StrictMode>` test requires one valid selection to produce exactly one upload and completion, restore the enabled state, and retain the existing concurrency, note-change, and true-unmount fences.
- A pure domain helper now creates NFC, note-directory-relative POSIX `_assets/<note-id>/<server-name>` references. It uses Markdown angle destinations, RFC 3986-safe path-segment encoding, and escaped labels; OwnerShell inserts only the persisted server name. Root, nested, and deep paths plus Unicode normalization, spaces, brackets, `#`, `?`, `%`, `<`, `>`, matched and unmatched parentheses, apostrophe, and other punctuation all round-trip through the production attachment projection and both deletion/publication fences. Literal backslash remains forbidden by the existing published-asset-name contract; label backslashes remain escaped.
- Owner publication state is bound to the current editor note ID as well as its non-null source/version, non-empty path, and exact `Saved` state. The confirmation count is derived from `attachmentReferenceProjection(source, path)` and counts only selected-note attachments accepted by canonical name or opaque private reference. Persisted-but-unreferenced assets report zero, and duplicate links count their attachment once.

Focused RED evidence before each production fix:

```text
StrictMode picker: 1 failed, 7 passed; upload/completion stayed at zero and busy stayed true
portable helper: 5 failed, 3 passed; createPortableAttachmentMarkdown was absent
owner nested insertion: 1 failed, 45 skipped; old root-relative/non-angle link did not match
referenced count: 2 failed, 1 passed, 46 skipped; expected 0/2 but received 1/3
```

Focused GREEN evidence:

```text
domain attachment references: 1 file, 8 passed
web attachment picker + editor/owner integration: 2 files, 57 passed
```

Fresh Node `v22.23.1`, pnpm `11.22.0`, live-Drive-unset repository validation:

```text
lint: PASS
typecheck: contracts, domain, API, web PASS
build: contracts, domain, API, web PASS
tests: 38 files passed, 1 skipped; 598 passed, 1 skipped
project contract: 2/2 passed
git diff --check: PASS
```

The only skip remains the opt-in live Google Drive integration test. Vite retained the existing non-failing large-chunk warning; the route-split anonymous page remained 2.62 kB before gzip. `pnpm artifact:verify` still exits 1 only because Task 14's `scripts/verify-artifacts.mjs` does not yet exist. Production web sensitive-name scan and the anonymous chunk private/session/owner/Drive scan each returned zero matches; the new helper is present in domain source, JavaScript dist, and declaration dist.

The root IAB rerun used a fresh same-origin fixture note at the nested path `Notes/Inbox/Plan.md` and the production StrictMode root. One file choice produced exactly one upload and one autosave update, returned to `Saved` at Version 8, rendered one private preview image, and inserted exactly:

```markdown
![Café \[draft\] #1? report).png](<../../_assets/8c8e1b93-2b52-4c0e-9c87-4c9333a25765/Caf%C3%A9%20%5Bdraft%5D%20%231%3F%20report%29.png>)
```

The Publish dialog showed `Version 8` and `1 referenced attachments`; Cancel restored focus to the Publish button. Console warnings/errors were empty and the emitted screenshot was visually clean. The rebound IAB viewport was 1280 px wide, so the original Task 13 desktop 1505×1045 and mobile 390×844 acceptance evidence above remains the responsive-layout evidence; this rerun specifically validates the three review fixes. The temporary fixture was stopped, ports 5173/5174 were closed, tracked build info was restored, and no Drive, GitHub, Azure, DNS, deployment, push, secret, or other external mutable state was accessed.
