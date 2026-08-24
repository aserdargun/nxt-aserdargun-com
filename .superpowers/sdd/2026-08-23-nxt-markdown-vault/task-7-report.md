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

# Fix round 4/5

Status: **DONE**

Implementation commit: `e0db37772ac2f53f43dc4cb56234f5c0eebd08bb`

Implementation tree: `8ac6ba4cbf005204c577cacdcf85726b9fe043a5`

The 12-route set, provisioned private system filenames, dependency pins,
`pnpm-lock.yaml`, exact-owner authorization order, and live-integration boundary
are unchanged.

## Round 4 RED evidence

Every command used Node `v22.23.1` through
`PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH` and kept
`NXT_RUN_GOOGLE_DRIVE_INTEGRATION` empty.

1. Mandatory move version and ETag admission

   Test files:
   `api/test/local-drive-adapter.test.ts`,
   `api/test/google-drive-adapter.test.ts`, and
   `api/test/google-drive-client.test.ts`.

   RED command, from `api`:

   `PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH NXT_RUN_GOOGLE_DRIVE_INTEGRATION= pnpm exec vitest run test/local-drive-adapter.test.ts test/google-drive-adapter.test.ts test/google-drive-client.test.ts`

   RED output: **2 test files failed, 1 passed; 7 tests failed, 66 passed**.
   The local adapter moved with an omitted version. Google admitted unquoted,
   lowercase-weak, unterminated, trailing-data, and control-containing ETags,
   and admitted an omitted move version before metadata/write calls.

2. Destination-ancestry TOCTOU and folder conflict classification

   Test files:
   `api/test/vault-transactions.test.ts` and
   `api/test/vault-functions.test.ts`.

   RED command, from `api`:

   `PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH NXT_RUN_GOOGLE_DRIVE_INTEGRATION= pnpm exec vitest run test/vault-transactions.test.ts test/vault-functions.test.ts`

   RED output: **1 test file failed, 1 passed; 4 tests failed, 38 passed**.
   Destination-ancestor rename and move left descendant index paths at the
   stale prefix, destination-ancestor Trash still allowed the source move, and
   a typed post-reservation storage version conflict surfaced as
   `DRIVE_UNAVAILABLE` instead of `CONFLICT`.

3. Restart-safe conflict resolution and rescan progress recovery

   Test files:
   `api/test/rescan-persistence.test.ts` and
   `packages/contracts/test/contracts.test.ts`.

   Contract RED command, from the repository root:

   `PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/contracts test`

   RED output: **1 test failed, 7 passed**. The strict response contract
   rejected the new owner-facing external-change recovery variant before it
   was implemented. A second contract RED run also produced **1 failed,
   7 passed** because the schema admitted 100 records plus 100 recoveries.

   Rescan RED command, from `api`:

   `PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH NXT_RUN_GOOGLE_DRIVE_INTEGRATION= pnpm exec vitest run test/rescan-persistence.test.ts`

   RED output: **1 test file failed; 2 tests failed, 6 passed**. A fresh
   instance rejected the old signed cursor after an accepted Google-backed
   progress write lost readback, and a deliberate rescan rejected persisted
   conflicted intents instead of rebuilding actual state and reclaiming the
   256-slot capacity.

## Round 4 implementation

- `StoragePort.move` remains compile-time required and now also has a shared
  runtime version guard at `RootBoundaryStorage`, `GoogleDriveAdapter`, and
  `LocalDriveAdapter`; missing, empty, control-containing, or oversized
  preconditions fail before metadata admission or mutation. Local and Google
  comparisons are unconditional. The same guard also hardens content updates.
- Google move/upload admission accepts only RFC-shaped strong or weak HTTP
  entity-tags, bounded to 512 characters and excluding controls, DEL, malformed
  quoting, lowercase weak prefixes, and trailing data. The exact admitted ETag
  reaches `If-Match`; the wrapped client continues to force `retry: false`, and
  Drive `412` remains the internal typed storage version conflict.
- Move intents now persist the preflight index generation and exact destination
  ancestry chain: folder identity, name, parent, and version for every node
  through `Notes`. Reservation CAS binds that generation. Owner/fence is checked
  around post-reservation source and destination revalidation immediately before
  the Drive mutation. Positive destination drift cancels the known-non-applied
  reservation and retries fresh; an invalid/trashed refreshed destination returns
  trusted `409`. Recovery refuses to replay into a changed destination chain.
- Folder move readback derives the committed descendant prefix from verified
  actual ancestry. Deterministic production-path interleavings cover destination
  ancestor rename, move, and Trash after reservation; successful cases make the
  actual folder path and descendant index path identical, while Trash performs
  zero source moves. Existing source-ancestor and note/folder coordination tests
  remain green.
- A typed post-reservation `StorageVersionConflictError` in folder update now
  becomes a trusted `ApiResponseError("CONFLICT")`; arbitrary dependency errors
  still pass through static redacted `503`. Handler coverage verifies exact
  `409`, code, static message, and absence of the raw folder identifier. Existing
  note mutation classification remains typed `409`.
- Conflicted intents are exposed only as bounded, path-only external-change
  recovery records through the existing rescan response. Starting a deliberate
  rescan is allowed only when every pending intent is terminal `conflicted`.
  Completion rebuilds the index from actual Drive reads and clears exactly the
  captured conflict IDs in the same CAS; it never writes Markdown or replays a
  stale intent. Two batches totaling 300 conflicts prove the 256-slot capacity
  is reclaimed without a new route, system file, or raw Drive ID response.
- Rescan no longer relies on the fixed 70-operation reserve. A new scan first
  persists and returns a signed checkpoint cursor. Resumed traversal consumes a
  request-relative fraction of the actual remaining 100-operation budget, while
  every adapter retry, RootBoundary ancestry read, system read/write/readback,
  and CAS retry shares the same lowest-level counter and stops before call 101.
- Every accepted progress transition persists its prior signed cursor binding
  and exact bounded response page. The immediately prior cursor can therefore
  replay only that committed successor without re-traversal; once the successor
  advances, older cursors fail closed. Finalization stores one bounded completion
  receipt in the existing index so an outcome-unknown final CAS is likewise
  derivable. The real offline
  `GoogleDriveAdapter -> RootBoundaryStorage -> SystemFileStore` probe injects
  retryable metadata/media reads, exactly one `412`, an accepted write, and three
  failed readbacks; every request stays at or below 100 calls, the old cursor
  recovers on a fresh instance, and the scan completes with a schema-valid index.
- Shared response schemas admit only the two static recovery variants and now
  enforce at most 100 records and recoveries combined. Stored replay pages use
  the same joint bound. No private mutation ID or Drive ID appears in recovery
  responses.

## Focused GREEN evidence

Adapter GREEN command, from `api`:

`PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH NXT_RUN_GOOGLE_DRIVE_INTEGRATION= pnpm exec vitest run test/local-drive-adapter.test.ts test/google-drive-adapter.test.ts test/google-drive-client.test.ts`

Output: **3 test files passed; 73 tests passed**.

Vault/function GREEN command, from `api`:

`PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH NXT_RUN_GOOGLE_DRIVE_INTEGRATION= pnpm exec vitest run test/vault-transactions.test.ts test/vault-functions.test.ts`

Output: **2 test files passed; 42 tests passed**.

Final expanded focused command, from the repository root:

`PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/contracts test && cd api && PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH NXT_RUN_GOOGLE_DRIVE_INTEGRATION= pnpm exec vitest run test/google-drive-adapter.test.ts test/google-drive-client.test.ts test/local-drive-adapter.test.ts test/root-boundary.test.ts test/vault-service.test.ts test/vault-transactions.test.ts test/vault-functions.test.ts test/rescan-service.test.ts test/rescan-persistence.test.ts test/preferences-service.test.ts`

Output: contracts **8 passed**; focused API **10 files passed, 146 tests
passed**.

## Root verification

Final command:

`PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH NXT_RUN_GOOGLE_DRIVE_INTEGRATION= pnpm lint && PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH NXT_RUN_GOOGLE_DRIVE_INTEGRATION= pnpm typecheck && PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH NXT_RUN_GOOGLE_DRIVE_INTEGRATION= pnpm test && PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH NXT_RUN_GOOGLE_DRIVE_INTEGRATION= pnpm build && git diff --check`

Output:

```text
lint:       PASS
typecheck:  PASS (contracts, domain, API)
test:       PASS
  contracts:   8 passed
  domain:     15 passed
  API:       275 passed, 1 live integration test skipped
build:      PASS (contracts, domain, API)
diff check: PASS
```

## Concerns and external-state statement

Concerns: none within the authorized offline scope. Live Google behavior remains
intentionally unverified; conditional requests, retries, budgets, and ambiguous
acknowledgement recovery are covered through the real production adapters over
an in-memory offline Drive client.

No live Google Drive, OAuth, network, credentials, `.env.local`, DNS, cloud,
deployment, repository remote, or other external state was accessed or changed.

# Fix round 5/5

Status: **DONE**

Round 4 report baseline: `f064cd863352a04f903097fbf9134eb5012d7df4`

Implementation commit: `8264cf358165ca138971e79dcfe673ccbca9b96e`

Implementation tree: `513d1d017c9dd23871ba86bcf99e3483777d65d6`

The 12-route set, provisioned private system filenames, dependency pins,
`pnpm-lock.yaml`, exact-owner authorization order, response bounds, and live
integration boundary are unchanged.

## Round 5 RED evidence

Every command used Node `v22.23.1` through the explicit
`PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH` path. The live
Drive integration was not enabled and was explicitly removed for the root gate.

1. Prior-cursor expiry, final outcome-unknown, bounded expiry, exact-cursor
   binding, advancement, and replay immutability

   Test file: `api/test/rescan-persistence.test.ts`.

   Command, from `api`:

   `PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH NXT_RUN_GOOGLE_DRIVE_INTEGRATION= pnpm exec vitest run test/rescan-persistence.test.ts`

   RED output: **1 test file failed; 5 tests failed, 9 passed**. The failures
   showed that progress and completion receipts had no explicit recovery
   expiry, that an old cursor could not recover an accepted write after its
   embedded expiry, and that a differently encoded but validly signed cursor
   with the same payload could replay the transition.

2. Self-review receipt-integrity probe

   Command, from `api`:

   `PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH NXT_RUN_GOOGLE_DRIVE_INTEGRATION= pnpm exec vitest run test/rescan-persistence.test.ts`

   RED output after adding the narrow probe: **1 test file failed; 1 test
   failed, 14 passed**. Altering the stored processed count and successor nonce
   still produced a replay, proving that the first receipt MAC did not yet bind
   the exact persisted response and successor cursor.

## Round 5 implementation

- The existing `vault-index.json` transition and completion schemas now carry
  a paired `recoveryExpiresAt` and 256-bit `receiptMac`. Nullable defaults keep
  pre-round-5 index documents readable, but legacy receipts never gain expired
  cursor recovery.
- Each new receipt uses a domain-separated HMAC over the exact supplied signed
  prior cursor string, scan ID, base generation, prior position, nonce and
  expiry, recovery expiry, complete flag, bounded records/recoveries response,
  and exact successor cursor. Re-encoded, cross-scan, cross-generation,
  wrong-position, wrong-nonce, altered-response, and altered-successor variants
  therefore fail closed.
- `resumeScan` verifies a matching live receipt before applying the ordinary
  prior-cursor expiry rejection. Progress receipt recovery expires exactly with
  the live successor state; completion recovery is bounded to ten minutes from
  finalization receipt creation. The deadline is MAC-bound and replay performs
  no write, so retry cannot renew or extend it.
- Only the immediately prior persisted transition can replay. Advancing the
  successor replaces that receipt, and receipt expiry is exclusive. A legacy
  non-expired receipt remains replayable only through the canonical cursor that
  the prior service version emitted.
- Accepted progress and accepted final index writes whose readback response is
  lost are recovered on a fresh service instance from the exact client-held
  prior cursor. Replay returns the stored successor response with zero vault
  traversal and no duplicate work; the successor continues normally.
- The recovery path adds no Drive mutation or traversal operation. Existing
  traversal and index work continues to share the 100-operation request budget,
  and existing 100-item and byte-size response bounds are unchanged. No route,
  system file, raw Drive ID, or public response field was added.

## Files

- `api/src/services/rescan-service.ts`
- `api/test/rescan-persistence.test.ts`
- `packages/contracts/src/vault.ts`
- `api/dist/services/rescan-service.d.ts`
- `api/dist/services/rescan-service.d.ts.map`
- `api/dist/services/rescan-service.js`
- `api/dist/services/rescan-service.js.map`
- `packages/contracts/dist/vault.d.ts`
- `packages/contracts/dist/vault.d.ts.map`
- `packages/contracts/dist/vault.js`
- `packages/contracts/dist/vault.js.map`

## GREEN and focused evidence

Final regression command, from `api`:

`PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH NXT_RUN_GOOGLE_DRIVE_INTEGRATION= pnpm exec vitest run test/rescan-persistence.test.ts`

Output: **1 test file passed; 15 tests passed**.

Focused command, from the repository root:

`PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/contracts test && cd api && PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH NXT_RUN_GOOGLE_DRIVE_INTEGRATION= pnpm exec vitest run test/rescan-service.test.ts test/rescan-persistence.test.ts`

Output: contracts **8 passed**; focused API **2 test files passed, 18 tests
passed**.

## Root verification

Root command, with live integration explicitly removed for each stage:

`env -u NXT_DRIVE_INTEGRATION PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm lint && env -u NXT_DRIVE_INTEGRATION PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm typecheck && env -u NXT_DRIVE_INTEGRATION PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm test && env -u NXT_DRIVE_INTEGRATION PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm build && git diff --check`

Fresh build and diff confirmation after the first combined command yielded its
final build output:

`env -u NXT_DRIVE_INTEGRATION PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm build && git diff --check`

Output:

```text
lint:       PASS
typecheck:  PASS (contracts, domain, API)
test:       PASS
  contracts:   8 passed
  domain:     15 passed
  API:       282 passed, 1 live integration test skipped
build:      PASS (contracts, domain, API)
diff check: PASS
```

## Concerns and external-state statement

Concerns: none within the authorized offline scope. Live Google behavior remains
intentionally unverified; accepted-write/readback-loss behavior is covered
through production service and system-store paths over controlled offline
storage adapters.

No live Google Drive, OAuth, network, credentials, `.env.local`, DNS, cloud,
deployment, repository remote, or other external state was accessed or changed.
