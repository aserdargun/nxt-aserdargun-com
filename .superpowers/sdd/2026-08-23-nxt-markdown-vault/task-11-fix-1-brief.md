# Task 11 — Fix round 1/5

Base: `c279ccb`

Fix only the four Important and two related Minor findings from the independent Task 11 review. Do not absorb Task 12 explorer/folder integration or Task 13 attachment/publication UI.

## Required fixes

1. Offline draft path and reconnect reconciliation
   - A locally loaded draft must never synthesize `${title}.md` and then compare it with a server path.
   - Persist the last exact verified note path with new drafts. Handle existing/malformed/pathless records fail-closed through an explicit IndexedDB migration or compatible validation.
   - If an offline/pathless draft reconnects, reconcile with an exact verified GET before PUT. If the Drive version advanced, open the normal conflict flow; otherwise use the verified path/version.
   - Add a production-adapter regression: offline load → reconnect → edit → exact confirmed save.

2. Durable local write before network/status claims
   - Track the local write promise/result per note, source, and generation.
   - Do not submit a generation to Drive until its matching IndexedDB write has succeeded.
   - Never display `Offline draft` unless the currently relevant source is durably present in IndexedDB.
   - A quota/IDB failure remains `Error`, does not make a network request for that generation, and cannot be overwritten by a stale network/local-write result.
   - Preserve the existing exact 1,000 ms debounce from the editor change; awaiting local durability must not shorten it.
   - Fence success and failure paths so an old request cannot drop or relabel a newer queued edit.

3. Bounded idempotent recovery storage
   - Deduplicate by note ID + local updated timestamp + exact source (and reject a colliding non-matching record).
   - Enforce explicit per-note and global limits. Do not silently evict old recoveries; fail closed with the active draft intact.
   - Implement bounded cursor/count behavior; do not unboundedly materialize the recovery store.
   - Repeated missing-folder/retry clicks must not create duplicate recovery records.

4. Invalid deep link and async error boundary
   - Validate `/app/notes/:noteId` with `NoteIdSchema.safeParse` and render controlled Not Found for invalid values.
   - Add a last-resort catch to initial autosave loading so synchronously throwing injected clients cannot create an unhandled rejection or blank perpetual `Saving` state.

5. Recovery lineage
   - Carry the local draft's actual base version into the conflict object and named recovery copy rather than substituting the latest Drive version.

6. Evidence and hygiene
   - Start with focused RED tests for every finding, then implement.
   - Run exact Node 22 focused tests, web typecheck/build, and one bounded live-unset full validation. If a command stalls, capture the exact process/test and stop only the checkout-owned process; do not loop.
   - Re-run desktop/mobile/conflict browser QA only if production layout changes; otherwise cite the unchanged inspected Task 11 artifacts.
   - Restore `web/tsconfig.tsbuildinfo`, close checkout-owned ports, commit implementation and a separate forced-added `task-11-fix-1-report.md`, and return clean status.
   - No live Drive credentials, Google, GitHub, Azure, DNS, deployment, push, or external mutable state.
