import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { build } from "vite";
import { OwnerShell } from "../app/owner-shell";
import { ThemeProvider, useTheme } from "../app/providers";
import gruvboxCss from "../theme/gruvbox.css?raw";
import layoutCss from "../theme/layout.css?raw";

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

const useMobileViewport = (matches: boolean): void => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string): MediaQueryList => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true)
    }))
  );
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

describe("responsive owner shell", () => {
  it("renders equivalent mobile and desktop destinations", () => {
    render(<OwnerShell />);
    const desktop = screen.getByRole("navigation", { name: "Desktop destinations" });
    const mobile = screen.getByRole("navigation", { name: "Mobile destinations" });

    for (const name of DESTINATIONS) {
      expect(within(desktop).getByRole("button", { name })).toBeVisible();
      expect(within(mobile).getByRole("button", { name })).toBeVisible();
      expect(screen.getAllByRole("button", { name }).length).toBeGreaterThan(1);
    }
    expect(screen.getByLabelText("Save status")).toHaveTextContent("Saved");
  });

  it("exposes only the selected mobile destination after every destination click", async () => {
    useMobileViewport(true);
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

  it("keeps every workspace region exposed concurrently on desktop", () => {
    useMobileViewport(false);
    render(<OwnerShell />);

    for (const name of DESTINATIONS) {
      expect(screen.getByRole("region", { name })).toBeVisible();
    }
  });

  it("exposes the complete active note path from the same visible value", () => {
    render(<OwnerShell />);

    const paths = screen.getAllByLabelText("Active note path: Notes / Plans");
    expect(paths).toHaveLength(2);
    for (const path of paths) {
      expect(path).toHaveTextContent("Notes / Plans");
      expect(path).toHaveAttribute("title", "Notes / Plans");
    }
  });

  it("uses semantic landmarks, direct actions, and a polite live save status", () => {
    render(<OwnerShell />);

    expect(screen.getByRole("banner")).toBeVisible();
    expect(screen.getByRole("main", { name: "NXT workspace" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Files" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Add attachment" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Publish" })).toBeVisible();
    expect(screen.getByLabelText("Save status")).toHaveAttribute("aria-live", "polite");
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
      expect(style.getPropertyValue("--code").trim()).toBe("var(--orange)");
      for (const accent of ["red", "green", "yellow", "blue", "purple", "aqua", "orange", "gray"]) {
        expect(style.getPropertyValue(`--accent-${accent}`).trim()).not.toBe("");
      }
    }
  });

  it("routes headings, selected/action chrome, focus, and code through locked semantics", () => {
    const rules = parseStyleRules(`${gruvboxCss}\n${layoutCss}`);
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
      "var(--focus)"
    );
    expect(getStyleRule(rules, ".preview-content code").getPropertyValue("color").trim()).toBe(
      "var(--code)"
    );
  });

  it("ships parsed focus, 44px target, reduced-motion, system-theme, and overflow rules", () => {
    const style = document.createElement("style");
    style.dataset.testTheme = "true";
    style.textContent = `${gruvboxCss}\n${layoutCss}`;
    document.head.append(style);
    const cssRules = Array.from(style.sheet?.cssRules ?? [], (rule) => rule.cssText).join("\n");

    expect(cssRules).toContain(":focus-visible");
    expect(cssRules).toMatch(/min-height:\s*44px/u);
    expect(cssRules).toContain("prefers-reduced-motion: reduce");
    expect(cssRules).toContain("prefers-color-scheme: light");
    expect(getComputedStyle(document.documentElement).overflowX).toBe("hidden");
  });

  it("continues directly from mobile note metadata into the editor surface", () => {
    const style = document.createElement("style");
    style.dataset.testTheme = "true";
    style.textContent = layoutCss;
    document.head.append(style);
    const cssRules = Array.from(style.sheet?.cssRules ?? [], (rule) => rule.cssText).join("\n");

    expect(cssRules).toMatch(
      /\.editor-region\s*>\s*\.region-toolbar\s*\{\s*display:\s*none;/u
    );
  });

  it("aligns desktop header groups to the explorer, editor, and context tracks", () => {
    const rules = parseStyleRules(layoutCss);

    expect(getStyleRule(rules, ".shell-header").getPropertyValue("grid-template-columns").trim()).toBe(
      "23fr 47fr 30fr"
    );
    expect(getStyleRule(rules, ".shell-header-explorer").getPropertyValue("grid-column").trim()).toBe(
      "1"
    );
    const actions = getStyleRule(rules, ".shell-actions");
    expect(actions.getPropertyValue("grid-column").trim()).toBe("2");
    expect(actions.getPropertyValue("justify-content").trim()).toBe("flex-end");
    const save = getStyleRule(rules, ".save-status");
    expect(save.getPropertyValue("grid-column").trim()).toBe("3");
    expect(save.getPropertyValue("justify-self").trim()).toBe("end");
  });

  it("locks each mobile control and active-destination treatment to the accepted sizes", () => {
    const rules = parseStyleRules(layoutCss);
    const mobile = "max-width: 767px";

    expect(getStyleRule(rules, ".search-row input", mobile).getPropertyValue("height").trim()).toBe(
      "44px"
    );
    for (const selector of [".shell-actions svg", ".mobile-path svg", ".explorer-region svg"]) {
      const style = getStyleRule(rules, selector, mobile);
      expect(style.getPropertyValue("width").trim()).toBe("22px");
      expect(style.getPropertyValue("height").trim()).toBe("22px");
    }
    const bottomIcon = getStyleRule(rules, ".mobile-destinations svg", mobile);
    expect(bottomIcon.getPropertyValue("width").trim()).toBe("24px");
    expect(bottomIcon.getPropertyValue("height").trim()).toBe("24px");
    const actions = getStyleRule(rules, ".text-action", mobile);
    expect(actions.getPropertyValue("min-height").trim()).toBe("44px");
    const destination = getStyleRule(rules, ".mobile-destinations .destination-button", mobile);
    expect(destination.getPropertyValue("min-height").trim()).toBe("44px");
    expect(destination.getPropertyValue("font-size").trim()).toBe("13px");
    const active = getStyleRule(
      rules,
      ".mobile-destinations .destination-button[aria-pressed=\"true\"]",
      mobile
    );
    expect(active.getPropertyValue("color").trim()).toBe("var(--yellow)");
    expect(active.getPropertyValue("background").trim()).toBe("transparent");
    expect(
      getStyleRule(
        rules,
        ".mobile-destinations .destination-button[aria-pressed=\"true\"]::after",
        mobile
      ).getPropertyValue("background").trim()
    ).toBe("var(--yellow)");
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
});
