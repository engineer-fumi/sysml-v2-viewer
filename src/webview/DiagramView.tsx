import { useEffect, useMemo, useRef, useState } from "react";
import {
  DiagramEdge,
  DiagramKind,
  DiagramNode,
  DiagramPort,
  EdgeStyle,
  LayoutOffsets,
  PortSide,
  edgeRoutingBase,
  layoutDiagram,
  portOffsetKey,
} from "../core/layout";
import { SysMLElement } from "../core/ast";

export type EditMode = "select" | "connect" | `add:${string}`;

interface LivePort {
  key: string;
  x: number;
  y: number;
  side: PortSide;
}

interface Interaction {
  mode: EditMode;
  selected?: SysMLElement;
  marked?: SysMLElement;
  onClick: (el: SysMLElement) => void;
  onDoubleClick: (el: SysMLElement) => void;
  onBoxMouseDown: (node: DiagramNode, e: React.MouseEvent) => void;
  onResizeMouseDown: (node: DiagramNode, e: React.MouseEvent, fromTop: boolean) => void;
  onPortMouseDown: (node: DiagramNode, port: DiagramPort, e: React.MouseEvent) => void;
  portKey: (owner: SysMLElement, port: SysMLElement) => string;
  /** drag-in-progress port position (ghost) */
  livePort?: LivePort | null;
  /** start dragging an edge (optionally an existing waypoint) */
  onEdgeMouseDown: (edge: DiagramEdge, e: React.MouseEvent, waypointIndex?: number) => void;
  onWaypointRemove: (edge: DiagramEdge, index: number) => void;
  /** drag-in-progress edge routing */
  liveEdge?: { key: string; points: { x: number; y: number }[] } | null;
  /** open the context menu for an edge (optionally on a waypoint) */
  onEdgeContextMenu: (edge: DiagramEdge, e: React.MouseEvent, waypointIndex?: number) => void;
  /** start dragging an edge endpoint along its box border */
  onEndpointMouseDown: (edge: DiagramEdge, which: "a" | "b", e: React.MouseEvent) => void;
  /** drag-in-progress endpoint position (ghost) */
  liveAnchor?: { key: string; which: "a" | "b"; x: number; y: number } | null;
  /** open the context menu for a box / actor / port element */
  onNodeContextMenu: (el: SysMLElement, e: React.MouseEvent, named: boolean) => void;
}

interface MenuItem {
  label: string;
  action?: () => void;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
}

interface Props {
  root: SysMLElement;
  /** diagram view kind (general / bdd / ibd / req / uc / state / action / seq) */
  kind: DiagramKind;
  selected?: SysMLElement;
  /** secondary highlight (connect souce) */
  marked?: SysMLElement;
  mode: EditMode;
  offsets: LayoutOffsets;
  keyOf: (el: SysMLElement) => string;
  onElementClick: (el: SysMLElement) => void;
  onElementDoubleClick: (el: SysMLElement) => void;
  /** commit a box move (delta in diagram coordinates) */
  onMoveBox: (key: string, ddx: number, ddy: number) => void;
  /** commit a box resize (delta in diagram coordinates); fromTop grows the
   *  upper edge (the box shifts up by the height gained) */
  onResizeBox: (key: string, ddw: number, ddh: number, fromTop: boolean) => void;
  /** commit a port move to a border side at position t (0..1 along the side) */
  onMovePort: (key: string, side: PortSide, t: number) => void;
  /** commit manual edge routing (empty array clears the routing) */
  onRouteEdge: (key: string, points: { x: number; y: number }[]) => void;
  /** change the line style of an edge */
  onEdgeStyle: (key: string, style: EdgeStyle) => void;
  /** pin an edge endpoint to a border position; null side clears both pins */
  onAnchorEdge: (key: string, which: "a" | "b" | null, side?: PortSide, t?: number) => void;
  /** delete the model element behind a box / line */
  onDeleteElement: (el: SysMLElement) => void;
  /** enter connect mode with the given element as the source */
  onStartConnect: (el: SysMLElement) => void;
  /** click on empty canvas (used by the add modes) */
  onBackgroundClick?: () => void;
}

/** edge kinds whose underlying statement can be safely deleted from the menu
 *  (synthesized edges like compose / specialize map to declarations) */
const DELETABLE_EDGE_KINDS = new Set([
  "connect", "flow", "bind", "transition", "interface", "connection",
  "allocation", "satisfy", "perform", "import",
]);

const KIND_FILL: Record<string, string> = {
  package: "#2a2a3e",
  "library package": "#2a2a3e",
  "part def": "#1e2a40",
  part: "#22304a",
  "item def": "#1c3331",
  item: "#1c3331",
  "action def": "#2a2340",
  action: "#2f284a",
  "state def": "#3a2438",
  state: "#42293f",
  "requirement def": "#3a2229",
  requirement: "#42262e",
  exhibit: "#42293f",
  perform: "#2f284a",
};

const EDGE_COLOR: Record<string, string> = {
  connect: "#74c7ec",
  connection: "#74c7ec",
  interface: "#fab387",
  bind: "#9399b2",
  flow: "#a6e3a1",
  transition: "#f5c2e7",
  allocation: "#f9e2af",
  specialize: "#cba6f7",
  compose: "#89b4fa",
  satisfy: "#f38ba8",
  perform: "#b4befe",
  assoc: "#9399b2",
  import: "#7f849c",
};

/** kinds whose end marker is custom (hollow triangle / diamond), not the generic arrow */
const CUSTOM_MARKER_KINDS = new Set(["specialize", "compose"]);

function fillFor(node: DiagramNode): string {
  return KIND_FILL[node.el.kind] ?? "#252536";
}

function strokeFor(node: DiagramNode, it: Interaction): { stroke: string; width: number } {
  if (it.selected === node.el) return { stroke: "#f9e2af", width: 2.5 };
  if (it.marked === node.el) return { stroke: "#a6e3a1", width: 2.5 };
  return { stroke: "#585b70", width: 1.2 };
}

/** use case actor: stick figure with the name below */
function ActorFigure({ node, it }: { node: DiagramNode; it: Interaction }) {
  const { stroke } = strokeFor(node, it);
  const color = it.selected === node.el ? stroke : "#fab387";
  const cx = node.x + node.w / 2;
  const top = node.y + 4;
  const draggable = it.mode === "select" && !!node.el.name;
  return (
    <g
      onClick={(e) => {
        e.stopPropagation();
        it.onClick(node.el);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        it.onDoubleClick(node.el);
      }}
      onMouseDown={(e) => {
        if (draggable) {
          e.stopPropagation();
          it.onBoxMouseDown(node, e);
        }
      }}
      onContextMenu={(e) => it.onNodeContextMenu(node.el, e, !!node.el.name)}
      style={{ cursor: draggable ? "move" : "pointer" }}
    >
      <rect x={node.x} y={node.y} width={node.w} height={node.h} fill="transparent" />
      <circle cx={cx} cy={top + 9} r={8} fill="none" stroke={color} strokeWidth={1.6} />
      <line x1={cx} y1={top + 17} x2={cx} y2={top + 40} stroke={color} strokeWidth={1.6} />
      <line x1={cx - 14} y1={top + 25} x2={cx + 14} y2={top + 25} stroke={color} strokeWidth={1.6} />
      <line x1={cx} y1={top + 40} x2={cx - 12} y2={top + 58} stroke={color} strokeWidth={1.6} />
      <line x1={cx} y1={top + 40} x2={cx + 12} y2={top + 58} stroke={color} strokeWidth={1.6} />
      <text
        x={cx}
        y={top + 74}
        textAnchor="middle"
        fontSize={12}
        fontWeight={600}
        fill="#cdd6f4"
        pointerEvents="none"
      >
        {node.label}
      </text>
    </g>
  );
}

function NodeBox({ node, it }: { node: DiagramNode; it: Interaction }) {
  if (node.actor) return <ActorFigure node={node} it={it} />;
  const { stroke, width } = strokeFor(node, it);
  const headerY = node.y + 14;
  // any named box can be moved in select mode (children re-anchor the parent)
  const draggable = it.mode === "select" && !!node.el.name;
  const shapeProps = {
    fill: fillFor(node),
    stroke,
    strokeWidth: width,
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      it.onClick(node.el);
    },
    onDoubleClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      it.onDoubleClick(node.el);
    },
    onMouseDown: (e: React.MouseEvent) => {
      if (draggable) {
        e.stopPropagation();
        it.onBoxMouseDown(node, e);
      }
    },
    onContextMenu: (e: React.MouseEvent) => it.onNodeContextMenu(node.el, e, !!node.el.name),
    style: { cursor: draggable ? "move" : "pointer" } as React.CSSProperties,
  };
  return (
    <g>
      {node.lifelineEnd !== undefined && (
        <line
          x1={node.x + node.w / 2}
          y1={node.y + node.h}
          x2={node.x + node.w / 2}
          y2={node.lifelineEnd}
          stroke="#585b70"
          strokeWidth={1}
          strokeDasharray="5 5"
        />
      )}
      {node.ellipse ? (
        <ellipse
          cx={node.x + node.w / 2}
          cy={node.y + node.h / 2}
          rx={node.w / 2 + 10}
          ry={node.h / 2 + 8}
          {...shapeProps}
        />
      ) : (
        <rect
          x={node.x}
          y={node.y}
          width={node.w}
          height={node.h}
          rx={node.rounded ? 14 : 4}
          {...shapeProps}
        />
      )}
      <text
        x={node.x + node.w / 2}
        y={headerY}
        textAnchor="middle"
        fontSize={10}
        fill="#9399b2"
        pointerEvents="none"
      >
        {`«${node.kindLabel}»`}
      </text>
      <text
        x={node.x + node.w / 2}
        y={headerY + 15}
        textAnchor="middle"
        fontSize={12.5}
        fontWeight={600}
        fill="#cdd6f4"
        pointerEvents="none"
      >
        {node.label}
        {node.typeLabel && (
          <tspan fontWeight={400} fill="#89b4fa">
            {" " + node.typeLabel}
          </tspan>
        )}
      </text>
      {node.attributes.length > 0 && (
        <>
          <line
            x1={node.x}
            x2={node.x + node.w}
            y1={node.y + 36}
            y2={node.y + 36}
            stroke="#585b70"
            strokeWidth={0.8}
          />
          {node.attributes.map((a, i) => (
            <text
              key={i}
              x={node.x + 10}
              y={node.y + 50 + i * 16}
              fontSize={11}
              fill="#a6adc8"
              pointerEvents="none"
            >
              {a}
            </text>
          ))}
        </>
      )}
      {node.ports.map((p, i) => {
        const pk = it.portKey(node.el, p.el);
        const lp = it.livePort && it.livePort.key === pk ? it.livePort : undefined;
        const px = lp?.x ?? p.x;
        const py = lp?.y ?? p.y;
        const side = lp?.side ?? p.side;
        const labelPos =
          side === "left"
            ? { x: px + 9, y: py + 4, anchor: "start" as const }
            : side === "right"
              ? { x: px - 9, y: py + 4, anchor: "end" as const }
              : side === "top"
                ? { x: px, y: py + 18, anchor: "middle" as const }
                : { x: px, y: py - 10, anchor: "middle" as const };
        return (
          <g
            key={i}
            onClick={(e) => {
              e.stopPropagation();
              it.onClick(p.el);
            }}
            onMouseDown={(e) => {
              if (it.mode === "select") {
                e.stopPropagation();
                it.onPortMouseDown(node, p, e);
              }
            }}
            onContextMenu={(e) => it.onNodeContextMenu(p.el, e, false)}
            style={{ cursor: it.mode === "select" ? "move" : "pointer" }}
          >
            <rect
              x={px - 5}
              y={py - 5}
              width={10}
              height={10}
              fill={it.selected === p.el ? "#f9e2af" : it.marked === p.el ? "#a6e3a1" : "#fab387"}
              stroke="#1e1e2e"
              strokeWidth={1}
            />
            <text
              x={labelPos.x}
              y={labelPos.y}
              fontSize={10}
              fill="#fab387"
              textAnchor={labelPos.anchor}
              pointerEvents="none"
            >
              {p.name}
            </text>
          </g>
        );
      })}
      {node.children.map((c, i) => (
        <NodeBox key={i} node={c} it={it} />
      ))}
      {/* resize handles: bottom-right grows down/right, top-right grows up/right */}
      {draggable && !node.ellipse && node.lifelineEnd === undefined && (
        <>
          <path
            d={`M ${node.x + node.w} ${node.y + node.h - 12} L ${node.x + node.w} ${node.y + node.h} L ${node.x + node.w - 12} ${node.y + node.h} z`}
            fill="#585b70"
            onMouseDown={(e) => {
              e.stopPropagation();
              it.onResizeMouseDown(node, e, false);
            }}
            style={{ cursor: "nwse-resize" }}
          />
          <path
            d={`M ${node.x + node.w - 12} ${node.y} L ${node.x + node.w} ${node.y} L ${node.x + node.w} ${node.y + 12} z`}
            fill="#585b70"
            onMouseDown={(e) => {
              e.stopPropagation();
              it.onResizeMouseDown(node, e, true);
            }}
            style={{ cursor: "nesw-resize" }}
          />
        </>
      )}
    </g>
  );
}

type Axis = "h" | "v";

/** axis perpendicular to the box border the anchor point sits on */
function sideAxis(box: DiagramNode, p: { x: number; y: number }): Axis {
  const eps = 1.5;
  if (Math.abs(p.x - box.x) < eps || Math.abs(p.x - (box.x + box.w)) < eps) return "h";
  if (Math.abs(p.y - box.y) < eps || Math.abs(p.y - (box.y + box.h)) < eps) return "v";
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  return Math.abs(p.x - cx) * box.h > Math.abs(p.y - cy) * box.w ? "h" : "v";
}

/** one right-angle segment: leaves `prev` along `leave`, optionally arrives
 *  at `cur` along `arrive` (so arrows hit box borders perpendicular) */
function orthoSegment(
  prev: { x: number; y: number },
  cur: { x: number; y: number },
  leave: Axis,
  arrive?: Axis
): string {
  if (Math.abs(prev.x - cur.x) < 0.5 || Math.abs(prev.y - cur.y) < 0.5) {
    return ` L ${cur.x} ${cur.y}`;
  }
  if (arrive === "h") {
    if (leave === "h") {
      const mx = (prev.x + cur.x) / 2;
      return ` L ${mx} ${prev.y} L ${mx} ${cur.y} L ${cur.x} ${cur.y}`;
    }
    return ` L ${prev.x} ${cur.y} L ${cur.x} ${cur.y}`;
  }
  if (arrive === "v") {
    if (leave === "v") {
      const my = (prev.y + cur.y) / 2;
      return ` L ${prev.x} ${my} L ${cur.x} ${my} L ${cur.x} ${cur.y}`;
    }
    return ` L ${cur.x} ${prev.y} L ${cur.x} ${cur.y}`;
  }
  return leave === "v"
    ? ` L ${prev.x} ${cur.y} L ${cur.x} ${cur.y}`
    : ` L ${cur.x} ${prev.y} L ${cur.x} ${cur.y}`;
}

/** SVG path for the given style: straight polyline, right-angle, or curve */
function pathFor(
  pts: { x: number; y: number }[],
  style: EdgeStyle,
  startAxis?: Axis,
  endAxis?: Axis
): string {
  if (pts.length < 2) return "";
  if (style === "ortho") {
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1];
      const cur = pts[i];
      const leave = i === 1 ? startAxis ?? "h" : "h";
      const arrive = i === pts.length - 1 ? endAxis : undefined;
      d += orthoSegment(prev, cur, leave, arrive);
    }
    return d;
  }
  if (style === "curve") {
    if (pts.length === 2) {
      const [p0, p1] = pts;
      const dx = (p1.x - p0.x) / 2;
      return `M ${p0.x} ${p0.y} C ${p0.x + dx} ${p0.y}, ${p1.x - dx} ${p1.y}, ${p1.x} ${p1.y}`;
    }
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      d += ` Q ${pts[i].x} ${pts[i].y}, ${mx} ${my}`;
    }
    const last = pts[pts.length - 1];
    d += ` L ${last.x} ${last.y}`;
    return d;
  }
  return pts.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" ");
}

function EdgeLine({ edge, it }: { edge: DiagramEdge; it: Interaction }) {
  const color = EDGE_COLOR[edge.kind] ?? "#74c7ec";
  const isSelected = it.selected === edge.el;
  // full path: source anchor, manual waypoints (live ones while dragging), target anchor
  const live = it.liveEdge && edge.key && it.liveEdge.key === edge.key ? it.liveEdge.points : undefined;
  const waypoints = live ?? edge.points ?? [];
  const la = it.liveAnchor && edge.key && it.liveAnchor.key === edge.key ? it.liveAnchor : undefined;
  const start = la?.which === "a" ? { x: la.x, y: la.y } : { x: edge.x1, y: edge.y1 };
  const end = la?.which === "b" ? { x: la.x, y: la.y } : { x: edge.x2, y: edge.y2 };
  const pts = [start, ...waypoints, end];
  const midA = pts[Math.floor((pts.length - 1) / 2)];
  const midB = pts[Math.floor((pts.length - 1) / 2) + 1] ?? midA;
  const mx = (midA.x + midB.x) / 2;
  const my = (midA.y + midB.y) / 2;
  const startAxis = edge.a ? sideAxis(edge.a, pts[0]) : undefined;
  const endAxis = edge.b ? sideAxis(edge.b, pts[pts.length - 1]) : undefined;
  const d = pathFor(pts, edge.style ?? "straight", startAxis, endAxis);
  const routable = it.mode === "select" && !!edge.key && !!edge.a && !!edge.b;
  return (
    <g
      onClick={(e) => {
        e.stopPropagation();
        it.onClick(edge.el);
      }}
      onContextMenu={(e) => it.onEdgeContextMenu(edge, e)}
      style={{ cursor: routable ? "move" : "pointer" }}
    >
      <path
        d={d}
        fill="none"
        stroke="transparent"
        strokeWidth={10}
        onMouseDown={(e) => {
          if (routable) {
            e.stopPropagation();
            it.onEdgeMouseDown(edge, e);
          }
        }}
      />
      <path
        d={d}
        fill="none"
        stroke={isSelected ? "#f9e2af" : color}
        strokeWidth={isSelected ? 2.5 : 1.5}
        strokeDasharray={edge.dashed ? "6 4" : undefined}
        markerEnd={
          edge.kind === "specialize"
            ? "url(#tri-specialize)"
            : edge.arrow
              ? `url(#arrow-${edge.kind})`
              : undefined
        }
        markerStart={edge.kind === "compose" ? "url(#diamond-compose)" : undefined}
        pointerEvents="none"
      />
      {/* waypoint handles: drag to move, double-click to remove */}
      {waypoints.map((p, i) => (
        <g
          key={i}
          onMouseDown={(e) => {
            if (routable) {
              e.stopPropagation();
              it.onEdgeMouseDown(edge, e, i);
            }
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            it.onWaypointRemove(edge, i);
          }}
          onContextMenu={(e) => it.onEdgeContextMenu(edge, e, i)}
          style={{ cursor: "move" }}
        >
          <circle cx={p.x} cy={p.y} r={9} fill="transparent" />
          <circle cx={p.x} cy={p.y} r={4} fill={color} stroke="#1e1e2e" strokeWidth={1} />
        </g>
      ))}
      {isSelected && routable && (
        <>
          {(["a", "b"] as const).map((which) => {
            const p = which === "a" ? pts[0] : pts[pts.length - 1];
            return (
              <rect
                key={which}
                x={p.x - 5}
                y={p.y - 5}
                width={10}
                height={10}
                fill="#f9e2af"
                stroke="#1e1e2e"
                strokeWidth={1}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  it.onEndpointMouseDown(edge, which, e);
                }}
                style={{ cursor: "move" }}
              />
            );
          })}
        </>
      )}
      {edge.label && (
        <text
          x={mx}
          y={my - 6}
          fontSize={10}
          fill={color}
          textAnchor="middle"
          style={{ paintOrder: "stroke", stroke: "#1e1e2e", strokeWidth: 3 }}
        >
          {edge.label}
        </text>
      )}
    </g>
  );
}

export function DiagramView({
  root,
  kind,
  selected,
  marked,
  mode,
  offsets,
  keyOf,
  onElementClick,
  onElementDoubleClick,
  onMoveBox,
  onResizeBox,
  onMovePort,
  onRouteEdge,
  onEdgeStyle,
  onAnchorEdge,
  onDeleteElement,
  onStartConnect,
  onBackgroundClick,
}: Props) {
  const viewRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [view, setView] = useState({ tx: 20, ty: 20, scale: 1 });
  const panRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const boxDragRef = useRef<{ key: string; x: number; y: number } | null>(null);
  const resizeRef = useRef<{ key: string; x: number; y: number; fromTop: boolean } | null>(null);
  const portDragRef = useRef<{
    key: string;
    box: { x: number; y: number; w: number; h: number };
  } | null>(null);
  const [livePort, setLivePort] = useState<LivePort | null>(null);
  const edgeDragRef = useRef<{
    key: string;
    points: { x: number; y: number }[];
    /** waypoint being dragged; -1 = translate the whole route */
    dragIndex: number;
    /** original points (translate mode) */
    orig: { x: number; y: number }[];
    /** drag start in diagram coordinates (translate mode) */
    start: { x: number; y: number };
    base: { x: number; y: number };
  } | null>(null);
  const [liveEdge, setLiveEdge] = useState<{
    key: string;
    points: { x: number; y: number }[];
  } | null>(null);
  const anchorDragRef = useRef<{
    key: string;
    which: "a" | "b";
    box: { x: number; y: number; w: number; h: number };
  } | null>(null);
  const [liveAnchor, setLiveAnchor] = useState<{
    key: string;
    which: "a" | "b";
    x: number;
    y: number;
  } | null>(null);
  const downPosRef = useRef<{ x: number; y: number } | null>(null);
  /** swallow the click that the browser fires right after a drag/resize */
  const suppressClickRef = useRef(false);
  const [liveDrag, setLiveDrag] = useState<{ key: string; dx: number; dy: number } | null>(null);
  const [liveResize, setLiveResize] = useState<{
    key: string;
    dw: number;
    dh: number;
    fromTop: boolean;
  } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const effectiveOffsets = useMemo(() => {
    if (!liveDrag && !liveResize) return offsets;
    const next = { ...offsets };
    if (liveDrag) {
      const cur = next[liveDrag.key] ?? { dx: 0, dy: 0 };
      next[liveDrag.key] = { ...cur, dx: cur.dx + liveDrag.dx, dy: cur.dy + liveDrag.dy };
    }
    if (liveResize) {
      const cur = next[liveResize.key] ?? { dx: 0, dy: 0 };
      const dw = Math.max(0, (cur.dw ?? 0) + liveResize.dw);
      if (liveResize.fromTop) {
        // dragging up grows the box; the top edge follows the cursor
        const dh = Math.max(0, (cur.dh ?? 0) - liveResize.dh);
        next[liveResize.key] = { ...cur, dy: cur.dy - (dh - (cur.dh ?? 0)), dw, dh };
      } else {
        next[liveResize.key] = { ...cur, dw, dh: Math.max(0, (cur.dh ?? 0) + liveResize.dh) };
      }
    }
    return next;
  }, [offsets, liveDrag, liveResize]);

  const layout = useMemo(
    () => layoutDiagram(root, { offsets: effectiveOffsets, keyOf, kind }),
    [root, effectiveOffsets, keyOf, kind]
  );

  const onWheel = (e: React.WheelEvent) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setView((v) => {
      const scale = Math.min(4, Math.max(0.15, v.scale * factor));
      const k = scale / v.scale;
      return { scale, tx: mx - (mx - v.tx) * k, ty: my - (my - v.ty) * k };
    });
  };

  const onBoxMouseDown = (node: DiagramNode, e: React.MouseEvent) => {
    boxDragRef.current = { key: keyOf(node.el), x: e.clientX, y: e.clientY };
  };

  const onResizeMouseDown = (node: DiagramNode, e: React.MouseEvent, fromTop: boolean) => {
    resizeRef.current = { key: keyOf(node.el), x: e.clientX, y: e.clientY, fromTop };
  };

  const distToSegment = (
    p: { x: number; y: number },
    a: { x: number; y: number },
    b: { x: number; y: number }
  ): number => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  };

  /** client coordinates -> diagram coordinates */
  const toDiagram = (clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (clientX - rect.left - view.tx) / view.scale,
      y: (clientY - rect.top - view.ty) / view.scale,
    };
  };

  /** nearest point on the box border, as side + position */
  const clampToBorder = (
    box: { x: number; y: number; w: number; h: number },
    mx: number,
    my: number
  ): { x: number; y: number; side: PortSide; t: number } => {
    const dLeft = Math.abs(mx - box.x);
    const dRight = Math.abs(mx - (box.x + box.w));
    const dTop = Math.abs(my - box.y);
    const dBottom = Math.abs(my - (box.y + box.h));
    const min = Math.min(dLeft, dRight, dTop, dBottom);
    if (min === dLeft || min === dRight) {
      const side: PortSide = min === dLeft ? "left" : "right";
      const t = Math.min(0.95, Math.max(0.05, (my - box.y) / box.h));
      return { x: side === "left" ? box.x : box.x + box.w, y: box.y + t * box.h, side, t };
    }
    const side: PortSide = min === dTop ? "top" : "bottom";
    const t = Math.min(0.95, Math.max(0.05, (mx - box.x) / box.w));
    return { x: box.x + t * box.w, y: side === "top" ? box.y : box.y + box.h, side, t };
  };

  const onPortMouseDown = (node: DiagramNode, port: DiagramPort) => {
    portDragRef.current = {
      key: portOffsetKey(keyOf, node.el, port.el),
      box: { x: node.x, y: node.y, w: node.w, h: node.h },
    };
  };

  /** start dragging an edge endpoint along the border of its box */
  const onEndpointMouseDown = (edge: DiagramEdge, which: "a" | "b", _e: React.MouseEvent) => {
    if (!edge.key) return;
    const box = which === "a" ? edge.a : edge.b;
    if (!box) return;
    anchorDragRef.current = {
      key: edge.key,
      which,
      box: { x: box.x, y: box.y, w: box.w, h: box.h },
    };
  };

  /** start routing an edge: grab an existing waypoint, or drag the whole
   *  route. Waypoints are only ADDED via the context menu, never by drag. */
  const onEdgeMouseDown = (edge: DiagramEdge, e: React.MouseEvent, waypointIndex?: number) => {
    if (!edge.key) return;
    const base = edgeRoutingBase(edge);
    if (!base) return;
    const points = (edge.points ?? []).map((p) => ({ ...p }));
    const m = toDiagram(e.clientX, e.clientY);
    let dragIndex: number;
    if (waypointIndex !== undefined) {
      dragIndex = waypointIndex;
    } else {
      const grabRadius = 10 / view.scale;
      // near an endpoint: move the endpoint along its box border instead
      const endpointR = 14 / view.scale;
      const dA = Math.hypot(edge.x1 - m.x, edge.y1 - m.y);
      const dB = Math.hypot(edge.x2 - m.x, edge.y2 - m.y);
      if (Math.min(dA, dB) <= endpointR) {
        onEndpointMouseDown(edge, dA <= dB ? "a" : "b", e);
        return;
      }
      // near an existing waypoint: grab it; otherwise translate the route
      let nearest = -1;
      let nearestD = grabRadius;
      points.forEach((p, i) => {
        const d = Math.hypot(p.x - m.x, p.y - m.y);
        if (d <= nearestD) {
          nearestD = d;
          nearest = i;
        }
      });
      if (nearest >= 0) {
        dragIndex = nearest;
      } else if (points.length) {
        dragIndex = -1; // move all waypoints together
      } else {
        // straight line: dragging creates the FIRST bend (further waypoints
        // are added via the context menu only, so they cannot pile up)
        points.push(m);
        dragIndex = 0;
      }
    }
    edgeDragRef.current = {
      key: edge.key,
      points,
      dragIndex,
      orig: points.map((p) => ({ ...p })),
      start: m,
      base,
    };
    setLiveEdge({ key: edge.key, points });
  };

  const onMouseDown = (e: React.MouseEvent) => {
    downPosRef.current = { x: e.clientX, y: e.clientY };
    panRef.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
  };

  const onSvgClick = (e: React.MouseEvent) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const d = downPosRef.current;
    const moved = d ? Math.hypot(e.clientX - d.x, e.clientY - d.y) : 0;
    if (moved < 4) onBackgroundClick?.();
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const ad = anchorDragRef.current;
    if (ad) {
      const m = toDiagram(e.clientX, e.clientY);
      const c = clampToBorder(ad.box, m.x, m.y);
      setLiveAnchor({ key: ad.key, which: ad.which, x: c.x, y: c.y });
      return;
    }
    const ed = edgeDragRef.current;
    if (ed) {
      const m = toDiagram(e.clientX, e.clientY);
      const points =
        ed.dragIndex >= 0
          ? ed.points.map((p, i) => (i === ed.dragIndex ? m : p))
          : ed.orig.map((p) => ({ x: p.x + (m.x - ed.start.x), y: p.y + (m.y - ed.start.y) }));
      ed.points = points;
      setLiveEdge({ key: ed.key, points });
      return;
    }
    const pd = portDragRef.current;
    if (pd) {
      const m = toDiagram(e.clientX, e.clientY);
      const c = clampToBorder(pd.box, m.x, m.y);
      setLivePort({ key: pd.key, x: c.x, y: c.y, side: c.side });
      return;
    }
    const rs = resizeRef.current;
    if (rs) {
      setLiveResize({
        key: rs.key,
        dw: (e.clientX - rs.x) / view.scale,
        dh: (e.clientY - rs.y) / view.scale,
        fromTop: rs.fromTop,
      });
      return;
    }
    const bd = boxDragRef.current;
    if (bd) {
      setLiveDrag({
        key: bd.key,
        dx: (e.clientX - bd.x) / view.scale,
        dy: (e.clientY - bd.y) / view.scale,
      });
      return;
    }
    const d = panRef.current;
    if (!d) return;
    setView((v) => ({ ...v, tx: d.tx + e.clientX - d.x, ty: d.ty + e.clientY - d.y }));
  };

  const endDrag = () => {
    if (boxDragRef.current && liveDrag) {
      if (Math.abs(liveDrag.dx) > 1 || Math.abs(liveDrag.dy) > 1) {
        onMoveBox(liveDrag.key, liveDrag.dx, liveDrag.dy);
        suppressClickRef.current = true; // the mouseup also fires a click
      }
    }
    if (resizeRef.current && liveResize) {
      if (Math.abs(liveResize.dw) > 1 || Math.abs(liveResize.dh) > 1) {
        onResizeBox(liveResize.key, liveResize.dw, liveResize.dh, liveResize.fromTop);
        suppressClickRef.current = true;
      }
    }
    const pd = portDragRef.current;
    if (pd && livePort) {
      const c = clampToBorder(pd.box, livePort.x, livePort.y);
      onMovePort(pd.key, c.side, c.t);
      suppressClickRef.current = true;
    }
    const ad = anchorDragRef.current;
    if (ad && liveAnchor) {
      const c = clampToBorder(ad.box, liveAnchor.x, liveAnchor.y);
      onAnchorEdge(ad.key, ad.which, c.side, c.t);
      suppressClickRef.current = true;
    }
    const ed = edgeDragRef.current;
    if (ed && liveEdge) {
      // waypoints are persisted relative to the endpoint boxes so they
      // follow when the boxes are moved later
      onRouteEdge(
        ed.key,
        liveEdge.points.map((p) => ({ x: p.x - ed.base.x, y: p.y - ed.base.y }))
      );
      suppressClickRef.current = true;
    }
    boxDragRef.current = null;
    setLiveDrag(null);
    resizeRef.current = null;
    setLiveResize(null);
    portDragRef.current = null;
    setLivePort(null);
    edgeDragRef.current = null;
    setLiveEdge(null);
    anchorDragRef.current = null;
    setLiveAnchor(null);
    panRef.current = null;
  };

  const fit = () => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || !layout.width || !layout.height) return;
    const scale = Math.min((rect.width - 40) / layout.width, (rect.height - 40) / layout.height, 1.5);
    setView({
      scale,
      tx: (rect.width - layout.width * scale) / 2,
      ty: (rect.height - layout.height * scale) / 2,
    });
  };

  const exportSvg = () => {
    const svg = svgRef.current;
    if (!svg) return;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
    clone.setAttribute("width", String(layout.width));
    clone.setAttribute("height", String(layout.height));
    const g = clone.querySelector("g[data-viewport]");
    g?.setAttribute("transform", "");
    const blob = new Blob(
      ['<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone)],
      { type: "image/svg+xml" }
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "diagram.svg";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // ---- context menus -------------------------------------------------------

  const openMenu = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = viewRef.current?.getBoundingClientRect();
    setMenu({ x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0), items });
  };

  /** commit edge waypoints, converting to box-relative coordinates */
  const commitRoute = (edge: DiagramEdge, absPoints: { x: number; y: number }[]) => {
    if (!edge.key) return;
    const base = edgeRoutingBase(edge);
    if (!base) return;
    onRouteEdge(edge.key, absPoints.map((p) => ({ x: p.x - base.x, y: p.y - base.y })));
  };

  const onEdgeContextMenu = (edge: DiagramEdge, e: React.MouseEvent, waypointIndex?: number) => {
    if (!edge.key) return;
    const m = toDiagram(e.clientX, e.clientY);
    const points = (edge.points ?? []).map((p) => ({ ...p }));
    // a waypoint near the click can be removed directly
    let nearIndex = waypointIndex ?? -1;
    if (nearIndex < 0) {
      const grabRadius = 12 / view.scale;
      points.forEach((p, i) => {
        if (Math.hypot(p.x - m.x, p.y - m.y) <= grabRadius) nearIndex = i;
      });
    }
    const routable = !!edge.a && !!edge.b;
    const style = edge.style ?? "straight";
    const items: MenuItem[] = [
      {
        label: "中継点を追加",
        disabled: !routable,
        action: () => {
          const pts = [{ x: edge.x1, y: edge.y1 }, ...points, { x: edge.x2, y: edge.y2 }];
          let best = 0;
          let bestD = Infinity;
          for (let i = 0; i < pts.length - 1; i++) {
            const d = distToSegment(m, pts[i], pts[i + 1]);
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
          const next = [...points];
          next.splice(best, 0, m);
          commitRoute(edge, next);
        },
      },
      {
        label: "中継点を削除",
        disabled: nearIndex < 0,
        action: () => commitRoute(edge, points.filter((_, i) => i !== nearIndex)),
      },
      {
        label: "経由点をすべてクリア",
        disabled: points.length === 0,
        action: () => onRouteEdge(edge.key!, []),
      },
      {
        label: "端点の固定を解除",
        disabled: !edge.pinnedA && !edge.pinnedB,
        action: () => onAnchorEdge(edge.key!, null),
      },
      { label: "", separator: true },
      ...EDGE_STYLES.map((st) => ({
        label: `線種: ${st.label}`,
        checked: style === st.value,
        action: () => onEdgeStyle(edge.key!, st.value),
      })),
    ];
    if (DELETABLE_EDGE_KINDS.has(edge.kind) && edge.el.fileId !== undefined) {
      items.push(
        { label: "", separator: true },
        { label: "接続を削除 (モデルから)", action: () => onDeleteElement(edge.el) }
      );
    }
    openMenu(e, items);
  };

  const onNodeContextMenu = (el: SysMLElement, e: React.MouseEvent, named: boolean) => {
    const items: MenuItem[] = [
      { label: "ここから接続 (connect)", action: () => onStartConnect(el) },
    ];
    if (named && el.fileId !== undefined) {
      items.push({ label: "リネーム", action: () => onElementDoubleClick(el) });
    }
    if (el.fileId !== undefined && el.kind !== "file") {
      items.push(
        { label: "", separator: true },
        { label: "削除 (モデルから)", action: () => onDeleteElement(el) }
      );
    }
    openMenu(e, items);
  };

  const interaction: Interaction = {
    mode,
    selected,
    marked,
    onClick: (el) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      onElementClick(el);
    },
    onDoubleClick: onElementDoubleClick,
    onBoxMouseDown,
    onResizeMouseDown,
    onPortMouseDown,
    portKey: (owner, port) => portOffsetKey(keyOf, owner, port),
    livePort,
    onEdgeMouseDown,
    onEndpointMouseDown,
    liveAnchor,
    onEdgeContextMenu,
    onNodeContextMenu,
    onWaypointRemove: (edge, index) => {
      if (!edge.key) return;
      const base = edgeRoutingBase(edge);
      if (!base) return;
      const points = (edge.points ?? [])
        .filter((_, i) => i !== index)
        .map((p) => ({ x: p.x - base.x, y: p.y - base.y }));
      onRouteEdge(edge.key, points);
    },
    liveEdge,
  };

  // edges of the currently selected element (line-style controls)
  const selectedEdges = layout.edges.filter((e) => e.el === selected && e.key);
  const EDGE_STYLES: { value: EdgeStyle; label: string }[] = [
    { value: "straight", label: "直線" },
    { value: "ortho", label: "折れ線" },
    { value: "curve", label: "曲線" },
  ];

  return (
    <div className="diagram-view" ref={viewRef}>
      <div className="diagram-toolbar">
        <button onClick={fit} title="全体表示">⤢ Fit</button>
        <button onClick={() => setView({ tx: 20, ty: 20, scale: 1 })} title="リセット">100%</button>
        <button onClick={exportSvg} title="SVG として保存">⭳ SVG</button>
        <span className="diagram-zoom">{Math.round(view.scale * 100)}%</span>
        {mode === "select" && selectedEdges.length > 0 && (
          <>
            <span className="diagram-zoom">線種:</span>
            {EDGE_STYLES.map((s) => (
              <button
                key={s.value}
                className={(selectedEdges[0].style ?? "straight") === s.value ? "active" : undefined}
                onClick={() => selectedEdges.forEach((e) => onEdgeStyle(e.key!, s.value))}
                title={`選択中の線を${s.label}で描画`}
              >
                {s.label}
              </button>
            ))}
            {selectedEdges.some((e) => e.points?.length) && (
              <button
                onClick={() => selectedEdges.forEach((e) => onRouteEdge(e.key!, []))}
                title="選択中の線の中継点をすべて削除"
              >
                ⟲ 経由点クリア
              </button>
            )}
          </>
        )}
      </div>
      <svg
        ref={svgRef}
        className="diagram-svg"
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
        onDoubleClick={fit}
        onClick={onSvgClick}
        onContextMenu={(e) => e.preventDefault()}
      >
        <defs>
          {Object.entries(EDGE_COLOR)
            .filter(([k]) => !CUSTOM_MARKER_KINDS.has(k))
            .map(([kind, color]) => (
              <marker
                key={kind}
                id={`arrow-${kind}`}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
              </marker>
            ))}
          {/* generalization: hollow triangle */}
          <marker
            id="tri-specialize"
            viewBox="0 0 12 12"
            refX="11"
            refY="6"
            markerWidth="11"
            markerHeight="11"
            orient="auto-start-reverse"
          >
            <path
              d="M 1 1 L 11 6 L 1 11 z"
              fill="#14141f"
              stroke={EDGE_COLOR.specialize}
              strokeWidth="1.2"
            />
          </marker>
          {/* composition: filled diamond at the owner end */}
          <marker
            id="diamond-compose"
            viewBox="0 0 14 8"
            refX="1"
            refY="4"
            markerWidth="14"
            markerHeight="8"
            orient="auto"
          >
            <path d="M 1 4 L 7 1 L 13 4 L 7 7 z" fill={EDGE_COLOR.compose} />
          </marker>
        </defs>
        <g data-viewport="true" transform={`translate(${view.tx},${view.ty}) scale(${view.scale})`}>
          {layout.nodes.map((n, i) => (
            <NodeBox key={i} node={n} it={interaction} />
          ))}
          {layout.edges.map((e, i) => (
            <EdgeLine key={i} edge={e} it={interaction} />
          ))}
        </g>
      </svg>
      {menu && (
        <div
          className="ctx-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {menu.items.map((item, i) =>
            item.separator ? (
              <div key={i} className="ctx-menu-sep" />
            ) : (
              <button
                key={i}
                className="ctx-menu-item"
                disabled={item.disabled}
                onClick={() => {
                  setMenu(null);
                  item.action?.();
                }}
              >
                <span className="ctx-menu-check">{item.checked ? "✓" : ""}</span>
                {item.label}
              </button>
            )
          )}
        </div>
      )}
      {layout.nodes.length === 0 && (
        <div className="diagram-empty">
          この図の種類に表示できる要素がありません。<br />
          図の種類を切り替えるか、対応する要素 (part / requirement / state など) を
          .sysml ファイルに記述してください。
        </div>
      )}
    </div>
  );
}
