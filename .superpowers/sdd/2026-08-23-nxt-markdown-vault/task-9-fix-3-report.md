# Task 9 fix round 3/5 report — live create-intent fencing

## Status

DONE

## Commits

- Review base: `79a4475120df9a04c4bbf1596ef96a5c5ef5a551`
- Implementation: `0114fa636d520184bbe32f4afe746ba64c5400b2` (`fix: fence live publication create intents`)

## Finding-to-code/test mapping

### Important — live create intent became recoverable before immediate verification completed

- `ensureOperationFolder` still persists the strict prepared intent and confirms its attempted state before invoking Drive. After a returned or mutation-outcome-unknown create, the renamed `recordAttemptedCreateIdentity` persists every known folder ID/version while requiring and preserving `state: "attempted"`. Immediate exact-child/get/readback verification therefore runs while the request remains the live owner (`api/src/services/publication-service.ts:411-467`, `:833-858`).
- `abandonOperation` remains the only immediate transition from attempted to recoverable. It runs in the origin's catch path after failed immediate verification. A crash that prevents explicit abandonment leaves the durable attempted intent and its cleanup-slot reservation intact; existing recovery admits it only after the bounded stale-operation time fence (`api/src/services/publication-service.ts:915-936`, `:971-999`, `:1585-1590`).
- Ambiguous manifest update/readback cannot discard ownership. The pre-create attempted intent is already durable; `updateOperation` independently accepts only the exact proposed identity state after ambiguous readback. If identity persistence cannot be confirmed, origin abandonment retains the attempted intent as recoverable, and a crash leaves it stale-recoverable later. Exact round-2 ancestry, marker, type, uniqueness, ID/version, child-before-parent, conditional Trash, and post-Trash readback checks are unchanged.
- A concurrent publish still runs normal maintenance, but non-stale attempted intents are absent from the recovery candidate set. It observes the live operation and conflicts at reservation without queuing cleanup or Trashing its folder. The valid origin can finish exact verification and commit. Existing revoke-first epoch/tombstone fencing is unchanged: an accepted revoke may prevent final commit, after which origin abandonment makes the create recoverable without resurrection.

Production-path regressions:

- `never recovers or trashes a non-stale attempted create owned by a live publisher` pauses the origin's post-identity-CAS exact-child read, starts a competing publish, and proves the contender conflicts; the exact attempted operation and known identity remain; no cleanup is queued; the folder remains active; and the origin completes and is anonymously readable (`api/test/publication-service.test.ts:352`). This test fails if known-identity persistence changes the intent to recoverable or if maintenance admits non-stale attempts.
- `rotates beyond four retained create intents so unprovable owners cannot starve a later recovery` persists five strict recoverable intents. The first four have no provable child; the fifth owns one exact marker-bound folder. Request one leaves the fifth untouched, proving the four-item work bound. Request two reaches, proves, queues, conditionally Trashes, and clears the fifth while retaining the four unprovable owners (`api/test/publication-service.test.ts:480`). This guards the existing persisted rotation offset without weakening proof or bounds.

## RED evidence

All commands used Node `v22.23.1` through `PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH`.

The first test-only harness attempt paused every public-folder create, including the contender, and correctly timed out rather than producing behavioral evidence. The pause was narrowed to the first create before any production edit. The resulting RED was:

```sh
pnpm --filter @nxt/api exec vitest run test/publication-service.test.ts
```

```text
Exit 1
Test Files: 1 failed
Tests: 1 failed, 37 passed (38)

never recovers or trashes a non-stale attempted create owned by a live publisher
Expected contender status: rejected with CONFLICT
Received contender status: fulfilled
```

The five-intent rotation regression passed during RED, characterizing and protecting the already-correct bounded rotation behavior. No production source changed before the meaningful RED observation.

## Focused GREEN evidence

```sh
pnpm --filter @nxt/api exec vitest run test/publication-service.test.ts
```

```text
Test Files 1 passed
Tests 38 passed
Duration 42.91s
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

Every live Drive/OAuth/root/file setting and the opt-in integration flag was explicitly removed:

```sh
env -u GOOGLE_CLIENT_ID -u GOOGLE_CLIENT_SECRET -u GOOGLE_REFRESH_TOKEN -u NXT_VAULT_DRIVE_FOLDER_ID -u NXT_PRIVATE_DRIVE_FOLDER_ID -u NXT_VAULT_INDEX_DRIVE_FILE_ID -u NXT_PREFERENCES_DRIVE_FILE_ID -u NXT_NOTES_DRIVE_FOLDER_ID -u NXT_INBOX_DRIVE_FOLDER_ID -u NXT_PLANS_DRIVE_FOLDER_ID -u NXT_ARCHIVE_DRIVE_FOLDER_ID -u NXT_ASSETS_DRIVE_FOLDER_ID -u NXT_PUBLICATION_MANIFEST_DRIVE_FILE_ID -u NXT_PUBLISHED_DRIVE_FOLDER_ID -u RUN_GOOGLE_DRIVE_INTEGRATION pnpm test
```

```text
contracts: 1 file passed; 11 tests passed
domain: 4 files passed; 19 tests passed
api: 18 files passed, 1 skipped; 391 tests passed, 1 skipped
Total: 421 passed, 1 skipped
Exit 0
```

Final validation after the last test assertion:

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

- The production correction is deliberately narrow: one helper now persists identity without changing intent state. No manifest schema, public/private route, reader, snapshot, cleanup capacity, or exact Trash validation behavior changed.
- The deterministic race uses real manifest CAS and local storage behavior; only the exact read boundary is gated. It asserts consumer-visible conflict, ownership, absence of cleanup, active folder state, and successful origin publication rather than mock call counts.
- Recovery traversal remains four intents per request, at most 64 operations, one bounded child page per exact parent, bounded CAS retries, and the existing 900-operation request budget. The rotation regression proves a permanently unprovable prefix cannot starve a later valid owner.
- The previously deferred structural Minor remains: `publication-service.ts` combines writer, recovery/cleanup, and reader responsibilities. No broad refactor was attempted.
- The one skipped test is the existing opt-in live Google Drive integration test, intentionally disabled. No unresolved Critical or Important correctness concern remains from this finding.

## External state

No live Google Drive/OAuth, credentials, `.env.local`, DNS, Azure, GitHub, deployment, remote push, or other external mutable state was read or changed. All races, recovery, CAS, and Trash behavior used local adapters only.
