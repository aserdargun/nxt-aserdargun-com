# NXT Markdown Vault Design

**Status:** Approved in chat on 2026-08-23

## 1. Summary

NXT is a private-first, Obsidian-inspired Markdown notes and planning web
application. Its source code is public, its authenticated workspace is limited
to the exact GitHub owner `aserdargun`, and Google Drive is the canonical store
for Markdown files, attachments, indexes, preferences, and publication
snapshots. The application runs on Azure Static Web Apps Free with managed
HTTP-triggered Azure Functions and no paid database or storage dependency.

Notes are private by default. The owner can publish a frozen copy at an
unguessable, unlisted URL and revoke that URL later. Publishing never changes
the sharing permission of the original Drive file.

## 2. Goals

- Write, render, organize, search, link, archive, and share Markdown notes.
- Provide full-featured desktop and mobile editing rather than a mobile
  read-only companion.
- Preserve Markdown portability and ordinary Drive file visibility.
- Support files added or edited directly in the configured
  `NXT-ASERDARGUN-COM` Drive folder.
- Keep the source repository public without exposing notes, OAuth credentials,
  Drive identifiers that grant access, unpublished metadata, or drafts.
- Keep all application features within Azure Static Web Apps Free and standard
  Google Drive API usage.
- Reproduce the visual character of the MIT-licensed Obsidian Gruvbox theme in
  an accessible responsive web interface, retaining source attribution.

## 3. Non-goals

- Obsidian plugin compatibility or an extension marketplace.
- Canvas, graph visualization, collaborative editing, comments, or multi-user
  permissions.
- Full offline synchronization. Offline behavior is limited to retaining a
  recoverable local draft until Drive is reachable again.
- Server-side WebSockets, background triggers, Durable Functions, or a separate
  bring-your-own Azure Functions resource.
- A searchable public note directory or search-engine-indexed public content.
- Rendering active HTML, SVG, JavaScript, or executable attachments.
- Custom-domain, DNS, certificate, or IHS changes as part of implementation.

## 4. Product identity

The assigned product code is `nxt`, the repository name is
`nxt-aserdargun-com`, and the product name is **NXT Markdown Vault**. “NXT”
means “Next”: a durable personal workspace that can grow beyond the first note
editor without naming the product after one storage provider or feature.

### Naming scorecard

| Criterion | Score | Weighted |
|---|---:|---:|
| Mnemonic meaning | 4/5 | 20/25 |
| Scope durability | 5/5 | 20/20 |
| Technical expectation safety | 5/5 | 15/15 |
| Brand strength | 5/5 | 15/15 |
| Expansion capacity | 5/5 | 15/15 |
| Collision safety | 5/5 | 10/10 |
| **Total** |  | **95/100** |

Alternatives considered were `pkm` (Personal Knowledge Management, 91/100;
precise but category-like), `vlt` (Vault, 90/100; memorable but tied to the
storage metaphor), and `nts` (Notes, 82/100; clear but too feature-specific).
Avoid `obs` because it ties the product to Obsidian and creates brand ambiguity;
avoid `mem` because its established software-memory meaning creates a misleading
technical expectation.

The compared assigned code set is `aia`, `llm`, `stk`, `usl`, `gpu`, `inf`, and
`nxt`. `nxt` is assigned to this checkout. A live read-only GitHub check on
2026-08-23 found no repository at `aserdargun/nxt-aserdargun-com`; the repository
has not been created. DNS availability was not checked because custom-domain
work is outside this design.

## 5. Architecture

```text
Browser
 ├─ React/Vite/TypeScript application
 ├─ CodeMirror Markdown editor
 ├─ Gruvbox design tokens
 └─ IndexedDB draft recovery
          │
          ▼
Azure Static Web Apps Free
 ├─ Static application and public note routes
 ├─ Preconfigured GitHub authentication
 └─ Managed HTTP Azure Functions
      ├─ owner authentication
      ├─ vault and search
      ├─ attachment handling
      └─ snapshot publishing
          │
          ▼
Two verified Google Drive roots
 ├─ NXT-ASERDARGUN-COM (owner-visible vault)
 └─ NXT-PRIVATE-COM (app-managed private data)
```

The frontend never receives Google OAuth credentials and never accesses private
Drive content directly. Managed Functions are the only Drive client. There is
no database and no durable server-local state.

The codebase will keep boundaries explicit:

- `auth` parses the Azure client principal and enforces the exact owner.
- `domain` owns note metadata, links, tags, publication rules, and errors.
- `markdown` parses frontmatter, resolves wiki links, renders safe HTML, and
  derives searchable text.
- `storage` defines a storage interface with local and Google Drive adapters.
- `vault` coordinates note, folder, index, favorite, and attachment operations.
- `publishing` creates immutable snapshots and exposes only manifest-approved
  public resources.
- `web` owns responsive presentation and communicates only through typed API
  contracts.

## 6. Drive authorization and provisioning

NXT deliberately requests `https://www.googleapis.com/auth/drive`, not
`drive.file`. The broader scope is required because the owner can place existing
or new Markdown files and attachments into the vault directly through Google
Drive. `drive.file` cannot reliably discover content created outside the app.

The OAuth scope is broad, so every storage operation must enforce a narrower
application boundary:

- The owner-visible root is named exactly `NXT-ASERDARGUN-COM`. The sibling
  app-managed root is named exactly `NXT-PRIVATE-COM`. Both are selected or
  created during a one-time local provisioning flow beneath the same verified
  Google account.
- Provisioning uses a Google OAuth **Desktop app** client, a loopback-only OAuth
  callback on `127.0.0.1`, PKCE, a validated `state` value, offline access, and
  exact Google account readback. The expected owner email is entered as
  `NXT_ALLOWED_GOOGLE_EMAIL` before authorization; a different Google account
  fails the flow before folder discovery or creation. A Web application client
  is not used for the variable-port loopback flow.
- Before durable deployment, the operator verifies the OAuth consent
  configuration. An External consent screen left in `Testing` issues a refresh
  token that expires after seven days for this Drive scope, so stable personal
  use requires an appropriate non-Testing configuration (or an Internal
  Workspace configuration) before the final refresh token is issued.
- The client ID, client secret, resulting refresh token,
  `NXT_ALLOWED_GOOGLE_EMAIL`, verified folder IDs, and verified system-file IDs
  are stored atomically in ignored `.env.local` with file mode `0600`.
- Production values are copied to Azure Static Web Apps application settings;
  no secret is placed in GitHub, source files, frontend build variables, logs,
  health responses, or test fixtures.
- Every Drive file operation walks and validates parent ancestry up to the
  exact root permitted for that operation. Owner note and attachment operations
  must terminate at `NXT-ASERDARGUN-COM`; index, preference, manifest, and
  snapshot operations must terminate at `NXT-PRIVATE-COM`. Both adapters reject
  trashed items, cycles, shortcuts, missing parents, ambiguous multiple parents,
  and IDs longer than the accepted bound.
- Health checks report only redacted status and counts.

Provisioning creates or validates the required folder tree idempotently. It
fails closed if ownership, MIME type, ancestry, or permission metadata does not
match the expected vault.

## 7. Drive layout

```text
NXT-ASERDARGUN-COM/
├── Notes/
│   ├── Inbox/
│   ├── Plans/
│   └── Archive/
└── _assets/
    └── <note-id>/
        ├── image.webp
        ├── document.pdf
        └── attachment.zip

NXT-PRIVATE-COM/
├── vault-index.json
├── preferences.json
├── publication-manifest.json
└── published/
    └── <public-id>/<revision>/
        ├── note.md
        └── assets/
```

`NXT-ASERDARGUN-COM` is the owner-visible, directly editable Markdown archive.
`NXT-PRIVATE-COM` is never shared and is not presented as a note folder in the
application. It separates searchable excerpts, preferences, publication state,
and immutable public projections from the user-managed vault. System JSON files
use a schema version. Each update targets the already verified Drive file in one
content-update request, reads the new version back, and relies on Drive revision
history for recovery instead of creating ambiguous duplicate filenames.

The two roots form one recovery unit. A backup or migration is incomplete unless
it inventories and verifies both folder trees. Folder names make the purpose
clear to the owner, while runtime access relies on the read-back folder IDs and
verified ancestry rather than name matching alone.

`Inbox`, `Plans`, and `Archive` are provisioned initial folders. The owner can
create, rename, move, archive, and trash additional nested folders beneath
`Notes`, up to an application depth of 20. The three provisioned folders and the
`Notes` root cannot be deleted through NXT. Trashing a non-empty custom folder
requires an explicit confirmation that displays its descendant note and
attachment counts.

Deleting a note or attachment moves it to Drive Trash; NXT never permanently
deletes user data. Archiving moves the note into `Notes/Archive` without
changing its stable ID.

## 8. Markdown note model

Every note is a UTF-8 `.md` file with YAML frontmatter:

```yaml
---
id: "018f47d2-6a34-7b2a-9f21-8a7034963aef"
title: "2026 Planı"
created: "2026-08-23T12:00:00.000Z"
updated: "2026-08-23T12:00:00.000Z"
tags: [plan, 2026]
aliases: [Yıllık Plan]
---
```

Rules:

- `id` is an immutable UUID and is the internal identity across renames and
  moves.
- `title` is required, trimmed, and limited to 160 Unicode characters.
- `created` and `updated` are UTC RFC 3339 timestamps.
- Tags and aliases are unique after Unicode-aware case folding.
- Publication state is never stored in note frontmatter.
- Invalid frontmatter is not silently rewritten. The note opens in recovery
  mode with the parse error and raw source preserved.
- A rename adds the old title to aliases unless it is already present.
- `[[Title]]` and `[[Title|Label]]` resolve by exact title, then alias. Ambiguous
  matches render as unresolved and never pick a note silently.
- Standard relative Markdown links reference files beneath `_assets/<note-id>`.
  Paths are recalculated when a note moves; Drive file IDs remain internal.

Supported Markdown includes headings, emphasis, links, images, tables, task
lists, footnotes, fenced code blocks, syntax highlighting, standard Markdown
links, wiki links, and a derived table of contents. Raw HTML is parsed only for
sanitization and is never trusted.

## 9. Index, search, links, and preferences

`vault-index.json` contains a bounded record for every note: stable ID, title,
aliases, Drive ID, path, timestamps, Drive version, tags, normalized search
text, excerpt, outbound note IDs, unresolved wiki targets, and attachment
metadata. Backlinks are derived by reversing outbound links.

The index is updated after a successful note or attachment mutation. A manual
**Rescan vault** command paginates through Drive, parses changed Markdown files,
adds externally created files, removes trashed entries, and rebuilds backlinks.
Rescan writes the new index only after the full scan succeeds. Search runs in a
web worker over the authenticated index and supports full text, title, folder,
tag, and favorite filters.

`preferences.json` stores favorites, recent note IDs, panel state, and theme
preference. Favoriting a note does not rewrite the Markdown file.

## 10. Authentication and routes

Anonymous routes:

- `/` — product and sign-in entrypoint.
- `/login` — friendly SPA sign-in page with a visible link to
  `/.auth/login/github?post_login_redirect_uri=/app`.
- `/p/:publicId` — unlisted public note shell.
- `/api/public/notes/:publicId` — published note projection.
- `/api/public/assets/:publicId/:assetId` — allowlisted published attachment.

Authenticated routes:

- `/app/*` — owner application shell.
- `/api/private/*` — private APIs.

Azure route rules require the built-in `authenticated` role for all private
routes. Every private Function then independently requires:

- `identityProvider === "github"`;
- `userDetails` equal to the configured `NXT_ALLOWED_GITHUB_USER`, with
  production fixed to `aserdargun`; and
- an `authenticated` role in the decoded principal.

Azure Static Web Apps preconfigured Microsoft Entra sign-in is explicitly
blocked. Authentication alone is insufficient: a different authenticated
GitHub user receives `403` from every private API.

A local auth bypass is permitted only when `NXT_LOCAL_AUTH_BYPASS=1`, the
runtime is not production, and the request host is loopback. Production fails
closed if the Azure principal is absent or malformed.

## 11. Private API responsibilities

The private API exposes typed operations rather than Drive primitives:

- session and redacted health status;
- vault tree and index reads;
- create, read, update, rename, move, archive, and trash note;
- create, rename, move, and trash custom note folders;
- rescan vault;
- add, read, and trash attachment;
- update favorites and preferences;
- publish note; and
- revoke publication.

All mutations validate request schemas, stable note identity, current Drive
version, root ancestry, MIME type, filename, and size. The browser cannot ask
the API to fetch an arbitrary Drive ID or path.

## 12. Editing, autosave, and conflict handling

The browser stores a local draft in IndexedDB after each editor change. The
draft contains the note ID, source, base Drive version, local timestamp, and
last confirmed server timestamp. A one-second debounce initiates Drive save
while online.

A save begins only after the API re-reads the file and confirms that the
expected Drive version still matches. App-originated writes for the same note
are serialized, the updated version and content checksum are read back, and the
local draft remains until verification completes. This is an optimistic guard,
not a claim of cross-client atomic locking. If the remote version changed before
the update, or the post-update readback indicates an unexpected concurrent
change, the API returns a conflict with redacted metadata and recoverable Drive
revision information. The UI offers exactly three explicit outcomes:

- keep the Drive version and retain the local draft as a recovery copy;
- save the local version as a new note; or
- open a side-by-side merge editor and submit the merged result against the
  latest Drive version.

NXT never proceeds when it observes a conflicting Drive version. A race that
occurs after the preflight check remains recoverable through Drive revision
history and the retained local draft. A network or Drive error keeps the local
draft and displays a persistent unsynced state. Once Drive confirms the same
content, the corresponding IndexedDB draft is removed.

## 13. Attachments

The owner can upload images, PDFs, Office files, archives, text files, and
general binary attachments up to **20 MB per file**. This leaves headroom below
Azure Static Web Apps' 30 MB request limit. Larger files can be stored directly
in Drive but are not attachable or publishable through the application.

- PNG, JPEG, WebP, and GIF may render inline after MIME sniffing.
- PDFs may render through the browser's safe PDF surface.
- SVG, HTML, XML with active content, executables, and unknown binary formats
  are always served as downloads with a safe `Content-Disposition`.
- Filename extension is not trusted as MIME evidence.
- Upload writes the asset first and adds its Markdown reference only after Drive
  confirms the file.
- Removing an attachment reference does not delete the asset automatically.
  Explicit deletion moves it to Trash after checking that no note references it.

## 14. Publishing and revocation

Publishing creates a frozen copy; it does not proxy the current private note.

1. Parse and sanitize the note.
2. Resolve each referenced attachment and validate its ancestry, size, and MIME.
3. Generate a cryptographically random public ID with at least 128 bits of
   entropy.
4. Create a new revision folder under
   `NXT-PRIVATE-COM/published/<public-id>`.
5. Write the note snapshot and only the referenced asset copies.
6. Verify every created file by readback.
7. Add the public ID and exact allowlist to `publication-manifest.json` last.

The public API fails closed when the manifest is missing, malformed, or points
outside the `NXT-PRIVATE-COM/published` subtree. It never accepts an arbitrary
Drive ID. Public responses use `X-Robots-Tag: noindex, nofollow`, the page
includes matching meta tags, and no public directory or sitemap lists public
IDs. External links use `rel="noopener noreferrer"`.

Revocation removes the manifest entry first, verifies that the public endpoint
returns `404`, and only then trashes the snapshot folder. Public responses avoid
long-lived caching so revocation takes effect immediately at the application
boundary.

## 15. User experience

Desktop uses three regions:

- left: folders, search, favorites, and tags;
- center: CodeMirror Markdown editor; and
- right: live preview, outline, or backlinks.

The top bar shows the active path, save or conflict state, attachment action,
and publication state. `Cmd/Ctrl+K` opens a command palette for note creation,
folder creation, navigation, move, rename, archive, favorite, rescan, publish,
and revoke.

Mobile provides the same feature set through Files, Editor, Preview, and Info
destinations, full-screen editing, touch attachment upload, image paste, the
command palette, and a quick-note action. Touch targets are at least 44 CSS
pixels and no primary flow relies on hover.

The theme adapts the MIT-licensed `insanum/obsidian_gruvbox` dark and light
palettes. Dark is the default; light and system modes are available. The source
repository retains license attribution. Gruvbox colors are adjusted only when
needed to maintain readable focus, error, selection, and text contrast.

## 16. Accessibility and rendering safety

- All controls are keyboard reachable with visible focus.
- Panels, dialogs, save state, conflict state, and errors have semantic labels
  and appropriate live regions.
- Focus is trapped and restored for dialogs and the command palette.
- Reduced-motion preferences disable nonessential animation.
- Desktop and mobile layouts are tested for horizontal overflow.
- Rendered Markdown is sanitized through an explicit allowlist.
- URL protocols are limited to safe web, mail, fragment, and application-owned
  attachment schemes.
- Images and embeds cannot inject credentials, raw Drive URLs, or active markup.

## 17. Failure behavior

- Missing or invalid owner principal: `401` or `403`, with no Drive access.
- Invalid or expired Google token: private health reports a redacted connection
  error; writes stop and local drafts remain.
- Drive rate limit or temporary outage: bounded exponential backoff for safe
  reads; no blind retries for non-idempotent writes.
- Corrupt system JSON: fail closed, preserve the corrupt file, and offer an
  owner-only rebuild from Markdown source.
- Partial attachment upload: do not update the note.
- Partial publication: do not update the publication manifest.
- External note change: surface a version conflict instead of overwriting.
- Duplicate titles or aliases: mark wiki links ambiguous and require owner
  resolution.
- Oversize or unsafe attachment: reject before publication and preserve the note.

User-visible errors never contain OAuth tokens, authorization headers, full
stack traces, or private Drive IDs.

## 18. Free-tier operating constraints

- Azure Static Web Apps plan: Free.
- Backend: built-in managed Azure Functions, HTTP triggers only.
- API prefix: `/api`.
- Maximum API request duration: 45 seconds.
- Application upload limit: 20 MB per attachment.
- No bring-your-own Functions, database, Key Vault, private endpoint,
  Application Insights requirement, or paid storage service.
- Standard Drive API usage remains within the personal project's included quota.
- Operations fail with a clear message instead of enabling a paid tier or
  silently continuing after a quota boundary.

Long Drive work, including rescan, is paginated into bounded owner-triggered API
requests so no individual Function depends on exceeding the request-duration
limit.

## 19. Validation strategy

Unit tests cover frontmatter, normalization, wiki resolution, backlinks,
search indexing, sanitization, path and ancestry validation, authorization,
manifest transitions, public IDs, and MIME policy.

API integration tests use an injected local Drive adapter and cover create,
save, conflict, move, archive, trash, rescan, attachment, publish, revoke,
malformed headers, wrong GitHub owner, arbitrary Drive IDs, and partial-write
failure.

Live Drive integration tests are opt-in and run only against a dedicated
`NXT-PRIVATE-COM/integration-tests` folder. They verify OAuth owner readback,
ancestry, CRUD, version detection, pagination, Trash behavior, and cleanup
without printing secrets or touching owner notes.

Playwright tests cover desktop and mobile flows for sign-in entry, note
creation, editing, local draft recovery, search, tags, favorites, wiki links,
backlinks, command palette, attachments, public URL, revocation, keyboard use,
focus, and horizontal overflow. Security regression tests prove that anonymous
and wrong-owner requests cannot read private data or arbitrary Drive files.

## 20. Repository and deployment flow

The source will live in the public GitHub repository
`aserdargun/nxt-aserdargun-com`. Pull requests run formatting, linting,
typechecking, unit, integration, accessibility, and browser validation. A
successful `main` revision may deploy to one Azure Static Web Apps Free resource
through GitHub Actions.

Deployment is complete only after correlating the exact revision, successful
workflow, Azure `Ready` state, generated-host HTTP behavior, authentication
boundary, public-note behavior, and desktop/mobile browser checks. Google
credentials and both verified root folder IDs are installed as Azure
application settings through a redaction-safe release step.

Custom-domain work is a separate, explicitly authorized stage. The generated
Azure hostname is the terminal deployment target until that authorization is
given.

## 21. Acceptance criteria

- The exact GitHub owner can sign in and every other authenticated user is
  denied private API access.
- The owner can create, edit, rename, move, archive, trash, search, tag,
  favorite, link, and recover Markdown notes and manage custom note folders on
  desktop and mobile.
- Files created or changed directly inside `NXT-ASERDARGUN-COM` appear after a
  successful rescan.
- `NXT-PRIVATE-COM` remains private and contains only app-managed index,
  preference, manifest, and publication-snapshot data.
- Autosave stops when its preflight check observes a newer Drive version; a
  cross-client race after that check remains recoverable from the retained local
  draft and Drive revision history.
- Images and PDFs preview safely; other supported attachments download safely;
  files above 20 MB are rejected before upload.
- A published note exposes only its frozen sanitized source and allowlisted
  attachments at an unlisted `noindex` URL.
- Revocation makes the public URL return `404` without changing the original
  note.
- No secret or private Drive identifier appears in the public repository,
  frontend bundle, public API, UI error, or CI log.
- Local Setup, Run, Validate, and Stop actions work from a clean checkout and
  leave no project listener running after Stop.
- The application passes automated unit, integration, security, accessibility,
  desktop, and mobile tests within Azure Static Web Apps Free constraints.

## 22. Primary references

- [Azure Static Web Apps plans](https://learn.microsoft.com/en-us/azure/static-web-apps/plans)
- [Azure Static Web Apps API constraints](https://learn.microsoft.com/en-us/azure/static-web-apps/apis-overview)
- [Azure Static Web Apps authentication](https://learn.microsoft.com/en-us/azure/static-web-apps/authentication-authorization)
- [Azure client principal data](https://learn.microsoft.com/en-us/azure/static-web-apps/user-information)
- [Google Drive OAuth scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Google OAuth loopback flow for Desktop apps](https://developers.google.com/identity/protocols/oauth2/resources/loopback-migration)
- [Google OAuth publishing state and token lifetime](https://developers.google.com/identity/protocols/oauth2)
- [Google Drive API limits](https://developers.google.com/workspace/drive/api/guides/limits)
- [Obsidian Gruvbox theme and MIT license](https://github.com/insanum/obsidian_gruvbox)
