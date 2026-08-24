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

# Fix round 2/5

Status: **DONE_WITH_CONCERNS**

Implementation commit: `1a24dd8bfea2c5c2aa78cf3769d799dd0e59c01e`

Implementation tree: `b7f75e833f563d889aead763e2292b938b003bc5`

Dependency pins, `pnpm-lock.yaml`, the 12-route set, the provisioned system-file
names, and the live-integration boundary are unchanged.

## Round 2 RED evidence

All RED commands used the required Node `v22.23.1` path.

1. `api/test/api-response.test.ts` and `api/test/vault-functions.test.ts`

   Command:
   `pnpm --filter @nxt/api test -- api/test/api-response.test.ts api/test/vault-functions.test.ts`

   Output: **3 failed, 231 passed, 1 skipped**. The failures proved that plain
   objects and `Error` instances could spoof trusted status codes, and that the
   combined folder PUT still invoked separate rename and move operations.

2. `api/test/vault-transactions.test.ts`

   Command:
   `cd api && pnpm exec vitest run test/vault-transactions.test.ts`

   Output: **4 failed, 9 passed**. The failures reproduced an accepted create
   with rejected readback becoming an unindexed orphan, reconciliation of a
   still-live write after 31 seconds, a cross-instance folder/descendant-note
   race, and a self-descendant folder move reaching the dependency layer.

3. `api/test/rescan-persistence.test.ts` and
   `api/test/vault-functions.test.ts`

   Command:
   `cd api && pnpm exec vitest run test/rescan-persistence.test.ts test/vault-functions.test.ts`

   Output: **5 failed, 13 passed**. The failures measured **105** and **107**
   total list/read calls once private-index reads were counted, demonstrated a
   cursor that accepted a changed folder tree, showed nested relation and
   preference collections stopping at 100 of 120, and retained the sequential
   combined-folder handler failure.

## Round 2 implementation

- Mutation intents in the existing `vault-index.json` now persist owner, fence,
  phase, old/new path scope, expected source checksum, bounded recovery source,
  and a reconciliation horizon. A reservation is persisted before a Drive
  call, moves to `drive-inflight` before the call, and remains recoverable for
  every ambiguous acknowledgement. Only typed, positively non-applied failures
  or optimistic version conflicts cancel immediately.
- A 15-minute in-flight horizon replaces expiry-only 30-second reconciliation.
  This is longer than the bounded Azure HTTP invocation window; another
  instance cannot reconcile or reuse the overlapping scope merely because the
  short reservation lease elapsed. Expired/incomplete intents are claimed by
  owner/fence CAS before recovery and are reconciled from actual parent, name,
  note identity, checksum, path, version, and Trash state.
- Conflict detection compares old/new path prefixes, so folder subtree
  operations serialize against every descendant note/folder operation while
  unrelated sibling paths remain concurrent. Create, update, move, Trash,
  finalize-conflict, delayed-write, subtree-race, combined-update, and restart
  paths have deterministic two-instance coverage.
- Folder PUT calls one `updateFolder` service operation. Rename and destination
  parent are reserved together and sent through one storage move request; the
  descendant path-prefix index update occurs once. An acknowledged move with a
  lost readback retains an intent and deterministically finalizes after restart.
  Self/descendant destinations fail with trusted `INVALID_INPUT` before a Drive
  mutation.
- Folder/note Trash applies membership, backlink, and preference changes as one
  recoverable logical operation. The intent remains `index-applied` until
  preference pruning and intent clearing succeed; the restart probe recovers an
  injected pruning failure idempotently.
- Google Drive mutations classify acknowledgement/readback failures as an
  internal outcome-unknown error carrying a raw identifier only inside the
  storage/service boundary. Public typed responses and static errors expose no
  raw Drive identifier.
- Vault cursors now bind committed generation and the exact tree version. They
  carry bounded offsets for entries, folders, every outbound/unresolved/
  attachment/backlink collection, favorites, and recent items. Size-adaptive
  pages retrieve all items across cursors; stale/tampered projections fail
  closed, and a typed success remains below the response byte ceiling.
- Rescan reserves traversal budget for private-index reads/readbacks and up to
  three CAS attempts. It performs at most 20 traversal list/read operations per
  request and returns at most 100 records plus recoveries jointly. Empty-folder,
  fresh-instance, recovery-heavy, and injected-CAS-retry probes count all
  adapter list/read calls.
- Error mapping now requires a module-branded `ApiResponseError`; plain objects,
  ordinary errors, and prototype spoofs map to the static redacted `503`.
  Internal index schema failure is `503`, while self/descendant input is the
  trusted pre-Drive `400` case.
- The previous report's 30-second in-flight operating note is superseded by the
  phase/fence plus 15-minute reconciliation horizon described above.

## Covering tests and GREEN evidence

- `packages/contracts/test/contracts.test.ts`
- `api/test/api-response.test.ts`
- `api/test/google-drive-adapter.test.ts`
- `api/test/rescan-persistence.test.ts`
- `api/test/vault-functions.test.ts`
- `api/test/vault-service.test.ts`
- `api/test/vault-transactions.test.ts`

Focused command:

`pnpm --filter @nxt/contracts test && cd api && pnpm exec vitest run test/api-response.test.ts test/google-drive-adapter.test.ts test/rescan-persistence.test.ts test/vault-functions.test.ts test/vault-service.test.ts test/vault-transactions.test.ts`

Output: contracts **8 passed**; focused API **108 passed**.

Large-index measurement command:

`cd api && pnpm exec vitest run test/vault-transactions.test.ts -t "measures every storage" --reporter=verbose`

Output: **1 passed, 14 filtered**. The permanent test counts every storage read
and every index write byte. A temporary diagnostic assertion run, removed after
capture, measured a 501-entry seed of **247,763 bytes**, **16** total storage
reads, **0** vault list calls, **4** full index writes, and **993,720** serialized
index bytes for one update.

Root command, with live integration unset:

`unset GOOGLE_DRIVE_INTEGRATION; pnpm lint && pnpm typecheck && pnpm test && pnpm build && git diff --check`

Output:

```text
lint:       PASS
typecheck:  PASS (contracts, domain, api)
test:       PASS
  contracts:   8 passed
  domain:     15 passed
  api:       245 passed, 1 live test skipped
build:      PASS (contracts, domain, api)
diff check: PASS
```

No live Google Drive, OAuth, network, credentials, `.env.local`, or external
state was accessed.

## Concern requiring fresh reviewer verdict

Finding 4's byte/work-independence guarantee cannot be truthfully implemented
through the approved persistence contract. `StoragePort.updateText` and the
Google Drive media update replace the entire content of the one pinned
`vault-index.json`; `SystemFileStore` must serialize that entire file, perform
the optimistic update, and read the entire file back. With no new private
system file, no partial/range update primitive, and the committed index required
to remain the CAS authority, sharding or journaling *inside the same file* still
rewrites all bytes. The measured probe above confirms bounded call count but
proportional serialized bytes and transform work. No unsupported partial-write
or vault-size-independent claim is made.

# Fix round 3/5

Status: **DONE**

Implementation commit: `40cc627dc5aa3b1a966ae7c6a70af6c27ffc75ce`

Implementation tree: `d5a98e34f0ba0d3630f8437e6502baf193d7d7eb`

Round 2 findings B/F/G and the fresh review's acceptance of the measured
single-file proportionality remain unchanged. Dependency pins,
`pnpm-lock.yaml`, the 12-route set, provisioned system-file names, and the live
integration boundary are unchanged.

## Round 3 RED evidence

Every command used Node 22 through the explicit
`PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH` prefix. No live
integration variable was enabled. RED and focused commands below ran from the
`api` directory; root commands ran from the worktree root.

1. `api/test/local-drive-adapter.test.ts` and
   `api/test/google-drive-adapter.test.ts`

   Command:
   `PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm exec vitest run test/local-drive-adapter.test.ts test/google-drive-adapter.test.ts`

   Output: **2 failed, 57 passed**. Local move overwrote a file whose observed
   version had changed, and the Google move issued only the update request with
   no conditional header instead of the required `If-Match` precondition.

2. `api/test/vault-transactions.test.ts`

   Command:
   `PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm exec vitest run test/vault-transactions.test.ts`

   Output: **7 failed, 15 passed**. The failures reproduced recovery
   overwriting an external folder rename, external folder parent move, and
   external note content; exact safe replay omitted a move version
   precondition; and note update, note move, and nested folder update reserved
   stale paths when an ancestor completed between preflight and reservation.

3. `api/test/vault-functions.test.ts` and
   `api/test/rescan-persistence.test.ts`

   Command:
   `PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm exec vitest run test/vault-functions.test.ts test/rescan-persistence.test.ts`

   Output: **2 failed, 19 passed**. A real `RootBoundaryStorage` projection over
   a counting low-level adapter performed **563** Drive-like calls in one
   request, and shuffled provider folder order made offset pagination duplicate
   `Notes/Charlie` while omitting `Notes/Bravo`.

## Round 3 implementation

- `StoragePort.move` now requires the exact observed version. The local adapter
  checks it inside its metadata lock. The Google adapter re-reads metadata,
  verifies that Drive version, obtains the response ETag, and sends the move
  through `files.update` with `If-Match`; HTTP `412` is classified as an
  optimistic conflict. The Google client wrapper preserves the conditional
  header while retaining disabled transport retries.
- Mutation intents persist the original checksum, the exact version prepared
  for a subsequent move, and a terminal internal `conflicted` phase. Recovery
  first classifies the current identity/checksum/path/parent/name/version:
  already-intended state finalizes, exact original or exact prepared state can
  be conditionally replayed, and any intervening external state/version change
  is retained as a static conflict without overwriting it. Conflicted scopes
  continue to block overlapping work while unrelated operations proceed.
- Note update/move and folder update establish reservations against the exact
  index generation and note identity/path/Drive version used by preflight.
  Generation or entry drift raises an internal stale-reservation signal and
  retries from fresh metadata. After reservation, the service verifies
  reservation ownership/fence and re-reads the exact Drive parent, name,
  version, and ancestry-derived path before beginning any Drive mutation.
- A request-scoped `StorageOperationBudget` is threaded only through rescan,
  through `SystemFileStore`, `RootBoundaryStorage`, and into the lowest adapter
  calls. Every metadata ancestry read, list, media read, index read/write
  preflight, write, readback, and retry consumes the same 100-operation token.
  Traversal uses one-child pages and reserves capacity for persisted progress;
  exhaustion is recognized before call 101 and leaves the existing signed scan
  cursor/state resumable by a fresh service instance.
- Folder tree collection sorts each provider page and the completed projection
  by normalized path plus internal identity before hashing, descendant counts,
  confirmations, and pagination. The handler applies the same deterministic
  projection rule defensively, so identical tree versions cannot reorder
  offset pages.

## Covering tests and GREEN evidence

- `api/test/google-drive-adapter.test.ts`
- `api/test/google-drive-client.test.ts`
- `api/test/local-drive-adapter.test.ts`
- `api/test/vault-transactions.test.ts`
- `api/test/rescan-persistence.test.ts`
- `api/test/vault-functions.test.ts`
- existing focused service/storage coverage in `api/test/vault-service.test.ts`,
  `api/test/rescan-service.test.ts`, `api/test/preferences-service.test.ts`, and
  `api/test/root-boundary.test.ts`

Focused round-3 command:

`PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH NXT_RUN_GOOGLE_DRIVE_INTEGRATION= pnpm exec vitest run test/google-drive-adapter.test.ts test/google-drive-client.test.ts test/local-drive-adapter.test.ts test/vault-transactions.test.ts test/vault-functions.test.ts test/rescan-persistence.test.ts`

Output: **6 files passed, 104 tests passed**.

Expanded focused service/storage/functions command:

`PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH NXT_RUN_GOOGLE_DRIVE_INTEGRATION= pnpm exec vitest run test/vault-service.test.ts test/vault-transactions.test.ts test/rescan-service.test.ts test/rescan-persistence.test.ts test/preferences-service.test.ts test/vault-functions.test.ts test/google-drive-adapter.test.ts test/google-drive-client.test.ts test/local-drive-adapter.test.ts test/root-boundary.test.ts`

Output: **10 files passed, 127 tests passed**.

## Root verification

Lint and typecheck command:

`PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH NXT_RUN_GOOGLE_DRIVE_INTEGRATION= pnpm lint && PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH NXT_RUN_GOOGLE_DRIVE_INTEGRATION= pnpm typecheck`

Output: lint **PASS**; typecheck **PASS** for contracts, domain, and API.

Root test command:

`PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH NXT_RUN_GOOGLE_DRIVE_INTEGRATION= pnpm test`

Output:

```text
contracts:   8 passed
domain:     15 passed
api:       256 passed, 1 live integration test skipped
```

Build and diff command:

`PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH NXT_RUN_GOOGLE_DRIVE_INTEGRATION= pnpm build && git diff --check`

Output: contracts/domain/API build **PASS**; diff check **PASS**.

The first self-review lint run reported one `preserve-caught-error` violation in
`RootBoundaryStorage`; attaching the dependency error as the internal cause
resolved it, and the final lint above is clean. No error cause is included in a
public response.

No live Google Drive, OAuth, network, credentials, `.env.local`, or external
state was accessed. The opt-in live integration test remained unset/skipped.

## Concerns

None. Live Google behavior remains intentionally unverified by the binding
offline task boundary; the production conditional request shape is covered by
the adapter and wrapped-client tests.
