import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GraphView } from "../explorer/graph-view";

const entries = [
  { id: "plans", title: "Plans", outboundNoteIds: ["research"] },
  { id: "research", title: "Research", outboundNoteIds: [] }
] as const;

describe("note link graph", () => {
  it("keeps every plotted note named and keyboard reachable", () => {
    const onSelect = vi.fn();
    render(<GraphView entries={entries} onSelect={onSelect} />);

    const plans = screen.getByRole("button", { name: "Plans" });
    const research = screen.getByRole("button", { name: "Research" });
    expect(plans).toHaveAttribute("tabindex", "0");
    expect(research).toHaveAttribute("tabindex", "0");
    expect(screen.getByText("Plans")).toBeInTheDocument();
    expect(screen.getByText("Research")).toBeInTheDocument();

    fireEvent.keyDown(plans, { key: "Enter" });
    fireEvent.keyDown(research, { key: " " });
    expect(onSelect).toHaveBeenNthCalledWith(1, "plans");
    expect(onSelect).toHaveBeenNthCalledWith(2, "research");
  });
});
