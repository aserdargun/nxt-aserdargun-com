import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { build } from "vite";
import { OwnerShell } from "../app/owner-shell";
import type { NotesClient } from "../api/notes";
import type { CompleteVault } from "../api/vault";
import type { DraftStore } from "../editor/draft-store";
import { ThemeProvider, useTheme } from "../app/providers";
import gruvboxCss from "../theme/gruvbox.css?raw";
import layoutCss from "../theme/layout.css?raw";
import workspaceCss from "../theme/workspace.css?raw";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DESTINATIONS = ["Files", "Editor", "Preview", "Info"] as const;
const FORBIDDEN_PRIVATE_MARKERS = [
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
  "NXT_PRIVATE_DRIVE_FOLDER_ID"
] as const;

interface StyleRuleSnapshot {
  readonly media: string | undefined;
  readonly selectors: readonly string[];
  readonly style: CSSStyleDeclaration;
}

const collectStyleRules = (
  rules: CSSRuleList,
  media: string | undefined = undefined,
  collected: StyleRuleSnapshot[] = []
): StyleRuleSnapshot[] => {
  for (const rule of rules) {
    if (rule.type === CSSRule.STYLE_RULE) {
      const styleRule = rule as CSSStyleRule;
      collected.push({
        media,
        selectors: styleRule.selectorText.split(",").map((selector) => selector.trim()),
        style: styleRule.style
      });
    } else if (rule.type === CSSRule.MEDIA_RULE) {
      const mediaRule = rule as CSSMediaRule;
      collectStyleRules(mediaRule.cssRules, mediaRule.conditionText, collected);
    }
  }
  return collected;
};

const parseStyleRules = (css: string): StyleRuleSnapshot[] => {
  const style = document.createElement("style");
  style.dataset.testTheme = "true";
  style.textContent = css;
  document.head.append(style);
  return collectStyleRules(style.sheet?.cssRules ?? ([] as unknown as CSSRuleList));
};

const getStyleRule = (
  rules: readonly StyleRuleSnapshot[],
  selector: string,
  media?: string
): CSSStyleDeclaration => {
  const matches = rules.filter(
    (rule) =>
      rule.selectors.includes(selector) &&
      (media === undefined ? rule.media === undefined : rule.media?.includes(media) === true)
  );
  expect(matches, `Expected one ${selector} rule in ${media ?? "the base stylesheet"}`).toHaveLength(1);
  const match = matches[0];
  if (match === undefined) throw new Error(`Missing CSS rule for ${selector}.`);
  return match.style;
};

const getCascadingStyleRule = (
  rules: readonly StyleRuleSnapshot[],
  selector: string,
  property: string,
  media?: string
): CSSStyleDeclaration => {
  const matches = rules.filter(
    (rule) =>
      rule.selectors.includes(selector) &&
      rule.style.getPropertyValue(property).trim() !== "" &&
      (media === undefined ? rule.media === undefined : rule.media?.includes(media) === true)
  );
  expect(
    matches,
    `Expected ${selector} to define ${property} in ${media ?? "the base stylesheet"}`
  ).not.toHaveLength(0);
  const match = matches.at(-1);
  if (match === undefined) throw new Error(`Missing ${property} rule for ${selector}.`);
  return match.style;
};

const useViewportWidth = (width: number): void => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string): MediaQueryList => {
      const constraints = Array.from(
        query.matchAll(/\((min|max)-width:\s*(\d+)px\)/gu),
        ([, boundary, value]) => ({ boundary, value: Number(value) })
      );
      const matches = constraints.every(({ boundary, value }) =>
        boundary === "min" ? width >= value : width <= value
      );
      return {
        matches,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(() => true)
      };
    })
  );
};

const useResponsiveViewport = (initialWidth: number): { readonly setWidth: (width: number) => void } => {
  let width = initialWidth;
  const queries = new Map<string, {
    readonly listeners: Set<() => void>;
    readonly mediaQuery: MediaQueryList;
  }>();
  const matches = (query: string): boolean => Array.from(
    query.matchAll(/\((min|max)-width:\s*(\d+)px\)/gu),
    ([, boundary, value]) => ({ boundary, value: Number(value) })
  ).every(({ boundary, value }) => boundary === "min" ? width >= value : width <= value);

  vi.stubGlobal("matchMedia", vi.fn((query: string): MediaQueryList => {
    const existing = queries.get(query);
    if (existing !== undefined) return existing.mediaQuery;
    const listeners = new Set<() => void>();
    const mediaQuery = {
      get matches() { return matches(query); },
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        if (typeof listener === "function") listeners.add(listener as () => void);
      },
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        if (typeof listener === "function") listeners.delete(listener as () => void);
      },
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true)
    } as MediaQueryList;
    queries.set(query, { listeners, mediaQuery });
    return mediaQuery;
  }));

  return {
    setWidth: (nextWidth) => {
      width = nextWidth;
      for (const { listeners } of queries.values()) {
        for (const listener of listeners) listener();
      }
    }
  };
};

const readTree = async (directory: string): Promise<string> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const sources = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? readTree(path) : readFile(path, "utf8");
    })
  );
  return sources.join("\n");
};

const ThemeHarness = (): React.JSX.Element => {
  const { mode, setMode } = useTheme();
  return (
    <div data-testid="theme-mode" data-mode={mode}>
      <button type="button" onClick={() => setMode("dark")}>dark</button>
      <button type="button" onClick={() => setMode("light")}>light</button>
      <button type="button" onClick={() => setMode("system")}>system</button>
    </div>
  );
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-theme");
  document.head.querySelectorAll("style[data-test-theme]").forEach((style) => style.remove());
});

const EMPTY_VAULT: CompleteVault = {
  entries: [],
  folders: [],
  preferences: { schemaVersion: 1, favorites: [], recent: [], theme: "dark" },
  treeVersion: "a".repeat(64)
};

const NOTE_ID = "018f47d2-6a34-7b2a-9f21-8a7034963aef";

const EXPLORER_VAULT: CompleteVault = {
  entries: [{
    id: NOTE_ID,
    title: "Plan",
    aliases: [],
    path: "Notes/Plan.md",
    created: "2026-08-23T09:00:00.000Z",
    updated: "2026-08-23T09:03:00.000Z",
    driveVersion: "7",
    tags: ["plan"],
    searchText: "drive plan",
    excerpt: "Drive",
    outboundNoteIds: [],
    unresolvedWikiTargets: [],
    attachments: [],
    backlinks: []
  }],
  folders: [
    { id: "notes", name: "Notes", path: "Notes", version: "3", protected: true },
    { id: "archive", name: "Archive", path: "Archive", version: "2", protected: false }
  ],
  preferences: { schemaVersion: 1, favorites: [], recent: [], theme: "dark" },
  treeVersion: "b".repeat(64)
};

const NOTE_SOURCE = `---\nid: "${NOTE_ID}"\ntitle: "Plan"\ncreated: "2026-08-23T09:00:00.000Z"\nupdated: "2026-08-23T09:03:00.000Z"\ntags: []\naliases: []\n---\n\n# Plan\n`;
const NOTES_CLIENT: NotesClient = {
  getNote: vi.fn().mockResolvedValue({
    note: {
      frontmatter: {
        id: NOTE_ID,
        title: "Plan",
        created: "2026-08-23T09:00:00.000Z",
        updated: "2026-08-23T09:03:00.000Z",
        tags: [],
        aliases: []
      },
      body: "\n# Plan\n"
    },
    source: NOTE_SOURCE,
    version: "7",
    path: "Notes/Plan.md",
    checksum: createHash("sha256").update(NOTE_SOURCE).digest("hex")
  }),
  updateNote: vi.fn(),
  createNote: vi.fn(),
  moveNote: vi.fn(),
  archiveNote: vi.fn(),
  trashNote: vi.fn()
};

const NOOP_DRAFT_STORE: DraftStore = {
  get: vi.fn().mockResolvedValue(null),
  put: vi.fn().mockResolvedValue(undefined),
  markConfirmed: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
  preserveRecovery: vi.fn().mockResolvedValue(undefined),
  listRecoveries: vi.fn().mockResolvedValue({ items: [], nextCursor: null, totalCount: 0 })
};

describe("owner feedback states", () => {
  it("shows the disabled first-note reason as ordinary visible text", () => {
    render(<OwnerShell vault={EMPTY_VAULT} />);

    expect(screen.getByRole("button", { name: "Create first note" })).toBeDisabled();
    const reason = screen.getByText("The Plans or Inbox folder is unavailable.");
    expect(reason).toBeVisible();
    expect(reason).toHaveAttribute("data-tone", "warning");
  });

  it("shows attachment and publication disabled reasons in note details", () => {
    render(<OwnerShell vault={EMPTY_VAULT} />);

    const info = screen.getByRole("region", { name: "Info" });
    expect(within(info).getAllByText("Select a saved note first.")).toHaveLength(2);
    for (const reason of within(info).getAllByText("Select a saved note first.")) {
      expect(reason).toBeVisible();
    }
  });

  it("opens the existing new-note dialog at the exact expanded empty folder", async () => {
    const user = userEvent.setup();
    const folderId = "v1.abcdefghijklmnop.folder_empty.abcdefghijklmnopqrstuv";
    render(<OwnerShell vault={{
      ...EMPTY_VAULT,
      folders: [{ id: folderId, name: "Empty Folder", path: "Empty Folder", version: "1", protected: false }]
    }} />);
    const folder = screen.getByRole("treeitem", { name: "Empty Folder" });
    folder.focus();
    await user.keyboard("{ArrowRight}");

    await user.click(screen.getByRole("button", { name: "New note in Empty Folder" }));

    const dialog = screen.getByRole("dialog", { name: "New note" });
    expect(within(dialog).getByRole("combobox", { name: "Folder" })).toHaveValue(folderId);
  });

  it("checks a failed publication status again without losing retry focus", async () => {
    const user = userEvent.setup();
    let rejectInitial!: (reason: Error) => void;
    let resolveRetry!: (value: null) => void;
    const initialStatus = new Promise<null>((_resolve, reject) => { rejectInitial = reject; });
    const retryStatus = new Promise<null>((resolve) => { resolveRetry = resolve; });
    const getStatus = vi.fn()
      .mockReturnValueOnce(initialStatus)
      .mockReturnValueOnce(retryStatus);
    const publicationApi = { getStatus, publish: vi.fn(), revoke: vi.fn() };
    const { rerender } = render(
      <>
        <button type="button">Before workspace</button>
        <OwnerShell notes={NOTES_CLIENT} publicationApi={publicationApi} />
      </>
    );
    const previousFocus = screen.getByRole("button", { name: "Before workspace" });
    previousFocus.focus();
    rerender(
      <>
        <button type="button">Before workspace</button>
        <OwnerShell noteId={NOTE_ID} notes={NOTES_CLIENT} publicationApi={publicationApi} />
      </>
    );

    expect(previousFocus).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
    rejectInitial(new Error("Drive unavailable"));

    const failure = await screen.findByRole("alert");
    expect(failure).toHaveAttribute("data-tone", "error");
    expect(failure).toHaveTextContent("Publication status could not be verified.");
    const retry = screen.getByRole("button", { name: "Check again" });
    retry.focus();
    expect(retry).toHaveFocus();
    await user.click(retry);

    const publicationHeading = screen.getByRole("heading", { level: 2, name: "Publication" });
    expect(screen.getByText("Checking publication status")).toBeVisible();
    expect(publicationHeading).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
    resolveRetry(null);

    expect(await screen.findByText("Not published")).toBeVisible();
    expect(publicationHeading).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
    expect(getStatus).toHaveBeenNthCalledWith(1, NOTE_ID);
    expect(getStatus).toHaveBeenNthCalledWith(2, NOTE_ID);
  });
});

describe("responsive owner shell", () => {
  it("exposes only the selected mobile destination after every destination click", async () => {
    useViewportWidth(390);
    const user = userEvent.setup();
    render(<OwnerShell />);
    const mobile = screen.getByRole("navigation", { name: "Mobile destinations" });

    const expectOnlySurface = (selected: (typeof DESTINATIONS)[number]): void => {
      for (const name of DESTINATIONS) {
        const exposed = screen.queryByRole("region", { name });
        if (name === selected) {
          expect(exposed).toBeVisible();
        } else {
          expect(exposed).not.toBeInTheDocument();
        }
        const preserved = document.querySelector(
          `section[role="region"][aria-label="${name}"]`
        );
        expect(preserved).toBeInTheDocument();
        if (name === selected) {
          expect(preserved).not.toHaveAttribute("hidden");
        } else {
          expect(preserved).toHaveAttribute("hidden");
        }
      }
    };

    expectOnlySurface("Editor");
    for (const destination of ["Files", "Preview", "Info", "Editor"] as const) {
      await user.click(within(mobile).getByRole("button", { name: destination }));
      expectOnlySurface(destination);
      expect(within(mobile).getByRole("button", { name: destination })).toHaveAttribute(
        "aria-pressed",
        "true"
      );
    }
  });

  it.each([820, 1024])(
    "keeps the mobile Files destination selection while presenting Editor as the tablet primary at %ipx",
    async (tabletWidth) => {
      const viewport = useResponsiveViewport(390);
      const user = userEvent.setup();
      render(<OwnerShell />);

      await user.click(within(screen.getByRole("navigation", { name: "Mobile destinations" })).getByRole(
        "button",
        { name: "Files" }
      ));
      expect(screen.getByTestId("owner-shell")).toHaveAttribute("data-mobile-destination", "files");

      act(() => viewport.setWidth(tabletWidth));

      expect(screen.getByTestId("owner-shell")).toHaveAttribute("data-mobile-destination", "files");
      const tablet = screen.getByRole("navigation", { name: "Tablet destinations" });
      expect(within(tablet).getByRole("button", { name: "Editor" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("region", { name: "Editor" })).toBeVisible();
      expect(screen.queryByRole("region", { name: "Preview" })).not.toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Info" })).not.toBeInTheDocument();
    }
  );

  it("exposes Files, Editor, Preview, and Info at 1505px without destination navigation", () => {
    useViewportWidth(1505);
    render(<OwnerShell />);

    for (const name of DESTINATIONS) {
      expect(screen.getByRole("region", { name })).toBeVisible();
    }
    expect(screen.queryByRole("navigation", { name: "Desktop destinations" })).not.toBeInTheDocument();
  });

  it("keeps Files beside exactly one primary surface at 1024px", async () => {
    useViewportWidth(1024);
    const user = userEvent.setup();
    render(<OwnerShell />);

    expect(screen.getByRole("button", { name: "Hide files" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Files" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Editor" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Preview" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Info" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByRole("region", { name: "Files" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Editor" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Preview" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Info" })).not.toBeInTheDocument();
  });

  it("uses a compact tablet dialog that closes with Escape and restores Files focus", async () => {
    useViewportWidth(820);
    const user = userEvent.setup();
    render(<OwnerShell />);

    const trigger = screen.getByRole("button", { name: "Show files" });
    expect(screen.queryByRole("dialog", { name: "Files" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Files" })).not.toBeInTheDocument();

    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Files" });
    expect(dialog).toBeVisible();
    expect(screen.getByRole("region", { name: "Files" })).toBeVisible();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Files" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("retains Explorer search and non-selected expansion through compact close, reopen, and wide return", async () => {
    const viewport = useResponsiveViewport(1024);
    const user = userEvent.setup();
    render(<OwnerShell vault={EXPLORER_VAULT} />);

    const search = await screen.findByRole("searchbox", { name: "Search files" });
    await user.type(search, "plan");
    const archive = screen.getByRole("treeitem", { name: "Archive" });
    archive.focus();
    await user.keyboard("{ArrowRight}");
    expect(archive).toHaveAttribute("aria-expanded", "true");

    act(() => viewport.setWidth(820));
    await user.click(screen.getByRole("button", { name: "Show files" }));
    expect(screen.getByRole("searchbox", { name: "Search files" })).toHaveValue("plan");
    expect(screen.getByRole("treeitem", { name: "Archive" })).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Show files" }));
    expect(screen.getByRole("searchbox", { name: "Search files" })).toHaveValue("plan");
    expect(screen.getByRole("treeitem", { name: "Archive" })).toHaveAttribute("aria-expanded", "true");

    act(() => viewport.setWidth(1024));
    expect(screen.getByRole("searchbox", { name: "Search files" })).toHaveValue("plan");
    expect(screen.getByRole("treeitem", { name: "Archive" })).toHaveAttribute("aria-expanded", "true");
  });

  it("opens the real More actions menu on a compact tablet without a keyboard shortcut", async () => {
    useViewportWidth(820);
    const user = userEvent.setup();
    render(<OwnerShell />);

    await user.click(screen.getByRole("button", { name: "More actions" }));
    const menu = screen.getByRole("menu");
    expect(menu).toBeVisible();
    await user.click(within(menu).getByRole("menuitem", { name: "Open command palette" }));
    expect(await screen.findByRole("dialog", { name: "Commands" })).toBeVisible();
  });

  it("keeps the editor DOM node and selected note while crossing every layout", () => {
    const viewport = useResponsiveViewport(1505);
    render(<OwnerShell />);
    const editor = document.querySelector('section[role="region"][aria-label="Editor"]');
    expect(editor).not.toBeNull();

    act(() => viewport.setWidth(1024));
    expect(document.querySelector('section[role="region"][aria-label="Editor"]')).toBe(editor);

    act(() => viewport.setWidth(390));
    expect(document.querySelector('section[role="region"][aria-label="Editor"]')).toBe(editor);
    expect(screen.getByText("Plans", { selector: ".mobile-title" })).toBeVisible();
  });

  it("renders the active path inside each mobile scroll surface instead of the fixed header", async () => {
    useViewportWidth(390);
    const user = userEvent.setup();
    render(<OwnerShell />);

    const editor = screen.getByRole("region", { name: "Editor" });
    const editorScroll = editor.querySelector(".editor-canvas.workspace-scroll-target");
    const editorPath = editor.querySelector('[aria-label="Active note path: Notes / Plans"].mobile-content-path');
    expect(editorScroll).not.toBeNull();
    expect(editorPath).not.toBeNull();
    expect(editorScroll?.firstElementChild).toBe(editorPath);
    expect(editorPath).toHaveAttribute("title", "Notes / Plans");

    await user.click(within(screen.getByRole("navigation", { name: "Mobile destinations" })).getByRole(
      "button",
      { name: "Preview" }
    ));
    const preview = screen.getByRole("region", { name: "Preview" });
    const previewScroll = preview.querySelector(".preview-content.workspace-scroll-target");
    const previewPath = preview.querySelector('[aria-label="Active note path: Notes / Plans"].mobile-content-path');
    expect(previewScroll).not.toBeNull();
    expect(previewPath).not.toBeNull();
    expect(previewScroll?.firstElementChild).toBe(previewPath);
    expect(within(screen.getByRole("banner")).queryByText("Notes / Plans")).not.toBeInTheDocument();
  });

  it("uses semantic landmarks, direct actions, and a polite live save status", () => {
    useViewportWidth(1505);
    render(<OwnerShell />);

    expect(screen.getByRole("banner")).toBeVisible();
    expect(screen.getByRole("main", { name: "NXT workspace" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Files" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Add attachment" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Publish" })).toBeVisible();
    expect(screen.getByLabelText("Save status")).toHaveAttribute("aria-live", "polite");
  });

  it("tabs through Files, Editor, Context, then global actions", async () => {
    useViewportWidth(1505);
    const user = userEvent.setup();
    render(
      <OwnerShell
        noteId={NOTE_ID}
        vault={EXPLORER_VAULT}
        notes={NOTES_CLIENT}
        draftStore={NOOP_DRAFT_STORE}
        publicationApi={{ getStatus: vi.fn().mockResolvedValue(null), publish: vi.fn(), revoke: vi.fn() }}
      />
    );
    await screen.findByLabelText("Markdown editor");

    const files = screen.getByRole("searchbox", { name: "Search files" });
    const editor = screen.getByLabelText("Markdown editor");
    const context = screen.getByRole("tab", { name: "Preview" });
    const global = screen.getByRole("button", { name: "Open commands" });
    const tabUntil = async (target: HTMLElement, label: string): Promise<void> => {
      const visited: string[] = [];
      for (let index = 0; index < 64; index += 1) {
        await user.tab();
        if (document.activeElement === target) return;
        const active = document.activeElement;
        visited.push(active instanceof HTMLElement
          ? active.getAttribute("aria-label") ?? active.textContent?.trim().replace(/\s+/gu, " ") ?? active.tagName
          : active?.nodeName ?? "none");
      }
      throw new Error(`Tab order did not reach ${label}. Visited: ${visited.join(" -> ")}`);
    };
    await tabUntil(files, "Files");
    await tabUntil(editor, "Editor");
    await tabUntil(context, "Context");
    await tabUntil(global, "global actions");
    expect(global).toHaveFocus();
    expect(document.querySelectorAll('[tabindex]:is([tabindex="1"], [tabindex="2"], [tabindex="3"], [tabindex="4"], [tabindex="5"])')).toHaveLength(0);
    const rules = parseStyleRules(workspaceCss);
    expect(getStyleRule(rules, ".workspace-header").getPropertyValue("grid-row").trim()).toBe("1");
    expect(getStyleRule(rules, ".workspace").getPropertyValue("grid-row").trim()).toBe("2");
  });
});

describe("Gruvbox theme contract", () => {
  it("starts dark and exposes light and system modes through the provider", async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ThemeHarness />
      </ThemeProvider>
    );

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    await user.click(screen.getByRole("button", { name: "light" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    await user.click(screen.getByRole("button", { name: "system" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "system");
  });

  it("locks focus and code semantics to yellow and orange in every theme branch", () => {
    const rules = parseStyleRules(gruvboxCss);
    const branches = [
      [":root[data-theme=\"dark\"]", undefined, "#d79921", "#d65d0e"],
      [":root[data-theme=\"light\"]", undefined, "#b57614", "#af3a03"],
      [":root[data-theme=\"system\"]", undefined, "#d79921", "#d65d0e"],
      [":root[data-theme=\"system\"]", "prefers-color-scheme: light", "#b57614", "#af3a03"]
    ] as const;

    for (const [selector, media, yellow, orange] of branches) {
      const style = getStyleRule(rules, selector, media);
      expect(style.getPropertyValue("--yellow").trim()).toBe(yellow);
      expect(style.getPropertyValue("--orange").trim()).toBe(orange);
      expect(style.getPropertyValue("--focus").trim()).toBe("var(--yellow)");
      expect(style.getPropertyValue("--focus-ring").trim()).not.toBe("");
      expect(style.getPropertyValue("--code").trim()).toBe("var(--orange)");
      for (const accent of ["red", "green", "yellow", "blue", "purple", "aqua", "orange", "gray"]) {
        expect(style.getPropertyValue(`--accent-${accent}`).trim()).not.toBe("");
      }
    }
  });

  it("routes headings, selected/action chrome, focus, and code through locked semantics", () => {
    const rules = parseStyleRules(`${gruvboxCss}\n${layoutCss}\n${workspaceCss}`);
    const yellowUsages = [
      [".brand", "color"],
      [".primary-link", "color"],
      [".destination-button[aria-pressed=\"true\"]", "color"],
      [".publish-action", "color"],
      [".explorer-section h2", "color"],
      [".tree-row.selected::before", "background"],
      [".source-heading", "color"],
      [".context-tab.active::after", "background"]
    ] as const;

    for (const [selector, property] of yellowUsages) {
      expect(
        getCascadingStyleRule(rules, selector, property).getPropertyValue(property).trim()
      ).toBe("var(--yellow)");
    }
    expect(getStyleRule(rules, "button:focus-visible").getPropertyValue("outline").trim()).toContain(
      "var(--focus-ring)"
    );
    expect(getStyleRule(rules, ".preview-content code").getPropertyValue("color").trim()).toBe(
      "var(--code)"
    );
  });

  it("ships parsed focus, 44px target, reduced-motion, system-theme, and overflow rules", () => {
    const style = document.createElement("style");
    style.dataset.testTheme = "true";
    style.textContent = `${gruvboxCss}\n${layoutCss}\n${workspaceCss}`;
    document.head.append(style);
    const cssRules = Array.from(style.sheet?.cssRules ?? [], (rule) => rule.cssText).join("\n");

    expect(cssRules).toContain(":focus-visible");
    expect(cssRules).toMatch(/min-height:\s*44px/u);
    expect(cssRules).toContain("prefers-reduced-motion: reduce");
    expect(cssRules).toContain("prefers-color-scheme: light");
    expect(getComputedStyle(document.documentElement).overflowX).toBe("hidden");
  });

  it("uses the approved desktop, tablet, mobile, scrolling, and reading contracts", () => {
    const rules = parseStyleRules(workspaceCss);

    expect(getStyleRule(rules, '.owner-shell[data-layout="desktop"] .workspace').getPropertyValue("grid-template-columns").trim()).toBe(
      "clamp(240px, 20vw, 300px) minmax(480px, 1fr) clamp(320px, 28vw, 420px)"
    );
    expect(getStyleRule(rules, '.owner-shell[data-layout="tablet"] .workspace').getPropertyValue("grid-template-columns").trim()).toBe(
      "minmax(0, 1fr)"
    );
    expect(getStyleRule(rules, '.owner-shell[data-layout="mobile"] .workspace-header').getPropertyValue("grid-template-rows").trim()).toBe(
      "52px 48px"
    );
    expect(getStyleRule(rules, ".workspace-scroll-target").getPropertyValue("scroll-padding-block").trim()).toBe(
      "100px"
    );
    const nativeEditorScroller = getStyleRule(
      rules,
      '.owner-shell[data-layout="mobile"] .markdown-editor .cm-scroller.workspace-scroll-target'
    );
    expect(nativeEditorScroller.getPropertyValue("padding-top").trim()).toBe("44px");
    expect(nativeEditorScroller.getPropertyValue("box-sizing").trim()).toBe("border-box");
    expect(nativeEditorScroller.getPropertyValue("height").trim()).toBe("");
    expect(nativeEditorScroller.getPropertyValue("overflow").trim()).toBe("");
    const leadingSlot = getStyleRule(
      rules,
      '.owner-shell[data-layout="mobile"] .cm-scroller.workspace-scroll-target > .markdown-editor-leading-slot'
    );
    expect(leadingSlot.getPropertyValue("position").trim()).toBe("absolute");
    expect(leadingSlot.getPropertyValue("inset").trim()).toBe("0 0 auto");
    expect(getStyleRule(rules, '.owner-shell[data-layout="mobile"] .cm-content').getPropertyValue("font-size").trim()).toBe("16px");
    const prose = getStyleRule(rules, ".markdown-preview > p");
    expect(prose.getPropertyValue("max-inline-size").trim()).toBe("80ch");
    expect(getStyleRule(rules, ".markdown-preview > p:has(img)").getPropertyValue("max-inline-size").trim()).toBe(
      "none"
    );
    const cappedSelectors = rules.flatMap((rule) =>
      rule.style.getPropertyValue("max-inline-size").trim() === "80ch" ? rule.selectors : []
    );
    expect(cappedSelectors).not.toContain(".preview-content");
    for (const wideSurface of [
      ".markdown-preview > pre",
      ".markdown-preview > table",
      ".markdown-preview > img",
      ".preview-content .attachment-card"
    ]) {
      expect(cappedSelectors).not.toContain(wideSurface);
    }
  });

  it("locks each mobile control and active-destination treatment to the accepted sizes", () => {
    const rules = parseStyleRules(`${layoutCss}\n${workspaceCss}`);
    const mobile = "max-width: 767px";

    expect(getStyleRule(rules, ".search-row input", mobile).getPropertyValue("height").trim()).toBe(
      "44px"
    );
    for (const selector of [
      ".workspace-contextual-row svg",
      ".mobile-content-path svg",
      '.owner-shell[data-layout="mobile"] .explorer-region svg'
    ]) {
      const style = getStyleRule(rules, selector);
      expect(style.getPropertyValue("width").trim()).toBe("22px");
      expect(style.getPropertyValue("height").trim()).toBe("22px");
    }
    const bottomIcon = getStyleRule(rules, ".mobile-destinations svg");
    expect(bottomIcon.getPropertyValue("width").trim()).toBe("24px");
    expect(bottomIcon.getPropertyValue("height").trim()).toBe("24px");
    const actions = getStyleRule(rules, ".workspace-contextual-row .text-action");
    expect(actions.getPropertyValue("min-height").trim()).toBe("44px");
    const destination = getStyleRule(rules, ".mobile-destinations .destination-button");
    expect(destination.getPropertyValue("min-height").trim()).toBe("44px");
    expect(destination.getPropertyValue("font-size").trim()).toBe("13px");
    const active = getStyleRule(
      rules,
      ".mobile-destinations .destination-button[aria-pressed=\"true\"]",
      undefined
    );
    expect(active.getPropertyValue("color").trim()).toBe("var(--yellow)");
    expect(active.getPropertyValue("background").trim()).toBe("transparent");
    expect(
      getStyleRule(
        rules,
        ".mobile-destinations .destination-button[aria-pressed=\"true\"]::after",
        undefined
      ).getPropertyValue("background").trim()
    ).toBe("var(--yellow)");
    const conflictNavButton = getStyleRule(rules, ".conflict-section-nav button", mobile);
    expect(conflictNavButton.getPropertyValue("min-height").trim()).toBe("44px");
    const conflictFooter = getStyleRule(rules, ".conflict-actions", mobile);
    expect(conflictFooter.getPropertyValue("position").trim()).toBe("sticky");
    expect(conflictFooter.getPropertyValue("bottom").trim()).toBe("0px");
    const attachmentActions = getStyleRule(
      rules,
      '.owner-shell[data-layout="mobile"] .attachment-actions'
    );
    expect(attachmentActions.getPropertyValue("grid-template-columns").trim()).toBe(
      "repeat(2, minmax(0, 1fr))"
    );
    expect(attachmentActions.getPropertyValue("max-width").trim()).toBe("100%");
  });
});

describe("production bundle boundary", () => {
  it("keeps private configuration markers out of the production bundle", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "nxt-web-dist-"));
    try {
      await build({
        root: WEB_ROOT,
        configFile: resolve(WEB_ROOT, "vite.config.ts"),
        logLevel: "silent",
        build: { outDir: outputDirectory, emptyOutDir: true }
      });
      const bundle = await readTree(outputDirectory);
      for (const marker of FORBIDDEN_PRIVATE_MARKERS) {
        expect(bundle).not.toContain(marker);
      }
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it("keeps the owner workspace out of the anonymous entry bundle", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "nxt-web-entry-"));
    try {
      await build({
        root: WEB_ROOT,
        configFile: resolve(WEB_ROOT, "vite.config.ts"),
        logLevel: "silent",
        build: { outDir: outputDirectory, emptyOutDir: true }
      });
      const html = await readFile(join(outputDirectory, "index.html"), "utf8");
      const entryPath = html.match(/<script[^>]+src="([^"]+)"/u)?.[1];
      if (entryPath === undefined) throw new Error("Production entry script is missing.");
      const entry = await readFile(join(outputDirectory, entryPath.replace(/^\//u, "")), "utf8");

      expect(entry).not.toContain("owner-shell");
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });
});
