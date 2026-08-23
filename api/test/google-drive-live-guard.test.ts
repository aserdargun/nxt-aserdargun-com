import { describe, expect, it } from "vitest";
import { assertDirectActiveIntegrationChildren } from "./support/google-drive-live-guard.js";

describe("live Drive integration child guard", () => {
  it("rejects C0 and C1 controls in IDs without rejecting ordinary Unicode", () => {
    const child = (id: string) => ({
      id,
      mimeType: "text/plain",
      parentIds: ["integration-root"],
      trashed: false
    });

    expect(() =>
      assertDirectActiveIntegrationChildren(
        [child("ordinary-İ-你好-🙂")],
        "integration-root",
        new Set()
      )
    ).not.toThrow();

    for (const control of ["\u0001", "\u007f", "\u0080", "\u0085", "\u009f"]) {
      expect(() =>
        assertDirectActiveIntegrationChildren(
          [child(`unsafe${control}id`)],
          "integration-root",
          new Set()
        )
      ).toThrow("child verification failed");
    }
  });

  it("retains bounded unique active non-shortcut direct-child checks", () => {
    const valid = {
      id: "valid-id",
      mimeType: "text/plain",
      parentIds: ["integration-root"],
      trashed: false
    };
    expect(() =>
      assertDirectActiveIntegrationChildren(
        [valid],
        "integration-root",
        new Set()
      )
    ).not.toThrow();

    const invalidChildren = [
      { ...valid, id: "" },
      { ...valid, id: "x".repeat(513) },
      { ...valid, trashed: true },
      { ...valid, mimeType: "application/vnd.google-apps.shortcut" },
      { ...valid, parentIds: [] },
      { ...valid, parentIds: ["other-root"] },
      { ...valid, parentIds: ["integration-root", "other-root"] }
    ];
    for (const invalid of invalidChildren) {
      expect(() =>
        assertDirectActiveIntegrationChildren(
          [invalid],
          "integration-root",
          new Set()
        )
      ).toThrow("child verification failed");
    }
    expect(() =>
      assertDirectActiveIntegrationChildren(
        [valid],
        "integration-root",
        new Set([valid.id])
      )
    ).toThrow("child verification failed");
  });
});
