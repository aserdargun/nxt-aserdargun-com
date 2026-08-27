# NXT Architecture

## System boundary

NXT separates public executable source from private owner content:

```text
Browser
  -> Azure Static Web Apps GitHub authentication
  -> Vite React owner shell or isolated anonymous /p/:publicId route
  -> Azure Functions Node 22 handlers
  -> exact-owner service boundary
  -> GoogleDriveAdapter
  -> NXT-ASERDARGUN-COM + NXT-PRIVATE-COM
```

The public repository contains TypeScript, static configuration, tests, workflows, and deterministic build inputs. It contains no note, Drive ID, OAuth credential, production setting value, deployment token, or backup.

## Workspace layers

- `packages/contracts`: closed request/response and persisted-schema validation.
- `packages/domain`: Markdown parsing/rendering, indexing, attachment references, and pure domain rules.
- `api`: Functions handlers, exact-owner authorization, Drive boundary/storage services, publication snapshots, and recovery logic.
- `web`: route-split React application, owner editor/explorer/search, anonymous public-note page, Gruvbox presentation, and accessibility behavior.
- `scripts`: deterministic artifacts, checkout-owned lifecycle, OAuth/provisioning, deployment contracts, Azure settings, and read-only backup.
- `tools` and `e2e`: unit/integration contracts and real Chromium acceptance.

## Drive layout

```text
NXT-ASERDARGUN-COM
  Notes
    Inbox
    Plans
    Archive
  _assets

NXT-PRIVATE-COM
  published
  integration-tests
  vault-index.json
  preferences.json
  publication-manifest.json
```

Application operations are constrained to configured IDs below these roots. The owner-visible root contains portable Markdown and attachments. The private root contains derived state, bounded test fixtures, and publication snapshots. Publication manifests expose only opaque public IDs and allowlisted snapshot assets.

The storage client uses Drive v3 for normal reads, creates, listings, and revision history. Conditional mutations bridge to Drive v2 only to obtain and enforce the resource ETag that v3 no longer exposes: the v2 token must match a v3 version snapshot, media changes use conditional `files.update`, metadata-only changes use conditional `files.patch`, and every write is followed by stable-version and checksum/ancestry verification.

## Local composition

Task 14 owns the local lifecycle:

- Vite: literal `127.0.0.1:5173`.
- SWA CLI: literal `127.0.0.1:4280`.
- Functions: Core Tools `4.13.0` under the approved macOS host-local inbound sandbox.
- Atomic `.nxt-local/control.json`: checkout, nonce, full service identities, listeners, logs, gates, and state.
- Exact Stop: full-identity and descendant/group revalidation with no kill-by-port.

`--e2e` adds an exact canonical filesystem adapter below `.nxt-local/fixtures/playwright`. Local mode requires Development, the child-only auth bypass, random control nonce, exact ready Functions identity/attestation, and direct worker-parent topology. Production always defaults to Google.

## Build and release flow

`scripts/build-api.mjs` emits deterministic `api-dist`. Vite emits `web/dist`. `scripts/verify-artifacts.mjs` rejects extra/symlink/secret-bearing artifacts and validates the exact expected trees.

CI is split deliberately:

1. Ubuntu portable job: locked install, lint, typecheck, deterministic builds, artifact verification, unit/project/static/deployment/release/backup tests.
2. macOS acceptance job: exact official Core Tools `4.13.0`, Chromium, Task 14 sandbox lifecycle, and Task 15 real browser journeys.
3. Main deployment job: waits for both jobs, repeats portable artifact validation, independently checks the exact main ref even for manual dispatch, and uploads the two prebuilt artifacts with the Azure build disabled.

`.github/workflows/deploy-swa-nxt-aserdargun-com.yml` is the only authoritative Azure workflow. It targets the secret name and concurrency group derived from `nxt-aserdargun-com`.

Source verification intentionally works in the implementation worktree. Release verification additionally requires the clean exact repository checkout, exact `main`, exact origin, and exact workflow/resource/secret mapping. Azure settings installation is separate from deployment and action-time only. It binds the exact ARM resource ID to the validated subscription UUID and sends the closed settings dictionary through an official `az rest --body @file` mode-`0600` temporary payload rather than exposing values in process arguments. The payload lifecycle retains no-follow handles for the exact directory and file, truncates and syncs the exact file inode before path cleanup, revalidates device/inode identities, makes only one unlink/rmdir attempt, never recursively deletes foreign entries, and fails closed when cleanup is incomplete. POSIX pathname deletion cannot be inode-bound, so active same-UID syscall racing remains outside the quiescent normal-return guarantee.

## Backup format

Inventory creates one new mode-`0700` directory and immediately writes a mode-`0600` incomplete marker. It verifies both roots, performs a bounded breadth-first walk, refuses ancestry/duplicate/cycle/pagination/size ambiguity, and writes exports below:

```text
files/<vault|private>/<sha256-drive-id>.bin
```

The mode-`0600` schema-versioned manifest retains protected original names/relative paths and exact Drive metadata: root label, Drive ID, parent ID, MIME, size, version, modified time, Drive checksum, and local SHA-256. Normalized case-fold path collisions and unsafe segments are refused even though hashed export paths cannot overwrite each other.

Offline verification uses no-follow opens, validates the closed schema and root/parent graph, rejects cycles and extra/missing/symlink/special files, and re-hashes every export. It performs no Google request and requires no OAuth.

## External operation boundaries

Task 16 stops at local source, fake clients/runners, synthetic secrets, and ignored temporary filesystem fixtures. Task 17 owns authorized Drive creation/verification. Task 18 owns authorized GitHub/Azure creation and generated-host publication. Custom domain, DNS, IHS, and certificate work remains a separate later task.
