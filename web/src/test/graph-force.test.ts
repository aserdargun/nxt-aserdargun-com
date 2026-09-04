import { describe, expect, it } from "vitest";
import { buildGraphModel, layoutGraphModel, simulateLayout } from "../explorer/graph-force";

const NOTE_A = "018f47d2-6a34-7b2a-9f21-8a7034963a01";
const NOTE_B = "018f47d2-6a34-7b2a-9f21-8a7034963a02";
const NOTE_C = "018f47d2-6a34-7b2a-9f21-8a7034963a03";
const NOTE_D = "018f47d2-6a34-7b2a-9f21-8a7034963a04";

describe("buildGraphModel", () => {
  it("returns an empty model for an empty input", () => {
    const model = buildGraphModel([]);
    expect(model.nodes).toEqual([]);
    expect(model.edges).toEqual([]);
    expect(model.index.size).toBe(0);
  });

  it("creates a node per entry even when no edges exist", () => {
    const model = buildGraphModel([
      { id: NOTE_A, title: "A", outboundNoteIds: [] },
      { id: NOTE_B, title: "B", outboundNoteIds: [] }
    ]);
    expect(model.nodes).toHaveLength(2);
    expect(model.edges).toHaveLength(0);
    expect(model.index.get(NOTE_A)?.degree).toBe(0);
  });

  it("builds undirected edges with the correct degree on each endpoint", () => {
    const model = buildGraphModel([
      { id: NOTE_A, title: "A", outboundNoteIds: [NOTE_B, NOTE_C] },
      { id: NOTE_B, title: "B", outboundNoteIds: [NOTE_A] },
      { id: NOTE_C, title: "C", outboundNoteIds: [NOTE_A] },
      { id: NOTE_D, title: "D", outboundNoteIds: [] }
    ]);
    expect(model.edges).toHaveLength(2);
    expect(model.index.get(NOTE_A)?.degree).toBe(2);
    expect(model.index.get(NOTE_B)?.degree).toBe(1);
    expect(model.index.get(NOTE_C)?.degree).toBe(1);
    expect(model.index.get(NOTE_D)?.degree).toBe(0);
  });

  it("ignores self-loops and duplicate edges", () => {
    const model = buildGraphModel([
      { id: NOTE_A, title: "A", outboundNoteIds: [NOTE_A, NOTE_B, NOTE_B] },
      { id: NOTE_B, title: "B", outboundNoteIds: [NOTE_A] }
    ]);
    expect(model.edges).toHaveLength(1);
    expect(model.index.get(NOTE_A)?.degree).toBe(1);
  });
});

describe("layoutGraphModel", () => {
  it("produces deterministic positions for the same seed", () => {
    const model = buildGraphModel([
      { id: NOTE_A, title: "A", outboundNoteIds: [NOTE_B] },
      { id: NOTE_B, title: "B", outboundNoteIds: [NOTE_A] },
      { id: NOTE_C, title: "C", outboundNoteIds: [NOTE_B] }
    ]);
    const first = layoutGraphModel(model, 400, 300, 7);
    const second = layoutGraphModel(model, 400, 300, 7);
    expect(first.nodes).toHaveLength(3);
    expect(second.nodes).toHaveLength(3);
    for (let index = 0; index < first.nodes.length; index += 1) {
      expect(first.nodes[index]!.x).toBeCloseTo(second.nodes[index]!.x, 5);
      expect(first.nodes[index]!.y).toBeCloseTo(second.nodes[index]!.y, 5);
    }
  });

  it("returns empty layout for an empty model", () => {
    const model = buildGraphModel([]);
    const layout = layoutGraphModel(model, 400, 300);
    expect(layout.nodes).toEqual([]);
    expect(layout.edges).toEqual([]);
    expect(layout.width).toBe(400);
    expect(layout.height).toBe(300);
  });

  it("keeps every node inside the requested viewport", () => {
    const model = buildGraphModel([
      { id: NOTE_A, title: "A", outboundNoteIds: [NOTE_B, NOTE_C, NOTE_D] },
      { id: NOTE_B, title: "B", outboundNoteIds: [NOTE_A] },
      { id: NOTE_C, title: "C", outboundNoteIds: [NOTE_A] },
      { id: NOTE_D, title: "D", outboundNoteIds: [NOTE_A] }
    ]);
    const layout = layoutGraphModel(model, 480, 360);
    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(16);
      expect(node.x).toBeLessThanOrEqual(480);
      expect(node.y).toBeGreaterThanOrEqual(16);
      expect(node.y).toBeLessThanOrEqual(360);
    }
  });
});

describe("simulateLayout", () => {
  it("reduces overlap after the simulation converges", () => {
    const model = buildGraphModel([
      { id: NOTE_A, title: "A", outboundNoteIds: [NOTE_B, NOTE_C, NOTE_D] },
      { id: NOTE_B, title: "B", outboundNoteIds: [NOTE_A] },
      { id: NOTE_C, title: "C", outboundNoteIds: [NOTE_A] },
      { id: NOTE_D, title: "D", outboundNoteIds: [NOTE_A] }
    ]);
    const layout = layoutGraphModel(model, 400, 300);
    const positions = layout.nodes.map((node) => [node.x, node.y] as const);
    const overlapping = positions.some(([ax, ay], i) => positions.slice(i + 1).some(([bx, by]) => Math.hypot(ax - bx, ay - by) < 4));
    expect(overlapping).toBe(false);
  });

  it("accepts a deterministic random source for tests", () => {
    const model = buildGraphModel([
      { id: NOTE_A, title: "A", outboundNoteIds: [NOTE_B] },
      { id: NOTE_B, title: "B", outboundNoteIds: [NOTE_A] }
    ]);
    let state = 1;
    const rand = () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
    const layout = layoutGraphModel(model, 400, 300);
    simulateLayout(layout, { rand, iterations: 30 });
    expect(layout.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
  });
});
