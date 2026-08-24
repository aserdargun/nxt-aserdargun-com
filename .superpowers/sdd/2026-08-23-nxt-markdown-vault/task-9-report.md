# Task 9 report — immutable publication snapshots and immediate revocation

## Status

DONE

## Commits

- Base: `294a9ca02176f92c65120a86a213673380c1693d`
- Mandatory Task 8 breaker remediation: `eddb83e4d948a7b29432a254bccefc7a28f8a2f7` (`fix: close publication prerequisite breakers`)
- Task 9 implementation: `213c750b15ddf053b4c4bbee037a8e47b0e993b7` (`feat: add revocable public snapshots`)

## Mandatory breaker remediation

- Rescan finalization now creates and persists a fresh 128-bit finalization-attempt ID before the completion transform, binds it into the completed receipt/MAC, and compensates an ambiguous accepted final write only after a fresh read proves the exact proposed content, checksum, attempt ID, and currently observed version. Rollback uses that exact version and verifies the restored staged state. A losing byte-identical CAS caller cannot roll back the winner.
- Attachment delivery, recovery, and rescan use one downward-only safe-disposition rule. Fresh detection can lower legacy `inline` WebP/PDF to `download`; persisted `download` can never be upgraded. Publication consumes the same fresh verified delivery and public snapshot readers re-detect bytes rather than trusting legacy disposition.

## Task 9 implementation

- Evolved only the provisioned `publication-manifest.json` schema for bounded operations, tombstones, cleanup records, stable public entries, and immutable revisions. `SystemFileStore` remains pinned to the exact configured file ID, parent, name, JSON MIME, version, and checksum; it never creates a replacement system file.
- Public and asset IDs are exact 16-byte cryptographically random base64url values. Snapshot folders are marker-owned, ancestry-checked children of the verified configured `published` root. Revision names are bounded safe hashes of the source version with bounded collision suffixes.
- Publish resolves and re-verifies the current Vault note/version/checksum/path, extracts attachment references through the production projection, reads fresh owner-bound attachment bytes, rewrites only those exact references to current manifest URLs, and rejects preexisting unallowlisted public asset URLs. Every folder, note JSON, and copied asset is read back for exact identity, parent, name, MIME, size, version, checksum, marker, active state, and non-shortcut state.
- The public manifest entry is the final CAS. Partial or failed copies stay unreachable and leave only bounded cleanup state or marker-discoverable folders. Persisted operations fence concurrent calls, recover stale crash state after a bounded interval, and prevent older publishes from surviving an accepted revoke. Republish keeps one stable public ID, commits a new immutable revision last, and rejects public asset-ID collisions with retained manifest history.
- Revoke removes the manifest entry and installs the higher-epoch tombstone first, verifies the anonymous reader is dark, and then conditionally Trashes only the exact queued snapshot version. Failed or ambiguous Trash remains queued; a changed target is never Trashed and permanent delete is never used.
- Anonymous readers accept only exact manifest IDs, verify the pinned manifest and full snapshot ancestry/markers/readback, enforce the exact active asset allowlist, freshly detect snapshot bytes and disposition, and map all malformed, missing, corrupt, unallowlisted, and raw-ID probes to one generic `404`. Public responses include `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`, `X-Content-Type-Options: nosniff`, and a request ID; download names use shared RFC 5987 sanitization.
- Registered exactly four Task 9 routes while preserving the exact twelve Task 7 and three Task 8 routes. Private publish/revoke authorizes the exact owner before service resolution; anonymous readers never invoke owner authorization.

## RED evidence

Mandatory breaker tests were written first:

```sh
pnpm --filter @nxt/api exec vitest run test/rescan-persistence.test.ts test/rescan-service.test.ts test/attachment-service.test.ts
```

```text
5 failed regressions: legacy delivery returned 503, legacy recovery returned 404,
the completed receipt lacked an attempt ID, a losing same-content finalizer rolled
back the winner, and rescan copied legacy inline disposition.
Exit status 1
```

Initial Task 9 tests before implementation:

```sh
pnpm --filter @nxt/api exec vitest run test/publication-service.test.ts test/public-functions.test.ts
```

```text
Test Files 2 failed (2)
Both failures were missing publication service/function modules.
Exit status 1
```

Additional security regressions were also observed RED before their fixes:

```text
publication-service.test.ts: 3 failed — private attachment URL was not rewritten,
legacy inline WebP remained inline in the public note projection, and cleanup
Trashed a target whose queued version had changed.

publication-service.test.ts -t "preexisting public asset URL": 1 failed — an
unallowlisted public asset URL was accepted into a snapshot.
```

## GREEN evidence

All reported verification commands used Node `v22.23.1` (confirmed by `node -v`).

Focused breaker plus Task 9 validation:

```sh
pnpm --filter @nxt/api exec vitest run test/rescan-persistence.test.ts test/rescan-service.test.ts test/attachment-service.test.ts test/publication-service.test.ts test/public-functions.test.ts
```

```text
Test Files 5 passed (5)
Tests 83 passed (83)
Exit status 0
```

Lint, typecheck, build, and whitespace validation:

```sh
node -v
pnpm lint
pnpm typecheck
pnpm build
git diff --check
```

```text
v22.23.1
eslint: PASS
contracts/domain/api typecheck: PASS
contracts/domain/api build: PASS
git diff --check: PASS
```

Full tests with every live Drive/runtime setting and the opt-in integration flag unset:

```sh
env -u GOOGLE_CLIENT_ID -u GOOGLE_CLIENT_SECRET -u GOOGLE_REFRESH_TOKEN -u NXT_VAULT_DRIVE_FOLDER_ID -u NXT_PRIVATE_DRIVE_FOLDER_ID -u NXT_VAULT_INDEX_DRIVE_FILE_ID -u NXT_PREFERENCES_DRIVE_FILE_ID -u NXT_NOTES_DRIVE_FOLDER_ID -u NXT_INBOX_DRIVE_FOLDER_ID -u NXT_PLANS_DRIVE_FOLDER_ID -u NXT_ARCHIVE_DRIVE_FOLDER_ID -u NXT_ASSETS_DRIVE_FOLDER_ID -u NXT_PUBLICATION_MANIFEST_DRIVE_FILE_ID -u NXT_PUBLISHED_DRIVE_FOLDER_ID -u RUN_GOOGLE_DRIVE_INTEGRATION pnpm test
```

```text
contracts: 1 file passed; 11 tests passed
domain: 4 files passed; 19 tests passed
api: 18 files passed, 1 skipped; 372 tests passed, 1 skipped
Exit status 0
```

## Concerns

None. The one skipped API test is the existing opt-in live Google Drive integration test; it remained intentionally disabled.

## External state

No live Google Drive/OAuth, credentials, `.env.local`, DNS, Azure, GitHub, deployment, remote push, or other external mutable state was read or changed. All publication, race, ambiguity, recovery, and Trash verification used local or fake adapters.
