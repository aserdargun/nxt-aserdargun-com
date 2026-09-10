import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphView } from "../explorer/graph-view";

const entries = [
  { id: "plans", title: "Plans", outboundNoteIds: ["research"] },
  { id: "research", title: "Research", outboundNoteIds: [] }
] as const;

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

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

const pointer = (element: Element, type: string, x: number, y: number, pointerId = 1): void => {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  fireEvent(element, event);
};

it("drags in SVG coordinates at half scale, updates edges, and does not open a dragged note", () => {
  const onSelect = vi.fn();
  render(<GraphView entries={entries} onSelect={onSelect} />);
  const graph = screen.getByRole("group", { name: "Note link graph" });
  vi.spyOn(graph, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 20, 300, 240));
  const plans = screen.getByRole("button", { name: "Plans" });
  Object.assign(plans, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() });
  const circle = plans.querySelector(".graph-node-hit")!;
  const x = Number(circle.getAttribute("cx"));
  const y = Number(circle.getAttribute("cy"));
  pointer(plans, "pointerdown", 10 + x / 2, 20 + y / 2);
  pointer(graph, "pointermove", 30 + x / 2, 35 + y / 2, 2);
  expect(Number(circle.getAttribute("cx"))).toBe(x);
  pointer(graph, "pointermove", 30 + x / 2, 35 + y / 2);
  expect(Number(circle.getAttribute("cx"))).toBeCloseTo(x + 40);
  expect(Number(circle.getAttribute("cy"))).toBeCloseTo(y + 30);
  expect(Number(graph.querySelector("line")!.getAttribute("x1"))).toBeCloseTo(x + 40);
  pointer(plans, "pointerup", 30 + x / 2, 35 + y / 2);
  fireEvent.click(plans);
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.keyDown(plans, { key: "Enter" });
  expect(onSelect).toHaveBeenCalledWith("plans");
});

it("ends cancelled drags, clamps nodes to the graph, and accepts a later click", () => {
  const onSelect = vi.fn();
  render(<GraphView entries={entries} onSelect={onSelect} />);
  const graph = screen.getByRole("group", { name: "Note link graph" });
  vi.spyOn(graph, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 480));
  const plans = screen.getByRole("button", { name: "Plans" });
  Object.assign(plans, { setPointerCapture: vi.fn(), hasPointerCapture: () => false });
  const circle = plans.querySelector(".graph-node-hit")!;
  pointer(plans, "pointerdown", Number(circle.getAttribute("cx")), Number(circle.getAttribute("cy")));
  pointer(graph, "pointermove", -1000, -1000);
  expect(Number(circle.getAttribute("cx"))).toBe(9);
  expect(Number(circle.getAttribute("cy"))).toBe(9);
  pointer(graph, "pointercancel", -1000, -1000);
  pointer(graph, "pointermove", 400, 400);
  expect(Number(circle.getAttribute("cx"))).toBe(9);
  pointer(plans, "pointerdown", 9, 9);
  pointer(plans, "pointerup", 9, 9);
  fireEvent.click(plans);
  expect(onSelect).toHaveBeenCalledOnce();
});
