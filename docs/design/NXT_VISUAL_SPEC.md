# NXT Visual Implementation Spec

Status: approved NXT 1.1 evolution on 2026-08-29.

## Accepted concept set

- `concepts/nxt-desktop-primary.png` — desktop primary editor, native concept size 1505×1045.
- `concepts/nxt-mobile-primary.png` — mobile primary editor, native concept size 853×1844; implementation acceptance viewport remains 390×844 CSS pixels.
- `concepts/nxt-desktop-conflict.png` — desktop version-conflict state, native concept size 1505×1045.

The generated screenshots establish composition, density, panel anatomy, typography relationships, palette, control geometry, icon treatment, and responsive continuation. Exact product copy and behavior come from the approved product spec and implementation plan; minor spelling artifacts inside generated pixels are not product copy.

## Approved NXT 1.1 deviations from the 2026-08-23 concepts

- Desktop destination icons are removed because all panes are visible.
- Fixed desktop ratios are replaced with bounded tracks.
- Tablet has a two-region composition.
- The mobile fixed header is reduced from 140px to 100px.
- The mobile note path scrolls with content.
- More actions is a real menu.
- Semantic control/error tokens improve contrast without changing Gruvbox surface colors.

## Visual direction and container model

- Authentic Obsidian Gruvbox-inspired, warm dark editor surface; no marketing wrapper.
- Desktop uses a narrow explorer, a dominant Markdown editor, and a medium preview/context panel with crisp vertical separators.
- Mobile uses one active full-screen surface and a fixed bottom destination bar for Files, Editor, Preview, and Info.
- Use open panels, rails, rows, tabs, and lists. Do not introduce bento grids, floating card collections, glass, gradients, decorative illustrations, hero content, pills, badges, fake analytics, or AI chat.
- Radii are restrained at 4–6px. Borders are 1px. Shadows are absent except for modal elevation and the smallest mobile-navigation separation.
- Motion is limited to focus, selection, panel transitions, and dialog entry; reduced-motion removes nonessential transitions.

## Color lock

The default background is the exact warm dark Gruvbox family, not black, gray-blue, cream, or a gradient.

| Token | Value | Use |
|---|---:|---|
| `--bg` | `#282828` | editor and root background |
| `--surface` | `#32302f` | toolbar and raised rows |
| `--panel` | `#3c3836` | dialogs and active controls |
| `--border` | `#504945` | separators and input borders |
| `--text` | `#ebdbb2` | primary text |
| `--muted` | `#a89984` | secondary labels and line numbers |
| `--yellow` | `#d79921` | selection, headings, focus, primary action |
| `--green` | `#b8bb26` | saved and additions |
| `--blue` | `#83a598` | links and wiki targets |
| `--orange` | `#d65d0e` | warnings and code accents |
| `--red` | `#cc241d` | errors and removals |

Light and system themes reuse the same semantic tokens with Gruvbox-light values; dark remains the initial state.

## Typography

- UI chrome: `Inter`, `ui-sans-serif`, `-apple-system`, `BlinkMacSystemFont`, `"Segoe UI"`, sans-serif; use locally available/system fonts only, with no remote font dependency.
- Editor/code: `"SFMono-Regular"`, `"Cascadia Code"`, `"Roboto Mono"`, `ui-monospace`, monospace.
- Desktop chrome is 12–14px, editor text 15–16px with 1.55–1.65 line height, rendered note body 15–17px, and note title 28–30px.
- Mobile chrome is 13–15px, editor text 16px minimum, and touch labels remain readable without zoom.
- Buttons, tabs, tree rows, inputs, status text, dialog labels, and bottom navigation all receive explicit sizes and line heights; browser-default typography is prohibited.

## Exact visible-copy inventory

Primary chrome may use: `NXT`, `Files`, `Favorites`, `Tags`, `Notes`, `Inbox`, `Plans`, `Archive`, `Editor`, `Preview`, `Info`, `Outline`, `Backlinks`, `Add attachment`, `Publish`, `Saved`, `Saving`, `Offline draft`, `Conflict`, `Error`, and the active note path/title supplied by data.

Conflict UI uses exactly: `Version conflict`, `This note changed in Drive while you were editing.`, `Local draft`, `Drive version`, `Keep Drive version`, `Save local as a new note`, and `Merge versions`.

No eyebrow, kicker, badge, product claim, metric, or explanatory marketing copy is allowed above the fold.

## Component and icon inventory

- App shell: top toolbar, explorer rail, editor region, context region, status bar, and mobile bottom navigation.
- Explorer: search field, ARIA tree rows, disclosure chevrons, folder/file icons, favorite rows, tag rows with counts, selected row stripe, and footer utility actions.
- Editor: breadcrumb/path, action group, CodeMirror gutter/content, save state, attachment/publish actions, and narrow status footer.
- Context: text tabs, rendered preview, outline, backlink list, and section dividers.
- Dialog family: compact header, close action, body, footer, visible focus ring, and restrained elevation. Conflict mode uses equal diff panes on desktop and stacked panes on mobile.
- Command palette reuses the dialog family and list-row geometry; it does not create a separate visual language.
- Icons use the Lucide outline family where it matches the concepts: 1.5–2px strokes, round caps/joins, 16–20px desktop and 22–24px mobile, `currentColor`, no filled-icon substitution except checkbox/status states shown in the concepts.
- Every interactive target is at least 44×44 CSS pixels on touch viewports and has a visible yellow `:focus-visible` ring.

## Responsive continuation

- At desktop width, explorer/editor/context columns remain simultaneously visible; the editor owns the largest share.
- At tablet width, the explorer and one selected primary destination form the two-region composition; compact tablet widths move the explorer into a focus-contained sheet.
- At mobile width, only one destination surface is visible. Bottom navigation preserves Files, Editor, Preview, and Info feature parity.
- Attachment and Publish remain directly reachable on mobile; the two fixed header rows remain at or below 100px, while the note path scrolls with its destination content.
- More actions opens an accessible menu whose direct Quick note in Inbox path takes no more than two user clicks.
- Dialog panes stack vertically below the mobile breakpoint. Long filenames and paths truncate with an accessible full-value label.
- No viewport may have document-level horizontal overflow.

## Fidelity acceptance

Final visual verification must compare browser captures to all three accepted concepts with `view_image`. At minimum compare composition, panel widths, palette, typography, selected/focus states, controls/icons, dialog anatomy, and mobile overflow. Any intentional deviation must be recorded before handoff.
