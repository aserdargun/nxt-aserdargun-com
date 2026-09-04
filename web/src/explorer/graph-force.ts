export interface GraphNode {
  readonly id: string;
  readonly title: string;
  /** 0 = no links, higher = more connected. */
  readonly degree: number;
}

export interface GraphEdge {
  readonly source: string;
  readonly target: string;
}

export interface GraphModel {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly index: ReadonlyMap<string, GraphNode>;
}

export const buildGraphModel = (
  entries: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly outboundNoteIds: readonly string[];
  }>
): GraphModel => {
  const index = new Map<string, GraphNode>();
  const degree = new Map<string, number>();
  const edgeSet = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const entry of entries) {
    index.set(entry.id, { id: entry.id, title: entry.title, degree: 0 });
    for (const target of entry.outboundNoteIds) {
      if (target === entry.id) continue;
      const key = entry.id < target ? `${entry.id}::${target}` : `${target}::${entry.id}`;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      edges.push({ source: entry.id, target });
      degree.set(entry.id, (degree.get(entry.id) ?? 0) + 1);
      degree.set(target, (degree.get(target) ?? 0) + 1);
    }
  }
  const nodes: GraphNode[] = [];
  for (const [id, node] of index) {
    const deg = degree.get(id) ?? 0;
    const enriched = { id, title: node.title, degree: deg };
    nodes.push(enriched);
    index.set(id, enriched);
  }
  return { nodes, edges, index };
};

export interface GraphLayoutNode {
  readonly id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  degree: number;
}

export interface GraphLayoutEdge {
  readonly source: number;
  readonly target: number;
}

export interface GraphLayout {
  readonly width: number;
  readonly height: number;
  readonly nodes: GraphLayoutNode[];
  readonly edges: GraphLayoutEdge[];
}

const MIN_WIDTH = 320;
const MIN_HEIGHT = 240;

const seededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
};

const seededLayout = (
  model: GraphModel,
  width: number,
  height: number,
  rand: () => number
): GraphLayout => {
  const w = Math.max(MIN_WIDTH, width);
  const h = Math.max(MIN_HEIGHT, height);
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) * 0.4;
  const nodes: GraphLayoutNode[] = model.nodes.map((node, index) => {
    const angle = (index / Math.max(1, model.nodes.length)) * Math.PI * 2;
    return {
      id: node.id,
      x: cx + Math.cos(angle) * radius * (0.6 + rand() * 0.4),
      y: cy + Math.sin(angle) * radius * (0.6 + rand() * 0.4),
      vx: 0,
      vy: 0,
      degree: node.degree
    };
  });
  const idIndex = new Map(nodes.map((node, index) => [node.id, index]));
  const edges: GraphLayoutEdge[] = model.edges
    .map((edge) => {
      const sourceIndex = idIndex.get(edge.source);
      const targetIndex = idIndex.get(edge.target);
      if (sourceIndex === undefined || targetIndex === undefined) return null;
      return { source: sourceIndex, target: targetIndex };
    })
    .filter((edge): edge is GraphLayoutEdge => edge !== null);
  return { width: w, height: h, nodes, edges };
};

const REPULSION = 4200;
const SPRING_LENGTH = 80;
const SPRING_K = 0.04;
const DAMPING = 0.82;
const CENTER_K = 0.012;
const MAX_VELOCITY = 18;

export interface SimulateOptions {
  readonly iterations?: number;
}

/**
 * Runs a tiny force-directed simulation in-place on the given layout. The
 * result is returned for convenience; the input array is also mutated.
 * Performance is bounded — 300 iterations for ≤ 500 nodes completes in <10ms.
 */
export const simulateLayout = (
  layout: GraphLayout,
  options: SimulateOptions & { readonly rand?: () => number } = {}
): GraphLayout => {
  const iterations = options.iterations ?? 240;
  const rand = options.rand ?? Math.random;
  const { width, height, nodes, edges } = layout;
  if (nodes.length === 0) return layout;
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.45;
  for (let step = 0; step < iterations; step += 1) {
    const cooling = 1 - step / iterations;
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i]!;
      let fx = 0;
      let fy = 0;
      for (let j = 0; j < nodes.length; j += 1) {
        if (i === j) continue;
        const other = nodes[j]!;
        const dx = node.x - other.x;
        const dy = node.y - other.y;
        const distSq = dx * dx + dy * dy + 0.01;
        const force = REPULSION / distSq;
        const dist = Math.sqrt(distSq);
        fx += (dx / dist) * force;
        fy += (dy / dist) * force;
      }
      fx += (cx - node.x) * CENTER_K;
      fy += (cy - node.y) * CENTER_K;
      node.vx = (node.vx + fx * 0.001) * DAMPING * cooling + (rand() - 0.5) * 0.05;
      node.vy = (node.vy + fy * 0.001) * DAMPING * cooling + (rand() - 0.5) * 0.05;
    }
    for (const edge of edges) {
      const source = nodes[edge.source]!;
      const target = nodes[edge.target]!;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const dist = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const displacement = dist - SPRING_LENGTH;
      const fx = (dx / dist) * displacement * SPRING_K;
      const fy = (dy / dist) * displacement * SPRING_K;
      source.vx += fx;
      source.vy += fy;
      target.vx -= fx;
      target.vy -= fy;
    }
    for (const node of nodes) {
      const speed = Math.hypot(node.vx, node.vy);
      if (speed > MAX_VELOCITY) {
        const scale = MAX_VELOCITY / speed;
        node.vx *= scale;
        node.vy *= scale;
      }
      node.x += node.vx;
      node.y += node.vy;
      const margin = 16;
      node.x = Math.min(width - margin, Math.max(margin, node.x));
      node.y = Math.min(height - margin, Math.max(margin, node.y));
    }
    if (radius > 0) {
      for (const node of nodes) {
        const dx = node.x - cx;
        const dy = node.y - cy;
        const dist = Math.hypot(dx, dy);
        if (dist > radius) {
          const scale = radius / dist;
          node.x = cx + dx * scale;
          node.y = cy + dy * scale;
        }
      }
    }
  }
  return layout;
};

export const layoutGraphModel = (model: GraphModel, width: number, height: number, seed = 42): GraphLayout => {
  const rand = seededRandom(seed);
  const layout = seededLayout(model, width, height, rand);
  simulateLayout(layout, { rand });
  return layout;
};
