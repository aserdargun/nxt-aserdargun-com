# Task 9 fix round 1/5 report — publication causality and lossless cleanup

## Status

DONE

## Commit

- Review base: `4fd49e49f8c98e0fd56c9a4d48ecaf5c455bb87b`
- Implementation: `d5fcb5a07cddbe5a81d8484a6d726033825abddc` (`fix: harden publication fencing and cleanup`)

## Review-finding mapping

### Critical — pre-reservation publish/revoke resurrection

- `PublicationService.publish` now captures the exact same-note publication identity before cleanup/source work, captures a fresh generation fence after bounded cleanup, and rejects any predecessor/operation identity change before source resolution continues (`api/src/services/publication-service.ts:134-140`).
- `reservePublish` requires the exact fenced manifest generation and the SHA-256 identity of the complete active entry or cleanup-independent tombstone plus complete same-note operations (`api/src/services/publication-service.ts:257-323`, `1201-1235`). A revoke accepted while `vault.getNote` is blocked therefore changes the predecessor identity/generation and the old request cannot reserve from the tombstone.
- Deterministic production-path coverage pauses the first `vault.getNote`, accepts revoke, resumes publish, and proves `CONFLICT` plus anonymous `null` (`api/test/publication-service.test.ts:861`). The existing after-reservation revoke-wins race remains green (`:923`). A separate regression proves an explicitly later request can republish under the stable public ID at epoch 3 (`:908`).

### Important — lossless bounded ownership and cleanup

- The strict pinned manifest schema adds one/two cleanup-slot reservations per operation, exact cleanup ownership fields, at most 32 revoke-owned records per tombstone, a bounded rotation offset, globally unique cleanup IDs, and the invariant `global cleanup + reserved operation slots <= 64` (`packages/contracts/src/publication.ts:85-177`). No system file was added.
- A first publication reserves two slots before any public artifact can be created; a republish/recovery reserves one. Abandonment atomically exchanges its operation reservation for exact revision and, when applicable, never-published public-root records. `boundedCleanup` deduplicates only exact records and rejects overflow instead of slicing away older failures (`api/src/services/publication-service.ts:749-792`, `1115-1125`).
- Revoke commits darkness first and moves all retained immutable revisions into cleanup owned by the tombstone, without consuming or evicting the full global queue. Related in-flight operations remain fenced and keep their cleanup reservation until commit fails and abandonment transfers ownership (`api/src/services/publication-service.ts:199-253`).
- The 33rd publish queues the exact evicted revision in the same manifest CAS that removes its history reference (`api/src/services/publication-service.ts:677-707`). Cleanup selection rotates through all bounded global/tombstone ownership, so permanently failing old records cannot starve revoke cleanup (`:796-846`).
- Regressions cover first-publish root plus revision ownership/cleanup (`api/test/publication-service.test.ts:204`), fail-closed first-publish capacity at 63 records (`:242`), 33rd-revision queue/recovery (`:424`), full-queue revoke darkness/no eviction/eventual retry (`:489`), and 62-record stale-operation recovery without exceeding capacity (`:788`).

### Important — exact cleanup and Trash validation

- Every new cleanup record binds ownership version, exact folder ID/version, parent ID, safe name, public ID, marker, kind, and exact revision operation ID. Schema-valid legacy proofless records remain durably queued and are never acted on (`packages/contracts/src/publication.ts:103-140`).
- Before Trash, cleanup re-verifies the configured private root and exact `published` child. Public-root cleanup requires its exact unique public folder. Revision cleanup requires the exact unique public parent below `published` and the exact unique revision child. All targets must be active folders, never shortcuts/files, with exact name/parent/marker/public/operation identity and exact queued version (`api/src/services/publication-service.ts:796-887`, `1323-1339`).
- Trash uses the freshly observed exact version. Its return must preserve identity and exact metadata, change the version, and report trashed. A fresh `allowTrashed` read then re-verifies the complete root/parent/target chain and exact returned version before the exact unchanged cleanup record may be removed (`api/src/services/publication-service.ts:817-904`). An accepted ambiguous Trash stays queued until a later independent verified read.
- Regressions cover accepted ambiguous Trash (`api/test/publication-service.test.ts:458`), changed version (`:566`), copied marker/wrong ancestry (`:595`), ordinary file and shortcut substitution (`:628`), changed name with a current version (`:665`), missing post-Trash readback (`:695`), and a moved/wrong configured published-root chain (`:725`).

## RED evidence

All RED commands used `PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH`.

```sh
pnpm --filter @nxt/api test -- publication-service.test.ts
```

```text
Exit 1
publication-service.test.ts: 30 tests, 10 failed
API aggregate: 10 failed, 373 passed, 1 skipped (384)

Observed failures:
- first failure queued only `revision`, not `public-root`
- first publish incorrectly succeeded with 63 unresolved cleanup records
- full-queue revoke dropped the oldest cleanup ID
- copied-marker wrong-parent folder was Trashed
- copied-marker ordinary file was Trashed
- changed-name/current-version folder was Trashed
- missing post-Trash readback still cleared cleanup
- moved published root still allowed Trash
- pre-reservation publish resolved and resurrected after revoke
- the 33rd-revision test initially exceeded the default five-second test timeout
```

The bounded-history test timeout was raised to cover the intentional 33 local immutable publishes, then rerun alone to prove the actual missing behavior:

```sh
pnpm --filter @nxt/api exec vitest run test/publication-service.test.ts -t 'thirty-third publish'
```

```text
Exit 1
1 failed, 29 skipped
Expected an exact eviction cleanup record; received `undefined`.
```

No production source was changed before these RED observations.

## Focused GREEN evidence

```sh
pnpm --filter @nxt/api exec vitest run test/publication-service.test.ts
```

```text
Test Files 1 passed
Tests 31 passed
Duration 37.30s
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
Rescan accepted-write compensation + byte-identical finalizer race: 2 passed
Later-state-before-rollback guard: 1 passed
New/legacy delivery + ambiguous recovery downward correction: 2 passed
Rescan WebP/PDF downward correction: 1 passed
All exit 0
```

## Full final validation

Every command below used Node `v22.23.1`.

```sh
pnpm lint
pnpm typecheck
pnpm build
```

```text
eslint: PASS
contracts/domain/api typecheck: PASS
contracts/domain/api build: PASS
```

Full tests explicitly unset every live Drive/OAuth root/file setting and the opt-in integration flag:

```sh
env -u GOOGLE_CLIENT_ID -u GOOGLE_CLIENT_SECRET -u GOOGLE_REFRESH_TOKEN -u NXT_VAULT_DRIVE_FOLDER_ID -u NXT_PRIVATE_DRIVE_FOLDER_ID -u NXT_VAULT_INDEX_DRIVE_FILE_ID -u NXT_PREFERENCES_DRIVE_FILE_ID -u NXT_NOTES_DRIVE_FOLDER_ID -u NXT_INBOX_DRIVE_FOLDER_ID -u NXT_PLANS_DRIVE_FOLDER_ID -u NXT_ARCHIVE_DRIVE_FOLDER_ID -u NXT_ASSETS_DRIVE_FOLDER_ID -u NXT_PUBLICATION_MANIFEST_DRIVE_FILE_ID -u NXT_PUBLISHED_DRIVE_FOLDER_ID -u RUN_GOOGLE_DRIVE_INTEGRATION pnpm test
```

```text
contracts: 1 file passed; 11 tests passed
domain: 4 files passed; 19 tests passed
api: 18 files passed, 1 skipped; 384 tests passed, 1 skipped
Exit 0
```

```sh
git diff --check
```

```text
PASS (no output)
```

## Self-review and concerns

- The three review findings are mapped to production-path regressions and final code above.
- Cleanup traversal, storage calls, CAS attempts, global records, operation reservations, tombstone-owned records, revision history, random-ID collision attempts, and rotation state remain explicitly bounded.
- The existing decomposition Minor remains deferred as directed: `publication-service.ts` still combines writer, cleanup, and reader responsibilities; this round made no broad refactor.
- The one skipped test is the existing opt-in live Google Drive integration test. It was intentionally disabled.
- No unresolved Critical or Important correctness concern remains from this review round.

## External state

No live Google Drive/OAuth, credentials, `.env.local`, DNS, Azure, GitHub, deployment, remote push, or other external mutable state was read or changed. All races, ambiguity, recovery, Trash, and byte-disposition checks used local/fake adapters only.
