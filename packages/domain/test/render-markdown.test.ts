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
    expect(rendered.html).toContain('<h1 id="nxt-heading-başlık">Başlık</h1>');
    expect(rendered.html).toContain('href="/api/private/assets/a"');
    expect(rendered.html).not.toMatch(/javascript:|onclick|iframe|object|svg|onload/i);
    expect(rendered.outline).toEqual([{ depth: 1, id: "nxt-heading-başlık", text: "Başlık" }]);
    expect(rendered.plainText).toContain("Başlık");
  });

  it("keeps only canonical app attachment image routes", async () => {
    const token = "v1.abcdefghijklmnop.asset_1.abcdefghijklmnopqrstuv";
    const publicId = "a".repeat(22);
    const assetId = "b".repeat(22);
    const rendered = await renderMarkdown(`![external](https://attacker.example/track.png)\n![encoded](/api%2Fprivate%2Fattachments%2Fasset)\n![protocol-relative](//attacker.example/track.png)\n![private](/api/private/attachments/${token})\n![public](/api/public/assets/${publicId}/${assetId})`);
    expect(rendered.html).not.toMatch(/attacker\.example|api%2Fprivate/iu);
    expect(rendered.html).toContain(`src="/api/private/attachments/${token}"`);
    expect(rendered.html).toContain(`src="/api/public/assets/${publicId}/${assetId}"`);
  });

  it("keeps the exact opaque attachment token grammar emitted by the private codec", async () => {
    const token = "v1.abcdefghijklmnop.a_drive_identifier-with-dots.abcdefghijklmnopqrstuv";
    const rendered = await renderMarkdown(`![asset](/api/private/attachments/${token})\n![raw](/api/private/attachments/raw-drive-id)\n![query](/api/private/attachments/${token}?x=1)`);
    expect(rendered.html).toContain(`src="/api/private/attachments/${token}"`);
    expect(rendered.html).not.toContain("raw-drive-id");
    expect(rendered.html).not.toContain("?x=1");
  });

  it("namespaces clobber-prone heading identifiers in the outline and HTML", async () => {
    const rendered = await renderMarkdown("# constructor");
    expect(rendered.outline).toEqual([{ depth: 1, id: "nxt-heading-constructor", text: "constructor" }]);
    expect(rendered.html).toContain('<h1 id="nxt-heading-constructor">constructor</h1>');
  });
});
