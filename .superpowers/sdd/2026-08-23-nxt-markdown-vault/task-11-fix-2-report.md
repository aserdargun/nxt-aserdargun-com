# Task 11 Fix Round 2 Report

## Outcome

Implementation commit `1f7689c` migrates valid pre-fix Task 11 recovery records without changing editor behavior, layout, Task 12, or Task 13 boundaries.

- IndexedDB is upgraded from version 1 to version 2 with a recovery-migration marker.
- Before a DraftStore operation can use the database, one read-write transaction migrates recoveries and writes the completion marker atomically.
- Exact legacy IDs (`noteId:recoveredAt[:collision]`) and fields are validated. `localUpdatedAt` comes from an exact canonical `Local draft <UTC timestamp>` name; otherwise a separately validated canonical legacy `recoveredAt` is retained as the conservative lineage.
- Migration re-keys with the deterministic note/local-time key using add-only semantics. Matching note/time/source duplicates are deduplicated; a different source aborts the whole transaction without replacing or deleting either record.
- On failure, the connection/promise is discarded, the marker remains absent, and the next operation reopens and retries the migration. Existing recovery caps and bounded cursor pages remain unchanged.

## TDD and validation evidence

- RED: `draft-store.test.ts` ran 16 tests; 13 passed and all 3 new migration regressions failed with the missing-migration `DraftStoreError` (exit 1, 829 ms).
- Migration GREEN: 16/16 tests passed (505 ms).
- Full Task 11 focused GREEN: 3 files / 59 tests passed (2.91 s).
- Bounded live-unset validation: 525 passed and 1 opt-in Drive test skipped — contracts 11, domain 19, web 104, API 391; exit 0. All Drive credential, folder, and integration opt-in variables were explicitly unset.
- Fresh web TypeScript and repository ESLint checks exited 0.

The regression suite proves accessible named and fallback legacy records, exact duplicate deduplication, idempotent current `preserveRecovery`, source-collision rollback with no overwrite, same-store retry after failure, and the existing per-note/global/page limits.

## Files and boundaries

- `web/src/editor/draft-store.ts`
- `web/src/test/draft-store.test.ts`

No layout or CSS changed, so no browser screenshots were recaptured; the previously inspected Task 11 desktop, mobile, and conflict artifacts remain applicable. `web/tsconfig.tsbuildinfo` matches HEAD, ports 5173 and 5174 are closed, and no live Drive, credentials, `.env.local`, Google, GitHub, Azure, DNS, deployment, push, remotes, or other external mutable state was accessed.

## Concerns

None blocking.
