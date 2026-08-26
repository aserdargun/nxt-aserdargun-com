import { describe, expect, it } from "vitest";
import {
  attachmentIsReferenced,
  attachmentReferenceProjection,
  canonicalAttachmentReference,
  createPortableAttachmentMarkdown,
  projectionReferencesAttachment,
  renderMarkdown
} from "../src/index.js";

const noteId = "018f47d2-6a34-7b2a-9f21-8a7034963aef";
const opaque = "v1.abcdefghijklmnop.a_drive_identifier-with-dots.abcdefghijklmnopqrstuv";

describe("attachment reference projection", () => {
  it.each([
    {
      notePath: "Plan.md",
      name: "diagram.png",
      inlineImage: true,
      markdown: `![diagram\\.png](<_assets/${noteId}/diagram.png>)`,
      canonical: `_assets/${noteId}/diagram.png`
    },
    {
      notePath: "Notes/Plan.md",
      name: "Cafe\u0301 [draft] #1?.png",
      inlineImage: true,
      markdown: `![Café \\[draft\\] \\#1\\?\\.png](<../_assets/${noteId}/Caf%C3%A9%20%5Bdraft%5D%20%231%3F.png>)`,
      canonical: `_assets/${noteId}/Café [draft] #1?.png`
    },
    {
      notePath: "Notes/Inbox/Deep/Plan.md",
      name: "100% <done> (final)!'$&+,;=@.pdf",
      inlineImage: false,
      markdown: `[100\\% \\<done\\> \\(final\\)\\!\\'\\$\\&\\+\\,\\;\\=\\@\\.pdf](<../../../_assets/${noteId}/100%25%20%3Cdone%3E%20%28final%29%21%27%24%26%2B%2C%3B%3D%40.pdf>)`,
      canonical: `_assets/${noteId}/100% <done> (final)!'$&+,;=@.pdf`
    },
    {
      notePath: "Notes/Inbox/Plan.md",
      name: "report).png",
      inlineImage: true,
      markdown: `![report\\)\\.png](<../../_assets/${noteId}/report%29.png>)`,
      canonical: `_assets/${noteId}/report).png`
    },
    {
      notePath: "Notes/Inbox/Plan.md",
      name: "report(1.png",
      inlineImage: true,
      markdown: `![report\\(1\\.png](<../../_assets/${noteId}/report%281.png>)`,
      canonical: `_assets/${noteId}/report(1.png`
    }
  ])("creates a portable, parser-stable attachment reference for $notePath / $name", ({
    notePath,
    name,
    inlineImage,
    markdown,
    canonical
  }) => {
    const generated = createPortableAttachmentMarkdown({ notePath, noteId, name, inlineImage });

    expect(generated).toBe(markdown);
    const projection = attachmentReferenceProjection(generated, notePath);
    expect(projection).toEqual([canonical]);
    expect(attachmentIsReferenced({ source: generated, notePath, noteId, name: canonical.slice(canonical.lastIndexOf("/") + 1) })).toBe(true);
    expect(projectionReferencesAttachment(projection, { noteId, name: canonical.slice(canonical.lastIndexOf("/") + 1) })).toBe(true);
  });

  it.each([
    {
      name: "<done>.png",
      inlineImage: true,
      html: `<p><img src="/api/private/attachments/${opaque}" alt="<done>.png"></p>`
    },
    {
      name: "mail <user@example.com>.pdf",
      inlineImage: false,
      html: `<p><a href="/api/private/attachments/${opaque}">mail &#x3C;user@example.com>.pdf</a></p>`
    },
    {
      name: `punct !"#$%&'()*+,-.:;<=>?@[]^_\`{|}~.txt`,
      inlineImage: false,
      html: `<p><a href="/api/private/attachments/${opaque}">punct !"#$%&#x26;'()*+,-.:;&#x3C;=>?@[]^_\`{|}~.txt</a></p>`
    },
    {
      name: "Café [世界] <δοκιμή> #?.pdf",
      inlineImage: false,
      html: `<p><a href="/api/private/attachments/${opaque}">Café [世界] &#x3C;δοκιμή> #?.pdf</a></p>`
    }
  ])("keeps the exact normalized filename as the rendered label for $name", async ({
    name,
    inlineImage,
    html
  }) => {
    const notePath = "Notes/Inbox/Plan.md";
    const markdown = createPortableAttachmentMarkdown({ notePath, noteId, name, inlineImage });
    const expectedReference = `_assets/${noteId}/${name}`;
    const projection = attachmentReferenceProjection(markdown, notePath);
    const rendered = await renderMarkdown(markdown, {
      rewriteUrl: (value) => canonicalAttachmentReference(value, notePath) === expectedReference
        ? `/api/private/attachments/${opaque}`
        : undefined
    });

    expect(rendered.html).toBe(html);
    expect(projection).toEqual([expectedReference]);
    expect(attachmentIsReferenced({ source: markdown, notePath, noteId, name, opaqueId: opaque })).toBe(true);
    expect(projectionReferencesAttachment(projection, { noteId, name, opaqueId: opaque })).toBe(true);
    expect(rendered.html.match(/<a\b/gu) ?? []).toHaveLength(inlineImage ? 0 : 1);
    expect(rendered.html).not.toMatch(/mailto:|https?:|<script\b|javascript:/iu);
  });

  it("canonicalizes inline, reference, escaped, encoded and Obsidian attachment forms", () => {
    const source = [
      `![inline](../../_assets/${noteId}/diagram\\.png)`,
      `[ref]: <../../_assets/${noteId}/diagram.png>`,
      `![use][ref]`,
      `![[../../_assets/${noteId}/diagram%2Epng|Diagram]]`,
      `![opaque](/api/private/attachments/${opaque})`
    ].join("\n");
    const projection = attachmentReferenceProjection(source, "Notes/Inbox/Plan.md");
    expect(projection).toContain(`_assets/${noteId}/diagram.png`);
    expect(projection).toContain(`/api/private/attachments/${opaque}`);
    expect(attachmentIsReferenced({ source, notePath: "Notes/Inbox/Plan.md", noteId, name: "diagram.png", opaqueId: opaque })).toBe(true);
  });

  it("rejects external, near-match, query and raw ID forms", () => {
    const source = `![external](https://example.test/_assets/${noteId}/diagram.png)\n![near](../../_assets/${noteId}/diagram.png.bak)\n![query](../../_assets/${noteId}/diagram.png?x=1)\n![raw](/api/private/attachments/raw-drive-id)`;
    expect(attachmentIsReferenced({ source, notePath: "Notes/Inbox/Plan.md", noteId, name: "diagram.png", opaqueId: opaque })).toBe(false);
  });

  it("uses the renderer parser for collapsed definitions and decodes path segments only after syntax checks", () => {
    const source = [
      `[asset]: ../../_assets/${noteId}/diagram%23draft.png`,
      `![collapsed][]`,
      `![full][asset]`,
      `![query](../../_assets/${noteId}/diagram.png?blocked)`,
      `![fragment](../../_assets/${noteId}/diagram.png#blocked)`
    ].join("\n").replace("[collapsed][]", "![asset][]");
    const projection = attachmentReferenceProjection(source, "Notes/Inbox/Plan.md");
    expect(projection).toContain(`_assets/${noteId}/diagram#draft.png`);
    expect(projection).not.toContain(`_assets/${noteId}/diagram.png`);
  });
});
