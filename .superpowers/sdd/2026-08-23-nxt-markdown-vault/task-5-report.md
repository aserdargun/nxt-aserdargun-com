# Task 5 report — exact GitHub owner authentication

## Status

DONE. Task 5 is implemented and committed from the approved baseline. No
GitHub, Azure, Google Drive, deployment, push, credential, or other external
service was used.

## Baseline and implementation commit

- Approved baseline: `830ee61b03c1d9cf5dcdd5bb9c82443e617b1ccf`.
- Implementation: `895b05be6e02c577caa3f5096c9f34ff5ab8f869` —
  `feat: enforce exact github owner`.

## Implementation

- Added bounded, canonical base64 decoding with fatal UTF-8 validation, strict
  exact-key JSON principal validation, bounded fields and roles, and a frozen
  prototype-free principal projection.
- Added exact-owner enforcement with missing/malformed principal failures as
  `401`, valid wrong-provider/user/role failures as `403`, trimmed
  case-insensitive provider/username comparison, and the configured canonical
  owner in successful results.
- Restricted the local bypass to an explicit flag, a non-production runtime,
  and exact `localhost`, `127.0.0.1`, or `[::1]` host syntax with an optional
  valid port. Lookalikes, paths, schemes, userinfo-shaped strings, forwarded
  host assumptions, and invalid ports remain rejected.
- Added typed API error/status mapping, random request IDs, static public error
  messages, and bounded recursive JSON sanitization. Token/secret/credential
  keys, authorization headers, stacks, causes, Drive/file/folder/root ID keys,
  accessors, native errors, cycles, hostile proxies, and unsafe primitive forms
  cannot enter the serialized response projection.
- Added the defensive session handler and registered `GET
/api/private/session` with the Azure Functions v4 code-centric API. Its
  `authLevel` is intentionally `anonymous`, while the handler still executes
  exact-owner authorization. The handler ignores forwarded-host headers.
- Added the built `api/dist` artifacts and set the API package entrypoint to
  `./dist/functions/index.js`. `@azure/functions@4.16.2` remains an exact
  production dependency.

## RED evidence

All commands used the required runtime prefix:

```text
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH
```

Initial RED, after adding the auth/response tests and before adding production
modules:

```text
pnpm --filter @nxt/api test -- auth api-response
```

Exit `1`. Both new suites failed on the expected missing modules:

```text
Cannot find module '../src/auth/client-principal.js'
Cannot find module '../src/http/api-response.js'
Test Files 2 failed | 3 passed
Tests 50 passed
```

Accessor/proxy/loopback RED, added before the corresponding production fixes:

```text
pnpm --filter @nxt/api test -- auth api-response
```

Exit `1`, with three expected failures: uppercase `LOCALHOST` was not accepted,
an array-index getter executed and threw, and a hostile error proxy threw during
prototype inspection. The remaining 92 tests passed.

Recursive-redaction RED, added before expanding the redaction boundary:

```text
pnpm --filter @nxt/api test -- api-response
```

Exit `1`, with two expected failures: `errorStack`/`nestedCause`/plural Drive-ID
fields survived the projection, and a native `Error.message` containing the
secret fixtures was serialized. The remaining 94 tests passed.

## GREEN and final validation

The focused GREEN after all changes was:

```text
pnpm --filter @nxt/api test -- auth api-response
```

It passed 5 test files and 96 tests. The tests explicitly assert that error
bodies contain none of `refresh_token`, `Bearer`, or `drive-file-id`.

The authoritative final validation ran under Node `v22.23.1`:

```text
node --version
pnpm --filter @nxt/api test -- auth api-response
pnpm --filter @nxt/api typecheck
pnpm --filter @nxt/api build
pnpm lint
pnpm test
pnpm typecheck
pnpm build
node --input-type=module -e '<verify API main, artifact, and Functions pin>'
git diff --check
```

All commands exited `0`:

- focused API: 5 files, 96 tests passed;
- root tests: contracts 6, domain 15, API 96 — 117 tests passed;
- API and all-workspace typechecks passed;
- API and all-workspace builds passed;
- root ESLint passed;
- the package verifier found the built Functions entrypoint and exact
  `@azure/functions` version `4.16.2`; and
- the diff check reported no errors.

Before the implementation commit, `git diff --cached --check` also exited `0`
and the staged file list was restricted to `api/` (the lockfile was unchanged).

## Concerns

None.

## Fix round 1 — raw authority, classification order, and total sanitization

### Status and commit

DONE. All seven Important findings were reproduced with tests, fixed, and
validated without using an external service.

- Fix implementation: `ed10db20d6cb9fae9fb68e1bd86bd6882a118730` —
  `fix: harden owner session boundary`.

### Implementation

1. The local bypass now reads the raw standard `Host` authority rather than
   `request.url`. The Azure Functions `HttpRequest` constructor was verified to
   canonicalize numeric/hex/short IPv4, expanded IPv6, empty userinfo, and
   percent-encoded hosts before exposing `request.url`; the raw `Host` value
   preserves the syntax that must be rejected. Only exact `localhost`
   (case-insensitive), `127.0.0.1`, or `[::1]`, with an optional valid decimal
   port, is accepted. `x-forwarded-host` is never consulted.
2. Bypass environments now fail closed through an ASCII-only normalized
   allowlist containing exactly `development` and `test`. Empty, abbreviated,
   staging, production, unknown, zero-width, and control-character variants
   fail.
3. Non-bypass authorization now decodes and structurally classifies the
   principal before reading owner configuration: missing/malformed principals
   return `401`; valid wrong-provider or missing-role principals return `403`;
   only a valid GitHub authenticated principal can reach the missing-config
   `503`. Without configuration, a username cannot be classified as owner or
   non-owner.
4. Native Error detection uses Node's cross-realm-safe `util/types`
   `isNativeError`. A `node:vm` Error with an attacker-controlled message getter
   becomes `[Error]` without reading the getter; Error-spoofing accessors remain
   untouched.
5. Sanitization is total at the response boundary. Revoked array/object proxies,
   `Array.isArray`, native-error inspection, reflection, descriptor reads, and
   primitive conversion all fail to static markers rather than escaping the
   response helper.
6. One monotonic request-wide state now bounds visited nodes, visited entries,
   recursion depth, and serialized output bytes. Budgets are never restored
   while unwinding a branch; deterministic `[Truncated]`, `[Unserializable]`,
   `[Error]`, and `[Circular]` markers preserve bounded output and existing
   redaction behavior.
7. `GET /api/private/session` now returns the existing shared contract shape
   `{ user: { userDetails } }`. Endpoint tests parse the real response with
   `SessionResponseSchema`.

### RED evidence

All commands used the direct Node 22 prefix recorded above.

The first RED added all seven regression groups before production changes:

```text
pnpm --filter @nxt/api test -- auth api-response
```

Exit `1`: 32 tests failed and 105 passed. Expected failures covered cross-realm
Error handling, revoked proxies, shared-DAG truncation, nine invalid environment
forms, four pre-config principal classifications, all requested authority
canonicalization probes, and the shared session response schema.

Runtime inspection then proved that a real `HttpRequest` had already
canonicalized its `url`. The endpoint tests were therefore tightened to use a
real request with a raw `Host` header before changing production code:

```text
pnpm --filter @nxt/api exec vitest run test/auth.test.ts
```

Exit `1`: the seven requested numeric/hex/short IPv4, expanded IPv6, empty
userinfo, and percent-encoded raw-authority probes returned `200` instead of
`401`; the other 62 auth tests passed. Switching the handler from canonicalized
`request.url` to raw `Host` made the same file pass 69/69.

### GREEN and final validation

Focused file-level GREEN evidence:

```text
pnpm --filter @nxt/api exec vitest run test/auth.test.ts
pnpm --filter @nxt/api exec vitest run test/api-response.test.ts
```

The files passed 69/69 and 18/18 respectively. The shared-DAG probe produced a
deterministic truncation after 910 reflected leaf visits with a serialized body
of 260,051 bytes, below the 262,144-byte global output ceiling.

The authoritative final validation under Node `v22.23.1` was:

```text
pnpm --filter @nxt/api test -- auth api-response
pnpm --filter @nxt/api typecheck
pnpm --filter @nxt/api build
pnpm lint
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

All commands exited `0`:

- focused API: 5 files, 137 tests passed;
- root tests: contracts 6, domain 15, API 137 — 158 tests passed;
- API and all-workspace typechecks/builds passed;
- root ESLint passed; and
- staged and unstaged diff checks reported no errors.

### Fix round 1 concerns

None.
