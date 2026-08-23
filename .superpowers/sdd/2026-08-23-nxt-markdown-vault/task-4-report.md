# Task 4 report — bounded storage port

## Status

DONE. Implemented and committed the Node 22 `@nxt/api` storage package. The
work is restricted to the local filesystem-backed simulator; no Google Drive,
Azure resource, external service, deployment, push, or credential was used.

## Implementation

- Added the exact API workspace package contract, Azure Functions host
  configuration with the 45-second timeout, strict TypeScript configuration,
  pinned dependencies, and generated TypeScript build artifacts.
- Defined `StoragePort` and `StoredFile` with paged child listing, versioned
  text and byte reads/writes, folder/text/byte creation, move, Trash, and
  revision operations.
- Added `RootBoundaryStorage`, a decorator that validates exactly one parent
  at a time and terminates only at its configured root. It rejects paths over
  512 characters, multiple parents, cycles, shortcuts, trashed items, missing
  parents, foreign roots, and traversals over 100 nodes. The decorator is
  parameterized so vault and private roots use separate instances.
- Added `LocalDriveAdapter`, which persists only opaque synthetic IDs in
  `.metadata.json`, has deterministic logical timestamps and IDs, serializes
  local operations, uses stable name/ID order for paging, and rejects stale or
  malformed page tokens.
- Content writes create immutable local revision copies in
  `.revisions/<file-id>/`. Trash moves the active content below `.trash/` and
  records the changed metadata; it never invokes a permanent-delete API.
  Caller-supplied paths, traversal-shaped IDs, invalid names, symlinked
  storage paths, and conflicting write versions fail closed.

## RED → GREEN evidence

All commands used:

```text
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH
```

1. Initial RED, before storage source modules existed:

   ```text
   pnpm --filter @nxt/api test -- local-drive-adapter root-boundary
   ```

   Failed as intended with both test modules unable to import the missing
   `../src/storage/index.js` implementation.

2. Determinism RED, after the initial implementation but before its synthetic
   identifier behavior was fixed:

   ```text
   pnpm --filter @nxt/api test -- local-drive-adapter
   ```

   Failed as intended: the first created ID was a random UUID-backed
   `file_<uuid>` rather than the required deterministic `file_1`.

3. GREEN package validation:

   ```text
   pnpm --filter @nxt/api test -- local-drive-adapter root-boundary
   pnpm --filter @nxt/api typecheck
   pnpm --filter @nxt/api build
   ```

   Passed: 2 files and 9 tests; typecheck and build exited 0.

## Final validation

All of the following exited 0 under Node 22:

- `pnpm lint`
- `pnpm --filter @nxt/api test -- local-drive-adapter root-boundary`
- `pnpm --filter @nxt/api typecheck`
- `pnpm --filter @nxt/api build`
- `pnpm test` — contracts 6, domain 15, API 9 tests
- `pnpm typecheck`
- `pnpm build`
- `git diff --check`

## Commit

- `ebb16f862e6743fa777992a1c07bbc0466464958` — `feat: add bounded storage port`

## Concerns

None. The adapter intentionally models only the bounded local simulator
contract; the Google Drive adapter remains a later task.
