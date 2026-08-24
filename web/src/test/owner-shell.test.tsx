import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
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

  it("switches the single mobile destination while preserving all shell regions", async () => {
    const user = userEvent.setup();
    render(<OwnerShell />);
    const shell = screen.getByTestId("owner-shell");
    const mobile = screen.getByRole("navigation", { name: "Mobile destinations" });

    expect(shell).toHaveAttribute("data-mobile-destination", "editor");
    await user.click(within(mobile).getByRole("button", { name: "Preview" }));

    expect(shell).toHaveAttribute("data-mobile-destination", "preview");
    expect(within(mobile).getByRole("button", { name: "Preview" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("region", { name: "Editor" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Preview" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Info" })).toBeInTheDocument();
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

  it("parses exact dark colors, semantic tokens, and all eight accents", () => {
    const style = document.createElement("style");
    style.dataset.testTheme = "true";
    style.textContent = gruvboxCss;
    document.head.append(style);
    document.documentElement.dataset.theme = "dark";
    const tokens = getComputedStyle(document.documentElement);

    expect(tokens.getPropertyValue("--bg").trim()).toBe("#282828");
    expect(tokens.getPropertyValue("--surface").trim()).toBe("#32302f");
    expect(tokens.getPropertyValue("--panel").trim()).toBe("#3c3836");
    expect(tokens.getPropertyValue("--border").trim()).toBe("#504945");
    expect(tokens.getPropertyValue("--text").trim()).toBe("#ebdbb2");
    expect(tokens.getPropertyValue("--muted").trim()).toBe("#a89984");
    for (const semantic of [
      "focus",
      "selection",
      "error",
      "warning",
      "success",
      "link",
      "code"
    ]) {
      expect(tokens.getPropertyValue(`--${semantic}`).trim()).not.toBe("");
    }
    for (const accent of ["red", "green", "yellow", "blue", "purple", "aqua", "orange", "gray"]) {
      expect(tokens.getPropertyValue(`--accent-${accent}`).trim()).not.toBe("");
    }
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
