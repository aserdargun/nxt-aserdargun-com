import { describe, expect, it } from "vitest";
import { createPublicId, deriveIndex } from "../src/index.js";

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
});
