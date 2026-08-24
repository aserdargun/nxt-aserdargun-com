# Task 8 report — safe attachments and MIME-enforced delivery

## Status

DONE

## Commits

- Base: `8e6cee48958efd8755ce8e56a087ca3ec521a943`
- Implementation: `ff2c8d76c0bdae6fa62a73629e3dbf529514312c` (`feat: add safe drive attachments`)

## Files

- Added `api/src/services/attachment-policy.ts`, `api/src/services/attachment-service.ts`, and `api/src/functions/attachments.ts`.
- Added policy/service/handler regressions in `api/test/attachment-policy.test.ts` and `api/test/attachment-service.test.ts`.
- Registered only `POST /api/private/attachments`, `GET /api/private/attachments/{assetId}`, and `DELETE /api/private/attachments/{assetId}`; the existing twelve Task 7 routes remain in the separate unchanged `task7Routes` list.
- Added `file-type@22.0.2` to the API dependency and `pnpm-lock.yaml`.
- Extended the private index attachment record with checksum/disposition and added persisted `create-attachment` and `trash-attachment` mutation types. Generated API/contracts artifacts are committed with their sources.

## RED evidence

Command:

```sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/api test -- attachment
```

Output before implementation:

```text
Test Files  2 failed | 14 passed | 1 skipped (17)
Tests  282 passed | 1 skipped (283)
FAIL test/attachment-policy.test.ts: Cannot find module '../src/services/attachment-policy.js'
FAIL test/attachment-service.test.ts: Cannot find module '../src/functions/attachments.js'
Exit status 1
```

Additional red regressions were observed for declared folder/shortcut MIME acceptance, ambiguous-upload recovery, and an incorrectly configured asset root before their corresponding protections were added.

## GREEN evidence

Focused attachment validation:

```sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/api test -- attachment
```

```text
Test Files  16 passed | 1 skipped (17)
Tests  318 passed | 1 skipped (319)
Exit status 0
```

Lint and API typecheck:

```sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm lint
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/api typecheck
```

```text
eslint .
tsc --noEmit
Exit status 0
```

Full tests with all Google Drive settings and `RUN_GOOGLE_DRIVE_INTEGRATION` unset:

```sh
env -u GOOGLE_CLIENT_ID -u GOOGLE_CLIENT_SECRET -u GOOGLE_REFRESH_TOKEN -u NXT_VAULT_DRIVE_FOLDER_ID -u NXT_PRIVATE_DRIVE_FOLDER_ID -u NXT_VAULT_INDEX_DRIVE_FILE_ID -u NXT_PREFERENCES_DRIVE_FILE_ID -u NXT_NOTES_DRIVE_FOLDER_ID -u NXT_INBOX_DRIVE_FOLDER_ID -u NXT_PLANS_DRIVE_FOLDER_ID -u NXT_ARCHIVE_DRIVE_FOLDER_ID -u NXT_ASSETS_DRIVE_FOLDER_ID -u RUN_GOOGLE_DRIVE_INTEGRATION PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm test
```

```text
packages/contracts: 1 passed, 8 tests passed
packages/domain: 3 passed, 15 tests passed
api: 16 passed, 1 skipped; 318 passed, 1 skipped
Exit status 0
```

Build and whitespace validation:

```sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm build
git diff --check
```

```text
packages/contracts build: Done
packages/domain build: Done
api build: Done
Exit status 0
```

## Root and delivery verification

- The service resolves the note through `VaultService.getNote`, validates the UUID/frontmatter/checksum, and relies on the existing root-boundary storage plus Vault note-path ancestry checks.
- It accepts only the configured folder named `_assets`, then only an active, non-shortcut, exact-child `_assets/<note UUID>` folder. Asset metadata, parent, name, bytes, byte count, checksum, MIME, and active state are re-read before projection or delivery.
- Every HTTP asset ID is encrypted/decrypted through the existing opaque codec. Raw Drive IDs stay in the private index/service boundary and are absent from API response bodies.
- Binary detection uses `file-type`; inline is restricted to detected, extension-coherent PNG/JPEG/WebP/GIF/PDF with a matching declaration. All other content is attachment-download-only with `X-Content-Type-Options: nosniff` and an RFC 5987-safe filename.
- Tests cover malicious SVG/HTML/ZIP/executable fixtures, Unicode/control/separator/long-name normalization, collision suffixes, wrong-folder reads, mismatches, reference forms/races, exact readback failures, ambiguous upload/Trash persistence, owner-before-service resolution, headers/status/body, response shape, and raw-ID exclusion.

## Concerns

None. Ambiguous Drive write/Trash outcomes deliberately remain persisted and unavailable until a verified recovery can prove the final state; they are never exposed through the attachment API.

## External state

No live Google Drive, OAuth, credentials, `.env.local`, DNS, Azure, GitHub, deployment, or remote repository state was read or changed. Dependency resolution fetched only the public `file-type` package after the requested offline cache attempt reported its cache miss. All attachment verification used local/fake adapters; live integration remained skipped.

# Fix round 1/5

## Status

DONE

## Files

- Hardened `api/src/services/attachment-service.ts`, `attachment-policy.ts`, and `functions/attachments.ts` for convergent fenced recovery, bounded streaming upload parsing, declaration-before-write rejection, structural inline validation, and a shared Unicode filename metric.
- Added root-boundary recovery support in `api/src/storage/{storage-port,root-boundary}.ts`.
- Added shared attachment-reference canonicalization/index projection in `packages/domain/src/attachment-references.ts`, `indexer.ts`, and `render-markdown.ts`; contracts and generated artifacts are updated.
- Added/updated regressions in `api/test/attachment-policy.test.ts`, `api/test/attachment-service.test.ts`, `api/test/vault-functions.test.ts`, `packages/domain/test/attachment-references.test.ts`, and `packages/domain/test/render-markdown.test.ts`.

## RED evidence

```sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/api test -- attachment-policy.test.ts
```

```text
Test Files 1 failed | 15 passed | 1 skipped (17)
Tests 3 failed | 316 passed | 1 skipped (320)
FAIL: truncated PNG was incorrectly inline; shared attachmentNameLength was absent.
Exit status 1
```

```sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/domain test -- render-markdown.test.ts attachment-references.test.ts
```

```text
Test Files 1 failed | 3 passed (4)
Tests 1 failed | 17 passed (18)
FAIL: legacy non-opaque /api/private/attachments/asset_1 was rejected after strict opaque-token validation.
Exit status 1
```

```sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/api exec vitest run test/attachment-service.test.ts
```

```text
Test Files 1 failed (1)
Tests 1 failed | 20 passed (21)
FAIL: the new >256 recovery loop initially exceeded Vitest's default 5000ms timeout.
Exit status 1
```

## GREEN evidence

```sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/api exec vitest run test/attachment-policy.test.ts test/attachment-service.test.ts
```

```text
Test Files 2 passed (2)
Tests 42 passed (42)
Exit status 0
```

```sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/domain test -- render-markdown.test.ts attachment-references.test.ts
```

```text
Test Files 4 passed (4)
Tests 18 passed (18)
Exit status 0
```

Root checks:

```sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm lint; PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm typecheck; PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm build; git diff --check
```

```text
eslint .
packages/contracts/domain/api typecheck: Done
packages/contracts/domain/api build: Done
Exit status 0
```

```sh
env -u GOOGLE_CLIENT_ID -u GOOGLE_CLIENT_SECRET -u GOOGLE_REFRESH_TOKEN -u NXT_VAULT_DRIVE_FOLDER_ID -u NXT_PRIVATE_DRIVE_FOLDER_ID -u NXT_VAULT_INDEX_DRIVE_FILE_ID -u NXT_PREFERENCES_DRIVE_FILE_ID -u NXT_NOTES_DRIVE_FOLDER_ID -u NXT_INBOX_DRIVE_FOLDER_ID -u NXT_PLANS_DRIVE_FOLDER_ID -u NXT_ARCHIVE_DRIVE_FOLDER_ID -u NXT_ASSETS_DRIVE_FOLDER_ID -u RUN_GOOGLE_DRIVE_INTEGRATION PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm test
```

```text
packages/contracts: 1 passed, 8 tests passed
packages/domain: 4 passed, 18 tests passed
api: 16 passed, 1 skipped; 324 passed, 1 skipped
Exit status 0
```

## Root verification and review

- Create recovery claims by owner/fence, observes TTL/reconcile horizons, bounds recovery to eight intents per request, clears positively absent uploads, verifies exact active candidates before projection, and quarantines only exact unindexed duplicates.
- Trash recovery reads current active/trashed state through the root boundary, removes projection only after verified Trash, restores/keeps active projection when Trash did not apply, and releases terminal fences without overwriting unrelated attachments.
- The owner source is checked directly; other notes use the index's canonical attachment-reference projection. Owner checksum/path and index generation are fenced at reservation and rechecked immediately before Trash.
- `file-type@22.0.2` remains the only sniffer. PNG/JPEG/WebP/GIF/PDF require bounded container-level validity before inline disposition; malformed/truncated/polyglot content is download-only.
- Upload parsing counts the raw stream before JSON parsing, validates Base64 iteratively, and calculates decoded size before Buffer allocation. Rejected bodies do not resolve attachment services.
- Self-review found no new routes; the approved POST/GET/DELETE attachment routes remain the only Task 8 additions. Generated API/contracts/domain artifacts were regenerated by the root build.

## Commits

- Implementation: `79258ac` (`fix: harden attachment recovery`)
- Report: this documentation commit (its hash is reported in the task handoff).

## Concerns

None. The unrelated `pnpm artifact:verify` script references a missing `scripts/verify-artifacts.mjs`; it is not part of the requested lint/typecheck/test/build validation and was not used as completion evidence.

## External state

No live Google Drive, OAuth, credentials, `.env.local`, DNS, Azure, GitHub, deployment, remote repository, or other external mutable state was accessed or changed. All tests used local/fake adapters; live integration remained skipped.
