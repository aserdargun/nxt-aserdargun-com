# Task 11 — Fix round 3/5

Base: `56dc455`

Fix only the two remaining validation branches inside the version-1 recovery migration.

- Add RED tests showing that a legacy array, non-plain/prototype-bearing object, missing-key object, or extra-key object aborts the entire migration and preserves the original database without writing the marker.
- Accept only an exact plain-object v1 allowlist: `id`, `noteId`, `name`, `source`, `baseVersion`, `recoveredAt`, `removeMatchingDraft`. Reject symbols/accessor-like or otherwise non-plain values before field reads where applicable; keep validation bounded and side-effect free.
- When a migrated target key already exists, deduplicate only if at least `noteId`, derived `localUpdatedAt`, exact `source`, exact `name`, and exact `baseVersion` match. Treat preservation-attempt metadata consistently and document why any ignored legacy field is non-lineage metadata.
- A mismatch in name or base version must abort the transaction; neither legacy nor target record may change and the marker must stay absent. Add explicit regressions for both.
- Keep the previous valid legacy, canonical-name/fallback, exact-retry, source-collision, retry-after-failure, bounds, and pagination tests green.
- Run Node 22 focused tests and web typecheck/lint. Because this changes only bounded validation branches already covered by the prior 525-test live-unset full run, do not run another full monorepo suite unless focused or type evidence indicates a regression.
- Restore `web/tsconfig.tsbuildinfo`, keep ports closed, commit implementation plus a separate force-added `task-11-fix-3-report.md`, clean status, no external state.
