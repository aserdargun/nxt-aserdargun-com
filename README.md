# NXT Markdown Vault

NXT is a small, private-first Markdown planning and notes application inspired by Obsidian. The web interface uses an Obsidian Gruvbox visual language, while the source repository remains public and every owner note, attachment, index, preference, and publication snapshot remains in two dedicated private Google Drive roots.

## Data and identity model

- Public GitHub source: `aserdargun/nxt-aserdargun-com`.
- Owner-visible Drive root: `NXT-ASERDARGUN-COM`.
- Private system/publication root: `NXT-PRIVATE-COM`.
- Web authentication: Azure Static Web Apps GitHub authentication plus an exact, server-side `aserdargun` owner check. The generic `authenticated` role alone is never sufficient.
- Anonymous publication: only immutable manifest-allowlisted snapshots under `/p/<publicId>`. The public route loads no owner session or private API.
- Azure target: `rg-nxt-aserdargun-com` / `swa-nxt-aserdargun-com`, West Europe, Free, generated `*.azurestaticapps.net` hostname.

The application currently requests Google's full Drive scope because it must create folders, update Markdown and bounded attachments, atomically maintain three private system JSON files, move owner-approved content to Trash, and create/revoke public snapshots. Risk is limited by exact-owner OAuth, two dedicated roots, stored-ID/root-boundary checks, no sharing mutation, read-back verification, bounded operations, and redaction-safe tools. See [Security](docs/SECURITY.md) for the complete rationale.

## Prerequisites

- Node.js `22.x` and Corepack.
- pnpm `11.22.0`.
- macOS for the real local Functions lifecycle. Task 14 uses a host-local child sandbox because installed Core Tools `4.13.0` binds Functions broadly on macOS; do not weaken that profile.
- Azure Functions Core Tools exactly `4.13.0`.
- Chromium installed through Playwright for browser acceptance.
- For live Drive authorization only: a Google Cloud OAuth client of type **Desktop app**, Drive API enabled, and the intended owner Google account.

Install the locked workspace:

```sh
corepack enable
corepack prepare pnpm@11.22.0 --activate
pnpm install --frozen-lockfile
node scripts/local-dev.mjs --check
```

CI installs Core Tools deterministically with:

```sh
npm install --global azure-functions-core-tools@4.13.0
test "$(func --version)" = "4.13.0"
```

The exact package contains its own shrinkwrap and downloads the version/build-specific official binary. Floating `@4` and floating Homebrew installation are not used.

## Local Setup, Run, Validate, Stop

Run the normal checkout-owned stack:

```sh
pnpm dev:codex
```

Use the seeded, deterministic filesystem simulator for local owner/public testing without Drive or GitHub OAuth:

```sh
pnpm dev:codex -- --e2e
```

Both modes serve the SWA proxy at `http://127.0.0.1:4280`. Local authentication bypass exists only inside the Development Functions child. It is never written to disk or passed to Vite/SWA/build children. Test fixtures exist only at the canonical ignored checkout child `.nxt-local/fixtures/playwright`.

Run repository validation on macOS:

```sh
pnpm validate:codex
```

Run the portable Ubuntu-compatible gate:

```sh
pnpm validate:ci
```

Run the complete real lifecycle and Chromium gate:

```sh
pnpm validate:macos
```

Stop only the exact checkout-owned stack:

```sh
pnpm stop:codex
```

Stop validates the atomic control record, full process identity, process group, descendants, cwd, executable, command, nonce, and listener ownership. It never kills by port and refuses stale or foreign processes.

## Google Desktop OAuth and Drive provisioning

The ignored credential file is `.env.local`. It must be a canonical regular non-symlink file with mode `0600`:

```sh
chmod 600 .env.local
```

Never commit the downloaded OAuth client JSON or `.env.local`. The OAuth client must be a Google **Desktop app**. Authorization uses a temporary exact `127.0.0.1` high-port callback, PKCE, state verification, and full Drive scope:

```sh
node scripts/google-drive-authorize.mjs --client-config /absolute/path/to/google-oauth-client.json
node scripts/google-drive-provision.mjs
```

The provisioning command verifies the exact owner and creates or reuses only the approved two-root layout without changing sharing permissions.

For a personal Gmail account, an External OAuth consent screen left in **Testing** generally produces a refresh token limited to seven days. Before stable publication, move the consent configuration to Production/published status and reauthorize, or use an eligible Google Workspace Internal consent configuration. Treat a Testing token as temporary development access, not a durable production credential.

## Drive backup, offline verification, and recovery

Inventory is read-only. It walks both verified roots with bounded pages, operations, depth, entries, and bytes. Markdown and the three approved system JSON files are exported by default. Other binaries are metadata-only unless explicitly requested. Google-native documents are never exported implicitly.

Choose a new directory that does not already exist:

```sh
BACKUP_PARENT="$(mktemp -d)"
node scripts/google-drive-backup.mjs inventory --output "$BACKUP_PARENT/nxt-drive-inventory"
node scripts/google-drive-backup.mjs verify --output "$BACKUP_PARENT/nxt-drive-inventory"
```

To include bounded binary attachments:

```sh
node scripts/google-drive-backup.mjs inventory --output "$BACKUP_PARENT/nxt-drive-with-binaries" --include-binaries
node scripts/google-drive-backup.mjs verify --output "$BACKUP_PARENT/nxt-drive-with-binaries"
```

Inventory requires `.env.local`; offline verify does not load OAuth or contact Drive. The created directory is mode `0700`; `manifest.json` and exported files are mode `0600`. Names are retained only in the protected manifest, while exported filenames are ID-derived hashes. Separator, traversal, normalization, case-fold, duplicate, cycle, parent, checksum, and no-follow failures are refused. A failed new inventory retains an explicit `.incomplete` marker and never overwrites a prior backup.

Recovery is intentionally conservative and not automated by this read-only tool:

1. Stop NXT with `pnpm stop:codex`.
2. Run offline `verify` and retain the verified manifest as incident evidence.
3. Confirm the exact owner account and both root IDs.
4. Restore only the intended Markdown/system file/attachment through a separately reviewed Drive operation, preserving the manifest's ID, parent, version, MIME, size, and checksum evidence.
5. Re-run provisioning health, Drive integration, application rescan, and a new inventory/verify pair before reopening writes.

Never bulk-copy an unverified directory into Drive and never use this inventory tool as a Drive writer.

## CI and Azure Free release

Task 16 creates only local source files. It does **not** create a GitHub repository, Azure resource, Actions secret, Drive resource, DNS record, workflow run, deployment, or custom domain.

PR validation lives in `.github/workflows/ci.yml`. Production deployment lives only in:

```text
.github/workflows/deploy-swa-nxt-aserdargun-com.yml
```

Both workflows use immutable action SHAs. Portable validation runs on Ubuntu. A separate macOS job installs exact Core Tools `4.13.0`, installs Chromium, and runs the real sandboxed lifecycle/browser gate. Deployment is main-only, serialized, waits for both jobs, repeats portable artifact validation, and uploads only verified prebuilt `web/dist` plus `api-dist` with both Azure builds skipped.

Pure source verification is safe in this intentionally named worktree:

```sh
pnpm deployment:verify
```

Release identity is stricter and intentionally fails here. It requires a clean checkout whose basename is exactly `nxt-aserdargun-com`, branch `main`, exact origin `aserdargun/nxt-aserdargun-com`, and the exact source/workflow mapping:

```sh
node scripts/verify-deployment-contract.mjs release
```

Installing production app settings is a manual action-time operation only. The environment file must contain only the 15 production runtime keys accepted by the release tool, use mode `0600`, and contain no local/test key:

```sh
node scripts/azure-static-web-app-release.mjs apply --env-file .env.local
```

The command first repeats release identity, authenticated subscription, exact Free resource, Ready/Succeeded provisioning, West Europe, generated hostname, and zero-custom-hostname checks. It sends settings with `--only-show-errors --output none` and prints only sorted key names. There is no basename bypass, `--force`, OIDC, or automatic workflow settings mutation.

Live Task 17/18 operations require a fresh display of exact Google/GitHub/Azure targets and explicit action-time authorization. Local plan approval is not permission to authorize Drive, create a public repository, push, create Azure resources, install secrets/settings, dispatch a workflow, or deploy.

## Secret rotation and incidents

- Google client secret/refresh token: revoke the prior grant, reauthorize the Desktop app, validate exact owner/root health, update the manual Azure settings set, and inventory again.
- Azure deployment token: rotate it in Azure and update only `AZURE_STATIC_WEB_APPS_API_TOKEN_SWA_NXT_ASERDARGUN_COM`; never print or store it locally.
- Suspected Drive compromise: stop the app, revoke OAuth, preserve and offline-verify the last inventory, inspect sharing/root ancestry, rotate credentials, then reconcile data deliberately.
- Suspected publication leak: revoke the publication, verify the private manifest and snapshot attachment allowlist, rotate affected credentials, and retain hashes/log timestamps.

## Hard custom-domain boundary

**STOP after the Azure-generated `*.azurestaticapps.net` hostname is verified.** Do not create or change Azure custom domains, DNS, IHS/e-destek records, `_dnsauth` TXT, CNAME/A/AAAA/ALIAS records, nameservers, certificates, mail, apex, or `www` under Task 16. Custom-domain work requires the separate domain workflow, fresh exact targets, and a new action-time confirmation.

See [Architecture](docs/ARCHITECTURE.md) and [Security](docs/SECURITY.md).
