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
