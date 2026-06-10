import { SysMLElement } from "./ast";

/** Kinds rendered as nested boxes in the diagram. */
const BOX_KINDS = new Set([
  "namespace", "package", "library package",
  "part def", "part",
  "item def", "item",
  "action def", "action",
  "state def", "state",
  "interface def", "connection def",
  "requirement def", "requirement",
  "use case def", "use case",
  "occurrence def", "occurrence",
  "analysis def", "analysis",
  "verification def", "verification",
  "view def", "view",
  "enum def",
  "port def",
  "constraint def",
  "concern def", "concern",
  "calc def",
  "allocation def",
  "metadata def",
  "flow def",
  "case def", "case",
  "exhibit", "perform",
]);

/** Kinds listed as text lines inside their parent box. */
const TEXT_KINDS = new Set([
  "attribute", "attribute def", "ref", "enum", "constraint", "calc",
  "satisfy", "event", "import", "alias", "comment",
]);

const PORT_KINDS = new Set(["port"]);

export interface DiagramPort {
  el: SysMLElement;
  name: string;
  /** absolute centre position */
  x: number;
  y: number;
  side: "left" | "right";
}

export interface DiagramNode {
  el: SysMLElement;
  label: string;
  kindLabel: string;
  typeLabel?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rounded: boolean;
  attributes: string[];
  ports: DiagramPort[];
  children: DiagramNode[];
  depth: number;
}

export interface DiagramEdge {
  el: SysMLElement;
  kind: "connect" | "flow" | "bind" | "transition" | "interface" | "connection" | "allocation";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label?: string;
  arrow: boolean;
  dashed: boolean;
}

export interface DiagramLayout {
  nodes: DiagramNode[]; // roots (children nested inside)
  edges: DiagramEdge[];
  width: number;
  height: number;
}

// ---- measurement constants ------------------------------------------

const CHAR_W = 7.2;
const HEADER_H = 26;
const KIND_H = 14;
const LINE_H = 16;
const PAD = 14;
const GAP = 22;
const PORT_SIZE = 10;
const MIN_W = 110;

function textWidth(s: string): number {
  return s.length * CHAR_W;
}

function isEdgeElement(el: SysMLElement): boolean {
  return (
    el.kind === "connect" ||
    el.kind === "bind" ||
    el.kind === "flow" ||
    el.kind === "transition" ||
    ((el.kind === "connection" || el.kind === "interface" || el.kind === "allocation") &&
      (el.ends?.length ?? 0) >= 2)
  );
}

function kindLabel(el: SysMLElement): string {
  if (el.kind === "exhibit") return "state";
  if (el.kind === "perform") return "action";
  return el.kind;
}

function nodeLabel(el: SysMLElement): string {
  return el.name ?? el.shortName ?? el.target ?? "";
}

function typeLabel(el: SysMLElement): string | undefined {
  const t = [...el.typedBy, ...el.specializes];
  if (!t.length) return undefined;
  return ": " + t.join(", ");
}

function attributeLine(el: SysMLElement): string {
  let s = el.name ?? el.target ?? "";
  if (el.kind === "import" || el.kind === "alias") s = `${el.kind} ${el.target ?? ""}`;
  if (el.typedBy.length) s += " : " + el.typedBy.join(", ");
  if (el.multiplicity) s += " " + el.multiplicity;
  if (el.value !== undefined && el.value.length <= 24) s += " = " + el.value;
  return s;
}

// ---- layout ----------------------------------------------------------

interface Size {
  w: number;
  h: number;
}

/** Pre-computed relative layout for a node before absolute placement. */
interface RelNode {
  el: SysMLElement;
  size: Size;
  attributes: string[];
  ports: SysMLElement[];
  children: RelNode[];
  childPos: { x: number; y: number }[];
  headerH: number;
}

function shouldRenderAsBox(el: SysMLElement): boolean {
  if (isEdgeElement(el)) return false;
  if (BOX_KINDS.has(el.kind)) return true;
  return false;
}

function measure(el: SysMLElement, depth: number): RelNode {
  const attributes: string[] = [];
  const ports: SysMLElement[] = [];
  const children: RelNode[] = [];

  for (const c of el.children) {
    if (isEdgeElement(c)) continue;
    if (PORT_KINDS.has(c.kind)) {
      ports.push(c);
    } else if (shouldRenderAsBox(c) && depth < 6) {
      children.push(measure(c, depth + 1));
    } else if (TEXT_KINDS.has(c.kind) || c.kind === "unknown") {
      const line = attributeLine(c);
      if (line.trim()) attributes.push(line);
    }
  }

  const label = nodeLabel(el);
  const tLabel = typeLabel(el) ?? "";
  const headerW = Math.max(textWidth(label + " " + tLabel) + PAD * 2, textWidth(`«${kindLabel(el)}»`) + PAD * 2);
  const headerH = HEADER_H + KIND_H;
  const attrW = attributes.reduce((m, a) => Math.max(m, textWidth(a) + PAD * 2), 0);
  const attrH = attributes.length ? attributes.length * LINE_H + 6 : 0;

  // arrange children in rows, wrapping to keep a pleasant aspect ratio
  const childPos: { x: number; y: number }[] = [];
  let innerW = 0;
  let innerH = 0;
  if (children.length) {
    const totalArea = children.reduce((s, c) => s + (c.size.w + GAP) * (c.size.h + GAP), 0);
    const targetW = Math.max(Math.sqrt(totalArea * 1.9), ...children.map((c) => c.size.w));
    let x = 0;
    let y = 0;
    let rowH = 0;
    for (const c of children) {
      if (x > 0 && x + c.size.w > targetW) {
        x = 0;
        y += rowH + GAP;
        rowH = 0;
      }
      childPos.push({ x, y });
      x += c.size.w + GAP;
      rowH = Math.max(rowH, c.size.h);
      innerW = Math.max(innerW, x - GAP);
    }
    innerH = y + rowH;
  }

  // room for port labels sticking out
  const portLabelW = ports.reduce((m, p) => Math.max(m, textWidth(p.name ?? "")), 0);

  const w = Math.max(MIN_W, headerW, attrW, innerW + PAD * 2, portLabelW + MIN_W);
  const portH = ports.length ? Math.ceil(ports.length / 2) * (PORT_SIZE + 14) : 0;
  const h = headerH + attrH + (children.length ? innerH + PAD * 2 : PAD) + Math.max(0, portH - (children.length ? innerH : 0)) * 0;

  const minPortH = headerH + Math.ceil(ports.length / 2) * (PORT_SIZE + 16) + PAD;

  return {
    el,
    size: { w, h: Math.max(h, minPortH) },
    attributes,
    ports,
    children,
    childPos,
    headerH: headerH + attrH,
  };
}

function place(
  rel: RelNode,
  x: number,
  y: number,
  depth: number,
  boxByEl: Map<SysMLElement, DiagramNode>
): DiagramNode {
  const node: DiagramNode = {
    el: rel.el,
    label: nodeLabel(rel.el),
    kindLabel: kindLabel(rel.el),
    typeLabel: typeLabel(rel.el),
    x,
    y,
    w: rel.size.w,
    h: rel.size.h,
    rounded: rel.el.kind.startsWith("state") || rel.el.kind === "exhibit",
    attributes: rel.attributes,
    ports: [],
    children: [],
    depth,
  };
  boxByEl.set(rel.el, node);

  // ports: alternate left / right sides
  rel.ports.forEach((p, i) => {
    const side = i % 2 === 0 ? "left" : "right";
    const row = Math.floor(i / 2);
    const py = y + HEADER_H + KIND_H + 10 + row * (PORT_SIZE + 16);
    const port: DiagramPort = {
      el: p,
      name: p.name ?? "",
      side,
      x: side === "left" ? x : x + rel.size.w,
      y: Math.min(py, y + rel.size.h - 10),
    };
    node.ports.push(port);
    boxByEl.set(p, { ...node, el: p, x: port.x - 5, y: port.y - 5, w: 10, h: 10, children: [], ports: [] });
  });

  rel.children.forEach((c, i) => {
    const pos = rel.childPos[i];
    node.children.push(place(c, x + PAD + pos.x, y + rel.headerH + PAD + pos.y, depth + 1, boxByEl));
  });
  return node;
}

// ---- edge resolution --------------------------------------------------

function findByName(scope: SysMLElement, name: string): SysMLElement | undefined {
  // breadth-first so the nearest declaration wins
  const queue: SysMLElement[] = [...scope.children];
  while (queue.length) {
    const el = queue.shift()!;
    if (el.name === name || el.shortName === name) return el;
    queue.push(...el.children);
  }
  return undefined;
}

function resolvePath(scope: SysMLElement, path: string): SysMLElement | undefined {
  const segments = path.split(/::|\./).filter(Boolean);
  if (!segments.length) return undefined;

  // first segment: look in scope, then walk up ancestors
  let cur: SysMLElement | undefined;
  let s: SysMLElement | undefined = scope;
  while (s && !cur) {
    cur = findByName(s, segments[0]);
    s = s.parent;
  }
  if (!cur) return undefined;
  for (let i = 1; i < segments.length; i++) {
    const nextEl: SysMLElement | undefined = findByName(cur, segments[i]);
    if (!nextEl) return cur; // partial resolution: keep deepest found
    cur = nextEl;
  }
  return cur;
}

function rectAnchor(a: DiagramNode, b: DiagramNode): { x: number; y: number } {
  // anchor on the border of a towards centre of b
  const acx = a.x + a.w / 2;
  const acy = a.y + a.h / 2;
  const bcx = b.x + b.w / 2;
  const bcy = b.y + b.h / 2;
  const dx = bcx - acx;
  const dy = bcy - acy;
  if (dx === 0 && dy === 0) return { x: acx, y: acy };
  const sx = dx !== 0 ? (a.w / 2) / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? (a.h / 2) / Math.abs(dy) : Infinity;
  const t = Math.min(sx, sy, 1);
  return { x: acx + dx * t, y: acy + dy * t };
}

// ---- main entry --------------------------------------------------------

export function layoutDiagram(root: SysMLElement): DiagramLayout {
  const boxByEl = new Map<SysMLElement, DiagramNode>();

  // top-level children of the chosen root become root boxes
  // (file nodes are transparent: their contents are rendered directly)
  const rels: RelNode[] = [];
  const addTop = (el: SysMLElement) => {
    if (el.kind === "file") {
      el.children.forEach(addTop);
    } else if (shouldRenderAsBox(el)) {
      rels.push(measure(el, 0));
    }
  };
  root.children.forEach(addTop);
  // if the root itself is a box-ish element with no box children at top level,
  // render the root itself
  if (!rels.length && shouldRenderAsBox(root)) {
    rels.push(measure(root, 0));
  }

  const nodes: DiagramNode[] = [];
  let x = GAP;
  let y = GAP;
  let rowH = 0;
  const targetW = Math.max(
    900,
    ...rels.map((r) => r.size.w + GAP * 2)
  );
  for (const rel of rels) {
    if (x > GAP && x + rel.size.w > targetW) {
      x = GAP;
      y += rowH + GAP * 1.5;
      rowH = 0;
    }
    nodes.push(place(rel, x, y, 0, boxByEl));
    x += rel.size.w + GAP * 1.5;
    rowH = Math.max(rowH, rel.size.h);
  }

  // collect edges anywhere under root
  const edges: DiagramEdge[] = [];
  const visit = (el: SysMLElement) => {
    for (const c of el.children) {
      if (isEdgeElement(c)) {
        const edge = buildEdge(c, boxByEl);
        if (edge) edges.push(edge);
      }
      visit(c);
    }
  };
  visit(root);

  const width = nodes.reduce((m, n) => Math.max(m, n.x + n.w), 0) + GAP;
  const height = nodes.reduce((m, n) => Math.max(m, n.y + n.h), 0) + GAP;
  return { nodes, edges, width, height };
}

function buildEdge(
  el: SysMLElement,
  boxByEl: Map<SysMLElement, DiagramNode>
): DiagramEdge | undefined {
  const scope = el.parent;
  if (!scope) return undefined;

  let aEl: SysMLElement | undefined;
  let bEl: SysMLElement | undefined;

  if (el.kind === "transition") {
    if (el.transition?.source) aEl = resolvePath(scope, el.transition.source);
    if (el.transition?.target) bEl = resolvePath(scope, el.transition.target);
  } else {
    const ends = el.ends ?? [];
    if (ends.length >= 2) {
      aEl = resolvePath(scope, ends[0].path);
      bEl = resolvePath(scope, ends[1].path);
    }
  }
  if (!aEl || !bEl) return undefined;
  const a = boxByEl.get(aEl);
  const b = boxByEl.get(bEl);
  if (!a || !b || a === b) return undefined;

  const p1 = rectAnchor(a, b);
  const p2 = rectAnchor(b, a);

  let label: string | undefined = el.name;
  if (el.kind === "flow" && el.typedBy.length) label = (label ? label + ": " : "") + el.typedBy.join(",");
  if (el.kind === "transition") {
    const parts = [el.transition?.trigger, el.transition?.guard ? `[${el.transition.guard}]` : undefined]
      .filter(Boolean);
    label = parts.join(" ") || el.name;
  }

  return {
    el,
    kind: el.kind as DiagramEdge["kind"],
    x1: p1.x,
    y1: p1.y,
    x2: p2.x,
    y2: p2.y,
    label,
    arrow: el.kind === "flow" || el.kind === "transition" || el.kind === "allocation",
    dashed: el.kind === "flow" || el.kind === "allocation" || el.kind === "bind",
  };
}
