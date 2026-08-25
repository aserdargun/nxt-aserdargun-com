# Task 11 Fix Round 3 Report

## Outcome

Implementation commit `239817a` closes the two remaining version-1 recovery migration validation branches.

- A legacy recovery must be an exact plain data object with only `id`, `noteId`, `name`, `source`, `baseVersion`, `recoveredAt`, and `removeMatchingDraft`. Arrays, non-plain values, symbol/accessor descriptors, missing keys, `__proto__`/extra keys, and other shapes fail closed before field reads.
- An existing migrated target is deduplicated only when note ID, derived local timestamp, exact source, exact name, and exact base version match.
- `recoveredAt` and `removeMatchingDraft` are intentionally not lineage: they describe the preservation attempt and requested post-copy cleanup. As with an idempotent `preserveRecovery` retry, the first valid target retains that attempt metadata.
- Any shape or lineage mismatch aborts the complete migration transaction, leaves legacy and target records unchanged, and does not write the completion marker.

## TDD and validation evidence

- RED: `draft-store.test.ts` ran 22 tests; 17 passed and 5 required branches failed (array, prototype payload, extra key, name mismatch, base-version mismatch), exit 1 in 462 ms. Missing-key and otherwise non-plain rejection were already fail-closed and remained covered.
- Migration GREEN: 22/22 tests passed in 629 ms.
- Full Task 11 focused GREEN: 3 files / 65 tests passed in 2.51 s.
- Fresh web TypeScript and repository ESLint checks exited 0.
- Per the brief, the full monorepo suite was not repeated because focused/type evidence showed no regression; the immediately preceding live-unset round remains 525 passed with 1 opt-in Drive test skipped.

## Files and boundaries

- `web/src/editor/draft-store.ts`
- `web/src/test/draft-store.test.ts`

No editor, layout, CSS, Task 12, or Task 13 behavior changed, so browser screenshots were not recaptured. `web/tsconfig.tsbuildinfo` matches HEAD, ports 5173 and 5174 are closed, and no live Drive, credentials, `.env.local`, Google, GitHub, Azure, DNS, deployment, push, remotes, or other external mutable state was accessed.

## Concerns

None blocking.
