# NXT Markdown Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a public-source, private-first Markdown planning and notes web application backed by two verified Google Drive roots, protected by exact-owner GitHub authentication, and deployable on Azure Static Web Apps Free.

**Architecture:** A React/Vite/TypeScript SPA communicates only with managed Node.js 22 Azure Functions. Functions enforce the exact GitHub owner, own full-scope Google Drive OAuth, constrain all file operations to `NXT-ASERDARGUN-COM` or `NXT-PRIVATE-COM`, and expose immutable allowlisted public snapshots. IndexedDB protects unsynced browser drafts; Google Drive remains the sole canonical persistent store.

**Tech Stack:** Node.js 22, pnpm 11.22.0, TypeScript 5.9.3, React 19.2.8, Vite 8.2.2, Azure Functions Node programming model v4, CodeMirror 6, unified/remark/rehype, Zod 4.4.3, Google Drive API v3, MiniSearch 7.2.0, IndexedDB via idb 8.0.3, Vitest 4.1.11, Playwright 1.62.1, and Azure Static Web Apps CLI 2.0.10.

**Spec:** `docs/superpowers/specs/2026-08-23-nxt-markdown-vault-design.md`

## Global Constraints

- Runtime is Node.js `>=22.0.0 <23`; Azure `apiRuntime` is exactly `node:22`.
- Package manager is exactly `pnpm@11.22.0`; commit the generated lockfile.
- Production Azure plan is Static Web Apps Free with managed HTTP Functions only.
- Source repository is public `aserdargun/nxt-aserdargun-com`; notes and secrets never enter Git.
- Private APIs require Azure role `authenticated`, provider `github`, and exact user `aserdargun`.
- Local auth bypass requires `NXT_LOCAL_AUTH_BYPASS=1`, non-production runtime, and a loopback host.
- Google OAuth scope is exactly `https://www.googleapis.com/auth/drive` so direct Drive additions can be rescanned.
- Google authorization uses a Desktop-app OAuth client with a loopback callback; a seven-day External/Testing refresh token is not acceptable for stable deployment.
- Owner-visible Drive root is exactly `NXT-ASERDARGUN-COM`.
- App-managed Drive root is exactly `NXT-PRIVATE-COM`; it is never shared at the Drive permission layer.
- Application attachment upload and publication limit is exactly 20 MB per file.
- Public notes are frozen snapshots, unlisted, `noindex`, and revocable; no public directory or sitemap is allowed.
- Drive deletes move items to Trash; no application path permanently deletes user data.
- IndexedDB is draft recovery only; Drive is the canonical source.
- Gruvbox dark is the default; light and system modes remain available and accessible.
- No paid database, Azure Storage, Key Vault, Application Insights, private endpoint, or bring-your-own Functions dependency.
- The generated Azure hostname is the deployment terminal condition. DNS and custom-domain work require separate authorization.
- Do not create a GitHub repository, Drive folder, Azure resource, commit, push, or deployment until the corresponding explicit execution/release gate is authorized.

---

## File and responsibility map

```text
package.json                         Root commands and pinned workspace contract
pnpm-workspace.yaml                  web, api, and package membership
tsconfig.base.json                   Shared strict TypeScript configuration
eslint.config.js                     Repository lint rules
.env.example                         Secret names with empty values only
.gitignore                           Credentials, local state, builds, and logs
LICENSE                              MIT project license
ATTRIBUTIONS.md                      Obsidian Gruvbox attribution

packages/contracts/src/              Zod API and persisted-data contracts
packages/domain/src/                 Pure Markdown, links, index, and publication logic

api/src/auth/                        Azure principal parsing and exact-owner guard
api/src/storage/                     Storage port, local adapter, bounded Drive adapter
api/src/services/                    Vault, attachment, index, and publication services
api/src/functions/                   Azure Functions v4 HTTP registrations
api/test/                            API, storage, auth, and integration tests

web/src/app/                         Router, providers, owner/public shells
web/src/editor/                      CodeMirror, preview, drafts, conflict UI
web/src/explorer/                    Tree, search, tags, favorites, backlinks
web/src/publication/                 Publish controls and anonymous public view
web/src/theme/                       Gruvbox tokens and responsive layout
web/src/api/                         Typed fetch client only
web/src/test/                        Component and accessibility tests

scripts/build-api.mjs                Deterministic prebuilt Function artifact
scripts/google-drive-authorize.mjs   Loopback PKCE OAuth bootstrap
scripts/google-drive-provision.mjs   Two-root idempotent Drive provisioning
scripts/verify-artifacts.mjs         Static/API artifact and secret scan
scripts/verify-deployment-contract.mjs Azure Free/repo/workflow contract
scripts/local-dev.mjs                Checkout-scoped SWA local stack
scripts/stop-local.mjs               Ownership-verified bounded shutdown
tools/*.test.mjs                     Lifecycle, provisioning, and release regression tests
e2e/                                 Playwright desktop/mobile/public/security scenarios
.github/workflows/ci.yml             PR validation without deployment
.github/workflows/deploy.yml         Main-only verified artifact deployment
```

### Task 1: Bootstrap the workspace and executable project contract

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `eslint.config.js`
- Create: `.prettierrc.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `LICENSE`
- Create: `ATTRIBUTIONS.md`
- Create: `tools/project-contract.test.mjs`

**Interfaces:**
- Consumes: none.
- Produces: Node 22/pnpm 11 workspace, strict compiler base, repository scripts, ignored secret boundary, and `pnpm project:test`.

- [ ] **Step 1: Write the failing root-contract test**

```js
// tools/project-contract.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

test("root contract pins the supported toolchain and lifecycle", async () => {
  const pkg = await readJson("package.json");
  assert.equal(pkg.private, true);
  assert.equal(pkg.packageManager, "pnpm@11.22.0");
  assert.deepEqual(pkg.engines, { node: ">=22.0.0 <23" });
  for (const script of ["build", "lint", "typecheck", "test", "e2e", "dev:codex", "stop:codex", "validate:codex"]) {
    assert.equal(typeof pkg.scripts[script], "string", `${script} must exist`);
  }
});

test("secret and generated files are ignored", async () => {
  const ignore = await readFile(".gitignore", "utf8");
  for (const entry of [".env.local", "google-oauth-client*.json", ".nxt-local/", "web/dist/", "api-dist/", "playwright-report/"]) {
    assert.match(ignore, new RegExp(`^${entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  }
});
```

- [ ] **Step 2: Run the test and verify the empty checkout fails**

Run: `node --test tools/project-contract.test.mjs`

Expected: FAIL because `package.json` and `.gitignore` do not exist.

- [ ] **Step 3: Create the root workspace contract**

```json
{
  "name": "nxt-aserdargun-com",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.22.0",
  "engines": { "node": ">=22.0.0 <23" },
  "scripts": {
    "build": "pnpm -r build",
    "lint": "eslint .",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "e2e": "playwright test",
    "project:test": "node --test tools/project-contract.test.mjs",
    "api:build": "node scripts/build-api.mjs",
    "web:build": "pnpm --filter @nxt/web build",
    "artifact:verify": "node scripts/verify-artifacts.mjs",
    "dev:codex": "node scripts/local-dev.mjs",
    "stop:codex": "node scripts/stop-local.mjs",
    "validate:codex": "pnpm lint && pnpm typecheck && pnpm api:build && pnpm web:build && pnpm artifact:verify && pnpm test && pnpm e2e && git diff --check"
  },
  "devDependencies": {
    "@eslint/js": "10.0.1",
    "@types/node": "26.2.0",
    "eslint": "10.9.0",
    "globals": "17.11.0",
    "prettier": "3.9.6",
    "typescript": "5.9.3",
    "typescript-eslint": "8.67.0",
    "yaml": "2.9.0"
  }
}
```

Create the exact workspace membership:

```yaml
# pnpm-workspace.yaml
packages:
  - "web"
  - "api"
  - "packages/*"
injectWorkspacePackages: true
```

Create `tsconfig.base.json` with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules`, `resolveJsonModule`, `module: ESNext`, `moduleResolution: Bundler`, `target: ES2022`, and `lib: ["ES2022", "DOM", "DOM.Iterable"]`. Create a flat `eslint.config.js` from `@eslint/js` and `typescript-eslint` recommended type-checked rules, ignoring only generated directories. Set `.prettierrc.json` to `{ "semi": true, "singleQuote": false, "trailingComma": "none" }`.

Create `.gitignore` with exact lines for `node_modules/`, `.env.local`, `google-oauth-client*.json`, `.nxt-local/`, `web/dist/`, `api-dist/`, `coverage/`, `playwright-report/`, `test-results/`, and `.DS_Store`.

Create `.env.example` with empty values for `NXT_ALLOWED_GITHUB_USER`, `NXT_ALLOWED_GOOGLE_EMAIL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, all nine `NXT_*_DRIVE_FOLDER_ID` settings introduced in Task 6, and the three `NXT_*_DRIVE_FILE_ID` system-file settings introduced there. Never put example-looking secret values in this file.

Create `ATTRIBUTIONS.md` linking `https://github.com/insanum/obsidian_gruvbox` and its MIT license. Use `Copyright (c) 2026 aserdargun` in `LICENSE`.

- [ ] **Step 4: Install the pinned workspace and run the root test**

Run: `corepack enable && corepack prepare pnpm@11.22.0 --activate`

Run: `pnpm install`

Run: `pnpm project:test`

Expected: PASS; `pnpm-lock.yaml` is created and no secret file is tracked.

- [ ] **Step 5: Commit the bootstrap**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json eslint.config.js .prettierrc.json .gitignore .env.example LICENSE ATTRIBUTIONS.md tools/project-contract.test.mjs
git commit -m "chore: bootstrap nxt workspace"
```

### Task 2: Define shared note, API, and persisted-data contracts

**Files:**
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/note.ts`
- Create: `packages/contracts/src/vault.ts`
- Create: `packages/contracts/src/publication.ts`
- Create: `packages/contracts/src/api.ts`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/contracts.test.ts`

**Interfaces:**
- Consumes: root TypeScript contract from Task 1.
- Produces: `NoteFrontmatter`, `NoteDocument`, `VaultIndex`, `Preferences`, `PublicationManifest`, `ApiError`, request/response schemas, and package `@nxt/contracts`.

- [ ] **Step 1: Write failing schema tests**

```ts
// packages/contracts/test/contracts.test.ts
import { describe, expect, it } from "vitest";
import { NoteFrontmatterSchema, PublicationManifestSchema, PreferencesSchema } from "../src/index.js";

describe("NoteFrontmatterSchema", () => {
  it("accepts a portable note and rejects publication state", () => {
    const result = NoteFrontmatterSchema.parse({
      id: "018f47d2-6a34-7b2a-9f21-8a7034963aef",
      title: "2026 Planı",
      created: "2026-08-23T12:00:00.000Z",
      updated: "2026-08-23T12:00:00.000Z",
      tags: ["plan", "2026"],
      aliases: ["Yıllık Plan"]
    });
    expect(result.title).toBe("2026 Planı");
    expect(() => NoteFrontmatterSchema.parse({ ...result, visibility: "public" })).toThrow();
  });
});

it("requires 128-bit public identifiers and schema versions", () => {
  expect(() => PublicationManifestSchema.parse({ schemaVersion: 1, entries: [{ publicId: "short" }] })).toThrow();
  expect(PreferencesSchema.parse({ schemaVersion: 1, favorites: [], recent: [], theme: "dark" }).theme).toBe("dark");
});
```

- [ ] **Step 2: Run the package test and verify it fails**

Run: `pnpm --filter @nxt/contracts test`

Expected: FAIL because the package and schemas do not exist.

- [ ] **Step 3: Implement exact Zod contracts**

Use `zod@4.4.3`. Define the note schema with `.strict()`, a 160-character trimmed title, RFC 3339 UTC timestamps, unique case-folded tags/aliases, and UUID IDs. Define persisted schemas with `schemaVersion: z.literal(1)`.

Create `packages/contracts/package.json` with scripts `build: "tsc -p tsconfig.json"`, `typecheck: "tsc --noEmit"`, and `test: "vitest run"`; put `zod@4.4.3` in dependencies and `typescript@5.9.3` plus `vitest@4.1.11` in devDependencies.

```ts
const fold = (value: string): string => value.normalize("NFKC").toLocaleLowerCase("en-US");

const assertUniqueFoldedLists = (
  value: { tags: string[]; aliases: string[] },
  context: z.RefinementCtx
): void => {
  for (const key of ["tags", "aliases"] as const) {
    const seen = new Set<string>();
    value[key].forEach((item, index) => {
      const folded = fold(item);
      if (seen.has(folded)) {
        context.addIssue({ code: "custom", path: [key, index], message: `${key} must be unique` });
      }
      seen.add(folded);
    });
  }
};

export const NoteFrontmatterSchema = z.object({
  id: z.uuid(),
  title: z.string().trim().min(1).max(160),
  created: z.iso.datetime({ offset: true }),
  updated: z.iso.datetime({ offset: true }),
  tags: z.array(z.string().trim().min(1).max(64)).max(64),
  aliases: z.array(z.string().trim().min(1).max(160)).max(64)
}).strict().superRefine(assertUniqueFoldedLists);

export type NoteFrontmatter = z.infer<typeof NoteFrontmatterSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.enum(["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "CONFLICT", "INVALID_INPUT", "DRIVE_UNAVAILABLE", "UNSAFE_FILE", "TOO_LARGE"]),
    message: z.string(),
    requestId: z.string()
  })
});
```

`PublicationManifestSchema` maps a base64url public ID of at least 22 characters to a snapshot Drive ID, source note ID, published timestamp, revision, and an exact asset allowlist. `VaultIndexSchema` stores no OAuth values and validates every Drive identifier with `z.string().min(1).max(512)`.

- [ ] **Step 4: Build and verify the shared package**

Run: `pnpm --filter @nxt/contracts test && pnpm --filter @nxt/contracts typecheck && pnpm --filter @nxt/contracts build`

Expected: all PASS; `dist/index.js` and declarations exist.

- [ ] **Step 5: Commit the contracts**

```bash
git add packages/contracts pnpm-lock.yaml
git commit -m "feat: define nxt data contracts"
```

### Task 3: Implement portable Markdown, wiki links, safe rendering, and index derivation

**Files:**
- Create: `packages/domain/package.json`
- Create: `packages/domain/tsconfig.json`
- Create: `packages/domain/src/note-codec.ts`
- Create: `packages/domain/src/wiki-links.ts`
- Create: `packages/domain/src/render-markdown.ts`
- Create: `packages/domain/src/indexer.ts`
- Create: `packages/domain/src/publication.ts`
- Create: `packages/domain/src/index.ts`
- Create: `packages/domain/test/note-codec.test.ts`
- Create: `packages/domain/test/render-markdown.test.ts`
- Create: `packages/domain/test/indexer.test.ts`

**Interfaces:**
- Consumes: `NoteFrontmatter`, `VaultIndex`, and publication contracts from Task 2.
- Produces: `parseNote(source)`, `serializeNote(note)`, `extractWikiLinks(source)`, `resolveWikiLinks(notes)`, `renderMarkdown(input)`, `deriveIndex(records)`, and `createPublicId()`.

- [ ] **Step 1: Write failing domain tests**

```ts
import { describe, expect, it } from "vitest";
import { parseNote, renderMarkdown, resolveWikiTarget, createPublicId } from "../src/index.js";

it("round-trips UTF-8 frontmatter without publication fields", () => {
  const source = `---\nid: 018f47d2-6a34-7b2a-9f21-8a7034963aef\ntitle: 2026 Planı\ncreated: 2026-08-23T12:00:00.000Z\nupdated: 2026-08-23T12:00:00.000Z\ntags: [plan]\naliases: [Yıllık Plan]\n---\n\n# Hedef\n`;
  expect(parseNote(source).body).toContain("# Hedef");
});

it("sanitizes active markup and preserves GFM", async () => {
  const rendered = await renderMarkdown("<script>alert(1)</script>\n\n- [x] done\n\n[[Plan|Open]]");
  expect(rendered.html).not.toContain("script");
  expect(rendered.html).toContain("type=\"checkbox\"");
  expect(rendered.wikiLinks).toEqual([{ target: "Plan", label: "Open" }]);
});

it("does not guess ambiguous aliases and creates 128-bit identifiers", () => {
  expect(resolveWikiTarget("Plan", [
    { id: "a", title: "A", aliases: ["Plan"] },
    { id: "b", title: "B", aliases: ["Plan"] }
  ])).toEqual({ kind: "ambiguous", candidateIds: ["a", "b"] });
  expect(Buffer.from(createPublicId(), "base64url")).toHaveLength(16);
});
```

- [ ] **Step 2: Run tests and verify missing implementations fail**

Run: `pnpm --filter @nxt/domain test`

Expected: FAIL with unresolved exports.

- [ ] **Step 3: Implement the note codec and link resolver**

Parse only a leading `---` YAML block with `yaml@2.9.0`; reject duplicate YAML keys and schema violations without rewriting the source. Serialize frontmatter in the fixed field order `id`, `title`, `created`, `updated`, `tags`, `aliases`, followed by one blank line and the normalized body.

Create `packages/domain/package.json` with the same build/typecheck/test scripts as `@nxt/contracts`. Dependencies are `@nxt/contracts: workspace:*`, `yaml@2.9.0`, `unified@11.0.5`, the pinned remark/rehype packages listed in Step 4, and devDependencies `typescript@5.9.3` plus `vitest@4.1.11`.

Implement `[[Target]]` and `[[Target|Label]]` with a small tokenizer that ignores fenced and inline code. Resolution order is exact Unicode case-folded title, then alias. Return `resolved`, `unresolved`, or `ambiguous`; never select the first ambiguous result.

- [ ] **Step 4: Implement safe Markdown rendering and index derivation**

Use `unified@11.0.5`, `remark-parse@11.0.0`, `remark-gfm@4.0.1`, `remark-frontmatter@5.0.0`, `remark-rehype@11.1.2`, `rehype-highlight@7.0.2`, `rehype-sanitize@6.0.0`, and `rehype-stringify@10.0.1`.

```ts
export interface RenderedMarkdown {
  html: string;
  outline: Array<{ depth: number; id: string; text: string }>;
  wikiLinks: Array<{ target: string; label: string | null }>;
  plainText: string;
}

export async function renderMarkdown(source: string): Promise<RenderedMarkdown>;
export function deriveIndex(records: readonly IndexedSourceNote[]): VaultIndex;
export function createPublicId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}
```

Extend the sanitizer only for syntax-highlight class names, task-list checkbox attributes, safe heading IDs, and application-owned attachment URLs. Reject `javascript:`, `data:text/html`, inline event attributes, `iframe`, `object`, and raw SVG.

- [ ] **Step 5: Run package validation**

Run: `pnpm --filter @nxt/domain test && pnpm --filter @nxt/domain typecheck && pnpm --filter @nxt/domain build`

Expected: all PASS; malicious fixture output contains no executable markup.

- [ ] **Step 6: Commit the Markdown domain**

```bash
git add packages/domain pnpm-lock.yaml
git commit -m "feat: add portable markdown domain"
```

### Task 4: Define the storage port and a deterministic local Drive simulator

**Files:**
- Create: `api/package.json`
- Create: `api/tsconfig.json`
- Create: `api/host.json`
- Create: `api/src/storage/storage-port.ts`
- Create: `api/src/storage/root-boundary.ts`
- Create: `api/src/storage/local-drive-adapter.ts`
- Create: `api/test/local-drive-adapter.test.ts`
- Create: `api/test/root-boundary.test.ts`

**Interfaces:**
- Consumes: contracts and domain packages from Tasks 2–3.
- Produces: `StoragePort`, `StoredFile`, paginated child listing, versioned reads/writes, moves, Trash, ancestry checks, and a filesystem-backed local adapter.

- [ ] **Step 1: Write failing storage tests**

```ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalDriveAdapter, RootBoundaryStorage } from "../src/storage/index.js";

it("versions writes and never permanently deletes", async () => {
  const root = await mkdtemp(join(tmpdir(), "nxt-drive-"));
  const storage = await LocalDriveAdapter.create(root);
  const file = await storage.createText({ parentId: "vault", name: "note.md", mimeType: "text/markdown", text: "one" });
  const updated = await storage.updateText({ fileId: file.id, expectedVersion: file.version, text: "two", mimeType: "text/markdown" });
  expect(BigInt(updated.version)).toBeGreaterThan(BigInt(file.version));
  await storage.trash(file.id);
  expect((await storage.get(file.id)).trashed).toBe(true);
  expect(await readFile(join(root, ".metadata.json"), "utf8")).not.toContain("refresh_token");
});

it("rejects cross-root and ambiguous ancestry", async () => {
  const storage = RootBoundaryStorage.forTest({ allowedRootId: "vault", graph: { vault: [], note: ["other"] } });
  await expect(storage.assertInside("note")).rejects.toThrow("outside configured root");
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm --filter @nxt/api test -- local-drive-adapter root-boundary`

Expected: FAIL because the storage implementation does not exist.

- [ ] **Step 3: Implement the port and root-boundary decorator**

Create `api/package.json` with scripts `build: "tsc -p tsconfig.json"`, `typecheck: "tsc --noEmit"`, and `test: "vitest run"`. Dependencies are `@azure/functions@4.16.2`, `@nxt/contracts: workspace:*`, and `@nxt/domain: workspace:*`; devDependencies are `typescript@5.9.3` and `vitest@4.1.11`. Task 6 adds `googleapis`; Task 8 adds `file-type`.

```ts
export interface StoredFile {
  id: string;
  name: string;
  mimeType: string;
  parentIds: string[];
  version: string;
  modifiedTime: string;
  size: number;
  trashed: boolean;
}

export interface StoragePort {
  get(fileId: string): Promise<StoredFile>;
  listChildren(input: { parentId: string; pageToken?: string; pageSize: number }): Promise<{ files: StoredFile[]; nextPageToken?: string }>;
  readText(fileId: string): Promise<{ file: StoredFile; text: string; checksum: string }>;
  readBytes(fileId: string): Promise<{ file: StoredFile; bytes: Uint8Array; checksum: string }>;
  createFolder(input: { parentId: string; name: string }): Promise<StoredFile>;
  createText(input: { parentId: string; name: string; mimeType: string; text: string }): Promise<StoredFile>;
  createBytes(input: { parentId: string; name: string; mimeType: string; bytes: Uint8Array }): Promise<StoredFile>;
  updateText(input: { fileId: string; expectedVersion: string; mimeType: string; text: string }): Promise<StoredFile>;
  move(input: { fileId: string; fromParentId: string; toParentId: string; newName?: string }): Promise<StoredFile>;
  trash(fileId: string): Promise<StoredFile>;
  listRevisions(fileId: string): Promise<Array<{ id: string; modifiedTime: string }>>;
}
```

`RootBoundaryStorage` must walk exactly one parent at each level, stop at its configured root, cap traversal at 100 nodes, reject cycles, shortcuts, Trash, missing parents, and IDs longer than 512 characters. Use separate instances for vault and private roots.

- [ ] **Step 4: Implement the local adapter**

Map opaque synthetic IDs to paths below a temporary root in `.metadata.json`; never accept a path from callers. Preserve every content update in `.revisions/<file-id>/`. `trash()` changes metadata and moves content below `.trash/`; do not call `rm`.

- [ ] **Step 5: Validate the storage package**

Run: `pnpm --filter @nxt/api test -- local-drive-adapter root-boundary && pnpm --filter @nxt/api typecheck`

Expected: PASS; mutation tests confirm version increments and Trash recovery.

- [ ] **Step 6: Commit storage boundaries**

```bash
git add api pnpm-lock.yaml
git commit -m "feat: add bounded storage port"
```

### Task 5: Enforce Azure principal parsing and the exact GitHub owner

**Files:**
- Create: `api/src/auth/client-principal.ts`
- Create: `api/src/auth/require-owner.ts`
- Create: `api/src/http/api-response.ts`
- Create: `api/src/functions/session.ts`
- Create: `api/src/functions/index.ts`
- Create: `api/test/auth.test.ts`
- Create: `api/test/api-response.test.ts`
- Modify: `api/package.json`

**Interfaces:**
- Consumes: `ApiError` contracts from Task 2.
- Produces: `decodeClientPrincipal(header)`, `requireOwner(request, environment)`, redacted JSON responses, and `GET /api/private/session`.

- [ ] **Step 1: Write failing authorization tests**

```ts
import { describe, expect, it } from "vitest";
import { requireOwner } from "../src/auth/require-owner.js";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");

it("accepts only the exact GitHub owner", () => {
  const header = encode({ identityProvider: "github", userDetails: "aserdargun", userRoles: ["anonymous", "authenticated"], userId: "owner-id" });
  expect(requireOwner({ header, host: "nxt.example", environment: "production", allowedUser: "aserdargun", localBypass: false }).userDetails).toBe("aserdargun");
});

it.each([
  { identityProvider: "github", userDetails: "other", userRoles: ["authenticated"], userId: "x" },
  { identityProvider: "aad", userDetails: "aserdargun", userRoles: ["authenticated"], userId: "x" },
  { identityProvider: "github", userDetails: "aserdargun", userRoles: ["anonymous"], userId: "x" }
])("rejects non-owner principal %#", (principal) => {
  expect(() => requireOwner({ header: encode(principal), host: "nxt.example", environment: "production", allowedUser: "aserdargun", localBypass: false })).toThrow();
});

it("allows bypass only on loopback outside production", () => {
  expect(requireOwner({ header: null, host: "127.0.0.1:4280", environment: "development", allowedUser: "aserdargun", localBypass: true }).userDetails).toBe("aserdargun");
  expect(() => requireOwner({ header: null, host: "nxt.example", environment: "production", allowedUser: "aserdargun", localBypass: true })).toThrow();
});
```

- [ ] **Step 2: Run the auth tests and verify failure**

Run: `pnpm --filter @nxt/api test -- auth api-response`

Expected: FAIL because auth modules are missing.

- [ ] **Step 3: Implement strict principal parsing and error redaction**

Decode `x-ms-client-principal` as base64 UTF-8 JSON, validate a strict schema, and classify missing/malformed principals as `401`; valid but wrong principals are `403`. Compare provider and username case-insensitively after trimming, but return the configured canonical owner string.

```ts
export interface OwnerIdentity {
  provider: "github";
  userId: string;
  userDetails: string;
}

export function requireOwner(input: {
  header: string | null;
  host: string;
  environment: string;
  allowedUser: string;
  localBypass: boolean;
}): OwnerIdentity;
```

`api-response.ts` must generate a request ID, map domain errors to the contract enum, and remove token-like keys, authorization headers, stack traces, raw Drive IDs, and nested causes before serialization.

- [ ] **Step 4: Register the first Functions v4 endpoint**

Use `@azure/functions@4.16.2` in `dependencies`, never `devDependencies`. Register with code-centric v4 APIs:

```ts
app.http("private-session", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "private/session",
  handler: async (request) => {
    const owner = ownerFromRequest(request);
    return json({ owner: { provider: owner.provider, username: owner.userDetails } });
  }
});
```

The Function `authLevel` remains `anonymous` because Azure Static Web Apps performs edge authentication; the handler still executes `requireOwner` defensively.

- [ ] **Step 5: Run auth and type validation**

Run: `pnpm --filter @nxt/api test -- auth api-response && pnpm --filter @nxt/api typecheck`

Expected: PASS; no error body contains fixture strings `refresh_token`, `Bearer`, or `drive-file-id`.

- [ ] **Step 6: Commit owner authentication**

```bash
git add api pnpm-lock.yaml
git commit -m "feat: enforce exact github owner"
```

### Task 6: Implement full-scope Google OAuth, two-root provisioning, and Drive storage

**Files:**
- Create: `api/src/storage/google-drive-client.ts`
- Create: `api/src/storage/google-drive-adapter.ts`
- Create: `api/test/google-drive-adapter.test.ts`
- Create: `api/test/google-drive-adapter.integration.test.ts`
- Create: `scripts/google-drive-oauth.mjs`
- Create: `scripts/google-drive-authorize.mjs`
- Create: `scripts/google-drive-provision.mjs`
- Create: `tools/google-drive-provision.test.mjs`
- Modify: `api/package.json`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `StoragePort`, root-boundary rules, and exact environment names from Tasks 1 and 4.
- Produces: Google Drive v3 adapter, Desktop-client loopback PKCE authorization, verified owner readback, idempotent creation/selection of `NXT-ASERDARGUN-COM` and `NXT-PRIVATE-COM`, and opt-in live tests.

- [ ] **Step 1: Write failing OAuth and provisioning tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createOAuthRequest, parseDesktopClient, planFolders } from "../scripts/google-drive-oauth.mjs";

test("accepts only a downloaded Desktop-app OAuth client", () => {
  assert.equal(parseDesktopClient({ installed: { client_id: "desktop-client-id", client_secret: "secret" } }).clientId, "desktop-client-id");
  assert.throws(() => parseDesktopClient({ web: { client_id: "web-client-id", client_secret: "secret" } }), /Desktop app/u);
});

test("OAuth is loopback-only, offline, state-bound, PKCE, and full Drive scope", () => {
  const request = createOAuthRequest({ clientId: "desktop-client-id", redirectUri: "http://127.0.0.1:34117/", state: "fixed-state", verifier: "a".repeat(64) });
  const url = new URL(request.authorizationUrl);
  assert.equal(url.searchParams.get("scope"), "https://www.googleapis.com/auth/drive");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("state"), "fixed-state");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.hostname, "accounts.google.com");
});

test("provisioning plans two exact sibling roots and required children", () => {
  assert.deepEqual(planFolders(), {
    vaultRoot: "NXT-ASERDARGUN-COM",
    privateRoot: "NXT-PRIVATE-COM",
    vaultChildren: ["Notes", "_assets"],
    noteChildren: ["Inbox", "Plans", "Archive"],
    privateChildren: ["published", "integration-tests"],
    privateFiles: ["vault-index.json", "preferences.json", "publication-manifest.json"]
  });
});
```

- [ ] **Step 2: Run the tests and verify failure**

Run: `node --test tools/google-drive-provision.test.mjs`

Expected: FAIL because the OAuth module is absent.

- [ ] **Step 3: Implement redaction-safe local OAuth**

Require `google-drive-authorize.mjs --client-config <path>` on first authorization. Parse only the `installed` object from the downloaded Google client JSON and reject a configuration containing only `web`; atomically copy only its client ID/secret into ignored `.env.local`, never the source JSON. Read `NXT_ALLOWED_GOOGLE_EMAIL` from `.env.local`. Bind the callback server only to `127.0.0.1` on an available high port and use `http://127.0.0.1:<port>/`; generate 32 random bytes for `state`, a 64-character PKCE verifier, and a SHA-256 challenge. Open the authorization URL in the system browser, reject wrong state/host/path, exchange the code, and call Drive `about.get(fields="user(emailAddress,displayName)")`. Reject an email mismatch before folder operations.

Write `GOOGLE_REFRESH_TOKEN` atomically without printing the token, code, client secret, or callback query. If Google does not return a refresh token, fail with an instruction to revoke the prior grant and reauthorize with consent; never store only an expiring access token.

- [ ] **Step 4: Implement idempotent two-root provisioning**

For each exact folder name, list non-trashed folders beneath the verified parent. Accept exactly one match, create when none exists, and fail when duplicates exist. Read every created/selected folder back with `id,name,mimeType,parents,trashed,ownedByMe,permissions` and verify single ancestry and owner capability.

Under `NXT-PRIVATE-COM`, provision exactly one `application/json` file for each of `vault-index.json`, `preferences.json`, and `publication-manifest.json`. Create a missing file with its schema-version-1 empty contract, accept one valid existing file after schema validation, and fail closed on duplicates or invalid JSON. Read back and retain each system file's ID, version, and checksum; later services update these exact files and never create replacements.

Store these exact settings without logging values:

```text
NXT_VAULT_DRIVE_FOLDER_ID
NXT_NOTES_DRIVE_FOLDER_ID
NXT_ASSETS_DRIVE_FOLDER_ID
NXT_INBOX_DRIVE_FOLDER_ID
NXT_PLANS_DRIVE_FOLDER_ID
NXT_ARCHIVE_DRIVE_FOLDER_ID
NXT_PRIVATE_DRIVE_FOLDER_ID
NXT_PUBLISHED_DRIVE_FOLDER_ID
NXT_INTEGRATION_TEST_DRIVE_FOLDER_ID
NXT_VAULT_INDEX_DRIVE_FILE_ID
NXT_PREFERENCES_DRIVE_FILE_ID
NXT_PUBLICATION_MANIFEST_DRIVE_FILE_ID
```

- [ ] **Step 5: Implement the Google Drive adapter**

Add `googleapis@176.0.0` to `api/package.json` dependencies. Escape Drive query literals. Request only required fields. Convert Drive's monotonically increasing `version` to the `StoragePort` string version. Use multipart upload for text and byte updates; immediately read back `id,name,mimeType,parents,version,modifiedTime,size,trashed` and a checksum. Retry only idempotent reads on `429`, `500`, `502`, `503`, and `504` with bounded exponential backoff and jitter.

Do not call `files.delete` or `emptyTrash`. Implement `trash` through `files.update({ requestBody: { trashed: true } })`.

- [ ] **Step 6: Add isolated adapter and live integration tests**

Unit tests inject a fake Drive client and prove query escaping, pagination, exact field masks, version conflicts, ancestry rejection, redaction, and Trash-only deletion. The live test runs only when `NXT_DRIVE_INTEGRATION=1`; it creates fixtures exclusively under `NXT_INTEGRATION_TEST_DRIVE_FOLDER_ID`, verifies CRUD/revisions/pagination, trashes its fixtures, and never touches `Notes`.

Run: `node --test tools/google-drive-provision.test.mjs && pnpm --filter @nxt/api test -- google-drive-adapter`

Expected: PASS; live integration test is skipped without the opt-in variable.

- [ ] **Step 7: Commit Drive integration code without credentials**

```bash
git add api scripts/google-drive-oauth.mjs scripts/google-drive-authorize.mjs scripts/google-drive-provision.mjs tools/google-drive-provision.test.mjs .env.example pnpm-lock.yaml
git commit -m "feat: add bounded google drive integration"
```

### Task 7: Build the vault, folder, index, preference, and rescan services

**Files:**
- Create: `api/src/services/system-file-store.ts`
- Create: `api/src/services/vault-service.ts`
- Create: `api/src/services/rescan-service.ts`
- Create: `api/src/services/preferences-service.ts`
- Create: `api/src/functions/vault.ts`
- Create: `api/src/functions/notes.ts`
- Create: `api/src/functions/folders.ts`
- Create: `api/src/functions/preferences.ts`
- Create: `api/test/vault-service.test.ts`
- Create: `api/test/rescan-service.test.ts`
- Create: `api/test/preferences-service.test.ts`
- Modify: `api/src/functions/index.ts`

**Interfaces:**
- Consumes: bounded vault/private storage, Markdown domain, contracts, and owner wrapper.
- Produces: typed private note/folder/index/preference APIs, one-second-save-compatible version guards, and paginated rescan.

- [ ] **Step 1: Write failing vault behavior tests**

```ts
it("creates portable notes in Inbox and indexes only after readback", async () => {
  const result = await service.createNote({ title: "Quick note", body: "# Today", folderId: ids.inbox });
  expect(result.note.frontmatter.title).toBe("Quick note");
  expect(result.note.path).toBe("Notes/Inbox/Quick note.md");
  expect((await privateStorage.readText(ids.index)).text).toContain(result.note.frontmatter.id);
});

it("returns conflict and retains both sources when the Drive version changed", async () => {
  const opened = await service.getNote(noteId);
  await vaultStorage.updateText({ fileId: opened.driveId, expectedVersion: opened.version, mimeType: "text/markdown", text: remoteSource });
  await expect(service.updateNote({ noteId, expectedVersion: opened.version, source: localSource })).rejects.toMatchObject({ code: "CONFLICT" });
});

it("rescan discovers external markdown but excludes private and asset trees", async () => {
  const page = await rescan.scanPage({ cursor: null, limit: 100 });
  expect(page.records.map((item) => item.path)).toContain("Notes/Plans/External.md");
  expect(page.records.some((item) => item.path.includes("NXT-PRIVATE-COM"))).toBe(false);
});
```

- [ ] **Step 2: Run service tests and verify failure**

Run: `pnpm --filter @nxt/api test -- vault-service rescan-service preferences-service`

Expected: FAIL because services are missing.

- [ ] **Step 3: Implement system-file versioning and note operations**

`SystemFileStore` targets only verified files beneath `NXT-PRIVATE-COM`. It reads and validates schema version, updates the existing file in one Drive content request using its observed version, reads back the new version/checksum, and never creates duplicate system filenames.

`VaultService` implements create/get/update/rename/move/archive/trash. Preflight every update by re-reading Drive metadata and comparing `expectedVersion`; serialize app-originated writes per note ID; keep local draft recovery until post-write source/checksum readback matches.

On rename, sanitize the filename, add the old title to aliases, and keep the stable UUID. On move, recalculate every note-relative attachment link so `_assets/<note-id>` references remain valid from the new Markdown path. Custom folders may nest only below `Notes` to depth 20. `Notes`, `Inbox`, `Plans`, and `Archive` cannot be deleted through the app. A non-empty custom folder requires a descendant-count confirmation token tied to the current tree version.

- [ ] **Step 4: Implement bounded rescan and preferences**

`RescanService.scanPage({ cursor, limit: 100 })` processes at most 100 Drive entries per API request and returns `{ cursor, processed, complete }`. Only `.md` files below `Notes` become notes. Invalid frontmatter becomes a recovery record with raw content preserved. After the final page, build backlinks and atomically update the existing private index file.

`PreferencesService` stores favorites, recent IDs, theme, and panel state in `preferences.json`; it removes IDs no longer present in the index and never rewrites Markdown for a favorite change.

- [ ] **Step 5: Register typed private Functions**

Register exact-owner routes for:

```text
GET    /api/private/vault
POST   /api/private/vault/rescan
POST   /api/private/notes
GET    /api/private/notes/{noteId}
PUT    /api/private/notes/{noteId}
DELETE /api/private/notes/{noteId}
POST   /api/private/notes/{noteId}/move
POST   /api/private/notes/{noteId}/archive
POST   /api/private/folders
PUT    /api/private/folders/{folderId}
DELETE /api/private/folders/{folderId}
PUT    /api/private/preferences
```

Validate all bodies with shared contracts and return `409` for version/tree confirmation conflicts.

- [ ] **Step 6: Run vault validation**

Run: `pnpm --filter @nxt/api test -- vault-service rescan-service preferences-service && pnpm --filter @nxt/api typecheck`

Expected: PASS; injected partial index write leaves the prior valid index readable.

- [ ] **Step 7: Commit vault services**

```bash
git add api
git commit -m "feat: add drive backed vault services"
```

### Task 8: Add safe attachments and MIME-enforced delivery

**Files:**
- Create: `api/src/services/attachment-policy.ts`
- Create: `api/src/services/attachment-service.ts`
- Create: `api/src/functions/attachments.ts`
- Create: `api/test/attachment-policy.test.ts`
- Create: `api/test/attachment-service.test.ts`
- Modify: `api/src/functions/index.ts`
- Modify: `api/package.json`

**Interfaces:**
- Consumes: note IDs, `_assets/<note-id>` root, owner auth, and storage port.
- Produces: `POST/GET/DELETE /api/private/attachments`, 20 MB enforcement, MIME sniffing, inline/download policy, and reference-safe Trash.

- [ ] **Step 1: Write failing attachment-policy tests**

```ts
it.each([
  ["image/png", "inline"],
  ["image/jpeg", "inline"],
  ["image/webp", "inline"],
  ["image/gif", "inline"],
  ["application/pdf", "inline"],
  ["image/svg+xml", "download"],
  ["text/html", "download"],
  ["application/zip", "download"],
  ["application/x-msdownload", "download"]
])("maps %s to %s", (mime, disposition) => {
  expect(classifyAttachment(mime)).toBe(disposition);
});

it("rejects files above 20 MiB before Drive upload", async () => {
  await expect(service.upload({ noteId, name: "large.bin", declaredMime: "application/octet-stream", bytes: new Uint8Array(20 * 1024 * 1024 + 1) })).rejects.toMatchObject({ code: "TOO_LARGE" });
  expect(fakeDrive.createBytes).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the attachment tests and verify failure**

Run: `pnpm --filter @nxt/api test -- attachment`

Expected: FAIL because policy and service do not exist.

- [ ] **Step 3: Implement content detection and safe naming**

Add `file-type@22.0.2` to `api/package.json` dependencies and use it for binary sniffing. Treat valid UTF-8 text without a binary signature as `text/plain` or `text/markdown` only when the requested extension matches. Normalize filenames to Unicode NFC, remove separators/control characters, cap at 180 characters, and preserve the final safe extension.

Write the asset to the note's verified `_assets/<note-id>` folder; do not modify note Markdown until Drive readback verifies size, MIME, parent, and checksum. Reject folder/shortcut MIME types.

- [ ] **Step 4: Implement delivery and deletion safety**

Inline responses are limited to PNG/JPEG/WebP/GIF/PDF and include `X-Content-Type-Options: nosniff`. All other responses include `Content-Disposition: attachment; filename*=UTF-8''<encoded-name>`. Before Trash, scan the index and current note source; reject deletion while any note reference remains.

- [ ] **Step 5: Register and test private attachment routes**

```text
POST   /api/private/attachments
GET    /api/private/attachments/{assetId}
DELETE /api/private/attachments/{assetId}
```

Run: `pnpm --filter @nxt/api test -- attachment && pnpm --filter @nxt/api typecheck`

Expected: PASS; malicious extension/MIME mismatch fixtures download and never render inline.

- [ ] **Step 6: Commit attachment handling**

```bash
git add api pnpm-lock.yaml
git commit -m "feat: add safe drive attachments"
```

### Task 9: Implement immutable publication snapshots and immediate revocation

**Files:**
- Create: `api/src/services/publication-service.ts`
- Create: `api/src/functions/public-notes.ts`
- Create: `api/src/functions/public-assets.ts`
- Create: `api/src/functions/publications.ts`
- Create: `api/test/publication-service.test.ts`
- Create: `api/test/public-functions.test.ts`
- Modify: `api/src/functions/index.ts`

**Interfaces:**
- Consumes: safe Markdown renderer, attachment policy, private manifest store, published root, and exact-owner wrapper.
- Produces: publish/revoke private endpoints plus anonymous note/asset endpoints that accept only manifest IDs.

- [ ] **Step 1: Write failing atomicity and revocation tests**

```ts
it("does not expose a partial publication", async () => {
  fakeDrive.failAfterCreates(2);
  await expect(service.publish({ noteId })).rejects.toThrow("injected write failure");
  expect(await publicReader.get(publicId)).toBeNull();
  expect((await manifestStore.read()).entries).toHaveLength(0);
});

it("updates the manifest last and revokes it first", async () => {
  const publication = await service.publish({ noteId });
  expect((await publicReader.get(publication.publicId))?.note.title).toBe("Share me");
  await service.revoke({ publicId: publication.publicId });
  expect(await publicReader.get(publication.publicId)).toBeNull();
  expect((await fakeDrive.get(publication.snapshotFolderId)).trashed).toBe(true);
});

it("never serves an asset outside the exact allowlist", async () => {
  await expect(publicReader.getAsset(publicId, unrelatedDriveId)).rejects.toMatchObject({ code: "NOT_FOUND" });
});
```

- [ ] **Step 2: Run publication tests and verify failure**

Run: `pnpm --filter @nxt/api test -- publication public-functions`

Expected: FAIL because publication services are missing.

- [ ] **Step 3: Implement publish ordering**

Generate 16 cryptographically random bytes and encode base64url. Render and sanitize the source note, resolve every attachment, copy only referenced safe assets into `NXT-PRIVATE-COM/published/<public-id>/<source-version>`, read back every copy, then update `publication-manifest.json` last using its observed version. On pre-manifest failure, leave the orphan unreferenced and queue it for owner-only cleanup; it must remain unreachable publicly.

- [ ] **Step 4: Implement fail-closed anonymous readers and revocation**

Public readers load the verified manifest file, validate schema, locate the exact public ID, and assert snapshot/asset ancestry below the published root. Missing/malformed manifests and unknown IDs return `404`, not internal details.

Revocation removes the manifest entry and verifies a subsequent public read returns `404` before moving the snapshot folder to Trash. Set `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`, `X-Content-Type-Options: nosniff`, and a request ID on public responses.

- [ ] **Step 5: Register exact routes and run tests**

```text
POST   /api/private/notes/{noteId}/publish
DELETE /api/private/publications/{publicId}
GET    /api/public/notes/{publicId}
GET    /api/public/assets/{publicId}/{assetId}
```

Run: `pnpm --filter @nxt/api test -- publication public-functions && pnpm --filter @nxt/api typecheck`

Expected: PASS; public readers cannot receive raw Drive IDs, source paths, or unpublished metadata.

- [ ] **Step 6: Commit publication boundaries**

```bash
git add api
git commit -m "feat: add revocable public snapshots"
```

### Task 10: Scaffold the responsive authenticated shell and Gruvbox design system

**Files:**
- Create: `web/package.json`
- Create: `web/tsconfig.json`
- Create: `web/vite.config.ts`
- Create: `web/index.html`
- Create: `web/src/main.tsx`
- Create: `web/src/app/router.tsx`
- Create: `web/src/app/providers.tsx`
- Create: `web/src/app/login-page.tsx`
- Create: `web/src/app/owner-shell.tsx`
- Create: `web/src/app/not-found-page.tsx`
- Create: `web/src/api/client.ts`
- Create: `web/src/api/session.ts`
- Create: `web/src/theme/gruvbox.css`
- Create: `web/src/theme/layout.css`
- Create: `web/src/test/login-page.test.tsx`
- Create: `web/src/test/owner-shell.test.tsx`
- Create: `web/src/test/setup.ts`

**Interfaces:**
- Consumes: `GET /api/private/session` and shared response contracts.
- Produces: Vite React app, `/`, `/login`, `/app/*`, visible GitHub sign-in, exact-owner session gate, responsive desktop/mobile shells, and accessible Gruvbox tokens.

- [ ] **Step 1: Write failing login and responsive-shell tests**

```tsx
it("offers the exact GitHub sign-in path", () => {
  render(<LoginPage />);
  expect(screen.getByRole("link", { name: "Continue with GitHub" })).toHaveAttribute(
    "href",
    "/.auth/login/github?post_login_redirect_uri=/app"
  );
});

it("renders equivalent mobile and desktop destinations", async () => {
  render(<OwnerShell />);
  for (const name of ["Files", "Editor", "Preview", "Info"]) {
    expect(screen.getAllByRole("button", { name }).length).toBeGreaterThan(0);
  }
  expect(screen.getByLabelText("Save status")).toHaveTextContent("Saved");
});
```

- [ ] **Step 2: Run web tests and verify failure**

Run: `pnpm --filter @nxt/web test -- login-page owner-shell`

Expected: FAIL because the web package is missing.

- [ ] **Step 3: Create the pinned web package**

```json
{
  "name": "@nxt/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite --host 127.0.0.1 --port 5173",
    "build": "tsc -b && vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@nxt/contracts": "workspace:*",
    "@nxt/domain": "workspace:*",
    "@radix-ui/react-dialog": "1.1.23",
    "@tanstack/react-query": "5.102.0",
    "lucide-react": "1.33.0",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "react-router-dom": "7.18.2"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "7.0.1",
    "@testing-library/react": "16.3.2",
    "@testing-library/user-event": "14.6.6",
    "@types/react": "19.2.18",
    "@types/react-dom": "19.2.4",
    "jsdom": "30.0.1",
    "typescript": "5.9.3",
    "vitest": "4.1.11",
    "vite": "8.2.2"
  }
}
```

- [ ] **Step 4: Implement auth-aware routing and fetch boundaries**

The browser may call only application routes, never Google APIs. `api/client.ts` validates every JSON body with shared Zod schemas and maps non-2xx responses to typed errors. `/app/*` loads `/api/private/session`; `401` redirects to `/login`, `403` shows a wrong-account page with sign-out, and Drive errors do not sign the user out.

- [ ] **Step 5: Port Gruvbox tokens with attribution and accessibility**

Define CSS custom properties for dark, light, and system modes. Start from the MIT-licensed `insanum/obsidian_gruvbox` palette, preserve attribution, and define separate semantic tokens for background, panel, text, muted text, border, focus, selection, error, warning, success, link, code, and all eight Gruvbox accents.

Use a desktop grid of explorer/editor/context panels. At mobile breakpoints, keep one active surface and a bottom navigation for Files, Editor, Preview, and Info. Enforce 44 CSS-pixel touch targets, visible `:focus-visible`, reduced motion, and no hover-only actions.

- [ ] **Step 6: Run shell validation**

Run: `pnpm --filter @nxt/web test -- login-page owner-shell && pnpm --filter @nxt/web typecheck && pnpm --filter @nxt/web build`

Expected: PASS; the production bundle contains no string matching `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, or `NXT_PRIVATE_DRIVE_FOLDER_ID`.

- [ ] **Step 7: Commit the shell and theme**

```bash
git add web ATTRIBUTIONS.md pnpm-lock.yaml
git commit -m "feat: add responsive gruvbox shell"
```

### Task 11: Build the CodeMirror editor, safe preview, draft recovery, and conflict flow

**Files:**
- Create: `web/src/editor/markdown-editor.tsx`
- Create: `web/src/editor/markdown-preview.tsx`
- Create: `web/src/editor/draft-store.ts`
- Create: `web/src/editor/use-autosave.ts`
- Create: `web/src/editor/conflict-dialog.tsx`
- Create: `web/src/editor/editor-workspace.tsx`
- Create: `web/src/test/draft-store.test.ts`
- Create: `web/src/test/editor-workspace.test.tsx`
- Create: `web/src/test/conflict-dialog.test.tsx`
- Modify: `web/package.json`

**Interfaces:**
- Consumes: note GET/PUT APIs, safe Markdown renderer, current Drive version, and typed conflict response.
- Produces: CodeMirror editor, live sanitized preview, one-second autosave, IndexedDB recovery, save status, and three-choice conflict resolution.

- [ ] **Step 1: Write failing draft and conflict tests**

```ts
it("keeps a local draft until the same source is confirmed by Drive", async () => {
  await drafts.put({ noteId: "note-1", source: "local", baseVersion: "7", localUpdatedAt: "2026-08-23T12:00:00.000Z", confirmedAt: null });
  await drafts.markConfirmed({ noteId: "note-1", source: "different" });
  expect(await drafts.get("note-1")).not.toBeNull();
  await drafts.markConfirmed({ noteId: "note-1", source: "local" });
  expect(await drafts.get("note-1")).toBeNull();
});
```

```tsx
it("offers all conflict outcomes without a destructive default", async () => {
  render(<ConflictDialog conflict={fixtureConflict} onResolve={onResolve} />);
  expect(screen.getByRole("button", { name: "Keep Drive version" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Save local as a new note" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Merge versions" })).toBeVisible();
  expect(screen.queryByRole("button", { name: /overwrite/i })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run editor tests and verify failure**

Run: `pnpm --filter @nxt/web test -- draft-store editor-workspace conflict-dialog`

Expected: FAIL because editor modules are missing.

- [ ] **Step 3: Add pinned editor dependencies and implement CodeMirror**

Add `@uiw/react-codemirror@4.25.11`, `@codemirror/lang-markdown@6.5.2`, and `idb@8.0.3`. Configure Markdown language, bracket matching, line wrapping, history, keyboard navigation, and Gruvbox syntax tokens. Do not load remote extensions or execute code blocks.

`MarkdownPreview` calls the shared safe renderer, converts application attachment references to same-origin API URLs, and intercepts resolved wiki links for internal navigation.

- [ ] **Step 4: Implement IndexedDB draft recovery and autosave**

```ts
export interface LocalDraft {
  noteId: string;
  source: string;
  baseVersion: string;
  localUpdatedAt: string;
  confirmedAt: string | null;
}

export interface DraftStore {
  get(noteId: string): Promise<LocalDraft | null>;
  put(draft: LocalDraft): Promise<void>;
  markConfirmed(input: { noteId: string; source: string }): Promise<void>;
  remove(noteId: string): Promise<void>;
}
```

Write to IndexedDB immediately after each editor change. Debounce server save by exactly one second. Display `Saving`, `Saved`, `Offline draft`, `Conflict`, or `Error`; never display `Saved` before source/checksum readback confirms it.

- [ ] **Step 5: Implement conflict recovery**

The dialog shows local and Drive sources side-by-side. “Keep Drive version” preserves the local draft as a named recovery copy in IndexedDB. “Save local as a new note” calls note creation with a deterministic title suffix `Recovered <UTC timestamp>`. “Merge versions” edits a merged source and submits against the latest Drive version.

- [ ] **Step 6: Run editor validation**

Run: `pnpm --filter @nxt/web test -- draft-store editor-workspace conflict-dialog && pnpm --filter @nxt/web typecheck`

Expected: PASS; fake offline and 409 responses retain local content.

- [ ] **Step 7: Commit editing and recovery**

```bash
git add web pnpm-lock.yaml
git commit -m "feat: add markdown editing and recovery"
```

### Task 12: Add explorer, folders, search, tags, favorites, backlinks, and command palette

**Files:**
- Create: `web/src/explorer/file-tree.tsx`
- Create: `web/src/explorer/folder-actions.tsx`
- Create: `web/src/explorer/search-worker.ts`
- Create: `web/src/explorer/search-client.ts`
- Create: `web/src/explorer/search-panel.tsx`
- Create: `web/src/explorer/tags-panel.tsx`
- Create: `web/src/explorer/favorites-panel.tsx`
- Create: `web/src/explorer/backlinks-panel.tsx`
- Create: `web/src/explorer/outline-panel.tsx`
- Create: `web/src/explorer/command-palette.tsx`
- Create: `web/src/test/file-tree.test.tsx`
- Create: `web/src/test/search.test.ts`
- Create: `web/src/test/command-palette.test.tsx`
- Modify: `web/package.json`

**Interfaces:**
- Consumes: vault index, folder/note/preference APIs, rendered outline, and resolved links.
- Produces: accessible navigation, MiniSearch worker, tag/favorite filters, backlink navigation, custom folder actions, and `Cmd/Ctrl+K` commands.

- [ ] **Step 1: Write failing search and navigation tests**

```ts
it("searches Turkish text, title, tag, folder, and favorite", async () => {
  const search = await createSearchClient(indexFixture);
  expect((await search.query("yıllık tag:plan folder:Plans favorite:true")).map((item) => item.id)).toEqual(["note-2026"]);
});
```

```tsx
it("does not allow protected folder deletion", async () => {
  render(<FileTree tree={treeFixture} />);
  await userEvent.click(screen.getByRole("button", { name: "Inbox actions" }));
  expect(screen.queryByRole("menuitem", { name: "Move to Trash" })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run explorer tests and verify failure**

Run: `pnpm --filter @nxt/web test -- file-tree search command-palette`

Expected: FAIL because explorer modules are missing.

- [ ] **Step 3: Implement tree and safe folder actions**

Use ARIA tree/treeitem semantics with roving tabindex, arrow-key navigation, rename, move, archive, and Trash actions. Protected roots expose no destructive action. A non-empty folder Trash dialog displays current note and attachment counts and submits the server-issued confirmation token.

- [ ] **Step 4: Implement worker-based search and derived panels**

Add `minisearch@7.2.0`. Build the index inside a web worker from authenticated index records. Tokenize with `toLocaleLowerCase("tr-TR")` plus Unicode diacritic normalization while preserving the original display text. Parse exact filters `tag:`, `folder:`, and `favorite:`; unknown filter names remain ordinary text.

Backlinks and outline panels consume derived data only. Unresolved and ambiguous wiki links use distinct accessible states and never navigate until resolved.

- [ ] **Step 5: Implement the command palette**

Use Radix Dialog for focus trap and restoration. Commands are New note, Quick note in Inbox, New folder, Open note, Rename, Move, Archive, Favorite/Unfavorite, Rescan vault, Publish, Revoke, Toggle theme, and Sign out. Disable commands that do not apply to the current selection and explain why with visible text.

- [ ] **Step 6: Run explorer validation**

Run: `pnpm --filter @nxt/web test -- file-tree search command-palette && pnpm --filter @nxt/web typecheck`

Expected: PASS; keyboard-only tests can create/open/move a note and close the palette with focus restored.

- [ ] **Step 7: Commit knowledge navigation**

```bash
git add web pnpm-lock.yaml
git commit -m "feat: add vault navigation and search"
```

### Task 13: Complete attachments, publish controls, and the anonymous public view

**Files:**
- Create: `web/src/editor/attachment-picker.tsx`
- Create: `web/src/editor/attachment-view.tsx`
- Create: `web/src/publication/publish-dialog.tsx`
- Create: `web/src/publication/publication-status.tsx`
- Create: `web/src/publication/public-note-page.tsx`
- Create: `web/src/publication/public-attachment.tsx`
- Create: `web/src/test/attachment-picker.test.tsx`
- Create: `web/src/test/publish-dialog.test.tsx`
- Create: `web/src/test/public-note-page.test.tsx`
- Modify: `web/src/app/router.tsx`

**Interfaces:**
- Consumes: private attachment and publication APIs plus anonymous note/asset APIs.
- Produces: upload/paste/download UI, owner publish/revoke controls, `/p/:publicId`, noindex metadata, and safe public asset rendering.

- [ ] **Step 1: Write failing public/private UI tests**

```tsx
it("rejects oversized files before the request", async () => {
  render(<AttachmentPicker noteId="note-1" />);
  const large = new File([new Uint8Array(20 * 1024 * 1024 + 1)], "large.bin", { type: "application/octet-stream" });
  await userEvent.upload(screen.getByLabelText("Add attachment"), large);
  expect(screen.getByRole("alert")).toHaveTextContent("20 MB");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("marks public notes noindex and exposes no owner controls", async () => {
  render(<PublicNotePage publicId="valid-public-id-value" />);
  expect(await screen.findByRole("heading", { name: "Published plan" })).toBeVisible();
  expect(document.querySelector('meta[name="robots"]')).toHaveAttribute("content", "noindex,nofollow");
  expect(screen.queryByText("Drive ID")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run UI tests and verify failure**

Run: `pnpm --filter @nxt/web test -- attachment-picker publish-dialog public-note-page`

Expected: FAIL because components do not exist.

- [ ] **Step 3: Implement attachment interactions**

Support file input, drag/drop, and pasted images. Enforce 20 MB client-side and still rely on server enforcement. Render only API-classified image/PDF responses inline. Open all other assets as same-origin downloads; never use raw Drive links.

- [ ] **Step 4: Implement publish and revoke UX**

The publish dialog lists the note source version and referenced attachment count, states that the snapshot is unlisted/noindex, and requires one explicit confirmation. On success, show Copy link and Revoke. Republish creates a new immutable revision under the same public ID only after full readback; the prior revision remains recoverable but unreachable.

Revoke requires explicit confirmation and treats success only after a public API read returns `404`.

- [ ] **Step 5: Implement the anonymous route**

`/p/:publicId` calls only `/api/public/*`, renders the server-sanitized projection, injects `noindex,nofollow`, and contains no authenticated shell, Drive metadata, editor code path, or public-list link. A missing or revoked ID renders a generic `Not found` page.

- [ ] **Step 6: Run publication UI validation**

Run: `pnpm --filter @nxt/web test -- attachment-picker publish-dialog public-note-page && pnpm --filter @nxt/web build`

Expected: PASS; a bundle scan finds no Google credential/environment variable names beyond documentation-safe public labels.

- [ ] **Step 7: Commit public and attachment UI**

```bash
git add web
git commit -m "feat: add attachments and public note view"
```

### Task 14: Add Azure routing, deterministic builds, and checkout-scoped local lifecycle

**Files:**
- Create: `web/public/staticwebapp.config.json`
- Create: `scripts/build-api.mjs`
- Create: `scripts/verify-artifacts.mjs`
- Create: `scripts/local-dev.mjs`
- Create: `scripts/stop-local-core.mjs`
- Create: `scripts/stop-local.mjs`
- Create: `tools/static-security.test.mjs`
- Create: `tools/artifact-contract.test.mjs`
- Create: `tools/local-lifecycle.integration.test.mjs`
- Create: `.codex/environments/environment.toml`
- Modify: `package.json`
- Modify: `api/package.json`

**Interfaces:**
- Consumes: web/API applications from Tasks 5–13.
- Produces: `web/dist`, `api-dist`, Free SWA route/security config, local SWA stack on loopback, and safe Stop.

- [ ] **Step 1: Write failing static-security and artifact tests**

```js
test("static config protects private routes and blocks Entra sign-in", async () => {
  const config = JSON.parse(await readFile("web/public/staticwebapp.config.json", "utf8"));
  assert.deepEqual(config.platform, { apiRuntime: "node:22" });
  assert.deepEqual(config.routes.find((route) => route.route === "/api/private/*").allowedRoles, ["authenticated"]);
  assert.deepEqual(config.routes.find((route) => route.route === "/app/*").allowedRoles, ["authenticated"]);
  assert.equal(config.routes.find((route) => route.route === "/.auth/login/aad").statusCode, 404);
  assert.equal(config.routes.some((route) => route.route === "/login"), false);
});

test("prebuilt artifacts contain config and Functions v4 entrypoint", async () => {
  await access("web/dist/staticwebapp.config.json");
  await access("api-dist/host.json");
  const pkg = JSON.parse(await readFile("api-dist/package.json", "utf8"));
  assert.equal(pkg.main, "index.js");
  assert.equal(pkg.dependencies["@azure/functions"], "4.16.2");
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `node --test tools/static-security.test.mjs tools/artifact-contract.test.mjs`

Expected: FAIL because config and build scripts are missing.

- [ ] **Step 3: Create the exact SWA configuration**

```json
{
  "routes": [
    { "route": "/.auth/login/aad", "statusCode": 404 },
    { "route": "/api/private/*", "allowedRoles": ["authenticated"] },
    { "route": "/app/*", "allowedRoles": ["authenticated"] }
  ],
  "navigationFallback": {
    "rewrite": "/index.html",
    "exclude": ["/api/*", "/.auth/*"]
  },
  "globalHeaders": {
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "X-Content-Type-Options": "nosniff"
  },
  "platform": { "apiRuntime": "node:22" }
}
```

- [ ] **Step 4: Build deterministic prebuilt artifacts**

Add `@azure/static-web-apps-cli@2.0.10` and `esbuild@0.28.2` to root devDependencies. Require Azure Functions Core Tools v4 at least `4.0.5382` for the Node v4 programming model; record and validate the installed version during Setup (the planning machine has `4.13.0`).

Use `esbuild@0.28.2` in `scripts/build-api.mjs` to bundle `api/src/functions/index.ts` for Node 22 ESM into `api-dist/index.js`, externalize `@azure/functions`, copy `host.json`, and generate a minimal production `package.json` with `main: index.js` and runtime dependencies. Delete only the explicit repository path `api-dist` after resolving and proving it is a child of the checkout.

`verify-artifacts.mjs` checks file counts, web size below 250 MB, API entrypoint, Node runtime config, and public/private routes. It recursively scans text artifacts for non-empty values belonging to an explicit backend-only key allowlist (`GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, and every Drive folder/file ID); empty values are skipped. Report only matching key names, never values.

- [ ] **Step 5: Implement local Run and Stop**

`local-dev.mjs` verifies ports 4280, 5173, and 7071 are free or owned by this checkout, builds packages/API, starts Vite, Functions Core Tools, and SWA CLI bound to `127.0.0.1`, and writes `.nxt-local/control.json` with checkout realpath, PIDs, start times, ports, and random control nonce.

`stop-local.mjs` reads only this checkout's control file, verifies every PID start time and current working directory, sends `SIGTERM`, waits a bounded interval, sends `SIGKILL` only to surviving verified PIDs, removes the control file, and confirms all three listeners are gone. It refuses foreign/stale records and never scans or kills OS-wide ports.

- [ ] **Step 6: Add Codex environment actions**

`.codex/environments/environment.toml` exposes Setup (`pnpm install --frozen-lockfile`), Run (`pnpm dev:codex`), Validate (`pnpm validate:codex`), and Stop (`pnpm stop:codex`) with project-scoped descriptions.

- [ ] **Step 7: Run lifecycle validation**

Run: `pnpm api:build && pnpm web:build && pnpm artifact:verify`

Run: `node --test tools/static-security.test.mjs tools/artifact-contract.test.mjs tools/local-lifecycle.integration.test.mjs`

Expected: PASS; Run serves the app at `http://127.0.0.1:4280`, Stop leaves ports 4280/5173/7071 free, and a foreign control record is refused.

- [ ] **Step 8: Commit build and lifecycle contracts**

```bash
git add web/public/staticwebapp.config.json scripts tools .codex package.json api/package.json pnpm-lock.yaml
git commit -m "chore: add secure local and azure lifecycle"
```

### Task 15: Add full browser, mobile, accessibility, and security regression coverage

**Files:**
- Create: `playwright.config.ts`
- Create: `e2e/fixtures.ts`
- Create: `e2e/owner-workspace.spec.ts`
- Create: `e2e/mobile-workspace.spec.ts`
- Create: `e2e/drafts-conflicts.spec.ts`
- Create: `e2e/publication.spec.ts`
- Create: `e2e/security.spec.ts`
- Create: `e2e/accessibility.spec.ts`
- Create: `e2e/visual-layout.spec.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: complete local SWA stack and local Drive simulator.
- Produces: executable acceptance evidence for Chromium desktop and mobile viewports.

- [ ] **Step 1: Configure deterministic Playwright fixtures**

Add `@playwright/test@1.62.1` and `@axe-core/playwright@4.13.0` to root devDependencies. Start `pnpm dev:codex` as the web server and always invoke `pnpm stop:codex` in teardown. Seed only the local adapter below `.nxt-local/fixtures`; never use live Drive in browser tests.

Use projects for desktop Chromium at 1440×1000, iPhone 14-equivalent at 390×844, and a reduced-motion desktop context. Wait for `domcontentloaded`, not `networkidle`.

- [ ] **Step 2: Write the failing owner journey**

```ts
test("owner creates, links, finds, archives, and recovers a note", async ({ page }) => {
  await page.goto("/app");
  await page.getByRole("button", { name: "New note" }).click();
  await page.getByLabel("Title").fill("2026 Planı");
  await page.getByLabel("Markdown editor").fill("# Plan\n\n[[Kaynak]]\n\n#2026");
  await expect(page.getByLabel("Save status")).toHaveText("Saved");
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByRole("searchbox").fill("2026 tag:2026");
  await expect(page.getByRole("link", { name: "2026 Planı" })).toBeVisible();
  await page.getByRole("button", { name: "Archive" }).click();
  await expect(page.getByText("Notes/Archive/2026 Planı.md")).toBeVisible();
});
```

- [ ] **Step 3: Add mobile parity and draft/conflict scenarios**

Prove every desktop destination exists on mobile, the editor remains usable without horizontal overflow, pasted images upload, offline changes show `Offline draft`, reload restores the draft, and a simulated external Drive write opens the three-choice conflict dialog without overwriting.

- [ ] **Step 4: Add publication and security scenarios**

Prove a published note shows only allowlisted assets, includes noindex metadata/headers, has no owner controls, returns `404` immediately after revoke, and cannot access arbitrary Drive IDs. Send anonymous, wrong-GitHub-user, malformed-principal, path traversal, oversize, SVG/HTML, and manifest-corruption fixtures; assert fail-closed status and redacted bodies.

- [ ] **Step 5: Add accessibility and visual-layout assertions**

Run axe on login, owner explorer/editor/preview, dialog, and public note pages with zero serious/critical violations. Test keyboard-only tree and palette navigation, focus restoration, live save status, 44px touch targets, reduced motion, and `document.documentElement.scrollWidth === document.documentElement.clientWidth` at both viewports.

- [ ] **Step 6: Run the full local acceptance suite**

Run: `pnpm exec playwright install chromium`

Run: `pnpm e2e`

Expected: all desktop/mobile/accessibility/security scenarios PASS; teardown leaves no NXT listener.

- [ ] **Step 7: Commit acceptance coverage**

```bash
git add playwright.config.ts e2e package.json pnpm-lock.yaml
git commit -m "test: cover nxt owner and public journeys"
```

### Task 16: Add CI, artifact deployment, recovery tooling, and operator documentation

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/deploy.yml`
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

**Interfaces:**
- Consumes: deterministic artifacts, tests, environment names, and external resource naming contract.
- Produces: PR CI, main-only deployment, redaction-safe Azure settings installation, two-root Drive inventory backup, and complete Setup/Run/Validate/Stop documentation.

- [ ] **Step 1: Write failing workflow and release-contract tests**

```js
test("deployment is main-only, Free-compatible, and prebuilt", async () => {
  const workflow = YAML.parse(await readFile(".github/workflows/deploy.yml", "utf8"));
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  const deploy = workflow.jobs.deploy.steps.find((step) => step.name === "Deploy prebuilt artifacts");
  assert.equal(deploy.with.app_location, "web/dist");
  assert.equal(deploy.with.api_location, "api-dist");
  assert.equal(deploy.with.skip_app_build, true);
  assert.equal(deploy.with.skip_api_build, true);
  assert.equal(deploy.with.github_id_token, undefined);
});

test("release tooling never prints secret values", async () => {
  const result = await runAzureReleaseWithFakeCli({ GOOGLE_CLIENT_SECRET: "never-print-client-secret", GOOGLE_REFRESH_TOKEN: "never-print-refresh-token" });
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stdout + result.stderr, /never-print-client-secret|never-print-refresh-token/);
});
```

- [ ] **Step 2: Run contract tests and verify failure**

Run: `node --test tools/deployment-contract.test.mjs tools/azure-release.test.mjs tools/google-drive-backup.test.mjs`

Expected: FAIL because workflows and release scripts do not exist.

- [ ] **Step 3: Create PR CI and main-only deploy workflows**

Pin actions by immutable SHA. Use the verified action revisions below:

```yaml
name: Validate NXT
on:
  pull_request:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020
        with:
          node-version: "22"
      - run: corepack enable && corepack prepare pnpm@11.22.0 --activate
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec playwright install --with-deps chromium
      - run: pnpm validate:ci
```

The deploy workflow repeats validation, verifies `web/dist` and `api-dist`, then uses:

```yaml
- name: Deploy prebuilt artifacts
  uses: Azure/static-web-apps-deploy@4d27395796ac319302594769cfe812bd207490b1
  with:
    azure_static_web_apps_api_token: ${{ secrets.AZURE_STATIC_WEB_APPS_API_TOKEN_SWA_NXT_ASERDARGUN_COM }}
    action: upload
    app_location: web/dist
    api_location: api-dist
    output_location: ""
    skip_app_build: true
    skip_api_build: true
```

Set workflow `permissions: contents: read`, concurrency group `swa-nxt-aserdargun-com-production`, and `cancel-in-progress: false`. Do not request `id-token` and do not pass `github_id_token`.

- [ ] **Step 4: Implement redaction-safe Azure settings installation**

`azure-static-web-app-release.mjs` reads `.env.local`, requires every production key, checks `az account show`, verifies the exact resource group `rg-nxt-aserdargun-com`, app `swa-nxt-aserdargun-com`, SKU `Free`, and zero custom hostnames, then runs `az staticwebapp appsettings set` with `--only-show-errors --output none`. It prints only the sorted key names and success/failure state. Tests inject a fake `az` executable and prove values never reach stdout/stderr.

- [ ] **Step 5: Implement two-root backup inventory**

`google-drive-backup.mjs inventory --output <new-directory>` walks both verified roots, records relative path, Drive ID, parent ID, MIME, size, version, modified time, and checksum into a mode-0600 `manifest.json`, and downloads Markdown/system JSON but not arbitrary large binaries unless `--include-binaries` is explicit. It refuses existing output directories and fails if either root is missing. `verify` re-hashes the exported files and proves both roots are present.

- [ ] **Step 6: Write operator documentation**

`README.md` must contain exact prerequisites, public/private model, Google full-scope rationale, Desktop-app loopback OAuth setup, the seven-day refresh-token limitation for External consent left in Testing, `.env.local` permissions, Setup, Run, Validate, Stop, Drive authorization/provisioning, recovery, Free Azure deployment, generated-host verification, and the custom-domain stop boundary. `docs/SECURITY.md` documents exact-owner defense in depth, full Drive scope mitigation, OAuth consent status and token rotation, public manifest allowlisting, CSP, attachment policy, secret rotation, and incident recovery.

- [ ] **Step 7: Run repository-wide validation**

Add `validate:ci` to root scripts with the same gates as `validate:codex` but deterministic CI lifecycle settings.

Run: `pnpm validate:codex`

Run: `node --test tools/deployment-contract.test.mjs tools/azure-release.test.mjs tools/google-drive-backup.test.mjs`

Expected: all checks PASS and `pnpm stop:codex` confirms no project listener.

- [ ] **Step 8: Commit CI and operations**

```bash
git add .github scripts tools README.md docs/ARCHITECTURE.md docs/SECURITY.md package.json pnpm-lock.yaml
git commit -m "chore: add nxt validation and release contracts"
```

### Task 17: Provision and live-verify the two Google Drive roots

**Files:**
- Local-only: `.env.local` (ignored, mode `0600`)
- External create: Google Drive folders `NXT-ASERDARGUN-COM` and `NXT-PRIVATE-COM` plus approved children and three schema-version-1 system JSON files
- No tracked source change expected.

**Interfaces:**
- Consumes: authorization/provisioning/recovery tools from Tasks 6 and 16 and the owner's Google OAuth client values.
- Produces: exact-owner refresh credential, nine verified folder IDs, three verified system-file IDs, healthy live adapter, and a verified recovery inventory.

- [ ] **Step 1: Reconfirm the exact external targets before mutation**

Display, without secrets:

```text
Google account: value of NXT_ALLOWED_GOOGLE_EMAIL
Google OAuth client type: Desktop app
Google OAuth consent: Internal or non-Testing for durable use
Owner-visible root to create/select: NXT-ASERDARGUN-COM
Private root to create/select: NXT-PRIVATE-COM
Drive permission changes: none
GitHub/Azure/DNS changes: none
```

Proceed only under an explicit execution authorization for these Drive writes. The current design/plan approval alone is not a mutation authorization.

- [ ] **Step 2: Prepare the ignored credential file**

Use `apply_patch` to create `.env.local` with these exact keys, then run `chmod 600 .env.local`:

```dotenv
NXT_ALLOWED_GITHUB_USER=aserdargun
NXT_ALLOWED_GOOGLE_EMAIL=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=
NXT_VAULT_DRIVE_FOLDER_ID=
NXT_NOTES_DRIVE_FOLDER_ID=
NXT_ASSETS_DRIVE_FOLDER_ID=
NXT_INBOX_DRIVE_FOLDER_ID=
NXT_PLANS_DRIVE_FOLDER_ID=
NXT_ARCHIVE_DRIVE_FOLDER_ID=
NXT_PRIVATE_DRIVE_FOLDER_ID=
NXT_PUBLISHED_DRIVE_FOLDER_ID=
NXT_INTEGRATION_TEST_DRIVE_FOLDER_ID=
NXT_VAULT_INDEX_DRIVE_FILE_ID=
NXT_PREFERENCES_DRIVE_FILE_ID=
NXT_PUBLICATION_MANIFEST_DRIVE_FILE_ID=
```

In Google Cloud, enable Drive API and create an OAuth client of type **Desktop app**. For a personal Gmail account, move an External consent screen out of `Testing` before issuing the durable production refresh token; otherwise the Drive-scope refresh token expires after seven days. For an eligible Google Workspace account, an Internal consent configuration is the preferred equivalent. Do not continue to stable Azure publication with a seven-day Testing token.

Set `NXT_ALLOWED_GITHUB_USER=aserdargun` and the exact owner Google email. Leave client values, refresh token, folder IDs, and system-file IDs empty; the authorization tool writes only validated Desktop-client values and the refresh token. Verify with `git status --short` that `.env.local` and the downloaded client JSON are absent from Git output.

- [ ] **Step 3: Complete loopback OAuth authorization**

Run: `node scripts/google-drive-authorize.mjs --client-config /absolute/path/to/google-oauth-client.json`

Expected: the script proves the JSON contains an `installed` Desktop client, browser consent requests full Google Drive access, and CLI reports only the verified owner email and `refresh credential stored`, with no client secret or token value. After success, remove the downloaded client JSON through a recoverable/manual secret-cleanup step; `.env.local` remains the mode-0600 canonical local credential file.

- [ ] **Step 4: Create or select both exact roots idempotently**

Run: `node scripts/google-drive-provision.mjs`

Expected readback:

```text
NXT-ASERDARGUN-COM: healthy, owner-visible
  Notes/Inbox: healthy
  Notes/Plans: healthy
  Notes/Archive: healthy
  _assets: healthy
NXT-PRIVATE-COM: healthy, private
  published: healthy
  integration-tests: healthy
  vault-index.json: healthy, schema 1
  preferences.json: healthy, schema 1
  publication-manifest.json: healthy, schema 1
Duplicate exact roots: 0
Duplicate system files: 0
```

The script stores IDs without printing them and makes no sharing/permission mutation.

- [ ] **Step 5: Run isolated live Drive integration**

Run: `NXT_DRIVE_INTEGRATION=1 pnpm --filter @nxt/api test -- google-drive-adapter.integration`

Expected: PASS; fixtures exist only temporarily under `NXT-PRIVATE-COM/integration-tests` and finish in Trash.

- [ ] **Step 6: Create and verify a recovery inventory**

Run:

```bash
NXT_BACKUP_DIR="$(mktemp -d)/nxt-drive-inventory"
node scripts/google-drive-backup.mjs inventory --output "$NXT_BACKUP_DIR"
node scripts/google-drive-backup.mjs verify --input "$NXT_BACKUP_DIR"
```

Expected: PASS with both exact root names, no secret values, and a mode-0600 manifest.

- [ ] **Step 7: Verify no tracked or unintended external changes**

Run: `git status --short`

Expected: no `.env.local`, credential, backup, or Drive ID is tracked. Report the two folder names, health, and `commit=none`, `push=none`, `deploy=none` for this task.

### Task 18: Create the public GitHub repository and publish to Azure Static Web Apps Free

**Files:**
- External create: `https://github.com/aserdargun/nxt-aserdargun-com`
- External create: Azure resource group `rg-nxt-aserdargun-com`
- External create: Azure Static Web App `swa-nxt-aserdargun-com`
- External secret: `AZURE_STATIC_WEB_APPS_API_TOKEN_SWA_NXT_ASERDARGUN_COM`
- No DNS/custom-domain mutation.

**Interfaces:**
- Consumes: clean validated `main`, prebuilt artifacts, Azure CLI/GitHub CLI sessions, and live Drive settings.
- Produces: public source repository, successful correlated deployment, Ready Free SWA resource, generated-host evidence, and zero custom hostnames.

- [ ] **Step 1: Reconfirm publication authority and targets**

Display exactly:

```text
GitHub create: aserdargun/nxt-aserdargun-com (public)
Azure create: rg-nxt-aserdargun-com / swa-nxt-aserdargun-com / West Europe / Free
Deployment branch: main
Custom hostnames: none
DNS/IHS/certificate changes: none
```

Run these read-only collision checks before any creation:

```bash
gh repo view aserdargun/nxt-aserdargun-com --json nameWithOwner,visibility,defaultBranchRef,url
az group show --name rg-nxt-aserdargun-com --output json
az staticwebapp show --name swa-nxt-aserdargun-com --resource-group rg-nxt-aserdargun-com --output json
```

Expected for a first publication: all three targets are absent. If any target exists, stop and reconcile its exact owner, repository/resource identity, SKU, region, and bindings; do not reuse, overwrite, rename, or delete it under this plan approval.

Proceed only after explicit authorization for GitHub creation, push, Azure creation, secret installation, and deployment.

- [ ] **Step 2: Verify clean release inputs**

Run: `pnpm validate:ci`

Run: `git status --short --branch`

Expected: validation PASS, branch contains all planned commits, and worktree is clean. Rename the local branch only if needed: `git branch -M main`.

- [ ] **Step 3: Create the public GitHub repository without an implicit extra commit**

Run:

```bash
gh repo create aserdargun/nxt-aserdargun-com --public --source=. --remote=origin --description "Private-first Markdown planning and notes on Google Drive"
git push -u origin main
```

Expected: `gh repo view aserdargun/nxt-aserdargun-com --json visibility,defaultBranchRef,url` returns `PUBLIC`, `main`, and the exact URL.

- [ ] **Step 4: Create the exact Free Azure resources without repository automation**

Run:

```bash
az group create --name rg-nxt-aserdargun-com --location westeurope --only-show-errors
az staticwebapp create --name swa-nxt-aserdargun-com --resource-group rg-nxt-aserdargun-com --location westeurope --sku Free --only-show-errors
```

Expected: resource group location is `westeurope`, app SKU is `Free`, app state becomes `Ready`, and custom hostnames count is zero.

- [ ] **Step 5: Install the deployment token and runtime settings without printing values**

Run:

```bash
az staticwebapp secrets list --name swa-nxt-aserdargun-com --resource-group rg-nxt-aserdargun-com --query properties.apiKey --output tsv | gh secret set AZURE_STATIC_WEB_APPS_API_TOKEN_SWA_NXT_ASERDARGUN_COM --repo aserdargun/nxt-aserdargun-com
node scripts/azure-static-web-app-release.mjs apply --env-file .env.local
```

Expected: GitHub reports the secret name, the release script reports only installed application-setting key names, and neither command prints a token value.

- [ ] **Step 6: Trigger and correlate the production workflow**

Run: `gh workflow run deploy.yml --repo aserdargun/nxt-aserdargun-com --ref main`

Run: `gh run watch --repo aserdargun/nxt-aserdargun-com --exit-status`

Expected: the successful run head SHA equals `git rev-parse HEAD`; validation and artifact verification precede deployment.

- [ ] **Step 7: Verify Azure, HTTP, authentication, and public boundaries**

Run:

```bash
NXT_GENERATED_HOST="$(az staticwebapp show --name swa-nxt-aserdargun-com --resource-group rg-nxt-aserdargun-com --query defaultHostname --output tsv)"
curl --fail --silent --show-error --head "https://$NXT_GENERATED_HOST/"
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' "https://$NXT_GENERATED_HOST/api/private/session"
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' "https://$NXT_GENERATED_HOST/api/public/notes/unknown-public-id"
az staticwebapp hostname list --name swa-nxt-aserdargun-com --resource-group rg-nxt-aserdargun-com --query 'length(@)' --output tsv
```

Expected: root `200`, unauthenticated private boundary `401` or Azure auth redirect, unknown public ID `404`, hostname count `0`, and Azure state `Ready`.

- [ ] **Step 8: Verify real browser behavior on the generated host**

Using the in-app browser, verify desktop and mobile: visible `Continue with GitHub`, exact-owner sign-in, Drive health, create/save/rescan, attachment, publish, anonymous public view in a signed-out context, revoke to `404`, no horizontal overflow, and no console secret/error leakage. Use `domcontentloaded`.

- [ ] **Step 9: Report the release boundary**

Report exact commit SHA, workflow run URL/status, Azure resource names/SKU/state, generated hostname, HTTP codes, browser results, Drive root health, and `customHostnames=0`. State explicitly: `DNS=unchanged`, `IHS=unchanged`, `custom-domain=not-started`.
