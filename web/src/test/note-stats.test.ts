import { describe, expect, it } from "vitest";
import { computeNoteStats, formatNoteStatsForCard, formatReadingTime, formatStatNumber } from "../editor/note-stats";

const NOTE_ID = "018f47d2-6a34-7b2a-9f21-8a7034963aef";

const source = (body: string): string => `---
id: "${NOTE_ID}"
title: "Plan"
created: "2026-08-23T09:00:00.000Z"
updated: "2026-08-23T09:03:00.000Z"
tags: []
aliases: []
---

${body.replace(/\n*$/u, "")}
`;

describe("note-stats", () => {
  it("counts words and characters in the body, ignoring frontmatter", () => {
    const stats = computeNoteStats(source("Hello world from NXT.\nSecond line here."), "plans/test.md");
    expect(stats.words).toBe(7);
    expect(stats.chars).toBe(41);
  });

  it("returns at least one minute for any non-empty body", () => {
    expect(computeNoteStats(source("hi"), "a.md").readingMinutes).toBe(1);
  });

  it("counts ATX headings", () => {
    const stats = computeNoteStats(source("# H1\n## H2\n### H3\nbody"), "a.md");
    expect(stats.headings).toBe(3);
  });

  it("counts paired fenced code blocks", () => {
    const stats = computeNoteStats(source("```\nfoo\n```\n\n~~~\nbar\n~~~\ntext"), "a.md");
    expect(stats.codeBlocks).toBe(2);
  });

  it("counts wiki links and attachment references", () => {
    const stats = computeNoteStats(source("See [[Other Note]] and [[Third|alias]].\n\n![img](<../_assets/" + NOTE_ID + "/photo.png>)"), "plans/test.md");
    expect(stats.links).toBe(2);
    expect(stats.attachments).toBe(1);
  });

  it("falls back to a frontmatter strip when the source is partial", () => {
    const partial = "---\nid: x\ntitle: t\n---\njust text";
    const stats = computeNoteStats(partial, "x.md");
    expect(stats.words).toBe(2);
  });

  it("formats numbers and reading time", () => {
    expect(formatStatNumber(12345)).toBe("12,345");
    expect(formatReadingTime(0)).toBe("< 1 min read");
    expect(formatReadingTime(7)).toBe("7 min read");
  });

  it("produces a card-friendly model with localized timestamps", () => {
    const card = formatNoteStatsForCard(computeNoteStats(source("# A\nbody"), "a.md"));
    expect(card.headings).toBe("1");
    expect(card.createdLabel).not.toBeNull();
    expect(card.updatedLabel).not.toBeNull();
  });
});
