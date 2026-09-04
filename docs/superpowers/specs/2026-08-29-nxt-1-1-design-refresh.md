# NXT 1.1 Design Refresh

**Status:** Approved in chat on 2026-08-29.

**Extends:** `docs/superpowers/specs/2026-08-23-nxt-markdown-vault-design.md`

**Visual baseline:** `docs/design/NXT_VISUAL_SPEC.md`

## 1. Summary

NXT 1.1 is an evolutionary design refresh for the existing private-first
Markdown workspace. It preserves the approved Gruvbox identity, Drive-first
architecture, exact GitHub-owner boundary, immutable unlisted publication
model, CodeMirror editor, recoverable IndexedDB drafts, and equal desktop and
mobile priority.

The refresh addresses product growth since the original visual concept. NXT
now has a real vault tree, search, favorites, tags, wiki links, backlinks,
attachments, publication state, conflict recovery, folder operations, a
command palette, empty-vault creation, loading/error states, and public note
views. The interface must make these capabilities understandable without
turning NXT into a dashboard, marketing page, or full Obsidian clone.

The target is a calmer, more legible workspace with:

- an informative but restrained owner sign-in entry;
- adaptive desktop, tablet, and mobile compositions;
- visible access to frequent capture and note actions;
- consistent loading, empty, disabled, offline, conflict, and error states;
- contrast-safe controls and status communication; and
- focused component boundaries that keep the existing React application
  maintainable.

## 2. Evidence and design constraints

The 2026-08-29 audit captured the live unauthenticated desktop and mobile
login routes. Both rendered without relevant console warnings or errors. The
authenticated production workspace could not be captured without an owner
session, and the canonical local NXT ports could not be used because port 5173
was owned by a separate STK preview. No foreign process was stopped.

The authenticated design review therefore also used the current source,
existing end-to-end journeys, the approved concept set, and the current visual
specification. Implementation acceptance still requires fresh authenticated
browser captures after the normal NXT local stack becomes available.

The following decisions remain locked unless separately approved:

- Google Drive is canonical; IndexedDB is draft recovery only.
- Private access requires GitHub provider plus exact owner `aserdargun`.
- Public notes are immutable, unlisted, `noindex`, and revocable snapshots.
- No graph, canvas, plugins, collaboration, public directory, or active content
  rendering is added.
- Gruvbox dark remains the initial theme; light and system themes remain.
- NXT remains an editor workspace, not a card dashboard, AI surface, or
  marketing product.
- Deployment, GitHub, Azure, Google Drive, DNS, and custom-domain mutations are
  outside this design refresh.

## 3. Goals

1. Reduce the time from arrival to a trusted owner workspace.
2. Keep editing dominant while making frequent note actions discoverable.
3. Give tablet widths a deliberate layout instead of compressing three columns.
4. Recover useful vertical space on mobile without hiding attachment and
   publication actions.
5. Let loading, offline, disabled, conflict, success, and failure states explain
   both the current state and the next safe action.
6. Meet or exceed the existing keyboard, reduced-motion, touch-target, and
   serious-axe acceptance gates while adding manual contrast and focus checks.
7. Preserve current APIs, storage behavior, security boundaries, and route
   structure.

## 4. Non-goals

- Tabs, split resizing, pop-out windows, multi-note editing, or persistent
  workspace layouts.
- A new settings subsystem; current theme, rescan, and sign-out controls remain
  lightweight workspace actions.
- Native share-sheet integration, push notifications, background sync, or a
  service worker.
- A new icon family, illustration system, remote font, image-generation asset,
  or decorative brand layer.
- Changes to note, attachment, publication, Drive, authentication, or API
  contracts unless a narrowly required presentation field is identified during
  implementation and separately reviewed.

## 5. Experience architecture

### 5.1 Entry and authentication

`/` continues to resolve to the sign-in entry. `/login` remains a quiet owner
surface, but it must explain the trust model before the GitHub action:

- brand: `NXT`;
- heading: `Private Markdown workspace`;
- supporting line: `Owner access only. GitHub verifies identity; notes remain in Google Drive.`;
- primary action: `Continue with GitHub`;
- secondary status line: `Private by default · Unlisted snapshots only`.

The page uses the existing Gruvbox frame, no hero, illustration, feature grid,
testimonial, marketing navigation, or analytics copy. At desktop size the
content sits in a compact sign-in panel no wider than 420px. On mobile it uses
the full available width with at least 20px side padding. The GitHub action is
at least 44px high, remains an ordinary link, and retains a visible focus ring.

Session and vault loading states use the same frame. Loading must show the NXT
brand, a short visible status (`Checking owner access` or `Loading vault`), and
a reduced-motion-safe progress indicator. A user must never see an apparently
empty route while work is pending.

Authentication errors distinguish:

- wrong GitHub owner: existing safe message plus `Sign out`;
- temporary service failure: `NXT could not verify access` plus `Try again`;
- vault load failure: `The vault could not be loaded safely` plus `Try again`.

Retry re-runs only the failed query and must not clear a recoverable draft.

### 5.2 Desktop workspace: 1200px and wider

Desktop preserves the three-column model:

```text
Explorer (240-300px) | Editor (minmax 480px, 1fr) | Context (320-420px)
```

The outer grid uses bounded tracks rather than `23fr 47fr 30fr`. The editor
receives all remaining space and remains the largest column. Column dividers
are visual separators, not draggable controls.

The header is split into three aligned zones:

- left: NXT brand and one command-palette trigger;
- center: active note path and save/draft status;
- right: attachment, publication, and overflow actions.

The desktop destination icons are removed because all primary regions are
already visible. They must not imply that visible panes behave like mutually
exclusive mobile destinations.

The context column owns Preview, Outline, and Backlinks tabs. Info is not a
fourth peer tab. Note-specific attachment and publication details are shown in
a compact lower section beneath the active context tab, separated by a clear
heading. Global actions such as theme, rescan, and sign-out live in the
overflow menu.

### 5.3 Tablet workspace: 768px to 1199px

Tablet uses a two-region composition rather than three compressed columns:

```text
Optional explorer (240-280px) | Primary surface (remaining width)
```

The primary surface switches between Editor and Preview/Info using a labeled
segmented destination control in the header. Explorer can be shown or hidden
with a labeled button; closing it never changes the active note. Backlinks and
Outline remain tabs inside the Preview surface.

At widths below 900px the explorer opens as a modal side sheet over the primary
surface. The sheet traps focus, closes on Escape, restores focus to its trigger,
and does not create document-level horizontal overflow. No drag gesture is the
only way to open or close it.

### 5.4 Mobile workspace: below 768px

Mobile keeps one active destination and the existing Files, Editor, Preview,
and Info bottom navigation. The navigation remains 68px or smaller, respects
safe-area insets, and preserves 44×44 minimum targets.

The current 140px three-row header is replaced by:

1. a 52px title row containing NXT/back-to-files affordance, truncated note
   title, and a true overflow menu; and
2. a 48px contextual row containing the visible save/draft state plus two
   directly reachable note actions: attachment and publication.

The maximum fixed top footprint is therefore 100px before safe-area handling.
The active note path moves into a one-line breadcrumb immediately above the
editor or preview content and scrolls with that surface. This preserves context
without permanently consuming a third header row.

The overflow button opens a real menu. Its label is `More actions`, not `Info`.
It contains at least Quick note, command palette, favorite/unfavorite, theme,
rescan, and sign-out when those actions are available. Destructive or currently
unavailable actions retain their existing confirmation and disabled-reason
rules.

Quick note remains the existing `Quick note in Inbox` operation. The refresh
only makes it visible; it does not add native sharing or background capture.

## 6. Action and navigation model

NXT uses three action levels:

1. **Always visible:** current-note attachment, publish/revoke state, save/draft
   state, and the mobile destination bar.
2. **Contextual menu:** rename, move, archive, favorite, folder actions, theme,
   rescan, and sign-out.
3. **Command palette:** the complete keyboard-first command inventory and
   searchable access to every supported command.

The command palette remains available through `Meta+K`. A visible palette
trigger includes the shortcut hint on desktop. Disabled actions must show both
their label and a concise reason. Disabled state cannot rely on opacity alone;
it also uses a disabled cursor, muted icon, and visible reason text where the
surface provides room.

The Files search input is labeled `Search files` and keeps current title, path,
tag, and full-text behavior. Empty search results show `No matching notes` and
offer `Clear search`. Empty vault and empty folder states expose the existing
New note and Quick note operations instead of dead-end prose.

## 7. Status, feedback, and recovery

### 7.1 Shared status model

Every asynchronous surface communicates:

- what is happening;
- whether the user may continue editing;
- what data remains safe; and
- the next available action.

Shared status presentations are:

- **inline status:** save, upload, publication check, and copy confirmation;
- **surface state:** initial loading, empty vault, search empty, and route error;
- **persistent recovery banner:** offline draft, save failure, and unresolved
  conflict;
- **modal decision:** version conflict, revoke, and destructive folder Trash.

Inline messages use `aria-live="polite"`; destructive failures and data-loss
risks use `role="alert"`. Status is never expressed by color alone.

### 7.2 Save and offline states

The save state vocabulary remains `Saved`, `Saving`, `Offline draft`,
`Conflict`, and `Error`. `Offline draft` and `Error` include a short tooltip or
expanded message stating that the local recovery draft remains available.
`Saving` does not block editor input. `Saved` remains visually quiet.

### 7.3 Conflict dialog

The three approved outcomes remain unchanged. Desktop retains equal local and
Drive panes. Mobile keeps stacked panes but adds an explicit `Local draft` /
`Drive version` section index at the top of the scroll area so the relationship
is understandable before the actions.

The primary action remains `Merge versions`. `Keep Drive version` and `Save
local as a new note` remain visually secondary. All three actions stay visible
after pane scrolling; on mobile they occupy a sticky dialog footer that does
not obscure the focused control.

## 8. Attachments and publication

Attachment upload continues to accept one bounded file at a time and preserves
the current safety policy. User-facing changes are limited to presentation:

- upload progress stays attached to the triggering action;
- failures appear in an inline callout with ordinary text plus an error icon or
  border, rather than low-contrast red text alone;
- attachment cards display filename, type, and size before the open/download
  action;
- raster previews retain natural aspect ratio and show the filename in the
  expanded viewer; and
- mobile attachment actions do not cause horizontal overflow.

The publication dialog continues to state that the output is immutable,
unlisted, and `noindex`. After success, the note-details surface shows a compact
publication record with `Open link`, `Copy link`, and `Revoke`. Note details
appear in the Info destination on mobile and in the lower Context section on
desktop and tablet. Copy success is both visibly confirmed and announced.
Revoke remains confirmation-gated and must not disappear from the UI until the
public endpoint has been verified as unreachable by the existing publication
client.

## 9. Visual system and accessibility

### 9.1 Gruvbox tokens

The palette remains Gruvbox. Existing surface and text values stay locked. The
refresh separates semantic use from raw palette values:

- `--separator`: subtle panel division; may remain low contrast because it does
  not carry control meaning;
- `--control-border`: minimum 3:1 contrast against its immediate surface for
  inputs, selects, menus, and actionable card boundaries;
- `--text-danger` and `--text-warning`: minimum 4.5:1 for normal-size text;
- `--danger-border` and `--warning-border`: minimum 3:1 for state indication;
- `--focus-ring`: at least a 2 CSS-pixel perimeter and 3:1 change of contrast;
  and
- `--text-muted`: minimum 4.5:1 wherever it conveys required instructions or
  state.

Decorative separators may use lower contrast. Interactive boundaries and state
meaning may not.

### 9.2 Typography and density

The existing system-font UI stack and monospace editor stack remain. Remote
fonts are not added. Desktop chrome stays in the 12-14px range; required helper
and error text may not be smaller than 12px and must meet contrast. Mobile
editor text remains at least 16px. Line lengths in rendered Markdown target
65-80 characters where panel width allows.

### 9.3 Focus, touch, and motion

- Every visible mobile interactive target remains at least 44×44 CSS pixels.
- Desktop compact controls may be smaller only when they retain at least a
  24×24 target and adequate spacing; principal actions remain 44px high.
- Fixed headers, sticky dialog actions, and bottom navigation must not fully
  obscure the focused element. Scroll containers define matching
  `scroll-padding`.
- Focus order follows Files, Editor, Context, then global actions on desktop;
  it follows the visible surface before bottom navigation on mobile.
- Reduced motion keeps every state understandable with transitions removed.
- No new drag-only, hover-only, or gesture-only interaction is introduced.

## 10. React component boundaries

The refresh decomposes presentation without altering service or domain
ownership:

- `OwnerShell` retains orchestration and state ownership but delegates layout;
- `WorkspaceHeader` owns desktop/tablet/mobile header composition;
- `WorkspaceActions` owns visible and overflow action presentation;
- `ResponsiveWorkspace` selects desktop, tablet, or mobile composition;
- `MobileDestinationNav` owns the fixed mobile navigation;
- `OwnerOverflowMenu` owns global/contextual commands;
- `RouteState` owns branded loading, forbidden, error, and retry states;
- `StatusCallout` owns accessible inline/persistent feedback; and
- existing Editor, Explorer, Attachment, Publication, and Conflict components
  keep their data behavior.

Breakpoint state is derived from `matchMedia` subscriptions. It is not copied
into multiple effects or persisted as preferences. Heavy Editor, Search,
Command Palette, and dialog modules remain lazily loaded. Static destination and
action metadata stays at module scope. The refresh must not add unnecessary
global listeners or cause the editor to remount when only the responsive
composition changes.

## 11. Error handling and data flow

The UI continues to consume the existing typed clients. The refresh may call
existing query `refetch` functions for retry but does not bypass React Query,
call Drive directly, or invent optimistic server state.

Presentation errors map to controlled messages at the component boundary.
Unknown server errors remain redacted. Retry actions are idempotent reads unless
the existing domain flow already defines a guarded mutation retry. Publication,
attachment, folder Trash, and conflict mutations keep their current busy gates
and verification requirements.

Responsive navigation changes visibility only. It must not clear editor source,
draft state, search text, selected note, context tab, publication state, or
folder expansion. Moving between breakpoints must preserve the current note and
editor selection where CodeMirror permits.

## 12. Acceptance criteria

### 12.1 Visual and responsive

- Desktop at 1440×1000 shows Explorer, Editor, and Context simultaneously;
  Editor is the largest column and no destination icons imply pane switching.
- Tablet at 1024×768 shows at most two primary regions; no track is compressed
  below its declared minimum and no document-level horizontal overflow exists.
- Mobile at 390×844 has a fixed top footprint no greater than 100px before safe
  areas, exposes attachment and publication directly, and preserves all four
  bottom destinations.
- Login at desktop and mobile explains owner-only access and the Drive/GitHub
  trust split without marketing content.
- Light, dark, and system themes render every changed surface.

### 12.2 Interaction

- A first note can be created from an empty vault.
- Quick note is reachable in at most two actions on mobile.
- `Meta+K` opens the complete command palette and restores focus on close.
- Mobile overflow is labeled and behaves as a menu, not an Info shortcut.
- Breakpoint changes preserve selected note, unsaved editor content, search,
  and destination state.
- Loading, retry, offline draft, upload failure, publication success/revoke,
  and conflict flows each expose a clear next action.

### 12.3 Accessibility

- Existing serious-axe checks continue to pass for login, owner workspace,
  command palette, dialogs, and public note.
- Manual token assertions prove 4.5:1 required text contrast and 3:1 required
  control/state boundary contrast in both themes.
- Keyboard-only journeys cover sign-in link focus, Files tree, editor, context
  tabs, overflow menu, command palette, conflict dialog, and publication dialog.
- Focus is never fully hidden behind fixed or sticky UI.
- Reduced-motion and 200% browser zoom retain usable order and no horizontal
  document overflow.

### 12.4 Performance and regression

- The editor does not remount during ordinary destination or breakpoint
  changes.
- Existing lazy-loading boundaries remain or improve.
- No new network request is caused solely by a responsive layout transition.
- Existing owner, mobile, accessibility, publication, conflict, security,
  build, typecheck, lint, and lifecycle gates pass.

## 13. Verification plan

Implementation is complete only after:

1. component tests cover new route states, overflow actions, responsive
   composition, disabled reasons, and retry behavior;
2. current end-to-end journeys are updated rather than duplicated;
3. authenticated desktop, tablet, and mobile screenshots are captured in a
   fresh run;
4. screenshots are inspected against the approved Gruvbox concepts and this
   spec, with intentional deviations recorded;
5. console errors/warnings, page identity, framework overlays, interactions,
   focus, touch targets, overflow, reduced motion, and axe results are checked;
6. the full repository validation contract passes using Node 22; and
7. the checkout-owned stack is stopped and Git status is reported.

No commit, push, deployment, Azure/Drive/GitHub mutation, or custom-domain work
is included without separate explicit authorization.
