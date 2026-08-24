import { describe, expect, it } from "vitest";
import { attachmentIsReferenced, attachmentReferenceProjection } from "../src/index.js";

const noteId = "018f47d2-6a34-7b2a-9f21-8a7034963aef";
const opaque = "v1.abcdefghijklmnop.a_drive_identifier-with-dots.abcdefghijklmnopqrstuv";

describe("attachment reference projection", () => {
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
