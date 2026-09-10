import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import { Network } from "lucide-react";
import {
  buildGraphModel,
  layoutGraphModel,
  type GraphLayout,
  type GraphModel
} from "./graph-force";

export interface GraphViewProps {
  readonly entries: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly outboundNoteIds: readonly string[];
  }>;
  readonly selectedNoteId?: string | undefined;
  readonly onSelect?: ((noteId: string) => void) | undefined;
}

const NODE_RADIUS = 5;
const HIGHLIGHT_RADIUS = 9;

const radiusForDegree = (degree: number): number => NODE_RADIUS + Math.min(4, degree * 0.6);
const visibleTitle = (title: string): string => title.length > 24 ? `${title.slice(0, 23)}…` : title;

const buildTitleLookup = (model: GraphModel): Map<string, string> => {
  const map = new Map<string, string>();
  for (const node of model.nodes) map.set(node.id, node.title);
  return map;
};

const ResizeSensor = ({ onResize }: { readonly onResize: (width: number, height: number) => void }): React.JSX.Element => {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const target = ref.current;
    if (target === null) return undefined;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const rect = entry.contentRect;
        onResize(rect.width, rect.height);
      }
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [onResize]);
  return <div ref={ref} className="graph-view-sensor" aria-hidden />;
};

export const GraphView = ({ entries, selectedNoteId, onSelect }: GraphViewProps): React.JSX.Element => {
  const model = useMemo(() => buildGraphModel(entries), [entries]);
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 600, height: 480 });
  const [hoverId, setHoverId] = useState<string | null>(null);
  const dragRef = useRef<{
    id: string; pointerId: number; startX: number; startY: number;
    offsetX: number; offsetY: number; moved: boolean;
  } | null>(null);
  const suppressedClick = useRef<string | null>(null);
  const [positions, setPositions] = useState<ReadonlyMap<string, { x: number; y: number }>>(() => new Map());
  const resize = useCallback((width: number, height: number): void => {
    if (width <= 0 || height <= 0) return;
    setSize((current) => current.width === width && current.height === height ? current : { width, height });
  }, []);

  const baseLayout: GraphLayout = useMemo(() => {
    if (model.nodes.length === 0) {
      return { width: size.width, height: size.height, nodes: [], edges: [] };
    }
    return layoutGraphModel(model, size.width, size.height);
  }, [model, size.height, size.width]);

  const layout: GraphLayout = useMemo(() => {
    return {
      ...baseLayout,
      nodes: baseLayout.nodes.map((node) => {
        const position = positions.get(node.id);
        return position === undefined ? node : { ...node, x: position.x * baseLayout.width, y: position.y * baseLayout.height };
      })
    };
  }, [baseLayout, positions]);

  const titleById = useMemo(() => buildTitleLookup(model), [model]);
  const idToIndex = useMemo(() => new Map(layout.nodes.map((node, index) => [node.id, index])), [layout.nodes]);
  const highlightedIds = useMemo(() => {
    if (hoverId !== null) return new Set<string>([hoverId]);
    if (selectedNoteId !== undefined) return new Set<string>([selectedNoteId]);
    return null;
  }, [hoverId, selectedNoteId]);

  const svgPoint = (svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } | null => {
    const rect = svg.getBoundingClientRect();
    const scale = Math.min(rect.width / layout.width, rect.height / layout.height);
    if (scale <= 0) return null;
    return {
      x: (clientX - rect.left - (rect.width - layout.width * scale) / 2) / scale,
      y: (clientY - rect.top - (rect.height - layout.height * scale) / 2) / scale
    };
  };

  const onPointerDown = (id: string) => (event: ReactPointerEvent<SVGGElement>): void => {
    if (event.button !== 0 || dragRef.current !== null) return;
    const svg = event.currentTarget.ownerSVGElement;
    const node = layout.nodes[idToIndex.get(id) ?? -1];
    const point = svg === null ? null : svgPoint(svg, event.clientX, event.clientY);
    if (node === undefined || point === null) return;
    event.preventDefault();
    event.currentTarget.focus();
    suppressedClick.current = null;
    dragRef.current = {
      id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      offsetX: node.x - point.x, offsetY: node.y - point.y, moved: false
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const drag = dragRef.current;
    if (drag === null || event.pointerId !== drag.pointerId) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return;
    const point = svgPoint(event.currentTarget, event.clientX, event.clientY);
    if (point === null) return;
    drag.moved = true;
    const x = Math.max(HIGHLIGHT_RADIUS, Math.min(layout.width - HIGHLIGHT_RADIUS, point.x + drag.offsetX));
    const y = Math.max(HIGHLIGHT_RADIUS, Math.min(layout.height - HIGHLIGHT_RADIUS, point.y + drag.offsetY));
    setPositions((current) => new Map(current).set(drag.id, { x: x / layout.width, y: y / layout.height }));
  };

  const onPointerUp = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const drag = dragRef.current;
    if (drag === null || event.pointerId !== drag.pointerId) return;
    suppressedClick.current = drag.moved || event.type === "pointercancel" ? drag.id : null;
    dragRef.current = null;
    const target = event.target as Element;
    if (target.hasPointerCapture?.(drag.pointerId)) target.releasePointerCapture(drag.pointerId);
  };

  const onNodeClick = (id: string) => (): void => {
    if (suppressedClick.current === id) {
      suppressedClick.current = null;
      return;
    }
    onSelect?.(id);
  };
  const onNodeKeyDown = (id: string) => (event: ReactKeyboardEvent<SVGGElement>): void => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelect?.(id);
  };

  if (model.nodes.length === 0) {
    return (
      <div className="graph-view graph-view-empty">
        <Network size={20} aria-hidden />
        <p>No notes to plot yet. Create a note to start the graph.</p>
      </div>
    );
  }

  return (
    <div className="graph-view">
      <ResizeSensor onResize={resize} />
      <svg
        className="graph-view-svg"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width={layout.width}
        height={layout.height}
        role="group"
        aria-label="Note link graph"
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={onPointerUp}
      >
        <g className="graph-view-edges">
          {layout.edges.map((edge, index) => {
            const source = layout.nodes[edge.source];
            const target = layout.nodes[edge.target];
            if (source === undefined || target === undefined) return null;
            const isHighlighted =
              highlightedIds !== null &&
              (highlightedIds.has(source.id) || highlightedIds.has(target.id));
            return (
              <line
                key={`${edge.source}-${edge.target}-${index}`}
                x1={source.x}
                y1={source.y}
                x2={target.x}
                y2={target.y}
                className={isHighlighted ? "graph-edge graph-edge-highlighted" : "graph-edge"}
              />
            );
          })}
        </g>
        <g className="graph-view-nodes">
          {layout.nodes.map((node) => {
            const isSelected = node.id === selectedNoteId;
            const isHovered = node.id === hoverId;
            const isHighlighted = isSelected || isHovered;
            const title = titleById.get(node.id) ?? node.id;
            return (
              <g
                key={node.id}
                className={`graph-node${isHighlighted ? " graph-node-active" : ""}`}
                role="button"
                tabIndex={0}
                aria-label={title}
                onPointerDown={onPointerDown(node.id)}
                onClick={onNodeClick(node.id)}
                onKeyDown={onNodeKeyDown(node.id)}
                onPointerEnter={() => setHoverId(node.id)}
                onPointerLeave={() => setHoverId((current) => (current === node.id ? null : current))}
              >
                <circle cx={node.x} cy={node.y} r={22} fill="transparent" aria-hidden />
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={isHighlighted ? HIGHLIGHT_RADIUS : radiusForDegree(node.degree)}
                  className="graph-node-hit"
                  aria-hidden
                />
                <text
                  x={node.x + radiusForDegree(node.degree) + 5}
                  y={node.y + 4}
                  className="graph-node-label"
                  aria-hidden
                >
                  {visibleTitle(title)}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
      {hoverId !== null ? (
        <div className="graph-view-tooltip" role="status" aria-live="polite">
          {titleById.get(hoverId) ?? hoverId}
        </div>
      ) : null}
    </div>
  );
};
