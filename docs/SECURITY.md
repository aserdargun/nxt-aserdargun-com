# NXT Security Model

## Assets and trust boundaries

Protected assets include Markdown, attachments, preferences, vault index, publication manifest/snapshots, Google OAuth values, Drive IDs, the Azure deployment token, application settings, and checkout lifecycle ownership state.

Trust boundaries are:

- anonymous browser to the public snapshot API;
- authenticated SWA principal to the exact-owner API;
- Functions to Google Drive;
- local operator to ignored mode-`0600` credentials;
- GitHub Actions to the prebuilt Azure upload token;
- backup adapter to a new protected offline directory.

## GitHub exact-owner defense

Azure's `authenticated` role only proves that some provider identity signed in. Private handlers also parse the SWA principal, require GitHub provider semantics, validate the closed identity shape, and compare the normalized username with exact configured owner `aserdargun`. Malformed, missing in production, wrong-provider, and wrong-owner principals fail closed.

The local bypass is not an alternative production identity. It is accepted only when the principal header is absent, the Functions process is Development, and the launcher supplies exact local fixture/control/attestation evidence. A supplied principal always follows normal owner verification. Build, Vite, and SWA children never receive the bypass.

## Google OAuth and full Drive scope

NXT currently requires `https://www.googleapis.com/auth/drive` to support owner-approved create/update/move-to-Trash operations and private system/publication state. A narrower file-picker-only scope cannot maintain the selected dedicated hierarchy and recover existing files after reauthorization.

Mitigations:

- Desktop-app OAuth only; no web client secret embedded in the browser.
- Exact `127.0.0.1` high-port callback, PKCE, state, callback host/path, and owner-email verification.
- Two dedicated exact roots and stored-ID/root ancestry checks on every operation.
- No sharing/permission mutation path.
- Bounded pagination, calls, bytes, entries, confirmations, and optimistic version checks.
- Three validated private system files rather than broad Drive discovery.
- Read-back metadata/checksum verification after mutations.
- Redaction-safe CLI output and ignored mode-`0600` local credentials.

Drive v3 remains the primary metadata, media-read, list, create, and revision API. Because Drive v3 removed the resource `etag`, conditional mutations first bind the exact v2 `id,etag,version` resource token to a matching v3 metadata snapshot. Content writes use a v2 `files.update` media request; rename, move, and Trash mutations use v2 `files.patch`. Every mutation sends `If-Match`, disables automatic write retries, maps `412` to a version conflict, and waits for a stable post-write version before validating ancestry, MIME, active state, and checksum. This compatibility bridge is limited to the same official Drive service and does not weaken the configured root boundary.

An External Google consent screen left in Testing can limit a Drive-scope refresh token to seven days. Durable publication requires an eligible Internal consent configuration or External consent moved to Production/published status before a new refresh token is issued. Token status is an operator release gate.

## Secrets and release settings

`.env.local` must be a canonical regular non-symlink mode-`0600` file and is ignored by Git. After a no-follow open, the tool checks the opened file is still regular and has the same device, inode, mode, and size observed before open; symlinked parents and atomic replacement fail closed. The manual Azure release tool accepts the closed production key set plus exactly two validated operator-only inputs, `NXT_ALLOWED_GOOGLE_EMAIL` and `NXT_INTEGRATION_TEST_DRIVE_FOLDER_ID`; those two are never copied to Azure. It rejects duplicates, every other unknown/local/test key, controls, empty or oversized values, repeats exact release identity, and binds a valid enabled subscription UUID/tenant/user to the exact Free SWA resource ID with zero custom hostnames. Subscription display names are not security identities.

The official `az staticwebapp appsettings set` command requires `KEY=value` arguments and is therefore not used. NXT creates a mode-`0700` private temporary directory, retains its no-follow device/inode-bound handle, writes the exact REST `{properties:{...}}` body through an exclusive no-follow mode-`0600` file whose exact handle is also retained, and invokes `az rest` with only the exact ARM URL and `@<file>` reference in argv. Normal return-path cleanup first fstats, truncates to zero, syncs, re-fstats, and closes the exact payload handle. It then uses the retained directory handle to repair only exact-owned permissions, revalidates each pathname identity, and makes at most one unlink plus one empty-directory removal attempt. Destructive pathname operations are never retried. A foreign/mismatched entry is never recursively removed; incomplete cleanup fails closed and is composed with, rather than masking, the primary Azure mutation failure. The subprocess also uses `--only-show-errors --output none`; child diagnostics are discarded on failure, and only state plus sorted key names are reported. It has no `--force`, worktree-basename bypass, or environment-controlled test mode. Tests inject a fake runner, inspect the protected payload only while the call is active, and prove sentinel values never enter argv, logs, or errors.

POSIX `unlink` and `rmdir` remain name-based; `unlinkat` is also name-based and cannot atomically require an expected inode. Tests prove deterministic replacements completed before cleanup are preserved and the retained original secret inode is zeroed, but an actively hostile same-UID process can still race the final pathname check and syscall—and can already read or replace `.env.local`. SIGKILL or host failure can occur before truncation as well. An interrupted release or generic cleanup-incomplete error is therefore a local secret incident; inspect without printing payload contents and remove only an independently verified exact leftover directory before retrying.

The deployment workflow reads only `AZURE_STATIC_WEB_APPS_API_TOKEN_SWA_NXT_ASERDARGUN_COM`. GitHub permissions are `contents: read`; no OIDC/id-token permission or `github_id_token` input exists. Deployment is serialized with cancellation disabled, cannot start until both portable and real macOS acceptance jobs pass, and independently refuses any ref other than `refs/heads/main`, including manual dispatches.

## CSP, attachments, and public snapshots

Static Web Apps configuration enforces a self-first CSP, no objects, no framing, no base/form escape, no referrer, restricted browser permissions, and MIME sniffing prevention. Attachments are size/name/MIME/signature checked. Structurally proven PNG/JPEG/GIF may render inline; WebP/PDF are conservatively downloaded according to policy; active or unsupported content is forced to safe download or rejected.

Publishing copies an immutable source snapshot and only referenced, verified attachments into the private publication area. The anonymous API resolves an opaque public ID through the allowlisted manifest, returns generic redacted not-found responses, and never exposes owner/Drive/snapshot identifiers. Revocation removes manifest reachability. The public route imports no owner shell and sends no private/session request.

## Backup and recovery safety

Drive inventory is read-only. It refuses missing/duplicate/overlapping roots, Google-native exports, malformed metadata, ancestry ambiguity, pagination cycles, duplicate/cyclic IDs, unsafe/ambiguous normalized paths, unknown checksums, and size/operation bounds. Export filenames are SHA-256 hashes of Drive IDs, so a Drive name cannot traverse or overwrite the operator destination. Original paths remain only inside the protected manifest.

Creation requires a new canonical destination and never overwrites prior backups. Partial creation retains an explicit incomplete marker. Offline verification uses lstat plus `O_NOFOLLOW`, validates mode/schema/root/parent/path/count invariants, rejects symlink/special/extra/missing files, and verifies Drive MD5 plus local SHA-256 evidence. Metadata-only records must have no exported file.

The backup tool has no Drive create/update/delete/trash/share method. Restoration is a separately authorized, reviewed operation after offline verification and exact owner/root confirmation.

## Rotation

- Google OAuth: revoke the old grant, rotate client secret if necessary, authorize the exact Desktop client and owner again, prove both roots/system files, update Azure manually, and create a new verified inventory.
- Azure deployment token: rotate in the exact SWA, update only the exact GitHub Actions secret, then correlate a new main workflow run with the generated host.
- GitHub identity: stop private access before changing the configured exact owner; review SWA provider claims and callbacks before restoring.
- Public snapshot incident: revoke the manifest entry, preserve hashes/timestamps, inspect referenced assets, rotate affected credentials, and republish only from a verified saved source.

## Incident recovery

1. Stop the checkout-owned stack or disable the production application path as appropriate.
2. Revoke affected OAuth/deployment credentials without printing them.
3. Preserve the last mode-protected inventory and run offline verification.
4. Inspect exact Drive roots, ownership, ancestry, sharing, system-file schemas, publication manifest, and Azure hostname/settings state.
5. Restore deliberately from verified evidence; never perform an unreviewed bulk overwrite.
6. Re-run unit/static/lifecycle/browser gates, Drive health/integration, generated-host HTTP/MIME/auth checks, and a new backup verification.
7. Record rotated key names, timestamps, and outcomes—not secret values.

## Explicit non-goals and stop boundary

Task 16 does not access or mutate live Drive, GitHub, Azure, DNS, remotes, workflows, secrets, or deployments. Task 17/18 require fresh exact target display and action-time authorization.

Custom domains are out of scope. Stop before Azure custom hostname, `_dnsauth` TXT, CNAME/A/AAAA/ALIAS, IHS/e-destek, certificate, nameserver, apex, `www`, or mail changes. Those actions require the separate domain workflow and a new confirmation at mutation time.
