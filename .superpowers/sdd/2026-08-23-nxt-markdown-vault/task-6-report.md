# Task 6 report — bounded Google Drive integration

## Status

DONE. Task 6 is implemented and committed from the approved baseline. No live
Google OAuth flow, browser opening, callback listener, Google Drive/network
request, credential read, `.env.local` read/write, Drive folder/file creation,
Azure operation, push, or deployment was performed. The live integration flag
was never enabled.

## Baseline and implementation commit

- Approved baseline: `1b203a79737a2f45139c55d21176594ceb758f89`.
- Implementation: `12bcbce5532e02ee72f8b56685f9b6e8c7babffa` —
  `feat: add bounded google drive integration`.

## Implementation

- Added pure OAuth helpers that accept only an `installed` Desktop client,
  require the exact full-Drive scope, offline access, consent, state, a
  64-character PKCE verifier/SHA-256 challenge, and an exact
  `http://127.0.0.1:<high-port>/` redirect. Callback validation rejects a wrong
  host, port, path, or state.
- Added an import-safe authorization CLI boundary. When explicitly invoked by
  an operator it binds only to `127.0.0.1`, opens the browser, exchanges the
  one-time code, requests `about.get` with only
  `user(emailAddress,displayName)`, rejects a wrong owner before provisioning,
  requires a refresh token, and atomically persists only client ID, client
  secret, and refresh token. Secret values, authorization codes, callback
  queries, and access tokens are never logged or persisted.
- Added mode-`0600` same-directory atomic environment persistence with
  duplicate-key and newline-injection rejection, file and directory syncing,
  and temporary-file cleanup.
- Added idempotent exact-name provisioning for the two sibling roots, required
  children, and three schema-version-1 system JSON files. It resolves the real
  My Drive root ID, paginates exact-name queries, verifies single-parent
  ancestry, ownership and owner permission readback, fails on duplicates, and
  validates existing JSON, version, and MD5 readback without replacing invalid
  or duplicate system files. Returned settings contain exactly the twelve
  required folder/file ID keys and logs contain no values.
- Added an injected minimal Drive client and `GoogleDriveAdapter` implementing
  `StoragePort`. It escapes query literals, uses exact field masks, forwards or
  exhausts pagination as appropriate, maps versions to strings, checks
  optimistic text updates, uses multipart uploads, verifies MD5 upload/media
  readback, and exposes SHA-256 content checksums.
- Read retries are bounded to three attempts with exponential backoff and
  jitter and only apply to `429`, `500`, `502`, `503`, and `504`. Create,
  update, move, and Trash writes are never retried. Deletion is implemented
  only through `files.update({ requestBody: { trashed: true } })`; the client
  surface exposes neither `files.delete` nor `emptyTrash` and a configured
  boundary root cannot be trashed.
- Added root normalization for Drive-backed boundary instances so ancestry
  terminates at the configured application root while descendant parents remain
  validated by `RootBoundaryStorage`. Unit coverage includes ambiguous parents,
  shortcuts, Trash, invalid/checksum readback, secret-free logging, and raw-ID
  error redaction.
- Added an opt-in live integration test that remains skipped unless
  `NXT_DRIVE_INTEGRATION=1`. Its executable body reads credentials only after
  opt-in, requires `NXT_INTEGRATION_TEST_DRIVE_FOLDER_ID`, proves it differs
  from `NXT_NOTES_DRIVE_FOLDER_ID`, and creates/trashes fixtures only below the
  configured integration-test root.
- Pinned `googleapis` exactly to `176.0.0` in production dependencies, updated
  the lockfile, exported the adapter/client, and regenerated tracked API build
  artifacts. `.env.example` already contained every exact Task 6 setting, so no
  content change was required.

## RED evidence

Every command used the required runtime prefix:

```text
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH
```

Initial OAuth/provision RED:

```text
node --test tools/google-drive-provision.test.mjs
```

Exit `1`: the test could not import the absent
`scripts/google-drive-oauth.mjs` module.

Authorization workflow RED:

```text
node --test tools/google-drive-provision.test.mjs
```

Exit `1`: the test could not import the absent
`scripts/google-drive-authorize.mjs` module.

Initial adapter RED, with the live flag absent:

```text
env -u NXT_DRIVE_INTEGRATION pnpm --filter @nxt/api test -- google-drive-adapter
```

Exit `1`: all 9 new adapter tests failed because `GoogleDriveAdapter` did not
exist; 164 existing API tests passed and the live test skipped.

Subsequent focused RED cycles caught and then drove fixes for:

- three failures covering Drive-root normalization, create readback, and media
  checksum validation;
- one failure proving top-level siblings must use the resolved My Drive root ID;
- one failure proving the configured boundary root could be trashed; and
- one failure proving system-file media had not been matched to its readback
  checksum.

## GREEN and final validation

The final focused commands were:

```text
node --test tools/google-drive-provision.test.mjs
env -u NXT_DRIVE_INTEGRATION pnpm --filter @nxt/api test -- google-drive-adapter
```

They exited `0`: all 13 OAuth/provision tests passed; the API run passed 177
tests in 6 files and skipped exactly the live integration file.

The authoritative final validation under Node `v22.23.1` was:

```text
pnpm lint
env -u NXT_DRIVE_INTEGRATION pnpm test
pnpm typecheck
pnpm build
git diff --check
test ! -e .env.local
node --input-type=module -e '<verify googleapis is exactly 176.0.0>'
<scan api/src and scripts for files.delete or emptyTrash>
```

All commands exited `0`:

- root ESLint passed;
- root tests passed contracts 6, domain 15, and API 177, for 198 passing
  tests plus the single expected live-test skip;
- all workspace typechecks and builds passed;
- the diff check was clean;
- `.env.local` was absent;
- the production dependency was exactly `googleapis@176.0.0`; and
- no permanent-delete API occurred in production source.

`git diff --cached --check` also exited `0` before the implementation commit.

## Concerns

None. The intentionally skipped live integration remains reserved for the
separately authorized live Drive task; this task created no external state.
