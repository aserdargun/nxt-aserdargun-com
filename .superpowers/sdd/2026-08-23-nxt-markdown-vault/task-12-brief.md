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

## Controller integration and quality constraints

- Base is the current clean Task 11 completion. Preserve its one-second autosave, recovery, exact readback, conflict flow, Gruvbox shell, responsive thresholds, and all existing tests.
- The progress-ledger rulings permit typed vault/folder/preference API clients, note move/archive/Trash client methods, and the narrow shell/router/EditorWorkspace/style/test edits required for a real `/app` journey. Do not implement Task 13 upload/download/publication UI.
- Fetch every authenticated vault page using the typed cursor contract. Merge repeated relation pages for one note without duplicating data; any scalar mismatch, cursor loop, tree-version conflict, malformed response, unsafe size/page bound, or incomplete terminal state must fail closed. Never expose or retain raw Drive IDs.
- Extend the authenticated safe attachment projection with only an encoded opaque `assetId`, with shared contract, API projection, source/dist, and regression tests. Use this to resolve canonical existing attachment references to same-origin `/api/private/attachments/<opaque>` URLs.
- Replace Task 10's static explorer and context placeholders in the real owner route. Selecting a note navigates to `/app/notes/:noteId`; derive and inject the selected note's exact opaque parent-folder ID. Use `resolveWikiTarget` over complete title/alias data and navigate only exact resolved note IDs. This closes the Task 11 integration ruling.
- The file tree must implement real ARIA `tree`/`treeitem` semantics, roving tabindex, Home/End, ArrowUp/Down, ArrowLeft/Right expand/collapse/parent/child behavior, Enter/Space selection, and focus preservation across updates. Protected roots expose no destructive command.
- For folder Trash, compute visible note and attachment counts from the complete vault projection, display them with the server `descendantCount`, and submit the exact server-issued tree version and confirmation token. Never fabricate confirmation state.
- Search remains off-main-thread with a bounded request protocol, monotonic request IDs, stale-response fencing, explicit worker termination, and no remote code. Pin `minisearch@7.2.0`. Turkish matching uses `toLocaleLowerCase("tr-TR")` plus Unicode diacritic normalization while display text is unchanged. Only exact `tag:`, `folder:`, and `favorite:` filters are special; unknown filters remain query text.
- Prefer lazy loading for MiniSearch/search UI and the command palette. Keep a single deduplicated global Cmd/Ctrl+K listener with cleanup. Derive view state during render; use deferred values/transitions where worker/search result rendering is non-urgent; never define stateful components inside components.
- Tags, favorites, backlinks, and outline consume derived authenticated data. Backlink/wiki targets have separate resolved, unresolved, and ambiguous accessible states and only resolved targets navigate. Outline navigation must be based on the current real note source/rendered headings, not fixture copy.
- The command palette uses Radix Dialog focus trap/restoration. It exposes the exact approved command inventory; inapplicable commands are disabled and include a visible reason. Create/open/move/favorite/rescan/theme/sign-out actions use real typed clients or exact injected handlers. Publish/Revoke remain visibly disabled until Task 13 rather than being faked.
- Start with focused RED tests, then minimal implementation. Add integration tests proving real shell note/folder/resolver injection and keyboard-only create/open/move/palette close. Add regression coverage for pagination assembly, worker stale responses/termination, protected folders, confirmation tokens/counts, disabled reasons, focus restoration, and Task 10 responsive navigation.
- Browser target flow: `/app/notes/:noteId` → navigate tree/search/wiki → correct note route and context; Cmd/Ctrl+K → an applicable action or disabled reason → focus restored. Use the in-app Browser skill first. Validate page identity, meaningful DOM, no framework overlay, relevant console health, desktop 1505×1045, mobile 390×844, screenshots, and interaction evidence. If Browser invocation fails, record the exact blocker and use only the already permitted local Playwright fallback. Store temporary screenshots outside committed source.
- Node 22 only. Live Drive integration and all Google credential/folder variables remain unset; the opt-in live test stays skipped. Restore tracked build-info, close checkout-owned ports, commit implementation and a separate forced-added Task 12 report, and return a clean worktree. No Drive provisioning, GitHub, Azure, DNS, deployment, push, remotes, or other external mutable state.
