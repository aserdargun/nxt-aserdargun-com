import { describe, expect, it } from "vitest";
import gruvboxCss from "../theme/gruvbox.css?raw";
import layoutCss from "../theme/layout.css?raw";

interface StyleRuleSnapshot {
  readonly media: string | undefined;
  readonly selectors: readonly string[];
  readonly style: CSSStyleDeclaration;
}

const parseStyleRules = (css: string): StyleRuleSnapshot[] => {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  const collect = (rules: CSSRuleList, media?: string, result: StyleRuleSnapshot[] = []) => {
    for (const rule of rules) {
      if (rule.type === CSSRule.STYLE_RULE) {
        const styleRule = rule as CSSStyleRule;
        result.push({ media, selectors: styleRule.selectorText.split(",").map((s) => s.trim()), style: styleRule.style });
      } else if (rule.type === CSSRule.MEDIA_RULE) {
        const mediaRule = rule as CSSMediaRule;
        collect(mediaRule.cssRules, mediaRule.conditionText, result);
      }
    }
    return result;
  };
  return collect(style.sheet?.cssRules ?? ([] as unknown as CSSRuleList));
};

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

interface RgbaColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha: number;
}

const assertChannel = (value: number, label: string): number => {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Unsupported ${label} channel: ${value}`);
  }
  return value;
};

const resolveCssColor = (
  input: string,
  tokens: ReadonlyMap<string, string>,
  resolving: ReadonlySet<string> = new Set()
): RgbaColor => {
  const value = input.trim();
  if (value === "transparent") return { red: 0, green: 0, blue: 0, alpha: 0 };

  const hexMatch = value.match(/^#([0-9a-f]{6})$/iu);
  if (hexMatch?.[1] !== undefined) {
    const encoded = hexMatch[1];
    return {
      red: Number.parseInt(encoded.slice(0, 2), 16) / 255,
      green: Number.parseInt(encoded.slice(2, 4), 16) / 255,
      blue: Number.parseInt(encoded.slice(4, 6), 16) / 255,
      alpha: 1
    };
  }

  const variableMatch = value.match(/^var\((--[a-z0-9-]+)\)$/iu);
  if (variableMatch?.[1] !== undefined) {
    const token = variableMatch[1];
    if (resolving.has(token)) throw new Error(`Cyclic color token: ${token}`);
    const resolved = tokens.get(token);
    if (resolved === undefined || resolved.trim() === "") throw new Error(`Unresolved color token: ${token}`);
    return resolveCssColor(resolved, tokens, new Set([...resolving, token]));
  }

  const mixMatch = value.match(
    /^color-mix\(\s*in\s+srgb\s*,\s*(var\(--[a-z0-9-]+\)|#[0-9a-f]{6}|transparent)\s+([0-9]+(?:\.[0-9]+)?)%\s*,\s*(var\(--[a-z0-9-]+\)|#[0-9a-f]{6}|transparent)(?:\s+([0-9]+(?:\.[0-9]+)?)%)?\s*\)$/iu
  );
  if (mixMatch?.[1] !== undefined && mixMatch[2] !== undefined && mixMatch[3] !== undefined) {
    const first = resolveCssColor(mixMatch[1], tokens, resolving);
    const second = resolveCssColor(mixMatch[3], tokens, resolving);
    const firstWeight = Number.parseFloat(mixMatch[2]) / 100;
    const secondWeight = mixMatch[4] === undefined ? 1 - firstWeight : Number.parseFloat(mixMatch[4]) / 100;
    const weightTotal = firstWeight + secondWeight;
    if (!Number.isFinite(weightTotal) || weightTotal <= 0) throw new Error(`Unsupported color mix: ${value}`);
    const firstAlphaWeight = first.alpha * firstWeight / weightTotal;
    const secondAlphaWeight = second.alpha * secondWeight / weightTotal;
    const alpha = firstAlphaWeight + secondAlphaWeight;
    if (alpha === 0) return { red: 0, green: 0, blue: 0, alpha: 0 };
    return {
      red: assertChannel((first.red * firstAlphaWeight + second.red * secondAlphaWeight) / alpha, "red"),
      green: assertChannel((first.green * firstAlphaWeight + second.green * secondAlphaWeight) / alpha, "green"),
      blue: assertChannel((first.blue * firstAlphaWeight + second.blue * secondAlphaWeight) / alpha, "blue"),
      alpha: assertChannel(alpha, "alpha")
    };
  }

  throw new Error(`Unsupported CSS color: ${value}`);
};

const compositeOver = (foreground: RgbaColor, background: RgbaColor): RgbaColor => {
  assertChannel(foreground.red, "foreground red");
  assertChannel(foreground.green, "foreground green");
  assertChannel(foreground.blue, "foreground blue");
  assertChannel(foreground.alpha, "foreground alpha");
  assertChannel(background.red, "background red");
  assertChannel(background.green, "background green");
  assertChannel(background.blue, "background blue");
  assertChannel(background.alpha, "background alpha");
  const alpha = foreground.alpha + background.alpha * (1 - foreground.alpha);
  if (alpha === 0) return { red: 0, green: 0, blue: 0, alpha: 0 };
  return {
    red: (foreground.red * foreground.alpha + background.red * background.alpha * (1 - foreground.alpha)) / alpha,
    green: (foreground.green * foreground.alpha + background.green * background.alpha * (1 - foreground.alpha)) / alpha,
    blue: (foreground.blue * foreground.alpha + background.blue * background.alpha * (1 - foreground.alpha)) / alpha,
    alpha
  };
};

const rgbaLuminance = (color: RgbaColor): number => {
  if (color.alpha !== 1) throw new Error(`Contrast surface must be opaque, received alpha ${color.alpha}`);
  const channels = [color.red, color.green, color.blue].map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  );
  return channels.reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
};

const rgbaRatio = (first: RgbaColor, second: RgbaColor): number => {
  const left = rgbaLuminance(first);
  const right = rgbaLuminance(second);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
};

describe("NXT 1.1 semantic theme tokens", () => {
  it("defines semantic tokens in every dark and light theme branch", () => {
    const rules = parseStyleRules(gruvboxCss);
    const tokens = ["--separator", "--control-border", "--text-muted-strong", "--text-warning", "--text-danger", "--warning-border", "--danger-border", "--focus-ring"];
    const branches = [
      [":root[data-theme=\"dark\"]", undefined, "#3c3836"],
      [":root[data-theme=\"light\"]", undefined, "#fbf1c7"],
      [":root[data-theme=\"system\"]", undefined, "#3c3836"],
      [":root[data-theme=\"system\"]", "prefers-color-scheme: light", "#fbf1c7"]
    ] as const;

    for (const [selector, media, background] of branches) {
      const match = rules.find(
        (rule) =>
          rule.selectors.includes(selector) &&
          (media === undefined ? rule.media === undefined : rule.media?.includes(media) === true)
      );
      expect(match, `Missing ${selector} ${media ?? "base"} branch`).toBeDefined();
      for (const token of tokens) expect(match!.style.getPropertyValue(token).trim()).toMatch(/^#[0-9a-f]{6}$/iu);
      expect(ratio(match!.style.getPropertyValue("--text-danger").trim(), background)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(match!.style.getPropertyValue("--text-warning").trim(), background)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(match!.style.getPropertyValue("--text-muted-strong").trim(), background)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(match!.style.getPropertyValue("--control-border").trim(), background)).toBeGreaterThanOrEqual(3);
      expect(ratio(match!.style.getPropertyValue("--warning-border").trim(), background)).toBeGreaterThanOrEqual(3);
      expect(ratio(match!.style.getPropertyValue("--danger-border").trim(), background)).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps the light focus ring distinguishable from the actual panel surface", () => {
    const rules = parseStyleRules(gruvboxCss);
    const lightBranches = [
      [":root[data-theme=\"light\"]", undefined],
      [":root[data-theme=\"system\"]", "prefers-color-scheme: light"]
    ] as const;

    for (const [selector, media] of lightBranches) {
      const match = rules.find(
        (rule) =>
          rule.selectors.includes(selector) &&
          (media === undefined ? rule.media === undefined : rule.media?.includes(media) === true)
      );
      expect(match, `Missing ${selector} ${media ?? "base"} branch`).toBeDefined();
      expect(ratio(
        match!.style.getPropertyValue("--focus-ring").trim(),
        match!.style.getPropertyValue("--panel").trim()
      )).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps both light focus rings on the approved yellow token instead of the orange warning token", () => {
    const rules = parseStyleRules(gruvboxCss);
    const lightBranches = [
      [":root[data-theme=\"light\"]", undefined],
      [":root[data-theme=\"system\"]", "prefers-color-scheme: light"]
    ] as const;

    for (const [selector, media] of lightBranches) {
      const match = rules.find(
        (rule) =>
          rule.selectors.includes(selector) &&
          (media === undefined ? rule.media === undefined : rule.media?.includes(media) === true)
      );
      expect(match, `Missing ${selector} ${media ?? "base"} branch`).toBeDefined();
      expect(match!.style.getPropertyValue("--focus-ring").trim()).toBe("#7c5900");
      expect(match!.style.getPropertyValue("--focus-ring").trim()).not.toBe(
        match!.style.getPropertyValue("--orange").trim()
      );
    }
  });

  it("keeps required dark text and control boundaries above their thresholds", () => {
    expect(ratio(hex(gruvboxCss, "--text-danger"), "#3c3836")).toBeGreaterThanOrEqual(4.5);
    expect(ratio(hex(gruvboxCss, "--text-warning"), "#3c3836")).toBeGreaterThanOrEqual(4.5);
    expect(ratio(hex(gruvboxCss, "--text-muted-strong"), "#3c3836")).toBeGreaterThanOrEqual(4.5);
    expect(ratio(hex(gruvboxCss, "--control-border"), "#3c3836")).toBeGreaterThanOrEqual(3);
    expect(ratio(hex(gruvboxCss, "--danger-border"), "#3c3836")).toBeGreaterThanOrEqual(3);
  });

  it("keeps actual conflict marker glyphs above 4.5:1 through every theme branch", () => {
    const themeRules = parseStyleRules(gruvboxCss);
    const layoutRules = parseStyleRules(layoutCss);
    const markerRules = [
      ["removal", ".conflict-diff-marker-removal"],
      ["addition", ".conflict-diff-marker-addition"]
    ] as const;
    const branches = [
      ["dark", ":root[data-theme=\"dark\"]", undefined],
      ["light", ":root[data-theme=\"light\"]", undefined],
      ["system-dark", ":root[data-theme=\"system\"]", undefined],
      ["system-light", ":root[data-theme=\"system\"]", "prefers-color-scheme: light"]
    ] as const;

    for (const [branchName, selector, media] of branches) {
      const theme = themeRules.find(
        (rule) => rule.selectors.includes(selector)
          && (media === undefined ? rule.media === undefined : rule.media?.includes(media) === true)
      );
      expect(theme, `Missing ${branchName} theme branch`).toBeDefined();
      const tokens = new Map<string, string>();
      for (const property of theme!.style) tokens.set(property, theme!.style.getPropertyValue(property).trim());
      const gutterSurface = resolveCssColor("var(--surface)", tokens);

      for (const [kind, markerSelector] of markerRules) {
        const marker = layoutRules.find((rule) => rule.selectors.includes(markerSelector) && rule.media === undefined);
        expect(marker, `Missing ${kind} marker rule`).toBeDefined();
        const tintedMarkerSurface = compositeOver(
          resolveCssColor(marker!.style.getPropertyValue("background"), tokens),
          gutterSurface
        );
        const glyph = compositeOver(
          resolveCssColor(marker!.style.getPropertyValue("color"), tokens),
          tintedMarkerSurface
        );
        expect(
          rgbaRatio(glyph, tintedMarkerSurface),
          `${branchName} ${kind} marker glyph contrast`
        ).toBeGreaterThanOrEqual(4.5);
      }
    }

    expect(() => resolveCssColor("var(--missing)", new Map())).toThrow(/Unresolved color token/u);
    expect(() => resolveCssColor("lab(50% 0 0)", new Map())).toThrow(/Unsupported CSS color/u);
    expect(() => rgbaRatio(
      { red: 1, green: 1, blue: 1, alpha: 0.5 },
      { red: 0, green: 0, blue: 0, alpha: 1 }
    )).toThrow(/must be opaque/u);
  });
});
