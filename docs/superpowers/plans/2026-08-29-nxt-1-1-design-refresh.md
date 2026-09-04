# NXT 1.1 Design Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve the existing NXT workspace into the approved NXT 1.1 desktop, tablet, and mobile experience without changing its Drive, authentication, publication, or draft-recovery contracts.

**Architecture:** Keep OwnerShell as the state and API orchestrator while extracting responsive layout, header, overflow actions, route states, and status presentation into focused React components. Preserve the existing EditorWorkspace subtree across breakpoint changes, use CSS plus one matchMedia-backed layout hook for composition, and extend the existing unit and Playwright journeys rather than introducing a second UI architecture.

**Tech Stack:** Node.js 22.23.1, pnpm 11.22.0, React 19.2.8, TypeScript 5.9.3, Vite 8.2.2, React Query 5.102.0, CodeMirror 6, Radix Dialog 1.1.23, Radix Dropdown Menu 2.1.24, Lucide React 1.33.0, Vitest 4.1.11, Testing Library 16.3.2, Playwright 1.62.1, axe-core 4.13.0, CSS custom properties.

**Spec:** docs/superpowers/specs/2026-08-29-nxt-1-1-design-refresh.md

## Global Constraints

- Preserve Google Drive as canonical storage and IndexedDB as draft recovery only.
- Preserve private access as GitHub provider plus exact owner aserdargun.
- Preserve immutable unlisted noindex public snapshots and current revoke verification.
- Do not add graph, canvas, tabs, split resizing, plugins, collaboration, a settings subsystem, a service worker, native sharing, remote fonts, generated art, or a new icon family.
- Gruvbox dark remains initial; light and system themes remain supported.
- Desktop begins at 1200px, tablet spans 768px through 1199px, and mobile ends at 767px.
- Mobile fixed top UI is at most 100px before safe-area handling.
- Mobile controls remain at least 44 by 44 CSS pixels. Desktop compact controls remain at least 24 by 24, while primary controls remain 44px high.
- Required normal-size text contrast is at least 4.5:1. Required control and state boundary contrast is at least 3:1.
- Focus indicators use at least a 2 CSS-pixel perimeter and may not be fully hidden by fixed or sticky UI.
- Responsive transitions must preserve selected note, editor source, draft state, editor view identity, search query, context tab, publication state, and folder expansion.
- Keep EditorWorkspace, SearchPanel, CommandPalette, and existing dialogs lazy where they are already lazy.
- No frontend path may call Google Drive directly or bypass the existing typed clients and React Query.
- Do not stop a foreign listener by port. The NXT lifecycle may stop only its exact checkout-owned stack.
- Do not commit, push, deploy, or mutate GitHub, Azure, Google Drive, DNS, or the custom domain without separate explicit authorization.

---

## File and responsibility map

### New files

- web/src/app/workspace-layout.ts
  - Defines WorkspaceLayout, WorkspaceViewport, breakpoint constants, getWorkspaceViewport, and useWorkspaceViewport.
- web/src/app/route-state.tsx
  - Owns branded loading, error, forbidden, and retry presentation.
- web/src/app/status-callout.tsx
  - Owns accessible inline and persistent informational, warning, and error feedback.
- web/src/app/owner-overflow-menu.tsx
  - Presents the approved contextual/global action subset with Radix menu semantics and visible disabled reasons.
- web/src/app/workspace-header.tsx
  - Renders desktop, tablet, and mobile header composition without owning vault or mutation state.
- web/src/app/mobile-destination-nav.tsx
  - Renders only the four mobile destinations.
- web/src/theme/workspace.css
  - Owns the NXT 1.1 shell, responsive workspace, header, side-sheet, menu, state, and safe-area rules.
- web/src/test/workspace-layout.test.tsx
  - Verifies breakpoint classification and subscription cleanup.
- web/src/test/route-state.test.tsx
  - Verifies visible status copy and retry behavior.
- web/src/test/owner-overflow-menu.test.tsx
  - Verifies keyboard menu behavior, action execution, disabled reasons, and error feedback.
- web/src/test/workspace-header.test.tsx
  - Verifies composition and action visibility for all three layouts.
- web/src/test/status-callout.test.tsx
  - Verifies roles and live-region behavior.
- web/src/test/theme-contrast.test.ts
  - Parses theme CSS and proves semantic contrast pairs.
- e2e/tablet-workspace.spec.ts
  - Verifies tablet two-region behavior, explorer sheet, focus restoration, and overflow.

### Existing files to modify

- web/package.json and pnpm-lock.yaml
  - Add only @radix-ui/react-dropdown-menu 2.1.24.
- web/src/main.tsx
  - Import workspace.css after layout.css.
- web/src/theme/gruvbox.css
  - Add semantic separator, control-border, strong-muted, warning, danger, and focus tokens for every theme branch.
- web/src/theme/layout.css
  - Remove shell/mobile rules moved to workspace.css and route changed selectors through semantic tokens.
- web/src/app/login-page.tsx
  - Add the approved owner and trust copy.
- web/src/app/owner-route.tsx
  - Use RouteState and React Query refetch for safe retry.
- web/src/app/owner-shell.tsx
  - Keep orchestration; consume the extracted layout/header/menu/nav/status components and remove embedded presentation components.
- web/src/editor/editor-workspace.tsx
  - Keep the editor subtree mounted and add mobile conflict section navigation hooks without changing autosave.
- web/src/editor/attachment-picker.tsx
  - Present upload failures through StatusCallout.
- web/src/editor/attachment-view.tsx
  - Add filename/type/size metadata and an image lightbox while preserving the existing asset URL and Trash flow.
- web/src/editor/conflict-dialog.tsx
  - Add mobile section navigation and sticky actions without changing resolution values.
- web/src/explorer/search-panel.tsx
  - Add the explicit no-results state and Clear search action.
- web/src/publication/publication-status.tsx
  - Make copy confirmation visible as well as announced.
- web/src/test/login-page.test.tsx
  - Assert approved sign-in copy and unchanged auth target.
- web/src/test/owner-shell.test.tsx
  - Replace old destination-ratio assertions with NXT 1.1 layout, state-preservation, and token assertions.
- web/src/test/attachment-picker.test.tsx
  - Assert accessible error callout.
- web/src/test/editor-workspace.test.tsx
  - Assert editor identity survives responsive visibility changes.
- web/src/test/public-note-page.test.tsx and web/src/test/publish-dialog.test.tsx
  - Preserve public/private separation and publication copy.
- playwright.config.ts
  - Add a 1024 by 768 tablet project.
- e2e/mobile-workspace.spec.ts
  - Verify the 100px header budget, real overflow menu, Quick note reachability, and four destinations.
- e2e/accessibility.spec.ts
  - Cover the overflow menu and new route states.
- e2e/visual-layout.spec.ts
  - Check focus visibility, safe fixed regions, and layout-specific overflow.
- docs/design/NXT_VISUAL_SPEC.md
  - Record NXT 1.1 as the accepted evolution and list intentional deviations from the 2026-08-23 concepts.

### Files that must not change

- packages/contracts
- packages/domain
- api
- web/src/api
- scripts
- staticwebapp.config.json files
- Azure and GitHub workflow files

---

### Task 1: Add semantic Gruvbox tokens and contrast contracts

**Files:**
- Modify: web/src/theme/gruvbox.css:1-124
- Modify: web/src/theme/layout.css:1-120, 640-680, 920-1050, 1340-1380
- Create: web/src/test/theme-contrast.test.ts
- Modify: web/src/test/owner-shell.test.tsx:1-80, 288-380

**Interfaces:**
- Consumes: existing Gruvbox raw tokens --bg, --surface, --panel, --border, --text, --muted, --yellow, --orange, and --red.
- Produces: --separator, --control-border, --text-muted-strong, --text-warning, --text-danger, --warning-border, --danger-border, and --focus-ring in dark, light, system-dark, and system-light branches.

- [ ] **Step 1: Write the failing semantic-token contrast test**

Create web/src/test/theme-contrast.test.ts with the complete luminance helper and explicit expectations:

~~~ts
import { describe, expect, it } from "vitest";
import gruvboxCss from "../theme/gruvbox.css?raw";

const hex = (source: string, token: string): string => {
  const match = source.match(new RegExp(`${token}:\\s*(#[0-9a-f]{6})`, "iu"));
  if (match?.[1] === undefined) throw new Error(`Missing ${token}`);
  return match[1];
};

const luminance = (value: string): number => {
  const channels = value.match(/[0-9a-f]{2}/giu)?.map((part) => Number.parseInt(part, 16) / 255) ?? [];
  return channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
};

const ratio = (first: string, second: string): number => {
  const left = luminance(first);
  const right = luminance(second);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
};

describe("NXT 1.1 semantic theme tokens", () => {
  it("keeps required dark text and control boundaries above their thresholds", () => {
    expect(ratio(hex(gruvboxCss, "--text-danger"), "#3c3836")).toBeGreaterThanOrEqual(4.5);
    expect(ratio(hex(gruvboxCss, "--text-warning"), "#3c3836")).toBeGreaterThanOrEqual(4.5);
    expect(ratio(hex(gruvboxCss, "--text-muted-strong"), "#3c3836")).toBeGreaterThanOrEqual(4.5);
    expect(ratio(hex(gruvboxCss, "--control-border"), "#3c3836")).toBeGreaterThanOrEqual(3);
    expect(ratio(hex(gruvboxCss, "--danger-border"), "#3c3836")).toBeGreaterThanOrEqual(3);
  });
});
~~~

- [ ] **Step 2: Run the test and verify the new tokens are missing**

Run:

~~~sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/web test -- theme-contrast.test.ts
~~~

Expected: FAIL with Missing --text-danger.

- [ ] **Step 3: Add exact semantic values to every theme branch**

Use these values:

~~~css
/* dark and system-dark */
--separator: #504945;
--control-border: #928374;
--text-muted-strong: #bdae93;
--text-warning: #fe8019;
--text-danger: #ff7b72;
--warning-border: #fe8019;
--danger-border: #fb4934;
--focus-ring: #fabd2f;

/* light and system-light */
--separator: #bdae93;
--control-border: #504945;
--text-muted-strong: #504945;
--text-warning: #7c2d00;
--text-danger: #9d0006;
--warning-border: #7c2d00;
--danger-border: #9d0006;
--focus-ring: #b57614;
~~~

Keep the original locked palette tokens unchanged. Route actionable input borders to --control-border, required muted instructions to --text-muted-strong, error text to --text-danger, warning text to --text-warning, and purely decorative panel dividers to --separator.

- [ ] **Step 4: Extend the test to parse all four theme branches**

Reuse the existing parseStyleRules helper from owner-shell.test.tsx. Assert each theme branch defines all eight tokens and that resolved dark and light pairs meet the thresholds. Keep the existing yellow heading and orange code assertions unchanged.

- [ ] **Step 5: Run focused theme and owner-shell tests**

Run:

~~~sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/web test -- theme-contrast.test.ts owner-shell.test.tsx
~~~

Expected: PASS.

- [ ] **Step 6: Record the review checkpoint**

Run:

~~~sh
git diff --check
git status --short
~~~

Expected: only Task 1 theme and test files plus the already approved spec/plan are changed. Do not commit.

---

### Task 2: Build informative login and reusable route states

**Files:**
- Create: web/src/app/route-state.tsx
- Modify: web/src/app/login-page.tsx:1-16
- Modify: web/src/app/owner-route.tsx:1-112
- Modify: web/src/theme/layout.css:68-160
- Create: web/src/test/route-state.test.tsx
- Modify: web/src/test/login-page.test.tsx
- Create: web/src/test/owner-route.test.tsx

**Interfaces:**
- Produces:

~~~ts
export interface RouteStateProps {
  readonly state: "loading" | "error" | "forbidden";
  readonly title: string;
  readonly message?: string;
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
  readonly children?: React.ReactNode;
}

export const RouteState: (props: RouteStateProps) => React.JSX.Element;
~~~

- Consumes: React Query result refetch methods; it never receives a QueryClient and never clears cached draft state.

- [ ] **Step 1: Write failing route-state and login tests**

The route-state test must assert visible loading copy, aria-busy, alert semantics, and retry:

~~~tsx
it("shows visible loading copy and retries an error once", async () => {
  const retry = vi.fn();
  const user = userEvent.setup();
  const view = render(<RouteState state="loading" title="Loading vault" />);
  expect(screen.getByRole("status", { name: "Loading vault" })).toHaveAttribute("aria-busy", "true");
  view.rerender(
    <RouteState
      state="error"
      title="NXT could not verify access"
      message="The service is temporarily unavailable."
      onRetry={retry}
    />
  );
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(retry).toHaveBeenCalledOnce();
});
~~~

Extend login-page.test.tsx:

~~~tsx
expect(screen.getByRole("heading", { name: "Private Markdown workspace" })).toBeVisible();
expect(screen.getByText("Owner access only. GitHub verifies identity; notes remain in Google Drive.")).toBeVisible();
expect(screen.getByText("Private by default · Unlisted snapshots only")).toBeVisible();
expect(screen.getByRole("link", { name: "Continue with GitHub" })).toHaveAttribute("href", GITHUB_LOGIN_PATH);
~~~

- [ ] **Step 2: Run focused tests and verify failure**

Run:

~~~sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/web test -- route-state.test.tsx login-page.test.tsx
~~~

Expected: FAIL because RouteState and approved copy do not exist.

- [ ] **Step 3: Implement RouteState**

Use a shared brand frame. Loading renders a visible status label and a CSS progress line; error and forbidden render their title as h1. Retry is a normal button:

~~~tsx
export const RouteState = ({
  state,
  title,
  message,
  onRetry,
  retryLabel = "Try again",
  children
}: RouteStateProps): React.JSX.Element => (
  <div className="route-page">
    <header className="route-header"><span className="brand">NXT</span></header>
    <main className="route-main route-state-main">
      {state === "loading" ? (
        <div className="route-progress" role="status" aria-label={title} aria-busy="true">
          <span>{title}</span>
          <span className="route-progress-line" aria-hidden />
        </div>
      ) : (
        <div className="route-state-copy">
          <h1>{title}</h1>
          {message === undefined ? null : <p>{message}</p>}
          {onRetry === undefined ? null : (
            <button className="primary-action touch-target" type="button" onClick={onRetry}>
              {retryLabel}
            </button>
          )}
          {children}
        </div>
      )}
    </main>
  </div>
);
~~~

- [ ] **Step 4: Update LoginPage with the approved copy**

Keep GITHUB_LOGIN_PATH unchanged. Use a compact .login-panel and ordinary anchor:

~~~tsx
<main className="route-main" aria-labelledby="login-title">
  <section className="login-panel">
    <p className="login-owner">Owner workspace</p>
    <h1 id="login-title">Private Markdown workspace</h1>
    <p>Owner access only. GitHub verifies identity; notes remain in Google Drive.</p>
    <a className="primary-link touch-target" href={GITHUB_LOGIN_PATH}>Continue with GitHub</a>
    <p className="login-trust">Private by default · Unlisted snapshots only</p>
  </section>
</main>
~~~

- [ ] **Step 5: Route session and vault states through RouteState**

In OwnerGate, call session.refetch from the retry button. In OwnerVaultGate, call vault.refetch. Keep 401 navigation and 403 sign-out unchanged:

~~~tsx
if (session.isPending) return <RouteState state="loading" title="Checking owner access" />;
if (session.isError) {
  return (
    <RouteState
      state="error"
      title="NXT could not verify access"
      message="The service is temporarily unavailable."
      onRetry={() => { void session.refetch(); }}
    />
  );
}
~~~

Use title The vault could not be loaded safely for the vault error and Loading vault for its pending state.

- [ ] **Step 6: Add owner-route query tests**

Mock getSession and vaultClient.loadCompleteVault. Use a fresh QueryClient with retry false and MemoryRouter. Assert pending copy, one refetch after Try again, unchanged 401 redirect, and wrong-owner Sign out. The retry test must resolve on the second request and then render OwnerShell.

- [ ] **Step 7: Run focused and full web tests**

Run:

~~~sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/web test -- route-state.test.tsx login-page.test.tsx owner-route.test.tsx
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/web test
~~~

Expected: PASS.

- [ ] **Step 8: Record the review checkpoint**

Run git diff --check and git status --short. Do not commit.

---

### Task 3: Introduce one responsive workspace layout source

**Files:**
- Create: web/src/app/workspace-layout.ts
- Create: web/src/test/workspace-layout.test.tsx
- Modify: web/src/app/owner-shell.tsx:91-158, 572-646

**Interfaces:**
- Produces:

~~~ts
export type WorkspaceLayout = "mobile" | "tablet" | "desktop";
export interface WorkspaceViewport {
  readonly layout: WorkspaceLayout;
  readonly compactTablet: boolean;
}
export const MOBILE_MAX = 767;
export const COMPACT_TABLET_MAX = 899;
export const DESKTOP_MIN = 1200;
export const getWorkspaceViewport: () => WorkspaceViewport;
export const useWorkspaceViewport: () => WorkspaceViewport;
~~~

- Consumes: window.matchMedia with (max-width: 767px), (max-width: 899px), and (min-width: 1200px).

- [ ] **Step 1: Write failing layout classification tests**

Stub matchMedia by width. Assert 390 returns { layout: "mobile", compactTablet: false }, 768 returns { layout: "tablet", compactTablet: true }, 1024 returns { layout: "tablet", compactTablet: false }, and 1200 and 1505 return desktop with compactTablet false. Render a hook harness and capture addEventListener and removeEventListener calls to prove cleanup uses the same callback.

- [ ] **Step 2: Run the focused test and verify failure**

Run:

~~~sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/web test -- workspace-layout.test.tsx
~~~

Expected: FAIL because workspace-layout.ts does not exist.

- [ ] **Step 3: Implement classification and a single subscription**

Use one useSyncExternalStore subscription:

~~~ts
const snapshot = (): WorkspaceViewport => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return { layout: "desktop", compactTablet: false };
  }
  if (window.matchMedia(`(max-width: ${MOBILE_MAX}px)`).matches) {
    return { layout: "mobile", compactTablet: false };
  }
  if (window.matchMedia(`(min-width: ${DESKTOP_MIN}px)`).matches) {
    return { layout: "desktop", compactTablet: false };
  }
  return {
    layout: "tablet",
    compactTablet: window.matchMedia(`(max-width: ${COMPACT_TABLET_MAX}px)`).matches
  };
};

const subscribe = (onChange: () => void): (() => void) => {
  const mobile = window.matchMedia(`(max-width: ${MOBILE_MAX}px)`);
  const compactTablet = window.matchMedia(`(max-width: ${COMPACT_TABLET_MAX}px)`);
  const desktop = window.matchMedia(`(min-width: ${DESKTOP_MIN}px)`);
  mobile.addEventListener("change", onChange);
  compactTablet.addEventListener("change", onChange);
  desktop.addEventListener("change", onChange);
  return () => {
    mobile.removeEventListener("change", onChange);
    compactTablet.removeEventListener("change", onChange);
    desktop.removeEventListener("change", onChange);
  };
};

export const useWorkspaceViewport = (): WorkspaceViewport =>
  useSyncExternalStore(subscribe, snapshot, () => ({ layout: "desktop", compactTablet: false }));

export const getWorkspaceViewport = snapshot;
~~~

- [ ] **Step 4: Replace OwnerShell viewport hooks**

Delete useMobileViewport, useWideDesktopViewport, and their query helpers. Add:

~~~ts
const { layout, compactTablet } = useWorkspaceViewport();
const [explorerOpen, setExplorerOpen] = useState(true);

const isHidden = (destination: Destination): boolean => {
  if (layout === "desktop") return false;
  if (destination === "files") return layout === "tablet" ? !explorerOpen : activeDestination !== "files";
  return activeDestination !== destination;
};
~~~

Add data-layout={layout}, data-compact-tablet={compactTablet ? "true" : "false"}, and data-explorer-open={explorerOpen ? "true" : "false"} to owner-shell. Do not change EditorWorkspace keys or move its state into the layout hook.

- [ ] **Step 5: Add state-preservation regression test**

Render OwnerShell with a mutable matchMedia stub. Start at desktop, activate a destination, dispatch both media-query change listeners to tablet and mobile, and assert the same owner-shell instance keeps the selected note title, active destination, and Markdown editor DOM node. In editor-workspace.test.tsx, retain the same Markdown editor DOM node across hidden prop changes:

~~~tsx
const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
view.rerender(<EditorWorkspace {...props} hiddenEditor hiddenPreview={false} />);
expect(screen.getByRole("textbox", { name: "Markdown editor", hidden: true })).toBe(editor);
~~~

- [ ] **Step 6: Run workspace and editor tests**

Run:

~~~sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/web test -- workspace-layout.test.tsx owner-shell.test.tsx editor-workspace.test.tsx
~~~

Expected: PASS.

- [ ] **Step 7: Record the review checkpoint**

Run git diff --check and git status --short. Do not commit.

---

### Task 4: Add a real owner overflow menu and shared action execution

**Files:**
- Modify: web/package.json
- Modify: pnpm-lock.yaml
- Create: web/src/app/status-callout.tsx
- Create: web/src/app/owner-overflow-menu.tsx
- Create: web/src/test/status-callout.test.tsx
- Create: web/src/test/owner-overflow-menu.test.tsx
- Modify: web/src/app/owner-shell.tsx:803-930, 1050-1140

**Interfaces:**
- Consumes: readonly CommandPaletteAction[] from explorer/command-palette and onOpenCommandPalette.
- Produces:

~~~ts
export interface StatusCalloutProps {
  readonly tone: "info" | "warning" | "error";
  readonly children: React.ReactNode;
  readonly persistent?: boolean;
}

export interface OwnerOverflowMenuProps {
  readonly actions: readonly CommandPaletteAction[];
  readonly onOpenCommandPalette: () => void;
}
~~~

- [ ] **Step 1: Add the locked Radix dependency**

Run:

~~~sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/web add @radix-ui/react-dropdown-menu@2.1.24
~~~

Expected: web/package.json and pnpm-lock.yaml change; no other dependency is added.

- [ ] **Step 2: Write failing status and menu tests**

Status assertions:

~~~tsx
render(<StatusCallout tone="error">Upload failed</StatusCallout>);
expect(screen.getByRole("alert")).toHaveTextContent("Upload failed");
~~~

Menu assertions:

~~~tsx
const actions: CommandPaletteAction[] = [
  { id: "quick-note", disabledReason: null, run: vi.fn() },
  { id: "favorite", disabledReason: "Select a note first.", run: vi.fn() },
  { id: "toggle-theme", disabledReason: null, run: vi.fn() },
  { id: "rescan", disabledReason: null, run: vi.fn() },
  { id: "sign-out", disabledReason: null, run: vi.fn() }
];
render(<OwnerOverflowMenu actions={actions} onOpenCommandPalette={vi.fn()} />);
await user.click(screen.getByRole("button", { name: "More actions" }));
expect(screen.getByRole("menu")).toBeVisible();
expect(screen.getByText("Select a note first.")).toBeVisible();
expect(screen.getByRole("menuitem", { name: /Favorite\/Unfavorite/u })).toHaveAttribute("aria-disabled", "true");
~~~

Also assert ArrowDown moves focus, Escape closes and restores trigger focus, Quick note runs once, a rejected action shows The action could not be completed, and Open command palette calls its prop.

- [ ] **Step 3: Run tests and verify missing components**

Run:

~~~sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/web test -- status-callout.test.tsx owner-overflow-menu.test.tsx
~~~

Expected: FAIL because both components are missing.

- [ ] **Step 4: Implement StatusCallout**

Use role alert only for error; warning and info use status with aria-live polite. Include data-tone and data-persistent attributes for CSS. Text uses the semantic tokens from Task 1.

- [ ] **Step 5: Implement OwnerOverflowMenu**

Use @radix-ui/react-dropdown-menu. Render exactly these action IDs when present: quick-note, favorite, toggle-theme, rescan, sign-out. Add a separate Open command palette item. Use APPROVED_COMMANDS for labels. Disabled items remain present with aria-disabled and their reason in a small element; selecting them does nothing.

Action execution is fenced:

~~~ts
const activate = (action: CommandPaletteAction): void => {
  if (action.disabledReason !== null || busyId !== null) return;
  setBusyId(action.id);
  setError(null);
  void Promise.resolve(action.run()).catch(() => {
    setError("The action could not be completed.");
  }).finally(() => setBusyId(null));
};
~~~

Keep sign-out as an action supplied by OwnerShell. Do not duplicate navigation or API clients in the menu.

- [ ] **Step 6: Render the menu from OwnerShell**

Pass paletteActions and openPalette. Remove the old mobile-more button that was labeled Info. Keep Info reachable only through destination navigation. Do not change paletteActions or the Meta+K shortcut.

- [ ] **Step 7: Run focused and full web tests**

Run:

~~~sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/web test -- status-callout.test.tsx owner-overflow-menu.test.tsx owner-shell.test.tsx command-palette.test.tsx
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/web test
~~~

Expected: PASS.

- [ ] **Step 8: Record the review checkpoint**

Run git diff --check and git status --short. Do not commit.

---

### Task 5: Extract the header, mobile navigation, and adaptive shell

**Files:**
- Create: web/src/app/workspace-header.tsx
- Create: web/src/app/mobile-destination-nav.tsx
- Create: web/src/test/workspace-header.test.tsx
- Create: web/src/theme/workspace.css
- Modify: web/src/main.tsx:1-20
- Modify: web/src/theme/layout.css:160-330, 1420-1740
- Modify: web/src/app/owner-shell.tsx:91-292, 496-530, 541-1150
- Modify: web/src/test/owner-shell.test.tsx:160-286, 318-390

**Interfaces:**
- Produces:

~~~ts
export type Destination = "files" | "editor" | "preview" | "info";

export interface WorkspaceHeaderProps {
  readonly layout: WorkspaceLayout;
  readonly compactTablet: boolean;
  readonly activeDestination: Destination;
  readonly explorerOpen: boolean;
  readonly explorerTriggerRef: React.RefObject<HTMLButtonElement | null>;
  readonly noteTitle: string;
  readonly notePath: string;
  readonly saveStatus: SaveStatus;
  readonly attachmentAction: React.ReactNode;
  readonly publicationAction: React.ReactNode;
  readonly overflowAction: React.ReactNode;
  readonly onToggleExplorer: () => void;
  readonly onSelectDestination: (destination: Exclude<Destination, "files">) => void;
  readonly onOpenCommandPalette: () => void;
}

export interface MobileDestinationNavProps {
  readonly activeDestination: Destination;
  readonly onSelect: (destination: Destination) => void;
}
~~~

- [ ] **Step 1: Write failing header composition tests**

Desktop assertions:

~~~tsx
render(<WorkspaceHeader {...props} layout="desktop" />);
expect(screen.getByRole("button", { name: "Open commands" })).toBeVisible();
expect(screen.queryByRole("navigation", { name: "Desktop destinations" })).not.toBeInTheDocument();
expect(screen.getByLabelText("Save status")).toBeVisible();
~~~

Tablet assertions: Files toggle and Editor, Preview, Info segmented control are visible; attachment and publication remain visible.

Mobile assertions: one 52px title row and one contextual action row are rendered; More actions is supplied by overflowAction; note path is absent from fixed header.

Mobile navigation assertions: four buttons, aria-pressed on active, labels Files, Editor, Preview, Info.

- [ ] **Step 2: Run the test and verify missing components**

Run:

~~~sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/web test -- workspace-header.test.tsx
~~~

Expected: FAIL because workspace-header.tsx and mobile-destination-nav.tsx are missing.

- [ ] **Step 3: Implement pure presentation components**

WorkspaceHeader must not import vault, note, attachment, or publication clients. It renders supplied actions and calls supplied callbacks. SaveStatusOutput and ActiveNotePath move from OwnerShell into this file. The mobile title row contains the Files toggle, note title, and overflowAction. The contextual row contains save status, attachmentAction, and publicationAction.

Attach explorerTriggerRef to the tablet/mobile Files trigger. OwnerShell creates the ref once and uses it from the compact-tablet Dialog onCloseAutoFocus handler.

MobileDestinationNav contains the module-scope destination metadata and Lucide icons. It does not inspect viewport width.

- [ ] **Step 4: Move shell CSS into workspace.css**

Import workspace.css after layout.css in main.tsx. Move rather than duplicate these selector families:

- owner-shell, shell-header, workspace, context-column, shell-status;
- workspace-header zones, title row, contextual row, tablet destinations;
- mobile-destinations;
- responsive visibility and side-sheet rules;
- safe-area and scroll-padding rules.

Use these track contracts:

~~~css
.owner-shell[data-layout="desktop"] .workspace {
  grid-template-columns: clamp(240px, 20vw, 300px) minmax(480px, 1fr) clamp(320px, 28vw, 420px);
}

.owner-shell[data-layout="tablet"] .workspace {
  grid-template-columns: minmax(0, 1fr);
}

.owner-shell[data-layout="mobile"] .workspace-header {
  grid-template-rows: 52px 48px;
  min-height: 100px;
}

.workspace-scroll-target {
  scroll-padding-block: 100px calc(68px + env(safe-area-inset-bottom));
}

.owner-shell[data-layout="mobile"] .cm-content {
  font-size: 16px;
}

.preview-content {
  max-inline-size: 80ch;
}
~~~

At 900px through 1199px, tablet explorer is a 240-280px first track when open. When compactTablet is true, render the explorer inside a controlled Radix Dialog with fixed side-sheet content, max-width 280px, overlay, Escape close, and onCloseAutoFocus restoring the WorkspaceHeader Files trigger. Do not rely on CSS alone for the focus trap or Escape behavior.

Keep helper, disabled-reason, and error copy at 12px or larger. Preserve the existing editor typeface, use a 16px mobile editor size to avoid browser zoom, and constrain readable preview prose to 80ch without narrowing code blocks or attachment surfaces.

- [ ] **Step 5: Integrate components in OwnerShell**

Render WorkspaceHeader with layout, compactTablet, and actions. Render MobileDestinationNav only when layout is mobile. On desktop, all regions are exposed and Info remains the lower section of context-column. On non-compact tablet, only active Editor, Preview, or Info is exposed while Files follows explorerOpen in the grid. On compact tablet, render Files in the controlled Radix side sheet and only the active primary surface in the workspace. On mobile, only activeDestination is exposed.

Remove the placeholder Outline and Backlinks headings from InfoRegion. Desktop and non-compact tablet Context use Preview/Outline/Backlinks in the existing EditorWorkspace tabs, followed by a note-details section containing only Attachments and Publication. Mobile Info contains those same note details.

After successful publication:

~~~ts
if (layout !== "desktop") setActiveDestination("info");
~~~

Desktop leaves context visible and does not change destination state.

- [ ] **Step 6: Add the mobile scrolling breadcrumb**

Move ActiveNotePath out of the fixed mobile header. Render it as .mobile-content-path immediately before Editor/Preview content and only for mobile. Keep title and aria-label sourced from the same editorState.path string.

- [ ] **Step 7: Update owner-shell tests**

Delete assertions for 23fr 47fr 30fr and desktop destination icons. Add assertions for:

- 1505px desktop: Files, Editor, Preview, and Info visible; no Desktop destinations navigation.
- 1024px tablet: explorer toggle plus exactly one visible primary surface.
- 820px tablet: closed explorer sheet is absent; opening it exposes Files and Escape restores focus.
- 390px mobile: exactly one destination visible and mobile navigation present.
- transition desktop to tablet to mobile keeps the same editor DOM node and selected note.

- [ ] **Step 8: Run focused tests and build**

Run:

~~~sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/web test -- workspace-header.test.tsx owner-shell.test.tsx editor-workspace.test.tsx
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/web build
~~~

Expected: PASS.

- [ ] **Step 9: Record the review checkpoint**

Run git diff --check and git status --short. Do not commit.

---

### Task 6: Complete empty, disabled, search, and recovery feedback

**Files:**
- Modify: web/src/explorer/search-panel.tsx:1-75
- Modify: web/src/explorer/file-tree.tsx
- Modify: web/src/app/owner-shell.tsx:440-480, 980-1050
- Modify: web/src/editor/attachment-picker.tsx:1-170
- Modify: web/src/theme/layout.css and web/src/theme/workspace.css
- Modify: web/src/test/search.test.ts
- Modify: web/src/test/file-tree.test.tsx
- Modify: web/src/test/owner-shell.test.tsx
- Modify: web/src/test/attachment-picker.test.tsx

**Interfaces:**
- Consumes: StatusCallout from Task 4.
- Produces: explicit No matching notes plus Clear search, a New note action for expanded empty folders, visible disabled reasons in empty states, and status callouts for upload/publication failures.

- [ ] **Step 1: Write failing search-empty and status tests**

Search test:

~~~tsx
await user.type(screen.getByRole("searchbox", { name: "Search files" }), "not present");
expect(await screen.findByText("No matching notes")).toBeVisible();
await user.click(screen.getByRole("button", { name: "Clear search" }));
expect(screen.getByRole("searchbox", { name: "Search files" })).toHaveValue("");
~~~

Attachment test must assert the size failure is inside data-tone=error and contains the ordinary text Attachments must be 20 MB or smaller.

Owner-shell test must assert a disabled Create first note presents its visible reason, not title-only text.

File-tree test must render an expanded custom folder with no children, assert No notes in this folder, click New note in Empty Folder, and verify the callback receives that exact FolderExplorerNode.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

~~~sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/web test -- search.test.ts file-tree.test.tsx owner-shell.test.tsx attachment-picker.test.tsx
~~~

Expected: FAIL on missing no-results and visible-reason UI.

- [ ] **Step 3: Add explicit SearchPanel states**

Show results only after the client answers the current deferred query. When the non-empty query has zero results and client is ready and not pending, render:

~~~tsx
<div className="search-empty">
  <p>No matching notes</p>
  <button type="button" className="secondary-action touch-target" onClick={() => setQuery("")}>
    Clear search
  </button>
</div>
~~~

Do not terminate and recreate the worker when only query changes.

- [ ] **Step 4: Add the empty-folder note action**

Extend FileTreeProps:

~~~ts
readonly onCreateNoteInFolder?: ((folder: FolderExplorerNode) => void) | undefined;
~~~

For an expanded folder with no child folders or notes, render No notes in this folder and a button named New note in {folder.name}. OwnerShell passes a callback that opens the existing new-note ExplorerOperationDialog with initialFolderId set to that exact folder ID. Do not create a note directly from FileTree.

- [ ] **Step 5: Present disabled and empty reasons visibly**

EmptyEditorRegion renders disabledReason as StatusCallout tone=warning beneath Create first note. Attachment and publish controls may retain title as supplementary help, but their disabled reason must also be available in the overflow menu or note-details surface.

- [ ] **Step 6: Route failures through StatusCallout**

AttachmentPicker uses an error callout attached to its action. Publication status failure uses error tone with action Check again that reruns getStatus for the same note. Save Offline draft and Error states render a persistent warning/error callout stating Your local recovery draft remains available.

Do not clear or mutate draft storage from presentation components.

- [ ] **Step 7: Run focused and full web tests**

Run:

~~~sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/web test -- search.test.ts file-tree.test.tsx owner-shell.test.tsx attachment-picker.test.tsx
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/web test
~~~

Expected: PASS.

- [ ] **Step 8: Record the review checkpoint**

Run git diff --check and git status --short. Do not commit.

---

### Task 7: Refine attachments, publication feedback, and conflict recovery

**Files:**
- Modify: web/src/editor/attachment-view.tsx:1-85
- Modify: web/src/editor/conflict-dialog.tsx:1-150
- Modify: web/src/publication/publication-status.tsx:1-145
- Modify: web/src/theme/layout.css and web/src/theme/workspace.css
- Modify: web/src/test/attachment-picker.test.tsx
- Modify: web/src/test/conflict-dialog.test.tsx
- Modify: web/src/test/publish-dialog.test.tsx
- Modify: web/src/test/owner-shell.test.tsx

**Interfaces:**
- Produces:

~~~ts
export const formatAttachmentSize: (bytes: number) => string;
~~~

- Preserves: AttachmentViewProps, ConflictResolution values keep-drive, save-new, merge, and PublicationStatusProps.

- [ ] **Step 1: Write failing attachment metadata and lightbox tests**

Assert diagram.png displays image/png and 4 B. Clicking Open diagram.png opens a dialog named diagram.png containing the same private attachment URL and a visible filename. Trash remains a separate button and the existing confirmation test remains unchanged.

- [ ] **Step 2: Write failing conflict and copy-status tests**

Conflict test at mobile layout asserts Local draft and Drive version jump buttons exist, clicking each focuses its pane heading, and the three existing resolution buttons remain in the sticky footer.

PublicationStatus test mocks navigator.clipboard.writeText, clicks Copy link, and asserts visible Link copied. plus aria-live polite. Copy unavailable remains visible.

- [ ] **Step 3: Run focused tests and verify failure**

Run:

~~~sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/web test -- attachment-picker.test.tsx conflict-dialog.test.tsx publish-dialog.test.tsx
~~~

Expected: FAIL on metadata, section navigation, and visible copy status.

- [ ] **Step 4: Implement attachment metadata and lightbox**

formatAttachmentSize returns:

~~~ts
export const formatAttachmentSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
};
~~~

Use Radix Dialog for raster image expansion. The dialog has the attachment name as title, an img with the same safe same-origin URL, and no download, upload, or arbitrary URL input.

- [ ] **Step 5: Add conflict section navigation**

Use refs for local and Drive headings. Render a mobile-only nav before conflict-panes. Focus the target heading with preventScroll false. Keep mergeButton initial focus on desktop; on mobile initial focus the dialog title so the user encounters the relationship before a destructive choice.

- [ ] **Step 6: Make copy status visible**

Replace the sr-only-only copy message with:

~~~tsx
{copyStatus === null ? null : (
  <span className="publication-copy-status" aria-live="polite">{copyStatus}</span>
)}
~~~

The message uses --text-muted-strong for success/unavailable neutral feedback.

- [ ] **Step 7: Run focused and full web tests**

Run:

~~~sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/web test -- attachment-picker.test.tsx conflict-dialog.test.tsx publish-dialog.test.tsx owner-shell.test.tsx
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm --filter @nxt/web test
~~~

Expected: PASS.

- [ ] **Step 8: Record the review checkpoint**

Run git diff --check and git status --short. Do not commit.

---

### Task 8: Extend desktop, tablet, mobile, and accessibility acceptance

**Files:**
- Modify: playwright.config.ts:1-37
- Create: e2e/tablet-workspace.spec.ts
- Modify: e2e/mobile-workspace.spec.ts:1-42
- Modify: e2e/accessibility.spec.ts:1-80
- Modify: e2e/visual-layout.spec.ts:1-22
- Modify: e2e/owner-workspace.spec.ts
- Modify: docs/design/NXT_VISUAL_SPEC.md

**Interfaces:**
- Consumes: existing ownerPage fixture and exact local stack at 127.0.0.1:4280.
- Produces: tablet-chromium project at 1024 by 768 and fresh screenshot evidence in ignored test-results/playwright.

- [ ] **Step 1: Add the tablet Playwright project**

Add:

~~~ts
{
  name: "tablet-chromium",
  testMatch: ["**/tablet-workspace.spec.ts", "**/visual-layout.spec.ts"],
  use: { browserName: "chromium", viewport: { width: 1024, height: 768 }, hasTouch: true }
}
~~~

Exclude tablet-workspace.spec.ts from desktop and mobile projects.

- [ ] **Step 2: Write the tablet journey**

The test must:

1. assert owner-shell data-layout is tablet;
2. assert one primary surface is visible;
3. switch Editor to Preview and Info without changing URL or selected note;
4. toggle Files and verify explorer visibility;
5. at 820px, open the explorer sheet, press Escape, and verify focus returns to Show files;
6. assert document scrollWidth equals clientWidth; and
7. save task-nxt-1-1-tablet-workspace.png with animations disabled.

- [ ] **Step 3: Extend the mobile journey**

Measure fixed header rows and assert their combined height is at most 100px. Open More actions, choose Quick note in Inbox in no more than two clicks, wait for the new note URL, and verify the editor remains editable. Retain the existing four-destination, 44px-target, and no-horizontal-overflow checks.

- [ ] **Step 4: Extend accessibility checks**

Run axe on login, owner workspace, overflow menu, route error state, command palette, publish dialog, conflict dialog, and public note. Add keyboard focus checks for overflow trigger restoration and explorer sheet restoration.

For each theme, evaluate computed colors of:

- operation input border against its background;
- StatusCallout error text against its background;
- StatusCallout warning text against its background; and
- focus ring against adjacent surface.

Use the existing contrast helper and require 3 or 4.5 according to the global constraints.

- [ ] **Step 5: Extend layout and focus checks**

For each project, assert no document-level horizontal overflow. Focus the last visible action above the mobile bottom nav and the last dialog action above sticky footer; verify the focused element rectangle is not fully covered by fixed/sticky rectangles. Keep the existing reduced-motion duration assertions.

- [ ] **Step 6: Update the visual specification**

Change status to approved NXT 1.1 evolution on 2026-08-29. Record these intentional deviations from the 2026-08-23 concepts:

- desktop destination icons removed because all panes are visible;
- desktop fixed ratios replaced by bounded tracks;
- tablet receives a two-region composition;
- mobile fixed header reduced from 140px to 100px;
- mobile note path scrolls with content;
- More actions becomes a real menu;
- semantic control/error tokens add contrast without changing Gruvbox surface colors.

- [ ] **Step 7: Run source-level acceptance before the real stack**

Run:

~~~sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm lint
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm typecheck
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm web:build
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm test
~~~

Expected: PASS.

- [ ] **Step 8: Record the review checkpoint**

Run git diff --check and git status --short. Do not commit.

---

### Task 9: Run the real lifecycle, browser QA, and final regression gate

**Files:**
- No source files are created in this task.
- Ignored evidence: test-results/playwright and the current external visualization directory.

**Interfaces:**
- Consumes: exact Node 22 runtime, exact checkout-owned lifecycle, Playwright Chromium, all prior task changes.
- Produces: stopped local stack, fresh desktop/tablet/mobile evidence, complete validation results, and final git status.

- [ ] **Step 1: Prove the canonical ports are available or owned by this checkout**

Run:

~~~sh
lsof -nP -iTCP:4280 -sTCP:LISTEN
lsof -nP -iTCP:5173 -sTCP:LISTEN
lsof -nP -iTCP:7071 -sTCP:LISTEN
~~~

If a listener belongs to another checkout, do not kill it and do not run the NXT stack. Report the exact owning cwd and request that the user stop or move that preview. Continue only when all three ports are free or the NXT control record proves exact ownership.

- [ ] **Step 2: Run the complete NXT macOS gate**

Run:

~~~sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm validate:macos
~~~

Expected: lint, typecheck, deterministic builds, artifact verification, unit/integration/project/lifecycle tests, and all Playwright projects PASS; lifecycle exits stopped.

- [ ] **Step 3: Start a fresh checkout-owned E2E stack for visual inspection**

Run:

~~~sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm dev:codex -- --e2e
~~~

Expected: the SWA proxy reports http://127.0.0.1:4280 and the control record identifies this exact worktree.

- [ ] **Step 4: Perform authenticated browser QA**

Using the in-app Browser, verify the flow:

login -> local GitHub owner simulation -> owner workspace -> More actions -> Quick note -> edit -> Preview -> Info -> publish dialog -> conflict fixture.

For 1440 by 1000, 1024 by 768, and 390 by 844:

- verify URL and title;
- verify meaningful DOM and no framework overlay;
- inspect warning/error console logs;
- exercise at least one interaction per layout;
- capture fresh screenshots;
- verify no clipping, overlap, horizontal overflow, scroll trap, or obscured focus;
- compare the desktop and mobile screenshots with the accepted Gruvbox concepts and the NXT 1.1 intentional-deviation list.

At 200% browser zoom, repeat mobile/tablet reflow, keyboard focus, and dialog action visibility checks. Record this as manual browser evidence rather than simulating zoom with CSS.

- [ ] **Step 5: Stop only the exact NXT stack**

Run:

~~~sh
PATH=/Users/aserdargun/.nvm/versions/node/v22.23.1/bin:$PATH pnpm stop:codex
~~~

Expected: exact checkout-owned services stop and ports 4280, 5173, and 7071 no longer have NXT listeners.

- [ ] **Step 6: Run final repository checks**

Run:

~~~sh
git diff --check
git status --short --branch
lsof -nP -iTCP:4280 -sTCP:LISTEN
lsof -nP -iTCP:7071 -sTCP:LISTEN
~~~

Expected: no whitespace errors, only reviewed NXT 1.1 source/spec/plan changes, and no NXT listener remains. Do not commit, push, deploy, or mutate any external service.

---

## Implementation order and review gates

Tasks 1 through 3 establish contracts and must execute in order. Task 4 depends on Task 1 semantic tokens and Task 3 layout classification. Task 5 depends on Tasks 3 and 4. Tasks 6 and 7 depend on the shared StatusCallout and the new responsive shell. Task 8 updates integrated acceptance only after component behavior is stable. Task 9 is the sole real lifecycle and visual completion gate.

After every task:

1. run its focused tests;
2. run git diff --check;
3. inspect the task diff before proceeding; and
4. leave the worktree uncommitted unless the user separately authorizes commits.
