# Task 4 report — bounded storage port

## Status

DONE. Implemented and committed the Node 22 `@nxt/api` storage package. The
work is restricted to the local filesystem-backed simulator; no Google Drive,
Azure resource, external service, deployment, push, or credential was used.

## Implementation

- Added the exact API workspace package contract, Azure Functions host
  configuration with the 45-second timeout, strict TypeScript configuration,
  pinned dependencies, and generated TypeScript build artifacts.
- Defined `StoragePort` and `StoredFile` with paged child listing, versioned
  text and byte reads/writes, folder/text/byte creation, move, Trash, and
  revision operations.
- Added `RootBoundaryStorage`, a decorator that validates exactly one parent
  at a time and terminates only at its configured root. It rejects paths over
  512 characters, multiple parents, cycles, shortcuts, trashed items, missing
  parents, foreign roots, and traversals over 100 nodes. The decorator is
  parameterized so vault and private roots use separate instances.
- Added `LocalDriveAdapter`, which persists only opaque synthetic IDs in
  `.metadata.json`, has deterministic logical timestamps and IDs, serializes
  local operations, uses stable name/ID order for paging, and rejects stale or
  malformed page tokens.
- Content writes create immutable local revision copies in
  `.revisions/<file-id>/`. Trash moves the active content below `.trash/` and
  records the changed metadata; it never invokes a permanent-delete API.
  Caller-supplied paths, traversal-shaped IDs, invalid names, symlinked
  storage paths, and conflicting write versions fail closed.

## RED → GREEN evidence

All commands used:

```text
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH
```

1. Initial RED, before storage source modules existed:

   ```text
   pnpm --filter @nxt/api test -- local-drive-adapter root-boundary
   ```

   Failed as intended with both test modules unable to import the missing
   `../src/storage/index.js` implementation.

2. Determinism RED, after the initial implementation but before its synthetic
   identifier behavior was fixed:

   ```text
   pnpm --filter @nxt/api test -- local-drive-adapter
   ```

   Failed as intended: the first created ID was a random UUID-backed
   `file_<uuid>` rather than the required deterministic `file_1`.

3. GREEN package validation:

   ```text
   pnpm --filter @nxt/api test -- local-drive-adapter root-boundary
   pnpm --filter @nxt/api typecheck
   pnpm --filter @nxt/api build
   ```

   Passed: 2 files and 9 tests; typecheck and build exited 0.

## Final validation

All of the following exited 0 under Node 22:

- `pnpm lint`
- `pnpm --filter @nxt/api test -- local-drive-adapter root-boundary`
- `pnpm --filter @nxt/api typecheck`
- `pnpm --filter @nxt/api build`
- `pnpm test` — contracts 6, domain 15, API 9 tests
- `pnpm typecheck`
- `pnpm build`
- `git diff --check`

## Commit

- `ebb16f862e6743fa777992a1c07bbc0466464958` — `feat: add bounded storage port`

## Concerns

None. The adapter intentionally models only the bounded local simulator
contract; the Google Drive adapter remains a later task.

## Fix round 1 — root validation and transactional local content

### RED evidence

Under Node 22, added focused regressions and ran:

```text
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH \
  pnpm --filter @nxt/api test -- local-drive-adapter root-boundary
```

The command failed as intended with five failures:

- a configured root with missing metadata, Trash state, or shortcut MIME was
  accepted before it was read;
- an injected metadata persistence failure still exposed the new text and
  version;
- a pre-existing revision destination was overwritten;
- `<temporary>/container/link/nested` followed an intermediate symbolic link
  and initialized metadata outside the requested root; and
- `StoredFile` responses leaked the local-only `kind` field.

### Implementation

- `RootBoundaryStorage.assertInside()` now fetches and validates every node,
  including the configured root. The root must have no parents; descendants
  retain the exact-one-parent rule.
- Immutable revision files are now the authoritative local content. They are
  created with exclusive `wx` writes; an existing matching revision is an
  idempotent retry, while differing bytes fail without replacement. Metadata
  is written only after the immutable content revision exists, and active
  `.content` files are a post-commit cache. Thus a rejected metadata write has
  no StoragePort-visible new content, version, or listed revision.
- Creates use the same revision-before-metadata protocol. Trash commits its
  metadata before moving the non-authoritative active cache, so a rejected
  metadata save leaves the active content accessible and untrashed.
- Temporary-root paths are canonicalized before component-by-component
  validation; every later internal directory operation repeats that validation
  and rejects symlinked components. This prevents writes through a created
  intermediate link.
- `toStoredFile()` now builds only the public `StoredFile` fields explicitly.

### GREEN validation

All commands exited 0 under Node 22:

- `pnpm --filter @nxt/api test -- local-drive-adapter root-boundary` — 2 files,
  14 tests.
- `pnpm --filter @nxt/api typecheck`
- `pnpm --filter @nxt/api build`
- `pnpm lint`
- `pnpm test` — contracts 6, domain 15, API 14 tests.
- `pnpm typecheck`
- `pnpm build`
- `git diff --check`

Fix commit: `0185420909d4bd8bbc918b4819c965672a65060e` —
`fix: harden local storage transactions`.

## Fix round 2 — create reconciliation and Trash rollback

### RED evidence

Added two focused local-adapter regressions and ran under Node 22:

```text
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH \
  pnpm --filter @nxt/api test -- local-drive-adapter
```

The command failed as intended:

- a failed create left `file_1/1` as an uncommitted immutable revision, so a
  later create with the reused deterministic ID and different content failed
  with `immutable revision already exists`; and
- a pre-existing `.trash/<file-id>` destination made the post-metadata content
  move fail, but `trash()` swallowed that error and returned a trashed file.

### Implementation

- Before a new file claims its deterministic ID, the adapter identifies any
  revision directory not represented in metadata and moves it, without
  deletion, to the deterministic `.orphaned-revisions/<file-id>-<n>` archive.
  The next create can then write its own exclusive revision, while successful
  metadata-backed revisions remain immutable.
- Trash now snapshots its metadata, commits the trashed state, and requires the
  active-cache move to complete. A move error restores the original metadata
  without invoking test fault hooks and rejects the operation; the active
  content therefore remains readable and untrashed. A success is returned only
  after the expected `.trash/<file-id>` content artifact exists.

### GREEN validation

All commands exited 0 under Node 22:

- `pnpm --filter @nxt/api test -- local-drive-adapter` — 2 files, 16 tests.
- `pnpm --filter @nxt/api typecheck`
- `pnpm --filter @nxt/api build`
- `pnpm lint`
- `pnpm test` — contracts 6, domain 15, API 16 tests.
- `pnpm typecheck`
- `pnpm build`
- `git diff --check`

Fix commit: `6610438da0ad12e999cae00bc94cdfb40198b40f` —
`fix: recover local storage transactions`.

## Fix round 3 — cross-instance lock and durable Trash recovery

### RED evidence

Added a controlled two-adapter interleaving regression and a double-failure
Trash regression, then ran under Node 22:

```text
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH \
  pnpm --filter @nxt/api test -- local-drive-adapter
```

The command failed as intended:

- a second adapter could not enter a controlled pre-load mutation window, so
  there was no root-wide serialization point to prevent stale metadata from
  racing reconciliation; and
- forcing the Trash move failure followed by a rollback-metadata failure still
  reported the move error and left no durable recovery record for a fresh
  adapter to repair.

### Implementation

- All reads and mutations now use a root-local filesystem lock,
  `.mutation.lock`, acquired with exclusive creation. Locks carry an ownership
  token for safe release, wait for a bounded interval, and archive only stale
  lock files rather than deleting them. Mutations acquire the lock before the
  testable pre-load point, recover any pending Trash transaction, and only then
  reload metadata and reconcile/create revisions. This applies across adapter
  instances and processes, rather than relying on an in-process map.
- Trash writes `.trash-rollback.json` before staging metadata. If the final
  content move fails, it attempts an explicit rollback; a failed rollback leaves
  that symlink-checked journal durable. The next locked adapter initialization
  or operation restores the original metadata when the required regular
  `.trash/<id>` artifact is absent, then archives the completed journal without
  permanently deleting it. A journal observed with both trashed metadata and a
  regular Trash artifact is finalized as a successful Trash.

### GREEN validation

All commands exited 0 under Node 22:

- `pnpm --filter @nxt/api test -- local-drive-adapter root-boundary` — 2 files,
  18 tests.
- `pnpm --filter @nxt/api typecheck`
- `pnpm --filter @nxt/api build`
- `pnpm lint`
- `pnpm test` — contracts 6, domain 15, API 18 tests.
- `pnpm typecheck`
- `pnpm build`
- `git diff --check`

Fix commit: `a16d868e64e114447cdcb2abfd681e9b73c3e16e` —
`fix: serialize local storage recovery`.

## Fix round 4 — fail-closed locking and content-bound journals

### RED evidence

After the required lock-decision checkpoint, added six focused regressions and
ran under Node 22:

```text
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH \
  pnpm --filter @nxt/api test -- local-drive-adapter
```

The command failed as intended:

- an old active lock was treated as an unsafe/stale artifact rather than a
  bounded fail-closed timeout;
- owner release deleted lock artifacts and exposed no successor-release probe;
- a bogus regular Trash file finalized a journal without matching its content;
- an `EEXIST` lock handoff that disappeared during inspection failed instead of
  retrying;
- malformed metadata arrays were accepted during adapter creation; and
- the journal swap hook was never reached, leaving a check-then-read path.

### Implementation

- Replaced the time-based file lock with a non-stealable `.mutation.lock`
  directory. Acquisition uses atomic `mkdir`, never archives or breaks an
  existing lock due to age, waits only for the configured bounded interval, and
  then throws a timeout. `EEXIST` followed by `ENOENT` loops and retries.
  Release verifies the owner token and atomically renames the directory into
  `.lock-history`; it does not unlink an artifact, so a protocol successor can
  acquire only after the owner directory has moved.
- Each file Trash journal now records the source size and SHA-256 checksum.
  Recovery finalizes a trashed file only when the exact regular Trash artifact
  matches that descriptor; bogus, missing, or legacy-unbound file artifacts
  restore the original readable metadata and are retained rather than deleted.
- Existing metadata is validated during `create()`, including record shape, not
  deferred to the first operation. Journal JSON is opened once with
  `O_NOFOLLOW`, `fstat`ed, and read from that same handle; a swap to a symlink
  fails closed.

### GREEN validation

All commands exited 0 under Node 22:

- `pnpm --filter @nxt/api test -- local-drive-adapter root-boundary` — 2 files,
  24 tests.
- `pnpm --filter @nxt/api typecheck`
- `pnpm --filter @nxt/api build`
- `pnpm lint`
- `pnpm test` — contracts 6, domain 15, API 24 tests.
- `pnpm typecheck`
- `pnpm build`
- `git diff --check`

Fix commit: `f9900b257a873a9fedde08bbd7307917f6fc87ed` —
`fix: fail closed local storage locks`.
