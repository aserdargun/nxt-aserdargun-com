### Task 16: Add CI, artifact deployment, recovery tooling, and operator documentation

**Planned files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/deploy-swa-nxt-aserdargun-com.yml`
- Create: `scripts/verify-deployment-contract.mjs`
- Create: `scripts/azure-static-web-app-release.mjs`
- Create: `scripts/google-drive-backup.mjs`
- Create: `tools/deployment-contract.test.mjs`
- Create: `tools/azure-release.test.mjs`
- Create: `tools/google-drive-backup.test.mjs`
- Create: `README.md`
- Create: `docs/ARCHITECTURE.md`
- Create: `docs/SECURITY.md`
- Modify: `package.json`
- Modify only if exact tests require it: `pnpm-lock.yaml`, `.gitignore`, and existing project/static contract tests

**Interfaces:**
- Consumes: deterministic Task 14 artifacts, Task 15 local acceptance, exact `nxt` deployment identity, Google OAuth/provisioning clients, and an ignored mode-0600 `.env.local`.
- Produces: immutable-action PR CI, main-only prebuilt Free-SWA deployment, redaction-safe settings installation, two-root Drive inventory/verification, and complete operator documentation.

## Frozen acceptance contract

- Begin with focused RED contract tests for all missing workflow, Azure release, and backup artifacts. Do not access GitHub, Azure, Google Drive, DNS, remotes, or `.env.local` during Task 16 implementation/validation; tests use injected fake CLIs/clients and synthetic secrets.
- The deploy workflow filename is exactly `.github/workflows/deploy-swa-nxt-aserdargun-com.yml`, not the generic `deploy.yml`. Its display name and concurrency identify `swa-nxt-aserdargun-com`; later Task 18 must dispatch this exact file. Create no shadow/duplicate deployment workflow.
- Use the immutable action SHAs approved in the plan: `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1`, `actions/setup-node@820762786026740c76f36085b0efc47a31fe5020`, and `Azure/static-web-apps-deploy@4d27395796ac319302594769cfe812bd207490b1`. Every `uses:` entry is SHA-pinned; no floating tag, local action, OIDC, `id-token`, `github_id_token`, or third-party action.
- PR CI triggers only `pull_request` and `workflow_dispatch`; deployment triggers only `push` to `main` and `workflow_dispatch`. Both have `permissions: contents: read`. Deployment concurrency is exact group `swa-nxt-aserdargun-com-production`, `cancel-in-progress: false`.
- Portable validation runs on `ubuntu-latest`: Node 22, Corepack, exact pnpm 11.22.0, frozen install, deterministic lint/typecheck/build/artifact/unit/project/static/release/backup contract tests. `validate:ci` must not silently skip a portable gate and must not invoke the macOS-only Task 14 sandbox lifecycle.
- Real Chromium/Functions acceptance remains mandatory in PR and production workflows. Add a separate macOS job, using only official package tooling/commands, that obtains Functions Core Tools v4, installs Chromium, runs the exact Node 22 local lifecycle/Playwright gates, and leaves no ports/state. The Linux deploy job must `needs` both portable validation and macOS acceptance. If a deterministic Core Tools install cannot be specified without a floating dependency, stop and report the blocker before weakening/removing acceptance.
- The deploy job repeats portable artifact validation and deploys only verified prebuilt `web/dist` and `api-dist`. Azure action inputs are exact: token secret `AZURE_STATIC_WEB_APPS_API_TOKEN_SWA_NXT_ASERDARGUN_COM`, `action: upload`, `app_location: web/dist`, `api_location: api-dist`, empty `output_location`, `skip_app_build: true`, `skip_api_build: true`. No workflow step may build inside the Azure deploy action or install runtime settings automatically.
- `verify-deployment-contract.mjs` has a pure source/workflow verification mode usable in this intentionally named worktree, and a release-identity mode that requires a clean exact checkout basename/repository `nxt-aserdargun-com`, exact `aserdargun/nxt-aserdargun-com` origin, `main`, and the exact resource/workflow/secret mapping. The current `codex-nxt-markdown-vault` worktree must fail release identity rather than becoming a cloud identity. Tests use temporary exact/foreign repositories; validation never mutates remotes.
- `azure-static-web-app-release.mjs apply --env-file .env.local` is manual/action-time only. It reads a canonical regular non-symlink mode-0600 env file, accepts a closed exact key set, rejects duplicates/unknown/missing/control-containing/oversized values, and never prints values. It requires exact owner `aserdargun`, every Google credential and production Drive folder/file ID used by the API, and no local/test variables.
- Before settings mutation, the Azure release tool checks authenticated `az account show`, exact resource group `rg-nxt-aserdargun-com`, exact SWA `swa-nxt-aserdargun-com`, SKU `Free`, Ready/valid resource identity, and zero custom hostnames. It invokes `az staticwebapp appsettings set` only with `--only-show-errors --output none`, captures/redacts child output on failure, and prints only sorted key names plus a success/failure state. Tests inject a fake executable/runner through exported functions, not caller-controlled production environment overrides, and prove every sentinel secret is absent from stdout/stderr/errors.
- Azure release apply must re-run release-identity verification and refuse this implementation worktree. Unit tests may inject an already verified identity object; no hidden `--force`, basename bypass, or test environment switch in the CLI.
- `google-drive-backup.mjs inventory --output <new-directory> [--include-binaries]` requires both verified roots (`NXT_VAULT_DRIVE_FOLDER_ID`, `NXT_PRIVATE_DRIVE_FOLDER_ID`) and walks each with bounded pagination/cycle/duplicate/operation/size limits. It records root label, safe relative path, Drive ID, parent ID, MIME, size, version, modified time, and checksum in a schema-versioned mode-0600 `manifest.json` inside a new canonical mode-0700 directory.
- Inventory downloads Markdown and approved system JSON by default; arbitrary binaries are metadata-only unless `--include-binaries` is explicit and still bounded. Never export Google-native documents implicitly. Encode/sanitize filesystem names so Drive traversal, separator, normalization, case-fold, or duplicate collisions cannot escape or overwrite; retain the original relative path only inside the protected manifest.
- Backup creation refuses existing/symlink/foreign output, missing/overlapping/duplicate roots, ancestry ambiguity, malformed metadata, unsupported MIME, unbounded pages, unknown download checksum, and partial-success claims. On failure, leave an explicit incomplete marker or remove only the exact newly owned output; never overwrite a prior backup. Tests cover two roots, pagination, duplicate/cycle/traversal/collision, text download, binary opt-in, size bounds, and no secret/output leakage.
- `google-drive-backup.mjs verify --output <directory>` is offline: it opens manifest/files with no-follow semantics, validates the closed schema and both distinct roots, rejects extra/missing/symlink/special files, re-hashes every exported file, verifies metadata-only records have no file, and prints only counts/root labels. It never contacts Drive or requires OAuth.
- Reuse the repository's Google client/OAuth helpers only through an injected bounded backup adapter. Do not add Drive write/delete/update permission paths to the backup tool; inventory is read-only even though the existing OAuth scope is full Drive for the application.
- `README.md`, `docs/ARCHITECTURE.md`, and `docs/SECURITY.md` must accurately document: public source/private Drive content model; exact-owner GitHub defense; why full Drive scope is currently required and mitigated by two dedicated roots; Desktop-app loopback OAuth; External-consent Testing seven-day refresh-token limitation and Production/publishing choice; `.env.local` 0600; Setup/Run/Validate/Stop; local test fixtures; Drive authorization/provisioning/backup/verify/recovery; Azure Free generated-host release; secret rotation; CSP/attachments/public snapshots; incident recovery; and a hard stop before any custom-domain/DNS/IHS/certificate work.
- Documentation commands must match executable scripts and exact workflow filename. State that Task 16 creates no cloud/repository resource and that live Task 17/18 commands require fresh target display plus action-time authorization.
- Extend `validate:codex` and `validate:ci` deliberately. `validate:codex` retains all existing macOS lifecycle gates and includes new source/release/backup tests; `validate:ci` is portable and is paired with the separate macOS acceptance job. Neither may run a live backup, Azure apply, deployment, OAuth, GitHub mutation, or external request during validation.
- Validate focused RED/GREEN, workflow YAML/source contracts, secret sentinel redaction, backup filesystem safety, `pnpm validate:codex`, `pnpm validate:ci` locally where platform-compatible, exact `git diff --check`, tracked artifact parity, restored `web/tsconfig.tsbuildinfo`, and checkout-owned port/process/state cleanup.
- Commit implementation as `chore: add nxt validation and release contracts`; commit the forced-added Task 16 report/progress separately. Return a clean worktree. Record exact test counts, skips, platform-specific gates, workflow filenames, and state explicitly: no GitHub/Azure/Drive/DNS/deployment/push/remote mutation; custom domain not started.

## Review priorities

- No secret value can appear in command output, exception text, fake-CLI diagnostics, manifest logs, workflow interpolation outside GitHub secrets, or committed artifacts.
- Release identity fails closed in the current worktree and cannot target a similarly named repo/resource.
- CI never claims browser/lifecycle coverage it did not run; deployment cannot begin before both portable and real macOS acceptance jobs succeed.
- Backup path/collision handling and failure cleanup cannot overwrite or escape an operator-selected destination.
- Workflows deploy only prebuilt verified artifacts and cannot request broader GitHub/Azure permissions.
