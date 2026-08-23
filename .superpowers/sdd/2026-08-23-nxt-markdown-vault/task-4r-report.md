# Task 4R report — explicit local Trash state model

## Status

DONE_WITH_CONCERNS. The approved local storage remediation is implemented and
committed. No Google Drive, GitHub, Azure, deployment, push, credential, or
other external resource was used.

The only concern is process-only: one intermediate focused GREEN run was
started through a nested login shell that reset `PATH` and reported Node 26.
That run was discarded immediately. Every authoritative RED, GREEN, build,
typecheck, lint, and final validation result below used the required direct
Node 22 path; the final evidence set explicitly printed `v22.23.1`.

## Baseline and commits

- Approved baseline:
  `12f44ea6785694e20ae25b852d593ece8b15987a`.
- Implementation:
  `d51283ec831d90854be965e35a44ee4811c39ed8` —
  `fix: redesign local Trash recovery`.
- The documentation-only report commit is intentionally separate; its hash is
  reported in the Task 4R handoff because a commit cannot contain its own hash.

No merge, push, or deployment was performed. The named worktree and branch are
preserved.

## Root cause

The Task 4 implementation had three coupled gaps:

1. persisted metadata validated direct parent existence but did not validate
   the complete graph to one configured root, so cycles could survive a load;
2. active revision membership was checked without binding revision numbers to
   the file version, so version `1` could point at revision `2`; and
3. Trash recovery inferred success from scattered metadata/artifact checks,
   rejected legacy unbound file journals, and required the mutable `.content`
   cache even though immutable revisions were authoritative.

## RED evidence

Before production changes, the baseline focused suite passed under Node 22:

```text
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH \
  pnpm --filter @nxt/api test -- local-drive-adapter root-boundary

Test Files  2 passed (2)
Tests       30 passed (30)
```

The required regressions were then added and run before implementation:

```text
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH \
  pnpm --filter @nxt/api test -- local-drive-adapter root-boundary
```

Expected result: exit `1`, one test file failed, one passed, with `9 failed |
29 passed (38)`. The nine failures were:

1. a bogus schema-1 file Trash artifact was left live instead of archived;
2. a two-folder persisted parent cycle was accepted by `create()`;
3. a version `1` file pointing to active revision `2` was accepted;
4. a staged legacy/unbound file journal was rejected instead of rolled back;
5. missing `.content/<id>` caused otherwise valid file Trash to fail;
6. a corrupt cache directory caused otherwise valid file Trash to fail;
7. the explicit durable Trash state sequence did not exist;
8. restart could not resume a schema-2 `metadata-staged` transaction with an
   exact artifact; and
9. restart could not roll back a schema-2 `metadata-staged` transaction with no
   verifiable artifact.

The failure messages matched the missing behaviors: cycle/revision promises
resolved instead of rejecting, legacy/current journals raised `invalid Trash
rollback journal`, cache cases raised `ENOENT` or `unsafe content path`, the
state sequence was absent, and the bogus artifact remained at `.trash/<id>`.

## State model and recovery

`api/src/storage/trash-transaction.ts` defines a small schema-version `2`
discriminated union:

- common discriminator: `operation: "trash"`;
- item discriminator: `itemKind: "file" | "folder"`;
- explicit state: `prepared`, `metadata-staged`, `artifact-verified`,
  `finalized`, or rollback terminal `rolled-back`;
- file transactions require one exact positive-size-or-empty
  `{ size, checksum }` descriptor;
- folder transactions forbid a content descriptor; and
- a transition table rejects invalid state changes.

Normal file Trash follows these durable transitions:

```text
prepared
  -> metadata-staged
  -> artifact-verified
  -> finalized
```

The journal is written before metadata mutation. `metadata-staged` is written
after the trashed metadata commit. The adapter opens the committed immutable
revision with no-follow semantics, creates `.trash/<id>` exclusively with
no-follow flags, and verifies checksum plus size from one no-follow regular-file
handle. Only trashed metadata plus an artifact whose descriptor also matches the
immutable revision can advance to `artifact-verified` and `finalized`.

Restart recovery revalidates current metadata and the journal's complete
original metadata before acting. A provable current transaction resumes through
the remaining transitions. An unprovable transaction restores the validated,
readable, untrashed original metadata and advances to `rolled-back`. A schema-1
legacy file journal is never treated as successful, even when it contains an
old descriptor; it always takes the validated rollback path.

Each replaced current journal inode is hard-linked into a unique
`.transaction-state-history/state-<n>/journal.json` container before the next
state is installed. The terminal journal moves to a unique
`.transaction-history/trash-<n>/journal.json` container. Rollback and legacy
recovery also move any untrusted Trash artifact into that transaction container
as `artifact`. Nothing is overwritten or permanently deleted.

The mutable `.content/<id>` cache is never a success precondition. Missing,
regular, directory, symlink, or otherwise corrupt cache state is handled only by
a post-verification best-effort archive. Failure to archive it cannot reverse a
logically verified Trash or reach through a symlinked parent.

## Metadata validation

Every `.metadata.json` load, including adapter creation and transaction-original
metadata validation, now enforces:

- each non-root has exactly one valid folder/root parent;
- each ancestry walk detects cycles, terminates at exactly `vault` or `private`,
  and visits at most 100 nodes;
- both configured roots remain exact, parentless, untrashed folders;
- file versions, content revisions, and revision IDs are positive decimals;
- revision IDs are unique, strictly increasing, and never exceed file version;
- the active content revision exists exactly once and is the latest content
  revision while remaining less than or equal to file version; and
- folder/root files have no content revision and no revisions.

This preserves valid metadata-only version bumps from move/Trash while rejecting
future or ambiguous active content revisions.

## Changed files

- `api/src/storage/local-drive-adapter.ts`
- `api/src/storage/trash-transaction.ts`
- `api/test/local-drive-adapter.test.ts`
- generated tracked artifacts for both storage modules under
  `api/dist/storage/`

The public `StoragePort` and `StoredFile` contracts were not changed.

## Authoritative GREEN and final validation

All commands below were run with:

```text
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH
```

The final combined validation printed `v22.23.1` and all commands exited `0`:

```text
node --version
pnpm --filter @nxt/api test -- local-drive-adapter root-boundary
pnpm --filter @nxt/api typecheck
pnpm --filter @nxt/api build
pnpm lint
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Observed results:

- focused API: 2 files, 38 tests passed;
- API typecheck and build: passed;
- root lint: passed;
- root tests: contracts 6, domain 15, API 38 — 59 tests passed;
- root typecheck and build: all three workspace packages passed; and
- `git diff --check`: no errors.

## Remaining concerns

No product or contract concern remains in Task 4R scope. The discarded
non-authoritative Node 26 intermediate run is the process concern recorded in
Status; it did not produce the committed build artifacts or any final evidence.

DONE_WITH_CONCERNS
