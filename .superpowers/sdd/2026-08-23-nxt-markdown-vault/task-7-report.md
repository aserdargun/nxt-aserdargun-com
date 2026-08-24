# Task 7 implementation report

Status: **DONE**

## Scope and revisions

- Binding baseline: `c25383609874e94725800e70189faa76621da9c3`
- Original implementation: `c530e443820f44121207f30d0724a57ebb6ebfe7`
- Round 1 architecture fix: `0edb325917cebeeafc71c31802c286f5d541369b`
- Round 1 implementation tree: `4890b8a3d2c707a2cbe1699cd8faeafb2f892f2e`
- Dependency pins and `pnpm-lock.yaml`: unchanged

The round 1 fix replaces process-local coordination and post-Drive full index
rebuilds with durable state in the existing `vault-index.json` schema. It does
not introduce a new system filename and public contracts contain no raw Drive
identifiers.

## TDD evidence

The fix round began with dedicated failing tests before the architecture was
changed.

1. Shared-contract RED:
   `pnpm --filter @nxt/contracts test` produced 2 failures and 6 passes. The
   failures demonstrated the old raw-ID response shape and unbounded note
   source.
2. Mutation/folder RED:
   `pnpm --filter @nxt/api test -- vault-transactions` produced 7 new failures.
   They demonstrated lost concurrent creates, duplicate same-path creates,
   vault-size-dependent autosave reads, absent intents, missing crash recovery,
   missing case-only aliasing, and stale descendant paths.
3. Persisted-rescan RED:
   `pnpm --filter @nxt/api test -- rescan-persistence` produced 3 new failures.
   They demonstrated process-local cursors, operation-budget failure across
   empty folders, and non-persisted invalid-frontmatter recovery source.
4. Focused GREEN after the final probes:
   API had 233 passing tests and the single opt-in live integration test
   skipped. This includes deterministic two-instance create/update/Trash
   coordination, crash/failure recovery, 500-entry autosave call bounds,
   150-empty-folder rescan budgeting, handler schema parsing, 300 KB rejection,
   response truncation prevention, and large-index pagination.

## Implemented guarantees

- `SystemFileStore` remains pinned to the provisioned existing private file ID,
  exact parent, name, JSON MIME type, schema version, and SHA-256 checksum. It
  performs one optimistic content update followed by exact readback and never
  creates or replaces a system file. Typed storage conflicts drive bounded CAS
  retries; arbitrary dependency errors are not inferred from message text.
- The existing index stores bounded mutation leases. Reservations bind the
  operation, note/folder identity, old/target paths, expected version, and
  expiry. Cross-instance note/path collisions fail with `409`. Drive mutation
  and source/checksum readback happen before incremental index finalization;
  Drive failures cancel reservations and post-Drive failures leave an expired
  recoverable intent. The next eligible operation reconciles actual Drive state
  without replacing unrelated committed entries.
- Note create, update, rename, move, archive, and Trash update one known record
  plus backlink deltas. Autosave does not list or reread every Markdown file.
  UUID identity, portable Markdown, collision-safe names, exact-title aliases,
  and attachment-link recalculation remain intact.
- Folder create/rename/move/Trash use persisted path coordination. Rename and
  move replace every descendant record path prefix in one index CAS; Trash
  removes descendant records and backlink references, and preferences are
  pruned against the resulting index. Protected folders, Notes-root ancestry,
  depth bounds, and Trash-only deletion remain enforced.
- One vault tree snapshot produces the tree version, descendant-count map, and
  all delete confirmations. Confirmation tokens are strict `c1` HMAC tokens
  containing only a hashed folder binding, count, tree version, and expiry.
  Typed handler responses can deliver them; the general response sanitizer
  continues to redact token/secret fields.
- Rescan state, work queue, staged Markdown, recoveries, replay position, nonce,
  and expiry are persisted in the existing index while committed records stay
  readable. Signed `s1` cursors survive fresh service instances and bind scan
  ID, committed generation, position, nonce, and expiry. Replay, tampering, and
  conflicting scans fail closed. Each request returns at most 100 Drive entries
  and performs at most 100 vault list/read operations, including empty-folder
  list calls. Final backlinks are derived before one optimistic committed-record
  swap; failed finalization preserves the prior valid committed index and the
  resumable staging state.
- Shared strict schemas cover safe note, vault, folder, rescan, recovery,
  preference, and Trash responses. Vault entries/folders are paginated with an
  opaque generation-bound cursor and size-aware page construction. Sources are
  bounded by UTF-8 bytes and oversized requests fail with `413` before writes.
  Typed successes are schema- and byte-size-checked and never return a
  `[Truncated]` marker.
- Private handlers retain exact-owner authorization before service resolution,
  strict path/body/query validation, the 12 approved Azure Functions v4 routes,
  and static redacted errors. Confirmed absence maps to `404`, request contract
  failures to `400`, optimistic/tree/lease conflicts to `409`, oversize payloads
  to `413`, and dependency/ancestry/corruption/outage failures to `503`.
  Runtime opaque-ID configuration has no fallback secret and fails closed before
  runtime service resolution when the configured material is missing or short.

## Final verification

Every command used Node `v22.23.1` through the required explicit `PATH`.
`NXT_DRIVE_INTEGRATION` was explicitly unset for the root test run.

```text
pnpm lint                                      PASS
pnpm typecheck                                PASS
env -u NXT_DRIVE_INTEGRATION pnpm test        PASS
  contracts:   8 passed
  domain:     15 passed
  api:       233 passed, 1 live test skipped
pnpm build                                     PASS
git diff --check                               PASS
```

No live Google Drive, OAuth, network, credential, `.env.local`, or other
external-state access occurred.

## Operating notes

- Live Drive behavior remains intentionally unverified. The opt-in integration
  test requires separate authorization and its isolated fixture folder.
- Active mutation leases are 30 seconds. A genuinely abandoned in-flight
  operation remains collision-blocking until expiry, after which reconciliation
  verifies actual Drive state before finalizing or clearing the intent.
