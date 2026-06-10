import { useMemo, useRef, useState } from "react";
import { DiagramEdge, DiagramNode, LayoutOffsets, layoutDiagram } from "../core/layout";
import { SysMLElement } from "../core/ast";

export type EditMode =
  | "select"
  | "connect"
  | "add:part"
  | "add:port"
  | "add:attribute"
  | "add:item"
  | "add:action"
  | "add:state"
  | "add:requirement";

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
  /** secondary highlight (connect souce) */
  marked?: SysMLElement;
  mode: EditMode;
  offsets: LayoutOffsets;
  keyOf: (el: SysMLElement) => string;
  onElementClick: (el: SysMLElement) => void;
  onElementDoubleClick: (el: SysMLElement) => void;
  /** commit a top-level box move (delta in diagram coordinates) */
  onMoveBox: (key: string, ddx: number, ddy: number) => void;
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
  const draggable = node.depth === 0 && it.mode === "select";
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

function EdgeLine({ edge, it }: { edge: DiagramEdge; it: Interaction }) {
  const color = EDGE_COLOR[edge.kind] ?? "#74c7ec";
  const isSelected = it.selected === edge.el;
  const mx = (edge.x1 + edge.x2) / 2;
  const my = (edge.y1 + edge.y2) / 2;
  return (
    <g
      onClick={(e) => {
        e.stopPropagation();
        it.onClick(edge.el);
      }}
      style={{ cursor: "pointer" }}
    >
      <line x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2} stroke="transparent" strokeWidth={10} />
      <line
        x1={edge.x1}
        y1={edge.y1}
        x2={edge.x2}
        y2={edge.y2}
        stroke={isSelected ? "#f9e2af" : color}
        strokeWidth={isSelected ? 2.5 : 1.5}
        strokeDasharray={edge.dashed ? "6 4" : undefined}
        markerEnd={edge.arrow ? `url(#arrow-${edge.kind})` : undefined}
      />
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
  selected,
  marked,
  mode,
  offsets,
  keyOf,
  onElementClick,
  onElementDoubleClick,
  onMoveBox,
}: Props) {
  const [view, setView] = useState({ tx: 20, ty: 20, scale: 1 });
  const panRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const boxDragRef = useRef<{ key: string; x: number; y: number } | null>(null);
  const [liveDrag, setLiveDrag] = useState<{ key: string; dx: number; dy: number } | null>(null);
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
    () => layoutDiagram(root, { offsets: effectiveOffsets, keyOf }),
    [root, effectiveOffsets, keyOf]
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

  const onMouseDown = (e: React.MouseEvent) => {
    panRef.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
  };

  const onMouseMove = (e: React.MouseEvent) => {
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
      }
    }
    boxDragRef.current = null;
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
            <EdgeLine key={i} edge={e} it={interaction} />
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
