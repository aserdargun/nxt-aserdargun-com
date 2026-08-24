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

# Fix round 2/5

## Status

DONE

## Files

- `api/src/services/attachment-service.ts`: marker-proven recovery, version-conditional Trash, fenced committed-CAS re-reads, recovery leases, and terminal conflicts for ambiguous artifacts.
- `api/src/storage/{storage-port,local-drive-adapter,google-drive-adapter,google-drive-client}.ts`: bounded internal app properties and conditional Trash.
- `packages/domain/src/{render-markdown,attachment-references}.ts`: rendering-parser AST projection plus canonical URL segment handling.
- `api/src/services/attachment-policy.ts`: strict WebP/GIF/classic-xref-PDF validation.
- `packages/contracts/src/vault.ts`: discriminated 255-folder/180-attachment pending-name validation.
- Regression tests: contracts, attachment policy/service, Google adapter, and domain attachment references.

## RED evidence

```sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/contracts test
```

```text
Test Files  1 failed (1)
Tests  1 failed | 8 passed (9)
FAIL keeps folder pending names at 255 and attachment pending names at 180 code points
Expected true, received false for a 255-character create-folder targetName.
Exit status 1
```

```sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/domain exec vitest run test/attachment-references.test.ts
```

```text
Test Files  1 failed (1)
Tests  1 failed | 2 passed (3)
FAIL uses the renderer parser for collapsed definitions and decodes path segments only after syntax checks
Expected projection to contain the percent-decoded attachment filename; received [].
Exit status 1
```

```sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/api exec vitest run test/attachment-service.test.ts
```

```text
Test Files  1 failed (1)
Tests  1 failed | 22 passed (23)
FAIL stores a readback-verified asset only beneath its resolved note folder and projects no raw ID
Expected a bounded nxtAttachmentMutation marker; received undefined.
Exit status 1
```

## GREEN evidence

```sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/api exec vitest run test/attachment-service.test.ts test/attachment-policy.test.ts
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/domain test -- attachment-references.test.ts render-markdown.test.ts
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/contracts test
```

```text
api: Test Files 2 passed (2), Tests 43 passed (43)
domain: Test Files 4 passed (4), Tests 19 passed (19)
contracts: Test Files 1 passed (1), Tests 9 passed (9)
Exit status 0
```

```sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm lint
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm typecheck
env -u GOOGLE_CLIENT_ID -u GOOGLE_CLIENT_SECRET -u GOOGLE_REFRESH_TOKEN -u NXT_VAULT_DRIVE_FOLDER_ID -u NXT_PRIVATE_DRIVE_FOLDER_ID -u NXT_VAULT_INDEX_DRIVE_FILE_ID -u NXT_PREFERENCES_DRIVE_FILE_ID -u NXT_NOTES_DRIVE_FOLDER_ID -u NXT_INBOX_DRIVE_FOLDER_ID -u NXT_PLANS_DRIVE_FOLDER_ID -u NXT_ARCHIVE_DRIVE_FOLDER_ID -u NXT_ASSETS_DRIVE_FOLDER_ID -u RUN_GOOGLE_DRIVE_INTEGRATION PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm test
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm build
git diff --check
```

```text
eslint .
packages/contracts/domain/api typecheck: Done
packages/contracts: 9 passed
packages/domain: 19 passed
api: 325 passed, 1 skipped
packages/contracts/domain/api build: Done
Exit status 0
```

## Root verification and self-review

- Create records a phase boundary, random marker, and revalidates parent/name/size/checksum/detected MIME/version/marker before projection or delivery. Same-name/checksum alone is never ownership proof.
- Recovery re-reads its committed owner/fence claim, has a future lease, clears only expired non-Drive reservations, waits bounded unknown-create horizons, and hands ambiguous artifacts to existing rescan as terminal conflicts. Task 7 still skips live attachment recovery.
- Trash binds owner source checksum/path and index generation/projection, blocks pending cross-note source mutations, checks storage version, and removes only the exact projection after verified trashed readback.
- Projection uses the renderer Remark AST for Markdown links/references and the existing wiki dialect; query/fragment syntax is rejected before segment decoding. Opaque token grammar remains strict.
- WebP requires VP8/VP8L image content, GIF requires an image/LZW payload, and PDF requires bounded classic-xref Catalog validation. No routes changed; the approved 3 Task 8 and existing 12 Task 7 routes remain exact. `file-type@22.0.2` remains pinned.

## Commits

- Implementation: `2c3fddacfe2eaedc9ca0d9236620ffa6d31a08ed` (`fix: harden attachment recovery`).
- Report: recorded in the report commit below.

## Concerns

None.

## External state

No live Google Drive, OAuth, credentials, `.env.local`, DNS, Azure, GitHub, deployments, or other external mutable state was accessed or changed. Local/fake adapters only; live Drive integration remained skipped.

# Fix round 3/5

## Status

DONE

## Files

- `api/src/storage/{storage-port,root-boundary,local-drive-adapter,google-drive-adapter}.ts`: mandatory structural version-conditional Trash input, boundary forwarding/validation, and typed conditional Google Trash.
- `api/src/services/attachment-service.ts`: owner/fence/lease re-reads, fenced phase renewal, malformed terminal recovery, marker-only reconciliation, exact restore/finalize identity, and global note/folder-reference reservation fences.
- `api/src/services/{attachment-policy,vault-service}.ts`: stricter JPEG/WebP/GIF/PDF containers, 255-code-point folder handling, and rebased descendant attachment-reference projections.
- `packages/contracts/src/{attachment,api,vault}.ts`: NFC Unicode code-point folder bound while retaining the 180-code-point attachment mutation bound.
- Regression tests: RootBoundary forwarding, attachment policy/service recovery/races, Task 7 folder service/transactions, contracts, local and Google adapters.

## RED evidence

```sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/api exec vitest run test/root-boundary.test.ts
```

```text
Test Files  1 failed (1)
Tests  1 failed | 6 passed (7)
FAIL forwards a structurally required conditional Trash version to the inner storage
RootBoundaryStorage accepted the former positional Trash form instead of forwarding `{ fileId, expectedVersion }`.
Exit status 1
```

```sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/contracts test
```

```text
Test Files  1 failed (1)
Tests  1 failed | 9 passed (10)
FAIL uses NFC Unicode code points, not UTF-16 units, for every folder name boundary
Expected true, received false for a 255-emoji folder name.
Exit status 1
```

```sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/api exec vitest run test/attachment-policy.test.ts
```

```text
Test Files  1 failed (1)
Tests  1 failed | 19 passed (20)
FAIL requires real WebP/GIF image payloads and a classic-xref PDF
Expected a five-byte VP8L header shell to download; received inline.
Exit status 1
```

## GREEN evidence

```sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/api exec vitest run test/attachment-policy.test.ts test/attachment-service.test.ts test/vault-service.test.ts test/vault-transactions.test.ts test/root-boundary.test.ts
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/contracts test
```

```text
api focused: Test Files 5 passed (5), Tests 92 passed (92)
contracts: Test Files 1 passed (1), Tests 10 passed (10)
Exit status 0
```

```sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm lint
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm typecheck
env -u GOOGLE_CLIENT_ID -u GOOGLE_CLIENT_SECRET -u GOOGLE_REFRESH_TOKEN -u NXT_VAULT_DRIVE_FOLDER_ID -u NXT_PRIVATE_DRIVE_FOLDER_ID -u NXT_VAULT_INDEX_DRIVE_FILE_ID -u NXT_PREFERENCES_DRIVE_FILE_ID -u NXT_NOTES_DRIVE_FOLDER_ID -u NXT_INBOX_DRIVE_FOLDER_ID -u NXT_PLANS_DRIVE_FOLDER_ID -u NXT_ARCHIVE_DRIVE_FOLDER_ID -u NXT_ASSETS_DRIVE_FOLDER_ID -u RUN_GOOGLE_DRIVE_INTEGRATION PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm test
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm build
git diff --check
```

```text
eslint .
packages/contracts/domain/api typecheck: Done
packages/contracts: 10 passed
packages/domain: 19 passed
api: 330 passed, 1 skipped
packages/contracts/domain/api build: Done
Exit status 0
```

## Root verification and self-review

- All Trash calls now carry `{ fileId, expectedVersion }`; RootBoundary passes that exact object to the inner adapter. Local and Google adapters validate it at runtime; Google uses exact `If-Match`, disables write retries, and maps 412 to the typed version conflict.
- Attachment recovery claims the current CAS record only when owner, fence, phase, lease horizon, and due time still exactly match; every recovery/phase horizon renewal advances the fence. Invalid dates, missing identity, parent/marker mismatch, duplicate ambiguity, and version/readback drift become bounded terminal rescan conflicts rather than active hot loops.
- Active Trash recovery requires exact attachment identity and refuses a same-name different-ID projection. It never adopts or quarantines unmarked lookalikes; a version drift is left active and terminalized without a second Trash attempt.
- Attachment deletion serializes with every pending note or folder path mutation, including `conflicted` mutations. Folder path commits re-resolve canonical relative asset references at the new note path and retain opaque attachment URLs unchanged.
- VP8X and five-byte VP8L shells are download-only; VP8 needs a bounded key-frame payload. GIF requires code size 2..8 plus real LZW data; PDF accepts only the bounded classic-xref/Catalog form with no injected payload between trailer and `startxref`; JPEG end-marker scanning accepts valid EOI while rejecting truncation.
- Self-review: the approved three Task 8 routes and existing twelve Task 7 routes are unchanged; raw Drive IDs and mutation markers stay internal; `file-type@22.0.2` remains pinned; live integration is skipped.

## Commits

- Implementation: `2c065d10828e7a4ad7f83a4b9a720407e84d719f` (`fix: fence attachment recovery`).
- Report: this separate documentation commit (its final hash is included in the task handoff).

## Concerns

None.

## External state

No live Google Drive, OAuth, credentials, `.env.local`, DNS, Azure, GitHub, deployments, remote repository, or other external mutable state was accessed or changed. Local/fake adapters only; live Drive integration remained skipped.
