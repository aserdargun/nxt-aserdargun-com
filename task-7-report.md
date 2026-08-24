# Task 7 implementation report

Status: **DONE**

## Scope and revisions

- Baseline: `c25383609874e94725800e70189faa76621da9c3`
- Implementation commit: `c530e443820f44121207f30d0724a57ebb6ebfe7`
- Implementation tree: `dffb5e2f2a97971015011b06577cbcfc1062dc73`
- Commit subject: `feat: add drive backed vault services`
- Dependency pins and `pnpm-lock.yaml`: unchanged

The implementation adds the pinned `SystemFileStore`, Drive-backed vault/folder,
rescan, and preference services, lazy runtime composition, opaque folder-ID
transport, testable private handlers, and all 12 approved Azure Functions v4
registrations. Generated `api/dist` output is included with the TypeScript
source and tests.

## TDD evidence

Every production behavior started from a failing test:

1. Initial service RED:
   `pnpm --filter @nxt/api test -- vault-service rescan-service preferences-service`
   failed three suites because the service modules did not exist. The same run
   retained 191 passing pre-existing tests and one skipped live integration
   test.
2. Function RED:
   `pnpm --filter @nxt/api test -- vault-functions` failed because the Task 7
   Function modules did not exist.
3. Confirmation-clock RED: a current token was incorrectly rejected after the
   clock advanced by one second; the test failed with the expected `409` before
   expiry handling was corrected.
4. Descendant-confirmation RED: a folder containing only a nested folder was
   counted as empty; the test failed with `expected 0 to be 1` before folder
   descendants were included.
5. Attachment-path RED: angled/titled and reference-style Markdown attachment
   destinations were not recalculated at a different folder depth; the test
   showed the unchanged source before the link rewriter was extended.

Final focused GREEN command:

```text
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH \
  pnpm --filter @nxt/api test -- vault-service rescan-service preferences-service vault-functions
```

Result after the final edge-case additions: 12 test files passed, 213 tests
passed, and the single opt-in live Drive integration test was skipped.

## Implemented guarantees

- System JSON reads are pinned to the provisioned existing ID, exact parent,
  name, and MIME type; schema version and SHA-256 content checksum are checked.
  Updates use one optimistic content update and exact source/version/checksum
  readback. The service never creates or replaces a system file.
- Notes use the portable codec and stable UUID identity. Create, update, rename,
  move, archive, and Trash operations use preflight versions, same-note
  serialization, full readback before index mutation, collision-safe sanitized
  names, rename aliases, and relative `_assets/<note-id>` link recalculation.
- Custom folder nesting is limited to depth 20. `Notes`, `Inbox`, `Plans`, and
  `Archive` are protected. Folder deletion is Trash-only and non-empty deletion
  requires an HMAC-authenticated server token bound to a hashed folder ID,
  descendant count, current tree version, and expiry.
- Rescan processes at most 100 listed Drive entries per request, uses a bounded
  opaque cursor, starts only at `Notes`, excludes non-Markdown and asset/private
  trees, preserves invalid raw Markdown in recovery responses, rejects duplicate
  note IDs, rebuilds backlinks at completion, and optimistically updates only
  the existing index. A failed final update leaves the previous valid index
  readable.
- Preferences are validated through the shared request contract, deduplicated,
  and pruned against the current index. Preference updates do not touch Markdown.
- Every private handler invokes exact-owner authorization before resolving
  storage services, validates query/path/body input, returns static redacted
  errors with `409` for optimistic/tree conflicts, and removes raw Drive IDs
  from authenticated response projections. Folder references are authenticated
  opaque tokens.

## Final verification

All commands used Node `v22.23.1` through the required explicit `PATH`.

```text
pnpm lint                                      PASS
pnpm typecheck                                PASS (contracts, domain, api)
env -u NXT_DRIVE_INTEGRATION pnpm test        PASS
  contracts: 6 passed
  domain:    15 passed
  api:       213 passed, 1 live test skipped
pnpm build                                     PASS (contracts, domain, api)
git diff --check                               PASS
```

No live Google Drive, OAuth, network, credential, `.env.local`, or other
external-state operation was performed. `NXT_DRIVE_INTEGRATION` was explicitly
unset for the root test run.

## Concerns and operating notes

- Live Drive behavior remains intentionally unverified in this task; the
  opt-in integration test must be run only under its separately authorized
  fixture folder.
- Rescan cursors are opaque per-process session handles. If an Azure Functions
  instance is recycled between pages, the stale cursor fails closed with
  `INVALID_INPUT`; restarting with `cursor: null` is idempotent and preserves the
  prior valid index until a complete scan succeeds.
