# Task 11 — Fix round 2/5

Base: `778148e`

Fix only the remaining IndexedDB recovery migration finding. No layout, editor behavior, Task 12, Task 13, or external-state work.

## Required behavior

- Add a RED regression that creates the exact version-1 recovery shape from pre-fix Task 11 (`id = noteId:recoveredAt[:collision]`, no `localUpdatedAt`), then opens the current store and proves the recovery remains accessible.
- Upgrade the database schema/version and run an atomic, retryable migration before any DraftStore operation can observe recoveries.
- Derive `localUpdatedAt` from the exact legacy `Local draft <canonical UTC timestamp>` name when valid; an explicitly validated legacy `recoveredAt` may be the conservative fallback when the name does not prove the local timestamp.
- Re-key to the current deterministic note-ID + local-updated timestamp key without overwriting any non-matching record.
- Exact duplicate legacy copies may be deduplicated only when note ID, derived local timestamp, and source match. Different source at the target key must abort/fail closed; do not silently delete or replace either record.
- A failed migration must leave the original transaction data recoverable and must be retried on the next store open/operation rather than marking the database permanently migrated.
- Prove: legacy listing, exact duplicate handling, collision rollback/no overwrite, current idempotent `preserveRecovery` retry after migration, and existing per-note/global/page bounds.
- Keep the full Task 11 focused suite green, then run Node 22 web typecheck and the bounded live-unset validation once. Restore `web/tsconfig.tsbuildinfo`, keep ports closed, make implementation and separate force-added report commits, and return clean status.
- Do not access live Drive credentials, Google, GitHub, Azure, DNS, deployment, push, remotes, or external mutable state.
