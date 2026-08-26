### Task 13: Complete attachments, publish controls, and the anonymous public view

**Planned files:**
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
- Consumes: the exact-owner private attachment/publication APIs, the anonymous note/asset APIs, the current note version, and Task 12's safe opaque attachment projection.
- Produces: bounded upload/paste/download UI, durable owner publication status and publish/revoke controls, `/p/:publicId`, `noindex,nofollow`, and safe public asset rendering.

## Frozen acceptance contract

- Begin with focused RED tests. Keep every Task 10-12 responsive, auth, navigation, exact-folder, attachment-rendering, autosave, recovery, and conflict invariant green.
- Add typed, fail-closed web clients for private attachments, private publication/status, and anonymous note reads. Parse every JSON response with shared contracts; reject unexpected success bodies. Never accept or construct raw Drive URLs or IDs.
- The current private publication API lacks a durable read path. Add the minimum exact-owner `GET /api/private/notes/{noteId}/publication` projection needed for reload-safe controls. It returns either `null` or only `{ publicId, publishedAt, sourceVersion, attachmentCount }`; it resolves the manifest entry by stable note ID and its `activeRevisionId`, never exposes snapshot/folder/Drive IDs, and fails closed on inconsistent manifest state. Extend shared source/dist contracts and route/function/service tests accordingly.
- Keep `POST /api/private/notes/{noteId}/publish` version-fenced by the exact current note version. A publish/republish result is accepted only after the private status read and anonymous `/api/public/notes/{publicId}` both confirm the expected public ID and source version boundary. Republish retains the same public ID and only the active immutable revision is reachable.
- Revoke uses an explicit Radix confirmation. Treat it as successful only after `DELETE /api/private/publications/{publicId}` and a subsequent cache-bypassed anonymous note read returns exactly `404`. Any other response keeps the owner status visible and reports a controlled error. Refresh owner vault/publication state after completion.
- The publish dialog shows current source version, complete referenced attachment count from the selected safe vault entry, and explicit unlisted/`noindex` language. It requires one confirmation, fences double submit, restores focus, exposes Copy link only for a contract-valid public ID, and uses the current origin plus `/p/<publicId>` without external URL input.
- Wire the existing header Add attachment/Publish buttons and Task 12 palette Publish/Revoke commands to the real selected note state. Revoke is enabled only for an authoritative private status; Publish is disabled while no current note/version exists or while save/conflict state is unsafe. Visible disabled reasons remain exact. Owner state survives route changes without leaking one note's publication to another.
- The attachment picker supports one file per file-input, drag/drop, or image-file paste action. It must reject more than exactly 20 MiB (`20 * 1024 * 1024`) before reading/base64 conversion or fetch, reject multi-file drops visibly, preserve ordinary text paste, fence concurrent/note-change/unmount completions, reset the input so the same file can be selected again, and surface typed server errors without raw bodies or identifiers.
- Encode upload bytes without argument-spread/call-stack hazards and send only `{ noteId, name, declaredMime, bytesBase64 }` to the same-origin private endpoint. Client MIME is only a declaration; render from the server-classified response. After exact upload success, refresh the complete vault, then insert one portable, percent-encoded relative `_assets/<note-id>/<server-name>` Markdown reference into the current source. Inline images use image syntax; PDF/download assets use links. Never insert before persistence succeeds.
- Existing attachment cards consume only Task 12's opaque `assetId` and safe metadata. Inline only server-classified PNG/JPEG/WebP/GIF and PDF using same-origin `/api/private/attachments/<opaque>`; all other files are same-origin downloads. Trash is explicit, relies on the server reference fence, and refreshes the vault only on exact success. Do not use `blob:`, `data:`, external, or raw Drive URLs for persisted assets.
- `/p/:publicId` is a route-level lazy anonymous surface. It validates the route ID before fetch, calls only `/api/public/notes/<publicId>` and referenced `/api/public/assets/<publicId>/<assetId>`, renders the already server-sanitized projection, and never mounts/calls the session gate, private clients, owner shell, editor, command palette, Drive health, public directory, or sitemap. Missing, revoked, malformed, and malformed-success responses all show the same generic `Not found` surface.
- Public asset components accept only the typed asset list returned with that public note and exact same-public-ID root-relative URLs. Inline only server-classified safe images/PDF; everything else is a download. No arbitrary public asset lookup, query, fragment, redirect, raw HTML URL, or cross-public-ID substitution is allowed.
- Install and restore a single `meta[name="robots"]` value `noindex,nofollow` for the lifetime of every public route state, including loading and not-found. Preserve/restore any pre-existing metadata on unmount. The public page contains no owner controls, Drive labels/metadata, sign-in prompt, edit action, or public-list link.
- Use accessible 44 px controls, status/alert regions, dialog focus trap/restoration, keyboard activation, busy/disabled state, and Gruvbox tokens. Preserve Task 10's desktop 1505x1045 and mobile 390x844 single-surface layout. Prefer route/component lazy loading and do not introduce inline stateful component definitions or duplicate global listeners.
- Target browser flow: owner deep note route -> upload a small fixture -> canonical link/preview/attachment card -> publish -> copy/open anonymous link -> signed-out public page has no owner shell and clean console -> revoke -> anonymous page becomes generic Not found. Also verify oversize rejects before fetch, public asset allowlisting, desktop/mobile no overflow, page identity, no framework overlay, and focus restoration. Use IAB first and same-origin read-only fixtures; screenshots stay outside committed source.
- Validate focused RED/GREEN, full live-Drive-unset lint/typecheck/build/tests/project/static scans, source/dist parity, no credential/raw-ID leakage, and route bundle boundaries. The known missing Task 14 `scripts/verify-artifacts.mjs` remains a recorded baseline; do not implement Task 14 routing/lifecycle artifacts here.
- Node 22 only. Restore tracked build info, close only checkout-owned ports, commit implementation and a separate forced-added Task 13 report, and return a clean worktree. No Drive provisioning/access, GitHub, Azure, DNS, deployment, push, remotes, secrets, or other external mutable state.

## Planned RED examples

```tsx
it("rejects oversized files before reading or requesting", async () => {
  render(<AttachmentPicker noteId="123e4567-e89b-42d3-a456-426614174000" />);
  const large = new File([new Uint8Array(20 * 1024 * 1024 + 1)], "large.bin", { type: "application/octet-stream" });
  await userEvent.upload(screen.getByLabelText("Add attachment"), large);
  expect(screen.getByRole("alert")).toHaveTextContent("20 MB");
  expect(fetchMock).not.toHaveBeenCalled();
});
```

```tsx
it("keeps the anonymous route noindex and owner-free after revoke", async () => {
  render(<PublicNotePage publicId="AAAAAAAAAAAAAAAAAAAAAA" />);
  expect(await screen.findByRole("heading", { name: "Published plan" })).toBeVisible();
  expect(document.querySelector('meta[name="robots"]')).toHaveAttribute("content", "noindex,nofollow");
  expect(screen.queryByTestId("owner-shell")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
});
```
