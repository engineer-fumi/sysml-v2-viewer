import { useMemo, useRef, useState } from "react";
import {
  DiagramEdge,
  DiagramNode,
  EdgeLayout,
  EdgeStyle,
  LayoutOffsets,
  Point,
  layoutDiagram,
} from "../core/layout";
import { SysMLElement } from "../core/ast";

export type EditMode = "select" | "connect" | `add:${string}`;

interface Interaction {
  mode: EditMode;
  selected?: SysMLElement;
  marked?: SysMLElement;
  onClick: (el: SysMLElement) => void;
  onDoubleClick: (el: SysMLElement) => void;
  onBoxMouseDown: (node: DiagramNode, e: React.MouseEvent) => void;
}

interface Props {
  root: SysMLElement;
  selected?: SysMLElement;
  /** secondary highlight (connect source) */
  marked?: SysMLElement;
  mode: EditMode;
  offsets: LayoutOffsets;
  edges: Record<string, EdgeLayout>;
  keyOf: (el: SysMLElement) => string;
  edgeKeyOf: (el: SysMLElement) => string;
  onElementClick: (el: SysMLElement) => void;
  onElementDoubleClick: (el: SysMLElement) => void;
  /** commit a box move (delta in diagram coordinates) */
  onMoveBox: (key: string, ddx: number, ddy: number) => void;
  /** commit edge waypoints (relative to the edge base) */
  onEdgeEdit: (key: string, points: Point[]) => void;
  /** click on empty canvas (used by the add modes) */
  onBackgroundClick?: () => void;
}

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
};

function fillFor(node: DiagramNode): string {
  return KIND_FILL[node.el.kind] ?? "#252536";
}

function strokeFor(node: DiagramNode, it: Interaction): { stroke: string; width: number } {
  if (it.selected === node.el) return { stroke: "#f9e2af", width: 2.5 };
  if (it.marked === node.el) return { stroke: "#a6e3a1", width: 2.5 };
  return { stroke: "#585b70", width: 1.2 };
}

function NodeBox({ node, it }: { node: DiagramNode; it: Interaction }) {
  const { stroke, width } = strokeFor(node, it);
  const headerY = node.y + 14;
  // any named box can be moved in select mode (children re-anchor the parent)
  const draggable = it.mode === "select" && !!node.el.name;
  return (
    <g>
      <rect
        x={node.x}
        y={node.y}
        width={node.w}
        height={node.h}
        rx={node.rounded ? 14 : 4}
        fill={fillFor(node)}
        stroke={stroke}
        strokeWidth={width}
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
        style={{ cursor: draggable ? "move" : "pointer" }}
      />
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
      {node.ports.map((p, i) => (
        <g
          key={i}
          onClick={(e) => {
            e.stopPropagation();
            it.onClick(p.el);
          }}
          style={{ cursor: "pointer" }}
        >
          <rect
            x={p.x - 5}
            y={p.y - 5}
            width={10}
            height={10}
            fill={it.selected === p.el ? "#f9e2af" : it.marked === p.el ? "#a6e3a1" : "#fab387"}
            stroke="#1e1e2e"
            strokeWidth={1}
          />
          <text
            x={p.side === "left" ? p.x + 9 : p.x - 9}
            y={p.y + 4}
            fontSize={10}
            fill="#fab387"
            textAnchor={p.side === "left" ? "start" : "end"}
            pointerEvents="none"
          >
            {p.name}
          </text>
        </g>
      ))}
      {node.children.map((c, i) => (
        <NodeBox key={i} node={c} it={it} />
      ))}
    </g>
  );
}

// ---- edge rendering -------------------------------------------------------

/** full point list: anchor, waypoints..., anchor */
function fullPoints(edge: DiagramEdge, livePoints?: Point[]): Point[] {
  const wps = livePoints ?? edge.points;
  return [{ x: edge.x1, y: edge.y1 }, ...wps, { x: edge.x2, y: edge.y2 }];
}

function pathFor(pts: Point[], style: EdgeStyle): string {
  if (pts.length < 2) return "";
  if (style === "ortho") {
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1];
      const cur = pts[i];
      d += ` L ${cur.x} ${prev.y} L ${cur.x} ${cur.y}`;
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

function labelPos(pts: Point[]): Point {
  if (pts.length === 2) {
    return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
  }
  return pts[Math.floor(pts.length / 2)];
}

interface EdgeHandlers {
  onWaypointDown: (edge: DiagramEdge, index: number, isNew: boolean, at: Point, e: React.MouseEvent) => void;
  onWaypointRemove: (edge: DiagramEdge, index: number) => void;
}

function EdgeLine({
  edge,
  it,
  livePoints,
  handlers,
}: {
  edge: DiagramEdge;
  it: Interaction;
  livePoints?: Point[];
  handlers: EdgeHandlers;
}) {
  const color = EDGE_COLOR[edge.kind] ?? "#74c7ec";
  const isSelected = it.selected === edge.el;
  const pts = fullPoints(edge, livePoints);
  const d = pathFor(pts, edge.style);
  const lp = labelPos(pts);
  const showHandles = isSelected && it.mode === "select" && !!edge.key;
  const wps = livePoints ?? edge.points;

  return (
    <g
      onClick={(e) => {
        e.stopPropagation();
        it.onClick(edge.el);
      }}
      style={{ cursor: "pointer" }}
    >
      {/* fat invisible hit area */}
      <path d={d} stroke="transparent" strokeWidth={12} fill="none" />
      <path
        d={d}
        stroke={isSelected ? "#f9e2af" : color}
        strokeWidth={isSelected ? 2.5 : 1.5}
        strokeDasharray={edge.dashed ? "6 4" : undefined}
        fill="none"
        markerEnd={edge.arrow ? `url(#arrow-${edge.kind})` : undefined}
      />
      {edge.label && (
        <text
          x={lp.x}
          y={lp.y - 6}
          fontSize={10}
          fill={color}
          textAnchor="middle"
          style={{ paintOrder: "stroke", stroke: "#1e1e2e", strokeWidth: 3 }}
        >
          {edge.label}
        </text>
      )}
      {showHandles && (
        <>
          {/* virtual handles on each segment midpoint: drag to add a waypoint */}
          {pts.slice(0, -1).map((p, i) => {
            const m = { x: (p.x + pts[i + 1].x) / 2, y: (p.y + pts[i + 1].y) / 2 };
            return (
              <circle
                key={"v" + i}
                cx={m.x}
                cy={m.y}
                r={4}
                fill="#1e1e2e"
                stroke="#f9e2af"
                strokeWidth={1.2}
                style={{ cursor: "copy" }}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  handlers.onWaypointDown(edge, i, true, m, e);
                }}
              />
            );
          })}
          {/* real waypoints: drag to move, double-click to remove */}
          {wps.map((p, i) => (
            <circle
              key={"w" + i}
              cx={p.x}
              cy={p.y}
              r={5.5}
              fill="#f9e2af"
              stroke="#1e1e2e"
              strokeWidth={1.5}
              style={{ cursor: "move" }}
              onMouseDown={(e) => {
                e.stopPropagation();
                handlers.onWaypointDown(edge, i, false, p, e);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                handlers.onWaypointRemove(edge, i);
              }}
            />
          ))}
        </>
      )}
    </g>
  );
}

// ---- main view -------------------------------------------------------------

export function DiagramView({
  root,
  selected,
  marked,
  mode,
  offsets,
  edges,
  keyOf,
  edgeKeyOf,
  onElementClick,
  onElementDoubleClick,
  onMoveBox,
  onEdgeEdit,
  onBackgroundClick,
}: Props) {
  const [view, setView] = useState({ tx: 20, ty: 20, scale: 1 });
  const panRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const boxDragRef = useRef<{ key: string; x: number; y: number } | null>(null);
  const edgeDragRef = useRef<{ key: string; index: number; baseX: number; baseY: number } | null>(null);
  const downPosRef = useRef<{ x: number; y: number } | null>(null);
  const [liveDrag, setLiveDrag] = useState<{ key: string; dx: number; dy: number } | null>(null);
  const [liveEdge, setLiveEdge] = useState<{ key: string; points: Point[] } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const effectiveOffsets = useMemo(() => {
    if (!liveDrag) return offsets;
    const cur = offsets[liveDrag.key] ?? { dx: 0, dy: 0 };
    return {
      ...offsets,
      [liveDrag.key]: { dx: cur.dx + liveDrag.dx, dy: cur.dy + liveDrag.dy },
    };
  }, [offsets, liveDrag]);

  const layout = useMemo(
    () => layoutDiagram(root, { offsets: effectiveOffsets, keyOf, edges, edgeKeyOf }),
    [root, effectiveOffsets, keyOf, edges, edgeKeyOf]
  );

  const toDiagram = (e: { clientX: number; clientY: number }): Point => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (e.clientX - rect.left - view.tx) / view.scale,
      y: (e.clientY - rect.top - view.ty) / view.scale,
    };
  };

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

  const onWaypointDown = (
    edge: DiagramEdge,
    index: number,
    isNew: boolean,
    at: Point,
    _e: React.MouseEvent
  ) => {
    if (!edge.key) return;
    const points = [...(liveEdge?.key === edge.key ? liveEdge.points : edge.points)];
    if (isNew) points.splice(index, 0, at);
    edgeDragRef.current = { key: edge.key, index, baseX: edge.baseX, baseY: edge.baseY };
    setLiveEdge({ key: edge.key, points });
  };

  const onWaypointRemove = (edge: DiagramEdge, index: number) => {
    if (!edge.key) return;
    const points = edge.points.filter((_, i) => i !== index);
    onEdgeEdit(
      edge.key,
      points.map((p) => ({ x: p.x - edge.baseX, y: p.y - edge.baseY }))
    );
    setLiveEdge(null);
  };

  const onMouseDown = (e: React.MouseEvent) => {
    downPosRef.current = { x: e.clientX, y: e.clientY };
    panRef.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
  };

  const onSvgClick = (e: React.MouseEvent) => {
    const d = downPosRef.current;
    const moved = d ? Math.hypot(e.clientX - d.x, e.clientY - d.y) : 0;
    if (moved < 4) onBackgroundClick?.();
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const ed = edgeDragRef.current;
    if (ed) {
      const p = toDiagram(e);
      setLiveEdge((cur) => {
        if (!cur || cur.key !== ed.key) return cur;
        const points = [...cur.points];
        points[ed.index] = p;
        return { key: cur.key, points };
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
    const ed = edgeDragRef.current;
    if (ed && liveEdge && liveEdge.key === ed.key) {
      onEdgeEdit(
        ed.key,
        liveEdge.points.map((p) => ({ x: p.x - ed.baseX, y: p.y - ed.baseY }))
      );
    }
    if (boxDragRef.current && liveDrag) {
      if (Math.abs(liveDrag.dx) > 1 || Math.abs(liveDrag.dy) > 1) {
        onMoveBox(liveDrag.key, liveDrag.dx, liveDrag.dy);
      }
    }
    edgeDragRef.current = null;
    boxDragRef.current = null;
    setLiveEdge(null);
    setLiveDrag(null);
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

  const interaction: Interaction = {
    mode,
    selected,
    marked,
    onClick: onElementClick,
    onDoubleClick: onElementDoubleClick,
    onBoxMouseDown,
  };

  const edgeHandlers: EdgeHandlers = { onWaypointDown, onWaypointRemove };

  return (
    <div className="diagram-view">
      <div className="diagram-toolbar">
        <button onClick={fit} title="全体表示">⤢ Fit</button>
        <button onClick={() => setView({ tx: 20, ty: 20, scale: 1 })} title="リセット">100%</button>
        <button onClick={exportSvg} title="SVG として保存">⭳ SVG</button>
        <span className="diagram-zoom">{Math.round(view.scale * 100)}%</span>
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
      >
        <defs>
          {Object.entries(EDGE_COLOR).map(([kind, color]) => (
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
        </defs>
        <g data-viewport="true" transform={`translate(${view.tx},${view.ty}) scale(${view.scale})`}>
          {layout.nodes.map((n, i) => (
            <NodeBox key={i} node={n} it={interaction} />
          ))}
          {layout.edges.map((e, i) => (
            <EdgeLine
              key={i}
              edge={e}
              it={interaction}
              livePoints={liveEdge && liveEdge.key === e.key ? liveEdge.points : undefined}
              handlers={edgeHandlers}
            />
          ))}
        </g>
      </svg>
      {layout.nodes.length === 0 && (
        <div className="diagram-empty">
          表示できる要素がありません。<br />
          ワークスペースの .sysml ファイルに package / part などを記述すると図が表示されます。
        </div>
      )}
    </div>
  );
}
