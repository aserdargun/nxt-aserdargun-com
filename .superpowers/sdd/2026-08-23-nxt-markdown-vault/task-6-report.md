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

## Fix round 1

### Status and commit

DONE. Review findings 1 through 7 were reproduced with focused failing tests,
fixed, and committed as
`0f2129b8c1fa8720f8eda994dcd294f126762427` —
`fix: harden bounded google drive integration`.

This round did not run a live OAuth flow, open a browser, bind a callback
listener, make a Google/Drive/network request, read credentials, access
`.env.local`, or create a Drive folder/file. `NXT_DRIVE_INTEGRATION` remained
unset for every API test invocation.

### Fixes

- Both root CLI production loaders now use `createRequire` anchored at
  `api/package.json`, so they resolve the API-owned `googleapis@176.0.0` in a
  clean pnpm workspace. A local regression imports both exact production loader
  functions and loads the real installed package without invoking either CLI.
- Every Drive request path disables googleapis/gaxios retries with the second
  options argument `{ retry: false }`, including metadata, media, list,
  revision, about, create, update, provisioning, and root readback calls. The
  adapter remains the sole retry owner: allowlisted idempotent reads make at
  most three attempts; `408` and `501` make one; writes make one.
- Create, text update, move, and Trash readbacks now verify write-response ID,
  readback ID, exact expected name/MIME/state/single ancestry, and version
  behavior, plus MD5 where content was uploaded. Text updates reject MIME
  changes and post-write identity/name/MIME/parent/Trash drift. Moves preserve
  the old name unless an exact new name was supplied. Trash now preflights an
  active, non-shortcut, single-parent item and verifies the same identity and
  metadata after the version advances.
- `RootBoundaryStorage.updateText` now verifies returned identity and ancestry
  and rechecks the stored item, while `trash` still permits the expected
  trashed return value. An ancestry lookup whose returned ID differs from the
  requested ID also fails closed.
- The opt-in live test now requires private, integration, and Notes IDs. Before
  constructing the normalized boundary or writing, it performs a raw metadata
  read and requires the exact owned `integration-tests` folder, folder MIME,
  active state, owner permission, and exactly one parent equal to the private
  root. All fixture readbacks are verified as direct integration-root
  descendants; the executable body makes no Drive request for Notes.
- OAuth callbacks use `URLSearchParams.getAll` and require exactly one matching
  state and exactly one nonempty code. Missing/duplicate state or code and any
  error/code ambiguity fail with redacted static messages before exchange.
- Environment parsing rejects noncanonical leading spaces/tabs and duplicate
  keys before writing; update values still reject CR/LF/NUL injection. No real
  environment file was written. `.gitignore` and behavioral regressions now
  cover `Desktop-app-client*.json` and `client_secret_*.json` without hiding an
  unrelated JSON file.

### Fix-round RED evidence

Every Node/pnpm command used Node `v22.23.1` through the required PATH prefix.

```text
node --test tools/google-drive-provision.test.mjs tools/google-drive-runtime.test.mjs
```

Exit `1`: 13 passed and 4 failed. Failures proved the production loaders were
missing, callback ambiguity was accepted, leading-whitespace environment keys
were accepted, and downloaded credential filenames were not ignored.

```text
env -u NXT_DRIVE_INTEGRATION pnpm --filter @nxt/api test -- google-drive-client google-drive-adapter
```

Exit `1`: 177 passed, 1 failed, and 1 live test skipped because the real-client
retry-suppression wrapper did not exist.

```text
env -u NXT_DRIVE_INTEGRATION pnpm --filter @nxt/api test -- google-drive-adapter root-boundary
```

Exit `1`: 177 passed, 6 failed, and 1 live test skipped. The failures reproduced
incomplete create/update/move/Trash readback validation and the missing
`RootBoundaryStorage.updateText` postcheck.

```text
env -u NXT_DRIVE_INTEGRATION pnpm --filter @nxt/api test -- google-drive-client
```

Exit `1`: 183 passed, 1 failed, and 1 live test skipped because the pure private
integration-root preflight guard did not exist.

### Fix-round GREEN evidence

```text
node --test tools/google-drive-provision.test.mjs tools/google-drive-runtime.test.mjs
```

Exit `0`: all 18 tool tests passed.

```text
env -u NXT_DRIVE_INTEGRATION pnpm --filter @nxt/api test -- google-drive-client google-drive-adapter root-boundary
```

Exit `0`: 184 API tests passed and exactly 1 live test skipped.

Final repository validation:

```text
pnpm lint
pnpm typecheck
pnpm build
env -u NXT_DRIVE_INTEGRATION pnpm test
node --input-type=module -e '<load both production CLI googleapis loaders>'
git diff --check
```

All exited `0`. Root tests passed contracts 6, domain 15, and API 184, for 205
passing tests plus the one expected live skip. The loader probe printed
`api-owned googleapis loaders: ok`; the production dependency remains exactly
`googleapis@176.0.0`. Tracked API build artifacts were regenerated under Node
`v22.23.1`.

### Fix-round concerns

None. The live integration test remains intentionally skipped pending separate,
explicit authorization and credentials.

## Fix round 2

### Status and commit

DONE. The four Important findings and one Minor finding were addressed and
committed as `c954237ccec61da44ebce3c55ee372acad0906ee` —
`fix: align drive mutation contracts`.

This round did not run a live OAuth flow, open a browser, bind a callback
listener, make a Google/Drive/network request, read credentials, access
`.env.local`, or create a Drive folder/file. Every API test invocation removed
`NXT_DRIVE_INTEGRATION`, so the live executable body remained skipped.

### Fixes

- Drive metadata versions now pass the existing validator during conversion to
  `StoredFile`, and that validator requires a positive canonical decimal string
  (`1`, `2`, and so on). Create folder, create text, and create bytes readbacks
  reject zero, signed, leading-zero, and malformed decimal versions with a
  static error that does not surface the created Drive ID.
- The `StoragePort.updateText` contract again permits MIME changes. The Google
  adapter sends the requested MIME in both request metadata and multipart
  media, then verifies the post-write MIME is exactly the requested MIME while
  retaining ID, name, single-parent ancestry, active state, newer-version, and
  checksum verification. A local-adapter parity regression covers
  `text/plain` to `text/markdown`.
- A same-parent rename now sends only `fileId`, the exact name body, and the
  field mask; it omits both `addParents` and `removeParents`. Cross-parent moves
  retain their original add/remove-parent request. Both Local and Google
  adapters consistently reject a same-parent request without `newName` before
  writing.
- Environment source is first canonicalized from CRLF to LF, then rejected if
  any remaining ASCII control character other than LF is present. Existing
  content and update values now reject stray CR, NUL, tab, DEL, and other unsafe
  controls; update values also reject LF. Canonical CRLF files still parse and
  rewrite to LF. These are pure parser/builder tests and no environment file was
  written.
- The still-skipped live test now paginates to exhaustion with a 1000-page
  bound. Before continuing from every page it verifies every returned item has
  a bounded control-free ID unique across pages, is active and not a shortcut,
  and has exactly one parent equal to the integration root. Page-token cycles
  fail closed.

### Fix-round-2 RED evidence

Every Node/pnpm command used Node `v22.23.1` through the required PATH prefix.

```text
node --test tools/google-drive-provision.test.mjs tools/google-drive-runtime.test.mjs
```

Exit `1`: 17 passed and 1 failed because a stray CR/NUL/control character in
existing environment content was accepted.

```text
env -u NXT_DRIVE_INTEGRATION pnpm --filter @nxt/api test -- google-drive-adapter local-drive-adapter
```

Exit `1`: 184 passed, 5 failed, and 1 live test skipped. The failures proved
noncanonical create versions were accepted, Google rejected an allowed MIME
change, same-parent rename emitted contradictory parent mutations, and Google
and Local did not yet share the chosen same-parent no-op rejection behavior.

### Fix-round-2 GREEN evidence

```text
node --test tools/google-drive-provision.test.mjs tools/google-drive-runtime.test.mjs
```

Exit `0`: all 18 tool tests passed.

```text
env -u NXT_DRIVE_INTEGRATION pnpm --filter @nxt/api test -- google-drive-adapter google-drive-client local-drive-adapter root-boundary
```

Exit `0`: 189 API tests passed and exactly 1 live test skipped.

Final repository validation:

```text
pnpm lint
pnpm typecheck
pnpm build
env -u NXT_DRIVE_INTEGRATION pnpm test
git diff --check
```

All exited `0`. Root tests passed contracts 6, domain 15, and API 189, for 210
passing tests plus the one expected live skip. Tracked API build artifacts were
regenerated under Node `v22.23.1`.

### Fix-round-2 concerns

None. Live Drive integration remains intentionally unexecuted and requires a
separate explicit authorization.

## Fix round 3

### Status and commit

DONE. The Important C1-control finding and Minor live child-ID finding were
addressed and committed as `a328474cae093e75c313120cfea9ed1a90702afe` —
`fix: reject C1 controls in drive setup`.

This round did not run a live OAuth flow, open a browser, bind a callback
listener, make a Google/Drive/network request, read credentials, access
`.env.local`, or create a Drive folder/file. Every API test invocation removed
`NXT_DRIVE_INTEGRATION`, so the live integration body remained skipped.

### Fixes

- Environment source and update-value validation now reject every C0 and C1
  control character: U+0000 through U+001F and U+007F through U+009F. Existing
  source permits only LF as its canonical line separator after CRLF-to-LF
  conversion; individual update values permit no LF. Focused cases cover
  U+0080, U+0085, and U+009F through both `parseEnvFile` and `buildEnvFile`.
- U+00A0 and ordinary Turkish, CJK, and emoji content remain accepted, proving
  the range check does not reject normal Unicode.
- The skipped live test now calls an extracted pure child guard whose ID check
  rejects all C0/C1 controls. Unit coverage executes that exact helper locally
  without enabling integration and also retains its bounded-length, uniqueness,
  active, non-shortcut, and exact-direct-parent checks.

### Fix-round-3 RED evidence

Every Node/pnpm command used Node `v22.23.1` through the required PATH prefix.

```text
node --test tools/google-drive-provision.test.mjs tools/google-drive-runtime.test.mjs
```

Exit `1`: 17 passed and 1 failed because environment parsing/building accepted
a C1 control.

```text
env -u NXT_DRIVE_INTEGRATION pnpm --filter @nxt/api test -- google-drive-live-guard google-drive-adapter
```

Exit `1`: 189 passed, 1 failed, and 1 live test skipped because the exact live
child guard accepted a C1-bearing Drive ID.

### Fix-round-3 GREEN evidence

```text
node --test tools/google-drive-provision.test.mjs tools/google-drive-runtime.test.mjs
```

Exit `0`: all 18 tool tests passed.

```text
env -u NXT_DRIVE_INTEGRATION pnpm --filter @nxt/api test -- google-drive-live-guard google-drive-adapter google-drive-client local-drive-adapter root-boundary
```

Exit `0`: 191 API tests passed and exactly 1 live test skipped.

Final repository validation:

```text
pnpm lint
pnpm typecheck
pnpm build
env -u NXT_DRIVE_INTEGRATION pnpm test
git diff --check
```

All exited `0`. Root tests passed contracts 6, domain 15, and API 191, for 212
passing tests plus the one expected live skip.

### Fix-round-3 concerns

None. Live Drive integration remains intentionally unexecuted and requires a
separate explicit authorization.
