import {
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
  const [drag, setDrag] = useState<{ id: string; pointerId: number } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const layout: GraphLayout = useMemo(() => {
    if (model.nodes.length === 0) {
      return { width: size.width, height: size.height, nodes: [], edges: [] };
    }
    return layoutGraphModel(model, size.width, size.height);
  }, [model, size.height, size.width]);

  const titleById = useMemo(() => buildTitleLookup(model), [model]);
  const idToIndex = useMemo(() => new Map(layout.nodes.map((node, index) => [node.id, index])), [layout.nodes]);
  const highlightedIds = useMemo(() => {
    if (hoverId !== null) return new Set<string>([hoverId]);
    if (selectedNoteId !== undefined) return new Set<string>([selectedNoteId]);
    return null;
  }, [hoverId, selectedNoteId]);

  const onPointerDown = (id: string) => (event: ReactPointerEvent<SVGCircleElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    setDrag({ id, pointerId: event.pointerId });
    (event.target as Element).setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (drag === null) return;
    const target = containerRef.current;
    if (target === null) return;
    const rect = target.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    const layoutNode = layout.nodes[idToIndex.get(drag.id) ?? -1];
    if (layoutNode === undefined) return;
    layoutNode.x = localX;
    layoutNode.y = localY;
    layoutNode.vx = 0;
    layoutNode.vy = 0;
    setSize({ width: rect.width, height: rect.height });
  };

  const onPointerUp = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (drag === null) return;
    if ((event.target as Element).hasPointerCapture?.(drag.pointerId)) {
      (event.target as Element).releasePointerCapture(drag.pointerId);
    }
    setDrag(null);
  };

  const onNodeClick = (id: string) => (): void => onSelect?.(id);
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
    <div className="graph-view" ref={containerRef}>
      <ResizeSensor onResize={(width, height) => setSize({ width, height })} />
      <svg
        className="graph-view-svg"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width={layout.width}
        height={layout.height}
        role="group"
        aria-label="Note link graph"
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
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
                onClick={onNodeClick(node.id)}
                onKeyDown={onNodeKeyDown(node.id)}
                onPointerEnter={() => setHoverId(node.id)}
                onPointerLeave={() => setHoverId((current) => (current === node.id ? null : current))}
              >
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={isHighlighted ? HIGHLIGHT_RADIUS : radiusForDegree(node.degree)}
                  className="graph-node-hit"
                  onPointerDown={onPointerDown(node.id)}
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
