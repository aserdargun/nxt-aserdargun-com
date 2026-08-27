# Task 16 Report — CI, Release, and Recovery Contracts

## Status

DONE

Implementation is committed as `639fbb3` (`chore: add nxt validation and release contracts`). This report and the progress-ledger entry are committed separately.

## Delivered contract

- Added PR validation at `.github/workflows/ci.yml` and the single authoritative production workflow at `.github/workflows/deploy-swa-nxt-aserdargun-com.yml`. Every `uses:` entry has the approved immutable SHA, permissions are `contents: read`, and no OIDC input or permission exists.
- Both workflows pair portable `ubuntu-latest` validation with a separate `macos-latest` gate. The macOS job installs `azure-functions-core-tools@4.13.0`, asserts `func --version` is exactly `4.13.0`, installs Chromium, and runs `pnpm validate:macos`. Deployment waits for both jobs, repeats portable validation, and uploads only verified prebuilt `web/dist` and `api-dist` with both Azure builds disabled.
- Added pure source verification and strict release identity. Source mode is valid in the intentionally named implementation worktree. Release mode requires the exact `nxt-aserdargun-com` checkout basename/root, `main`, clean status, exact origin, workflow/resource/secret mapping, and repeats source verification. This worktree fails closed.
- Added manual, action-time Azure settings installation. It accepts only 15 production runtime keys from a mode-`0600` canonical regular non-symlink file, checks exact owner and Azure Free target state, refuses custom hostnames, suppresses child diagnostics, and logs sorted key names only. Tests inject a fake runner and sentinel values; no live Azure command ran.
- Added bounded, read-only two-root Drive inventory plus offline verification. It uses a new mode-`0700` output, mode-`0600` marker/manifest/exports, protected manifest names, ID-hashed export paths, bounded operations/pages/depth/entries/bytes, checksum verification, metadata-only binary defaults, and explicit binary opt-in. Creation and verification reject traversal/separators, NFC/case-fold collisions, duplicate/cyclic IDs, parent/root ambiguity, malformed metadata, repeated pagination, symlinks, special files, missing/extra files, tampering, unsafe modes, and incomplete state. Offline verify loads no OAuth client and prints only correct root labels/counts.
- Added complete public-source/private-Drive, exact-owner, full Drive-scope, Desktop OAuth, consent-token, local lifecycle, recovery, Azure Free release, rotation, CSP/attachment/publication, incident, and hard custom-domain-stop documentation.

## RED → GREEN evidence

Initial focused RED was run before production files existed:

```sh
node --test tools/deployment-contract.test.mjs tools/azure-release.test.mjs tools/google-drive-backup.test.mjs
```

```text
0 passed, 10 failed
expected failures: missing workflows and release/backup modules
```

Follow-up RED regressions proved release mode did not yet re-run source/workflow verification, env admission lacked an injected no-follow open boundary for a controlled lstat-to-open swap, and manifest/path hardening cases were not yet enforced. The deployment/Azure hardening slice was `5 passed, 3 failed` before the fixes. The backup collision/ancestry cases failed in their focused test before implementation.

Focused GREEN after implementation:

```sh
node --test tools/google-drive-backup.test.mjs tools/deployment-contract.test.mjs tools/azure-release.test.mjs tools/project-contract.test.mjs
```

```text
12/12 passed in 190.8 ms
```

The final backup-only rerun after adding explicit FIFO-special-file, offline CLI, normalized-manifest-collision, and manifest-cycle assertions was `4/4` in `182.9 ms`; its focused ESLint run and `git diff --check` also passed.

The complete portable focused set was:

```sh
node --test --test-concurrency=1 \
  tools/static-security.test.mjs tools/artifact-contract.test.mjs \
  tools/local-fixtures.test.mjs tools/deployment-contract.test.mjs \
  tools/azure-release.test.mjs tools/google-drive-backup.test.mjs
```

```text
23/23 passed in 1.11 seconds
```

`pnpm deployment:verify` passed source mode. Direct release mode in this worktree returned nonzero with empty stdout and the exact release-checkout-basename refusal.

## Full validation

All validation used Node `22.23.1`, pnpm `11.22.0`, local Functions Core Tools `4.13.0`, and Playwright `1.62.1` on macOS `26.6.2`. Every live Google/Drive/Azure/GitHub/local-bypass variable was explicitly unset.

`pnpm validate:ci` completed with exit `0`:

```text
lint/typecheck: PASS
deterministic API and web builds: PASS
artifact verifier: 13 web files, 3 API files
contracts: 14 passed
domain: 29 passed
web: 170 passed
API: 404 passed, 1 live Drive integration skipped
workspace total: 617 passed, 1 skipped
project contract: 2/2
portable focused contracts: 23/23
git diff --check: PASS
```

Fresh `pnpm validate:codex` completed with exit `0`:

```text
lint/typecheck/build/artifact gates: PASS
workspace total: 617 passed, 1 live Drive integration skipped
project contract: 2/2
static/artifact/release/backup/E2E-runner/lifecycle focused suite: 56/56 in 170.7 seconds
git diff --check: PASS
```

The fresh macOS command ran the real checkout-owned Task 14 Functions/SWA/Vite lifecycle tests and cleaned its stack. Task 16 did not rerun the unchanged Task 15 Chromium suite locally; both PR and production workflows require that browser gate through `pnpm validate:macos`, and deployment cannot start without it.

## Cleanup and boundaries

- `pnpm stop:codex`: `NXT local stack is already stopped.`
- Ports `4280`, `5173`, and `7071`: no listeners.
- `.nxt-local`: absent.
- Checkout-owned Vite, Functions, SWA, lifecycle-supervisor, E2E runner, and Playwright test processes: none. The process probe matched only its own inspection shell.
- `web/tsconfig.tsbuildinfo`: restored to the tracked baseline.
- Built artifacts remain ignored; no `.env.local`, secret, backup, or runtime state was staged.
- No root checkout, live `.env.local`, Drive/Google, GitHub, Azure, DNS, IHS, workflow, deployment, push, remote, or external service was accessed or mutated. Fake injected runners/adapters and disposable exact local repositories/filesystems were used only.
- No GitHub/Azure/Drive resource was created. The custom-domain/DNS/certificate stage was not started.

## Review fix round 1 closure

Implementation commit `440c832` (`fix: secure azure release settings`) closes the process-argument secret exposure, manual-dispatch ref gap, and environment-file identity race.

### Official interface evidence and security ruling

Installed official Azure CLI `2.89.1` help and source were inspected locally without an Azure request:

- `az staticwebapp appsettings set --help` exposes only `--setting-names KEY=value`; the installed command implementation parses those argv pairs and therefore cannot meet process-argument secrecy.
- `az rest --help` officially supports `--body @{file}`.
- The installed official `azure-mgmt-web` `2025-05-01` request builder defines `PUT /subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Web/staticSites/{name}/config/appsettings?api-version=2025-05-01` with a `StringDictionary` JSON body.

The earlier `staticwebapp appsettings set --setting-names` implementation is superseded for security. NXT now creates a mode-`0700` temporary directory, writes the closed `{properties:{...}}` body through an exclusive no-follow mode-`0600` file, passes only `@<canonical-path>` to official `az rest`, and unlinks the exact file/removes the exact directory after both success and failure. Fake-runner assertions prove neither sentinel secret appears in any argv, log, child diagnostic, nor thrown error.

The account check no longer trusts an invented subscription display name. It requires an enabled UUID subscription, UUID tenant, well-formed signed-in user, and exact SWA resource ID; that subscription ID is the one embedded in the exact ARM REST URL. Exact Free/West Europe/Succeeded/generated-host/zero-custom-hostname checks remain.

### RED → GREEN

Focused RED preceded production edits:

```sh
node --test tools/deployment-contract.test.mjs tools/azure-release.test.mjs
```

```text
1 passed, 6 failed
```

The failures were exact: the old display-name check rejected an otherwise valid account, settings still traveled in argv with no protected payload lifecycle, symlink-parent/regular-rename swaps were admitted, account/resource UUID binding was absent, the deploy job had no exact main-ref condition, and a tampered dispatch gate reached the later dirty check instead of failing source verification.

Focused GREEN:

```text
deployment + Azure: 7/7 passed in 148.5 ms
deployment + Azure + backup + project: 13/13 passed in 207.3 ms
portable focused contracts: 24/24 passed in 1.18 seconds
```

The environment reader now requires a canonical path, performs `O_NOFOLLOW` open, fstats the opened handle, and compares regular-file/mode/size/device/inode identity with the pre-open lstat. Tests cover a symlinked parent, a symlink swap, and an atomic regular-file rename whose sentinel never reaches an error.

The deployment job now has the exact `github.ref == 'refs/heads/main'` condition. Source and temporary exact-release repository tests reject any altered gate, so a non-main `workflow_dispatch` cannot deploy.

### Fresh full validation

Node `22.23.1`, pnpm `11.22.0`, live Google/Drive/Azure/GitHub/local-bypass keys unset:

```text
pnpm validate:ci: exit 0
workspace: 617 passed, 1 opt-in live Drive skip
project: 2/2
portable focused: 24/24
artifacts: 13 web, 3 API

pnpm validate:codex: exit 0
workspace: 617 passed, 1 opt-in live Drive skip
project: 2/2
full focused/lifecycle: 57/57 in 172.1 seconds
artifacts: 13 web, 3 API
git diff --check: PASS
```

`web/tsconfig.tsbuildinfo` was restored. Checkout-owned Stop reported already stopped; ports `4280`, `5173`, and `7071` were closed and `.nxt-local` absent. No live Azure/Google/GitHub/DNS/remote/deployment/push operation ran, and custom-domain work remains unstarted.
