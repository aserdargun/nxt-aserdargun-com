import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveOutline, OutlinePanel } from "../explorer/outline-panel";

afterEach(cleanup);

describe("rendered Markdown outline", () => {
  const markdown = [
    "# **Bold** `code` #",
    "",
    "Setext *emphasis*",
    "-----------------",
    "",
    "> # Quoted heading",
    "",
    "## Duplicate",
    "## Duplicate"
  ].join("\n");

  it("uses the renderer's CommonMark headings, visible labels, and exact stable IDs", () => {
    expect(deriveOutline(markdown)).toEqual([
      { id: "nxt-heading-bold-code", level: 1, label: "Bold code" },
      { id: "nxt-heading-setext-emphasis", level: 2, label: "Setext emphasis" },
      { id: "nxt-heading-duplicate", level: 2, label: "Duplicate" },
      { id: "nxt-heading-duplicate-2", level: 2, label: "Duplicate" }
    ]);
  });

  it("emits the exact rendered heading identity when an outline item is activated", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<OutlinePanel source={markdown} onNavigate={onNavigate} />);

    await user.click(screen.getAllByRole("button", { name: "Duplicate" })[1]!);

    expect(onNavigate).toHaveBeenCalledWith({
      id: "nxt-heading-duplicate-2",
      level: 2,
      label: "Duplicate"
    });
  });
});
