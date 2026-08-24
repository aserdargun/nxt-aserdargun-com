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
