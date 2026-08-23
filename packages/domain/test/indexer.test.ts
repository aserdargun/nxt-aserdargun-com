import { describe, expect, it } from "vitest";
import { createPublicId, deriveIndex, renderMarkdown } from "../src/index.js";

const first = {
  source: `---
id: 018f47d2-6a34-7b2a-9f21-8a7034963aef
title: Plan
created: 2026-08-23T12:00:00.000Z
updated: 2026-08-23T12:00:00.000Z
tags: [plan]
aliases: []
---

[[Next]] hedefi`,
  driveId: "drive-plan",
  path: "Notes/Plan.md",
  driveVersion: "1",
  attachments: []
};

const second = {
  source: `---
id: 018f47d2-6a34-7b2a-9f21-8a7034963aff
title: Next
created: 2026-08-23T12:00:00.000Z
updated: 2026-08-23T12:00:00.000Z
tags: []
aliases: []
---

# Sonraki`,
  driveId: "drive-next",
  path: "Notes/Next.md",
  driveVersion: "2",
  attachments: []
};

describe("index derivation", () => {
  it("derives outbound links, backlinks, search text, and unresolved targets", () => {
    const index = deriveIndex([first, second]);
    expect(index.entries[0]?.outboundNoteIds).toEqual([second.source.match(/id: (.+)/u)?.[1]]);
    expect(index.entries[1]?.backlinks).toEqual([first.source.match(/id: (.+)/u)?.[1]]);
    expect(index.entries[0]?.searchText).toContain("hedefi");
    expect(index.entries[0]?.unresolvedWikiTargets).toEqual([]);
  });

  it("creates base64url identifiers with 128 bits", () => {
    expect(Buffer.from(createPublicId(), "base64url")).toHaveLength(16);
  });

  it("does not index wiki links inside multi-backtick code", () => {
    const coded = {
      ...first,
      source: first.source.replace("[[Next]] hedefi", "``[[Next]]``\n\n````md\n[[Next]]\n```\n[[Next]]\n````")
    };
    const index = deriveIndex([coded, second]);
    expect(index.entries[0]?.outboundNoteIds).toEqual([]);
    expect(index.entries[0]?.unresolvedWikiTargets).toEqual([]);
    expect(index.entries[1]?.backlinks).toEqual([]);
  });

  it("uses rendered plain text for excerpts and search text", async () => {
    const body = "Visible `inline code`\n\n```ts\nconst kept = true;\n```\n\n<script>discarded()</script>";
    const record = {
      ...first,
      source: first.source.replace("[[Next]] hedefi", body)
    };
    const rendered = await renderMarkdown(body);
    const index = deriveIndex([record]);
    expect(index.entries[0]?.excerpt).toBe(rendered.plainText);
    expect(index.entries[0]?.searchText).toMatch(/const kept = true\s*;/u);
    expect(index.entries[0]?.searchText).not.toContain("discarded");
  });
});
