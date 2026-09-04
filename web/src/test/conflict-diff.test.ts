import { describe, expect, it } from "vitest";
import { projectConflictDiff } from "../editor/conflict-diff";

describe("conflict line diff projection", () => {
  it("classifies unchanged, removed, and added lines exactly", () => {
    const projection = projectConflictDiff(
      "same\nlocal only\nrepeat\nlocal tail\nend",
      "same\ndrive only\nrepeat\ndrive tail\nend"
    );

    expect(projection.local).toEqual([
      { kind: "unchanged", text: "same" },
      { kind: "removal", text: "local only" },
      { kind: "unchanged", text: "repeat" },
      { kind: "removal", text: "local tail" },
      { kind: "unchanged", text: "end" }
    ]);
    expect(projection.drive).toEqual([
      { kind: "unchanged", text: "same" },
      { kind: "addition", text: "drive only" },
      { kind: "unchanged", text: "repeat" },
      { kind: "addition", text: "drive tail" },
      { kind: "unchanged", text: "end" }
    ]);
    expect(projection.counts).toEqual({ additions: 2, removals: 2 });
    expect(projection.strategy).toBe("bounded-lcs");
  });

  it("falls back before an adversarial middle exceeds the 10,000-cell budget", () => {
    const localLines = Array.from({ length: 101 }, (_, index) => `local-${index}`);
    const driveLines = Array.from({ length: 101 }, (_, index) => `drive-${index}`);

    const projection = projectConflictDiff(localLines.join("\n"), driveLines.join("\n"));

    expect(projection.strategy).toBe("whole-middle-fallback");
    expect(projection.local).toEqual(localLines.map((text) => ({ kind: "removal", text })));
    expect(projection.drive).toEqual(driveLines.map((text) => ({ kind: "addition", text })));
    expect(projection.counts).toEqual({ additions: 101, removals: 101 });
  });

  it("keeps fallback linear when a bounded source contains 130,001 short lines", () => {
    const localSource = "\n".repeat(130_000);

    const projection = projectConflictDiff(localSource, "changed");

    expect(projection.strategy).toBe("whole-middle-fallback");
    expect(projection.local).toHaveLength(130_001);
    expect(projection.local[0]).toEqual({ kind: "removal", text: "" });
    expect(projection.local.at(-1)).toEqual({ kind: "removal", text: "" });
    expect(projection.drive).toEqual([{ kind: "addition", text: "changed" }]);
    expect(projection.counts).toEqual({ additions: 1, removals: 130_001 });
  });

  it("preserves trailing newlines and repeated lines deterministically", () => {
    const first = projectConflictDiff("repeat\nrepeat\n", "repeat\nchanged\n");
    const second = projectConflictDiff("repeat\nrepeat\n", "repeat\nchanged\n");

    expect(first).toEqual(second);
    expect(first.local).toEqual([
      { kind: "unchanged", text: "repeat" },
      { kind: "removal", text: "repeat" },
      { kind: "unchanged", text: "" }
    ]);
    expect(first.drive).toEqual([
      { kind: "unchanged", text: "repeat" },
      { kind: "addition", text: "changed" },
      { kind: "unchanged", text: "" }
    ]);
    expect(projectConflictDiff("", "")).toEqual({
      local: [],
      drive: [],
      counts: { additions: 0, removals: 0 },
      strategy: "bounded-lcs"
    });
  });

  it("treats LF, CRLF, and lone CR as equivalent logical line separators", () => {
    const crlfProjection = projectConflictDiff(
      "same\nlocal only\nend",
      "same\r\ndrive only\r\nend"
    );

    expect(crlfProjection.local).toEqual([
      { kind: "unchanged", text: "same" },
      { kind: "removal", text: "local only" },
      { kind: "unchanged", text: "end" }
    ]);
    expect(crlfProjection.drive).toEqual([
      { kind: "unchanged", text: "same" },
      { kind: "addition", text: "drive only" },
      { kind: "unchanged", text: "end" }
    ]);
    expect(crlfProjection.counts).toEqual({ additions: 1, removals: 1 });

    expect(projectConflictDiff(
      "same\rlocal only\rend",
      "same\ndrive only\nend"
    )).toMatchObject({
      local: [
        { kind: "unchanged", text: "same" },
        { kind: "removal", text: "local only" },
        { kind: "unchanged", text: "end" }
      ],
      drive: [
        { kind: "unchanged", text: "same" },
        { kind: "addition", text: "drive only" },
        { kind: "unchanged", text: "end" }
      ],
      counts: { additions: 1, removals: 1 }
    });
  });
});
