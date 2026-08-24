# Task 9 fix round 2/5 report — durable ownership of ambiguous folder creates

## Status

DONE

## Commits

- Review base: `be257b7d2f0fb75568652c02b35ab703fde082f1`
- Implementation: `948b29b25860a8e2d9fbf960e92e9cad224054a9` (`fix: retain ambiguous publication creates`)

## Finding-to-code/test mapping

### Important — accepted folder creation could escape ownership after immediate recovery failure

- The strict schema for the existing pinned `publication-manifest.json` now gives every operation one bounded `createIntent`. The intent binds public-root versus revision kind, prepared/attempted/recoverable state, exact parent ID, safe child name, marker, public ID, operation ID, and any known child ID/version. Cross-field checks bind public-root intents to an unpublished two-slot operation and revision intents to the exact persisted public parent/revision. A bounded rotating recovery offset prevents a permanently unprovable intent from starving later intents (`packages/contracts/src/publication.ts:85-146`, `:196`). No file or system filename was added.
- Before either a public-root or revision-folder create can be called, `ensureOperationFolder` commits a prepared intent, then commits the attempted transition. A definitely not-applied adapter error clears the intent; all other create calls remain conservatively owned. A normal create or mutation-outcome-unknown result commits recoverable state plus any known ID/version before immediate exact-child/get verification. Successful verification atomically converts the intent into the normal persisted folder identity (`api/src/services/publication-service.ts:349-467`, `:833-886`).
- Abandonment never removes an attempted/recoverable operation or its reserved cleanup capacity. A caught failure makes an attempted intent immediately recoverable. An unacknowledged/crashed attempted intent becomes recoverable through the existing five-minute stale fence. Stale reservation replacement is forbidden while such an unresolved intent remains (`api/src/services/publication-service.ts:286-292`, `:916-970`).
- Fresh private publish/revoke requests run bounded intent recovery. Recovery verifies the configured `published` root under the private root. Public-root discovery requires one exact active folder at the exact parent/name with the public marker and no operation/asset metadata. Revision discovery first proves the exact public parent ID/version/name/marker/ancestry and uniqueness, then proves one exact revision child with the exact operation marker. Known IDs/versions must match. Files, shortcuts, wrong names/parents/markers, changed known identities, and duplicates are retained fail-closed and never converted to cleanup (`api/src/services/publication-service.ts:972-1064`).
- A proven create is atomically exchanged for the existing exact cleanup ownership. A first-publication revision exchanges its two reserved slots for revision-before-public-root cleanup, preserving the child-before-parent dependency; a republish queues only its revision. Cleanup IDs remain collision-bounded and globally unique. Existing conditional Trash and exact post-Trash readback then clear ownership; an ambiguous CAS is accepted only after the exact proposed cleanup records are independently observed (`api/src/services/publication-service.ts:1066-1125`, `:1127-1231`). Operation-held known folder IDs are treated as live manifest references until conversion (`:1612-1620`).
- Request causality still fences an accepted revoke before source resolution. Intent recovery may legitimately change same-note operation state, so the pre-maintenance check binds the exact predecessor identity; reservation still requires the complete freshly observed generation and full predecessor/operation identity. A concurrent revoke changes the predecessor and conflicts, while maintenance of an abandoned intent does not create a false resurrection path (`api/src/services/publication-service.ts:140-151`, `:1540-1562`).

Production-path regressions:

- Accepted first public-root create plus immediate exact-child read failure retains one two-slot operation, survives a fresh service instance, converts to exact cleanup, and is conditionally Trashed/cleared (`api/test/publication-service.test.ts:221`).
- Accepted revision create below a persisted public parent plus immediate read failure recovers the revision first. Injected parent Trash failure proves the public parent remains active while revision cleanup completes; a later retry safely Trashes/clears the parent (`:261`).
- Mutation-outcome-unknown after an accepted public-root create plus the first discovery-read failure is recovered by a fresh instance and cleaned (`:317`).
- Copied-marker duplicate and wrong-parent/wrong-marker discovery variants retain the exact operation reservation, queue no unproved cleanup, and Trash neither genuine nor lookalike folders (`:352`).

## RED evidence

All commands used Node `v22.23.1` through `PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH`.

```sh
pnpm --filter @nxt/api test -- publication-service.test.ts
```

```text
Exit 1
publication-service.test.ts: 36 tests, 5 failed
API aggregate: 5 failed, 384 passed, 1 skipped (390)

All five new production-path cases failed at the intended durable-ownership assertion:
expected manifest operations length 1; received 0.

- accepted public-root create / immediate recovery read failure
- accepted revision create / immediate recovery read failure
- ambiguously accepted public-root create / first discovery read failure
- copied-marker duplicate discovery
- wrong-parent plus wrong-marker discovery
```

No production source changed before this RED observation.

## Focused GREEN evidence

```sh
pnpm --filter @nxt/api exec vitest run test/publication-service.test.ts
```

```text
Test Files 1 passed
Tests 36 passed
Duration 43.65s
Exit 0
```

Mandatory Task 8 breaker preservation:

```sh
pnpm --filter @nxt/api exec vitest run test/rescan-persistence.test.ts -t 'accepted final swap|byte-identical finalizer'
pnpm --filter @nxt/api exec vitest run test/rescan-persistence.test.ts -t 'later index version'
pnpm --filter @nxt/api exec vitest run test/attachment-service.test.ts -t 'new and legacy WebP|legacy inline WebP mutation'
pnpm --filter @nxt/api exec vitest run test/rescan-service.test.ts -t 'downgrades legacy WebP and PDF'
```

```text
Rescan accepted-write compensation and byte-identical finalizer race: 2 passed, 15 skipped
Later-state-before-rollback guard: 1 passed, 16 skipped
New/legacy WebP delivery and ambiguous recovery downgrade: 2 passed, 29 skipped
Rescan WebP/PDF downward correction: 1 passed, 8 skipped
All exit 0
```

## Full offline validation

All live Drive/OAuth/root/file settings and the opt-in integration flag were explicitly removed:

```sh
env -u GOOGLE_CLIENT_ID -u GOOGLE_CLIENT_SECRET -u GOOGLE_REFRESH_TOKEN -u NXT_VAULT_DRIVE_FOLDER_ID -u NXT_PRIVATE_DRIVE_FOLDER_ID -u NXT_VAULT_INDEX_DRIVE_FILE_ID -u NXT_PREFERENCES_DRIVE_FILE_ID -u NXT_NOTES_DRIVE_FOLDER_ID -u NXT_INBOX_DRIVE_FOLDER_ID -u NXT_PLANS_DRIVE_FOLDER_ID -u NXT_ARCHIVE_DRIVE_FOLDER_ID -u NXT_ASSETS_DRIVE_FOLDER_ID -u NXT_PUBLICATION_MANIFEST_DRIVE_FILE_ID -u NXT_PUBLISHED_DRIVE_FOLDER_ID -u RUN_GOOGLE_DRIVE_INTEGRATION pnpm test
```

```text
contracts: 1 file passed; 11 tests passed
domain: 4 files passed; 19 tests passed
api: 18 files passed, 1 skipped; 389 tests passed, 1 skipped
Total: 419 passed, 1 skipped
Exit 0
```

Final static and build validation:

```sh
pnpm lint
pnpm typecheck
pnpm build
git diff --check
```

```text
eslint: PASS
contracts/domain/api typecheck: PASS
contracts/domain/api build: PASS
git diff --check: PASS (no output)
All exit 0
```

## Self-review and remaining concerns

- The round is narrow: it adds the missing durable create-intent state machine and recovery path without changing routes, public schemas, reader exposure, snapshot immutability, or the exact cleanup/Trash validator.
- Manifest operations, intent records, rotations, child listings, CAS retries, random-ID collision attempts, cleanup work, and total storage calls remain explicitly bounded. Unproved intent failures rotate rather than being evicted or blocking later candidates forever.
- Every Task 9 round-1 guarantee remains covered by the 36-test publication service file and full suite; every mandatory Task 8 breaker check passed separately.
- The previously deferred Minor remains: `publication-service.ts` combines writer, recovery/cleanup, and reader responsibilities. No broad refactor was attempted in this correctness-only round.
- The one skipped test is the existing opt-in live Google Drive integration test, intentionally disabled. No unresolved Critical or Important correctness concern remains from this review finding.

## External state

No live Google Drive/OAuth, credentials, `.env.local`, DNS, Azure, GitHub, deployment, remote push, or other external mutable state was read or changed. All failures, ambiguity, recovery, CAS, and Trash behavior used local adapters only.
