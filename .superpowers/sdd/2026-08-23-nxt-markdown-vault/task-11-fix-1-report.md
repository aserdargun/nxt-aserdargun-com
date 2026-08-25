# Task 11 Fix Round 1 Report

## Outcome

Implementation commit `0bee52f` fixes the reviewed Task 11 draft/recovery findings without changing layout, Task 12 folder/resolver injection, or Task 13 behavior.

- New drafts retain the last schema-verified path; legacy pathless IndexedDB records normalize explicitly to `null`, malformed paths fail closed, and no `${title}.md` path is synthesized.
- Offline/pathless sessions reconcile through a verified GET before PUT. An unchanged version adopts and persists the exact path/version; an advanced version opens the existing conflict flow without PUT.
- Draft writes are serialized and fenced by note/source/generation/local timestamp. The matching durable write must finish before network submission or `Offline draft`; IDB failure remains `Error` and cannot be relabeled by stale work.
- Atomic confirmation now compares source plus local-generation timestamp, so an older response cannot delete newer identical content.
- Recoveries use note ID + local-updated timestamp as the deterministic key, deduplicate exact-source retries, reject nonmatching collisions, cap storage at 32 per note and 256 globally without eviction, and expose pages of at most 50 records with cursor and count.
- Conflict recovery preserves the actual local `baseVersion`. Invalid note deep links fail before session/note clients, and initial injected synchronous failures reach controlled `Error` through the outer load catch.

## TDD evidence

- Initial focused RED: 2 files / 52 tests; 30 passed, 22 failed as expected, plus 2 unhandled synchronous-load rejections; exit 1 in 6.72 s.
- Additional atomic same-source RED: 13 tests; 12 passed and the stale-confirmation regression failed; exit 1 in 697 ms.
- Final focused GREEN: `draft-store.test.ts` + `editor-workspace.test.tsx`, 2 files / 53 tests passed in 2.52 s.
- Full live-unset validation: 522 passed and 1 opt-in Drive test skipped — contracts 11, domain 19, web 101, API 391; exit 0. All Google/Drive credential, folder, and integration opt-in variables were explicitly unset.
- Fresh final checks: ESLint exit 0; web TypeScript exit 0; project contract 2/2; production web build transformed 2,607 modules and exited 0.

## Files

- `web/src/editor/draft-store.ts`
- `web/src/editor/use-autosave.ts`
- `web/src/editor/conflict-dialog.tsx`
- `web/src/app/router.tsx`
- `web/src/test/draft-store.test.ts`
- `web/src/test/editor-workspace.test.tsx`
- `web/src/test/conflict-dialog.test.tsx`

## Visual and security evidence

No CSS, panel structure, copy, focus anatomy, or responsive layout changed, so the already inspected Task 11 artifacts remain the applicable visual evidence and were not recaptured:

- `artifacts/task-11-desktop-1505x1045.png`
- `artifacts/task-11-mobile-editor-390x844.png`
- `artifacts/task-11-mobile-preview-390x844.png`
- `artifacts/task-11-conflict-1505x1045.png`

The fresh production bundle scan found no Google endpoint or credential/folder identifier. `web/tsconfig.tsbuildinfo` was restored to HEAD. Ports 5173 and 5174 were closed. No live Drive, credentials, `.env.local`, Google, GitHub, Azure, DNS, deployment, push, remote, or other external mutable state was accessed.

## Concern

Vite still reports the pre-existing lazy CodeMirror chunk-size warning (`616.72 kB`, `211.03 kB` gzip). It is not a correctness or layout regression in this fix round.
