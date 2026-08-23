import { describe, expect, it } from "vitest";
import { extractWikiLinks, parseNote, resolveWikiLinks, resolveWikiTarget, serializeNote } from "../src/index.js";

const source = `---
id: 018f47d2-6a34-7b2a-9f21-8a7034963aef
title: 2026 Planı
created: 2026-08-23T12:00:00.000Z
updated: 2026-08-23T12:00:00.000Z
tags: [plan]
aliases: [Yıllık Plan]
---

# Hedef
`;

describe("note codec", () => {
  it("round-trips UTF-8 frontmatter without publication fields", () => {
    const note = parseNote(source);
    expect(note.body).toContain("# Hedef");
    const serialized = serializeNote(note);
    expect(serialized).toMatch(/^---\nid: /u);
    expect(serialized).toMatch(/\n---\n\n# Hedef\n$/u);
    expect(parseNote(serialized)).toEqual(note);
  });

  it("rejects duplicate and invalid frontmatter without mutating the source", () => {
    const duplicate = source.replace("title: 2026 Planı", "title: İlk\ntitle: İkinci");
    expect(() => parseNote(duplicate)).toThrow(/duplicate|map key/i);
    expect(() => parseNote(source.replace("tags: [plan]", "published: true"))).toThrow();
  });
});

describe("wiki links", () => {
  it("ignores inline and fenced code", () => {
    expect(extractWikiLinks("[[Plan]] `[[Code]]`\n```md\n[[Fence]]\n```\n[[Open|Read]]")).toEqual([
      { target: "Plan", label: null },
      { target: "Open", label: "Read" }
    ]);
  });

  it("ignores multi-backtick spans and only closes a bare compatible fence", () => {
    expect(extractWikiLinks("``[[Inline]]`` [[Visible]]\n\n````md\n[[FourFence]]\n```\n[[StillFenced]]\n```` trailing\n[[AlsoFenced]]\n````\n[[Open]]")).toEqual([
      { target: "Visible", label: null },
      { target: "Open", label: null }
    ]);
  });

  it("accepts a longer bare closing fence", () => {
    expect(extractWikiLinks("````md\n[[Hidden]]\n`````\n[[Open]]")).toEqual([
      { target: "Open", label: null }
    ]);
  });

  it("does not guess ambiguous aliases", () => {
    expect(resolveWikiTarget("Plan", [
      { id: "a", title: "A", aliases: ["Plan"] },
      { id: "b", title: "B", aliases: ["Plan"] }
    ])).toEqual({ kind: "ambiguous", candidateIds: ["a", "b"] });
  });

  it("resolves tokenized links without reparsing code spans", () => {
    const links = extractWikiLinks("[[Plan]] `[[Ignored]]`");
    expect(resolveWikiLinks(links, [{ id: "a", title: "Plan", aliases: [] }])).toEqual([
      { target: "Plan", label: null, resolution: { kind: "resolved", noteId: "a" } }
    ]);
  });
});
