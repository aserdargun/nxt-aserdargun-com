import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/index.js";

describe("renderMarkdown", () => {
  it("sanitizes active markup and preserves GFM", async () => {
    const rendered = await renderMarkdown("<script>alert(1)</script>\n\n- [x] done\n\n[[Plan|Open]]");
    expect(rendered.html).not.toContain("script");
    expect(rendered.html).toContain('type="checkbox"');
    expect(rendered.wikiLinks).toEqual([{ target: "Plan", label: "Open" }]);
  });

  it("removes executable markup while retaining safe headings and text", async () => {
    const rendered = await renderMarkdown("# Başlık\n\n<a href=\"javascript:alert(1)\" onclick=\"alert(1)\">bad</a><iframe src=\"https://evil.example\"></iframe><object data=\"x\"></object><svg onload=\"alert(1)\"></svg>\n\n[ok](/api/private/assets/a)");
    expect(rendered.html).toContain('<h1 id="başlık">Başlık</h1>');
    expect(rendered.html).toContain('href="/api/private/assets/a"');
    expect(rendered.html).not.toMatch(/javascript:|onclick|iframe|object|svg|onload/i);
    expect(rendered.outline).toEqual([{ depth: 1, id: "başlık", text: "Başlık" }]);
    expect(rendered.plainText).toContain("Başlık");
  });
});
