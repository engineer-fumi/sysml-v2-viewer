import { SysMLElement, createElement, walk } from "./ast";

// ---- diagram kinds ------------------------------------------------------

/** Diagram view kinds selectable in the diagram panel. */
export type DiagramKind =
  | "general"
  | "bdd"
  | "ibd"
  | "req"
  | "uc"
  | "state"
  | "action"
  | "seq";

export const DIAGRAM_KINDS: { id: DiagramKind; label: string; description: string }[] = [
  { id: "general", label: "全体図", description: "モデル全体 (構造・振る舞いのすべて)" },
  { id: "bdd", label: "ブロック定義図", description: "構造定義 (part def 等) と特化・コンポジション関係" },
  { id: "ibd", label: "内部ブロック図", description: "ブロック内部の part 構成と接続 (connect / flow / port)" },
  { id: "req", label: "要求図", description: "要求と satisfy / verify 関係" },
  { id: "uc", label: "ユースケース図", description: "ユースケースと perform / include 関係" },
  { id: "state", label: "状態遷移図", description: "状態機械 (状態と transition)" },
  { id: "action", label: "アクティビティ図", description: "アクションと succession / flow" },
  { id: "seq", label: "シーケンス図", description: "part 間のメッセージ (flow / message) を時系列表示" },
];

export function diagramKindLabel(kind: DiagramKind): string {
  return DIAGRAM_KINDS.find((k) => k.id === kind)?.label ?? kind;
}

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

const PACKAGE_KINDS = ["namespace", "package", "library package"];

/** structural definitions shown in the block definition diagram */
const STRUCTURAL_DEF_KINDS = [
  "part def", "item def", "port def", "attribute def", "interface def",
  "connection def", "enum def", "occurrence def", "flow def",
  "constraint def", "allocation def",
];

const ALL_EDGE_KINDS = [
  "connect", "bind", "flow", "transition", "interface", "connection", "allocation",
];

// ---- per-kind view specification ----------------------------------------

interface ViewSpec {
  /** kinds always rendered as boxes */
  primary: Set<string>;
  /** additional box predicate (e.g. actor-modified features) */
  extraPrimary?: (el: SysMLElement) => boolean;
  /** kinds rendered as boxes only when their subtree contains primary content */
  containers: Set<string>;
  /**
   * extra condition for top-level boxes. Elements that fail it are dropped
   * from the diagram top level (IBD: only composite parts), but still render
   * normally when nested inside another box.
   */
  topFilter?: (el: SysMLElement) => boolean;
  /** kinds rendered as text lines inside parent boxes */
  text: Set<string>;
  /** parsed edge kinds shown */
  edges: Set<string>;
  /** show port squares on box borders */
  ports: boolean;
  /** kinds rendered as ellipses (use cases) */
  ellipse?: Set<string>;
  /** include doc comments as body lines */
  doc?: boolean;
  /** synthesize specialization edges between rendered boxes */
  specializeEdges?: boolean;
  /** synthesize composition edges def -> type-of-member-usage (BDD) */
  composeEdges?: boolean;
  /** reference usages (satisfy / perform) drawn as edges */
  refEdges?: Set<string>;
  /**
   * pull actor members out of their use case box and connect them with an
   * association line instead (classic use case diagram rendering)
   */
  hoistActors?: boolean;
}

const VIEW_SPECS: Record<Exclude<DiagramKind, "seq">, ViewSpec> = {
  general: {
    primary: BOX_KINDS,
    containers: new Set(),
    text: TEXT_KINDS,
    edges: new Set(ALL_EDGE_KINDS),
    ports: true,
  },
  bdd: {
    primary: new Set(STRUCTURAL_DEF_KINDS),
    containers: new Set(PACKAGE_KINDS),
    text: new Set([
      ...TEXT_KINDS,
      "part", "item", "port", "action", "state", "requirement", "use case",
      "occurrence", "connection", "interface", "allocation", "case", "concern",
      "view", "viewpoint", "analysis", "verification", "metadata", "perform", "exhibit",
    ]),
    edges: new Set(),
    ports: false,
    specializeEdges: true,
    composeEdges: true,
  },
  // no package containers: composite parts are hoisted to the diagram top
  // level so the view shows block internals, not the package hierarchy
  ibd: {
    primary: new Set(["part", "item"]),
    containers: new Set(["part def", "item def"]),
    topFilter: (el) =>
      el.children.some(
        (c) =>
          c.kind === "part" || c.kind === "item" || c.kind === "port" || isEdgeElement(c)
      ),
    text: TEXT_KINDS,
    edges: new Set(["connect", "connection", "interface", "bind", "flow", "allocation"]),
    ports: true,
  },
  req: {
    primary: new Set([
      "requirement def", "requirement", "concern def", "concern",
      "verification def", "verification",
    ]),
    containers: new Set(),
    text: TEXT_KINDS,
    edges: new Set(),
    ports: false,
    doc: true,
    specializeEdges: true,
    refEdges: new Set(["satisfy"]),
  },
  uc: {
    primary: new Set(["use case def", "use case", "case def", "case"]),
    extraPrimary: (el) => el.modifiers.includes("actor"),
    containers: new Set(),
    text: TEXT_KINDS,
    edges: new Set(),
    ports: false,
    ellipse: new Set(["use case def", "use case", "case def", "case"]),
    specializeEdges: true,
    refEdges: new Set(["perform"]),
    hoistActors: true,
  },
  state: {
    primary: new Set(["state def", "state", "exhibit"]),
    containers: new Set(),
    text: new Set([...TEXT_KINDS, "action"]),
    edges: new Set(["transition"]),
    ports: false,
  },
  action: {
    primary: new Set(["action def", "action", "perform"]),
    containers: new Set(),
    // hide leaf actions at the top level (entry/exit actions of states,
    // bare performs): the view focuses on flows, which need sub-steps
    topFilter: (el) => el.kind === "action def" || el.children.length > 0,
    text: new Set([...TEXT_KINDS, "item"]),
    edges: new Set(["transition", "flow", "bind"]),
    ports: false,
  },
};

export type PortSide = "left" | "right" | "top" | "bottom";

/** line rendering styles: straight (waypoints make it a polyline), right-angle
 *  routing, or smoothed curve */
export type EdgeStyle = "straight" | "ortho" | "curve";

export interface DiagramPort {
  el: SysMLElement;
  name: string;
  /** absolute centre position */
  x: number;
  y: number;
  side: PortSide;
}

/** offsets key for a manually placed port (unique per owning usage) */
export function portOffsetKey(
  keyOf: (el: SysMLElement) => string,
  owner: SysMLElement,
  port: SysMLElement
): string {
  return `${keyOf(owner)}~port~${port.name ?? ""}`;
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
  /** render as ellipse (use cases) */
  ellipse?: boolean;
  /** render as a stick figure (use case actors) */
  actor?: boolean;
  /** sequence diagram: y where the dashed lifeline ends */
  lifelineEnd?: number;
  attributes: string[];
  ports: DiagramPort[];
  children: DiagramNode[];
  depth: number;
  /** pseudo-nodes used as edge anchors for the ports (kept in sync on shift) */
  portBoxes?: DiagramNode[];
}

export interface DiagramEdge {
  el: SysMLElement;
  kind:
    | "connect" | "flow" | "bind" | "transition" | "interface" | "connection"
    | "allocation" | "specialize" | "compose" | "satisfy" | "perform" | "assoc";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** manual routing waypoints between the endpoints (saved layout) */
  points?: { x: number; y: number }[];
  /** line rendering style (saved layout; default "straight") */
  style?: EdgeStyle;
  /** stable key for saved manual routing */
  key?: string;
  /** endpoint boxes (set when both are available; enables manual routing) */
  a?: DiagramNode;
  b?: DiagramNode;
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
  if (el.modifiers.includes("actor")) return "actor";
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
  if (!s && el.redefines.length) s = ":>> " + el.redefines.join(", ");
  if (el.kind === "import" || el.kind === "alias") s = `${el.kind} ${el.target ?? ""}`;
  if (el.typedBy.length) s += " : " + el.typedBy.join(", ");
  if (el.multiplicity) s += " " + el.multiplicity;
  if (el.value !== undefined && el.value.length <= 24) s += " = " + el.value;
  return s;
}

/** wrap documentation text into short lines for in-box display */
function wrapDoc(s: string, width = 34): string[] {
  const out: string[] = [];
  for (const para of s.split(/\n+/)) {
    let line = "";
    for (const ch of para.trim()) {
      line += ch;
      if (line.length >= width && (/[\s、。,.;)]/.test(ch) || line.length >= width + 10)) {
        out.push(line.trim());
        line = "";
      }
    }
    if (line.trim()) out.push(line.trim());
  }
  return out.slice(0, 6);
}

// ---- view filtering ------------------------------------------------------

interface ViewContext {
  spec: ViewSpec;
  /** elements forced to render as boxes (edge endpoints of ref edges) */
  forced: Set<SysMLElement>;
  asBox: (el: SysMLElement) => boolean;
  opts: LayoutOptions;
}

function makeViewContext(root: SysMLElement, spec: ViewSpec, opts: LayoutOptions): ViewContext {
  // resolve ref-edge endpoints up-front so they are kept as boxes even when
  // the view would otherwise prune them (e.g. `satisfy R by vehicle`)
  const forced = new Set<SysMLElement>();
  if (spec.refEdges) {
    walk(root, (el) => {
      if (!spec.refEdges!.has(el.kind) || !el.parent) return;
      if (el.target) {
        const t = resolvePath(el.parent, el.target, el);
        if (t) forced.add(t);
      }
      if ((el.ends?.length ?? 0) >= 2) {
        const s = resolvePath(el.parent, el.ends![1].path, el);
        if (s) forced.add(s);
      } else {
        // no `by` clause: the enclosing named element is the edge source
        // (e.g. the part performing a use case). Packages stay hidden.
        let p: SysMLElement | undefined = el.parent;
        while (p && !p.name) p = p.parent;
        if (p && p.kind !== "file" && !PACKAGE_KINDS.includes(p.kind)) forced.add(p);
      }
    });
  }

  const isPrimary = (el: SysMLElement) =>
    spec.primary.has(el.kind) ||
    (spec.extraPrimary?.(el) ?? false) ||
    (spec.refEdges?.has(el.kind) ?? false) ||
    forced.has(el);

  const memo = new Map<SysMLElement, boolean>();
  const hasPrimary = (el: SysMLElement): boolean => {
    const cached = memo.get(el);
    if (cached !== undefined) return cached;
    let v = false;
    for (const c of el.children) {
      if (isPrimary(c) || hasPrimary(c)) {
        v = true;
        break;
      }
    }
    memo.set(el, v);
    return v;
  };

  const asBox = (el: SysMLElement): boolean => {
    if (isEdgeElement(el) || (spec.refEdges?.has(el.kind) ?? false)) return false;
    if (spec.primary.has(el.kind) || (spec.extraPrimary?.(el) ?? false) || forced.has(el)) {
      return true;
    }
    if (spec.containers.has(el.kind)) return hasPrimary(el);
    return false;
  };

  return { spec, forced, asBox, opts };
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

/** arrange child boxes in rows (wrapping for a pleasant aspect ratio) and
 *  apply manual offsets from the saved diagram layout */
function arrangeChildren(
  children: RelNode[],
  opts: LayoutOptions
): { childPos: { x: number; y: number }[]; innerW: number; innerH: number } {
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
    }

    // manual offsets (saved diagram layout) – any child may be moved freely;
    // the parent grows to keep containing its children
    if (opts.offsets && opts.keyOf) {
      let minX = 0;
      let minY = 0;
      children.forEach((c, i) => {
        const o = opts.offsets![opts.keyOf!(c.el)];
        if (o) {
          childPos[i].x += o.dx;
          childPos[i].y += o.dy;
        }
        minX = Math.min(minX, childPos[i].x);
        minY = Math.min(minY, childPos[i].y);
      });
      if (minX < 0 || minY < 0) {
        for (const p of childPos) {
          p.x -= minX;
          p.y -= minY;
        }
      }
    }
    children.forEach((c, i) => {
      innerW = Math.max(innerW, childPos[i].x + c.size.w);
      innerH = Math.max(innerH, childPos[i].y + c.size.h);
    });
  }
  return { childPos, innerW, innerH };
}

/** ports declared on the element's type defs (following specializations) */
function inheritedPorts(el: SysMLElement): SysMLElement[] {
  const out: SysMLElement[] = [];
  const visited = new Set<SysMLElement>();
  const visitType = (def: SysMLElement | undefined, depth: number) => {
    if (!def || visited.has(def) || depth > 5) return;
    visited.add(def);
    for (const c of def.children) {
      if (PORT_KINDS.has(c.kind)) out.push(c);
    }
    for (const s of def.specializes) {
      visitType(def.parent ? resolvePath(def.parent, s, def) : undefined, depth + 1);
    }
  };
  for (const tn of el.typedBy) {
    visitType(el.parent ? resolvePath(el.parent, tn, el) : undefined, 0);
  }
  return out;
}

function measure(el: SysMLElement, depth: number, ctx: ViewContext): RelNode {
  const { spec, opts } = ctx;
  const attributes: string[] = [];
  const ports: SysMLElement[] = [];
  const children: RelNode[] = [];

  // actors are drawn as fixed-size stick figures with the name below
  if (spec.hoistActors && (spec.extraPrimary?.(el) ?? false)) {
    const label = nodeLabel(el);
    return {
      el,
      size: { w: Math.max(64, textWidth(label) + 8), h: 84 },
      attributes: [],
      ports: [],
      children: [],
      childPos: [],
      headerH: 0,
    };
  }

  if (spec.doc && el.doc) attributes.push(...wrapDoc(el.doc));

  for (const c of el.children) {
    if (isEdgeElement(c) || (spec.refEdges?.has(c.kind) ?? false)) continue;
    // actor members are hoisted to the top level (rendered by layoutDiagram)
    if (spec.hoistActors && (spec.extraPrimary?.(c) ?? false)) continue;
    if (PORT_KINDS.has(c.kind)) {
      if (spec.ports) ports.push(c);
      else {
        const line = attributeLine(c);
        if (line.trim()) attributes.push(line);
      }
    } else if (ctx.asBox(c) && depth < 6) {
      children.push(measure(c, depth + 1, ctx));
    } else if (spec.text.has(c.kind) || c.kind === "unknown") {
      const line = attributeLine(c);
      if (line.trim()) attributes.push(line);
    }
  }

  // ports declared on the type definition render on the usage box too
  // (e.g. `part engine : Engine` shows the ports of `part def Engine`)
  if (spec.ports && !el.kind.endsWith("def")) {
    const have = new Set(ports.map((p) => p.name));
    for (const p of inheritedPorts(el)) {
      if (!have.has(p.name)) {
        have.add(p.name);
        ports.push(p);
      }
    }
  }

  const label = nodeLabel(el);
  const tLabel = typeLabel(el) ?? "";
  const headerW = Math.max(textWidth(label + " " + tLabel) + PAD * 2, textWidth(`«${kindLabel(el)}»`) + PAD * 2);
  const headerH = HEADER_H + KIND_H;
  const attrW = attributes.reduce((m, a) => Math.max(m, textWidth(a) + PAD * 2), 0);
  const attrH = attributes.length ? attributes.length * LINE_H + 6 : 0;

  // arrange children in rows, wrapping to keep a pleasant aspect ratio
  const { childPos, innerW, innerH } = arrangeChildren(children, opts);

  // room for port labels sticking out
  const portLabelW = ports.reduce((m, p) => Math.max(m, textWidth(p.name ?? "")), 0);

  let w = Math.max(MIN_W, headerW, attrW, innerW + PAD * 2, portLabelW + MIN_W);
  let h = headerH + attrH + (children.length ? innerH + PAD * 2 : PAD);

  const minPortH = headerH + Math.ceil(ports.length / 2) * (PORT_SIZE + 16) + PAD;
  h = Math.max(h, minPortH);

  // manual resize (saved layout): boxes may be enlarged beyond their content,
  // never shrunk below it
  const o = opts.offsets && opts.keyOf ? opts.offsets[opts.keyOf(el)] : undefined;
  w += Math.max(0, o?.dw ?? 0);
  h += Math.max(0, o?.dh ?? 0);

  return {
    el,
    size: { w, h },
    attributes,
    ports,
    children,
    childPos,
    headerH: headerH + attrH,
  };
}

/** port pseudo-boxes per owning box element, keyed by port name */
type PortsByOwner = Map<SysMLElement, Map<string, DiagramNode>>;

function place(
  rel: RelNode,
  x: number,
  y: number,
  depth: number,
  boxByEl: Map<SysMLElement, DiagramNode>,
  spec: ViewSpec,
  portsByOwner: PortsByOwner,
  opts: LayoutOptions
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
    ellipse: spec.ellipse?.has(rel.el.kind) ?? false,
    actor: (spec.hoistActors && (spec.extraPrimary?.(rel.el) ?? false)) || undefined,
    attributes: rel.attributes,
    ports: [],
    children: [],
    depth,
  };
  boxByEl.set(rel.el, node);

  // ports: alternate left / right by default; manual placement (saved layout)
  // may pin a port to any side at a 0..1 position along it
  rel.ports.forEach((p, i) => {
    let side: PortSide = i % 2 === 0 ? "left" : "right";
    const row = Math.floor(i / 2);
    let px = side === "left" ? x : x + rel.size.w;
    let py = Math.min(
      y + HEADER_H + KIND_H + 10 + row * (PORT_SIZE + 16),
      y + rel.size.h - 10
    );
    const pk = opts.keyOf ? portOffsetKey(opts.keyOf, rel.el, p) : undefined;
    const o = pk ? opts.offsets?.[pk] : undefined;
    if (o?.side && o.t !== undefined) {
      side = o.side;
      const t = Math.min(0.95, Math.max(0.05, o.t));
      if (side === "left" || side === "right") {
        px = side === "left" ? x : x + rel.size.w;
        py = y + t * rel.size.h;
      } else {
        px = x + t * rel.size.w;
        py = side === "top" ? y : y + rel.size.h;
      }
    }
    const port: DiagramPort = {
      el: p,
      name: p.name ?? "",
      side,
      x: px,
      y: py,
    };
    node.ports.push(port);
    const pseudo: DiagramNode = {
      ...node,
      el: p,
      x: port.x - 5,
      y: port.y - 5,
      w: 10,
      h: 10,
      children: [],
      ports: [],
      portBoxes: undefined,
    };
    (node.portBoxes ??= []).push(pseudo);
    // inherited ports may render on several usages of the same def: keep the
    // first registration for direct element lookups, and the per-owner map
    // for path-based lookups (`engine.fuelIn`)
    if (!boxByEl.has(p)) boxByEl.set(p, pseudo);
    let owner = portsByOwner.get(rel.el);
    if (!owner) portsByOwner.set(rel.el, (owner = new Map()));
    owner.set(p.name ?? "", pseudo);
  });

  rel.children.forEach((c, i) => {
    const pos = rel.childPos[i];
    node.children.push(
      place(c, x + PAD + pos.x, y + rel.headerH + PAD + pos.y, depth + 1, boxByEl, spec, portsByOwner, opts)
    );
  });
  return node;
}

// ---- edge resolution --------------------------------------------------

function findByName(
  scope: SysMLElement,
  name: string,
  exclude?: SysMLElement
): SysMLElement | undefined {
  // breadth-first so the nearest declaration wins
  const queue: SysMLElement[] = [...scope.children];
  while (queue.length) {
    const el = queue.shift()!;
    if (el !== exclude && (el.name === name || el.shortName === name)) return el;
    queue.push(...el.children);
  }
  return undefined;
}

/**
 * `exclude` skips the referencing element itself: reference usages such as
 * `perform OperateRobot` carry the target as their own name, so a naive
 * search would resolve to the reference instead of the declaration.
 */
function resolvePath(
  scope: SysMLElement,
  path: string,
  exclude?: SysMLElement
): SysMLElement | undefined {
  const segments = path.split(/::|\./).filter(Boolean);
  if (!segments.length) return undefined;

  // first segment: look in scope, then walk up ancestors
  let cur: SysMLElement | undefined;
  let s: SysMLElement | undefined = scope;
  while (s && !cur) {
    cur = findByName(s, segments[0], exclude);
    s = s.parent;
  }
  if (!cur) return undefined;
  for (let i = 1; i < segments.length; i++) {
    const nextEl: SysMLElement | undefined = findByName(cur, segments[i], exclude);
    if (!nextEl) return cur; // partial resolution: keep deepest found
    cur = nextEl;
  }
  return cur;
}

/** anchor on the border of a towards an arbitrary point */
function anchorTowards(a: DiagramNode, pt: { x: number; y: number }): { x: number; y: number } {
  const acx = a.x + a.w / 2;
  const acy = a.y + a.h / 2;
  const dx = pt.x - acx;
  const dy = pt.y - acy;
  if (dx === 0 && dy === 0) return { x: acx, y: acy };
  const sx = dx !== 0 ? (a.w / 2) / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? (a.h / 2) / Math.abs(dy) : Infinity;
  const t = Math.min(sx, sy, 1);
  return { x: acx + dx * t, y: acy + dy * t };
}

function rectAnchor(a: DiagramNode, b: DiagramNode): { x: number; y: number } {
  return anchorTowards(a, { x: b.x + b.w / 2, y: b.y + b.h / 2 });
}

/**
 * Assign stable keys to edges and apply saved manual routing (waypoints).
 * The key is keyOf(el) + edge kind + a per-element sequence number.
 */
function applyEdgeRouting(edges: DiagramEdge[], options: LayoutOptions): void {
  const counters = new Map<string, number>();
  for (const e of edges) {
    const base = `${options.keyOf ? options.keyOf(e.el) : ""}~edge~${e.kind}`;
    const i = counters.get(base) ?? 0;
    counters.set(base, i + 1);
    e.key = `${base}~${i}`;
    const entry = options.offsets?.[e.key];
    if (entry?.style) e.style = entry.style;
    const wp = entry?.wp;
    if (wp?.length && e.a && e.b) {
      e.points = wp.map((p) => ({ x: p.x, y: p.y }));
      // re-anchor the endpoints towards the first / last waypoint
      const p1 = anchorTowards(e.a, e.points[0]);
      const p2 = anchorTowards(e.b, e.points[e.points.length - 1]);
      e.x1 = p1.x;
      e.y1 = p1.y;
      e.x2 = p2.x;
      e.y2 = p2.y;
    }
  }
}

/**
 * Subject type name of a use case: its own `subject x : T` member, or one
 * found via its typing / specialization chain.
 */
function subjectTypeOf(el: SysMLElement): string | undefined {
  const visited = new Set<SysMLElement>();
  const queue: SysMLElement[] = [el];
  let guard = 0;
  while (queue.length && guard++ < 32) {
    const cur = queue.shift()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const subj = cur.children.find((c) => c.modifiers.includes("subject"));
    if (subj?.typedBy.length) return subj.typedBy[0];
    for (const name of [...cur.typedBy, ...cur.specializes]) {
      const t = cur.parent ? resolvePath(cur.parent, name, cur) : undefined;
      if (t) queue.push(t);
    }
  }
  return undefined;
}

/** box of el itself, or of its nearest boxed ancestor */
function nearestBox(
  el: SysMLElement | undefined,
  boxByEl: Map<SysMLElement, DiagramNode>
): DiagramNode | undefined {
  let cur = el;
  while (cur) {
    const b = boxByEl.get(cur);
    if (b) return b;
    cur = cur.parent;
  }
  return undefined;
}

// ---- main entry --------------------------------------------------------

export interface LayoutOffsets {
  /**
   * manual position shift and (optional) size enlargement per element;
   * port entries (see portOffsetKey) store a border side and a 0..1 position
   * along that side instead
   */
  [elementKey: string]: {
    dx: number;
    dy: number;
    dw?: number;
    dh?: number;
    side?: PortSide;
    t?: number;
    /** manual edge routing waypoints (edge entries only) */
    wp?: { x: number; y: number }[];
    /** line style override (edge entries only) */
    style?: EdgeStyle;
  };
}

export interface LayoutOptions {
  /** manual position offsets for top-level boxes, keyed by keyOf(el) */
  offsets?: LayoutOffsets;
  keyOf?: (el: SysMLElement) => string;
  /** diagram view kind (default "general") */
  kind?: DiagramKind;
}

/** Shift a node, its ports and children by (dx, dy). */
function shiftNode(node: DiagramNode, dx: number, dy: number): void {
  node.x += dx;
  node.y += dy;
  for (const p of node.ports) {
    p.x += dx;
    p.y += dy;
  }
  for (const pb of node.portBoxes ?? []) {
    pb.x += dx;
    pb.y += dy;
  }
  for (const c of node.children) shiftNode(c, dx, dy);
}

export function layoutDiagram(root: SysMLElement, options: LayoutOptions = {}): DiagramLayout {
  const kind = options.kind ?? "general";
  if (kind === "seq") return layoutSequence(root, options);

  const spec = VIEW_SPECS[kind];
  const ctx = makeViewContext(root, spec, options);
  const boxByEl = new Map<SysMLElement, DiagramNode>();
  const portsByOwner: PortsByOwner = new Map();

  // use case view: actors with the same name collapse into one figure, and a
  // part with a matching name (the performer) merges into that figure too
  const actorGroups = new Map<string, SysMLElement[]>();
  const actorAlias = new Map<SysMLElement, SysMLElement>();
  if (spec.hoistActors && spec.extraPrimary) {
    walk(root, (el) => {
      if (el === root || !spec.extraPrimary!(el)) return;
      const label = nodeLabel(el) || "(actor)";
      const g = actorGroups.get(label);
      if (g) {
        g.push(el);
        actorAlias.set(el, g[0]);
      } else {
        actorGroups.set(label, [el]);
      }
    });
    if (actorGroups.size) {
      walk(root, (el) => {
        if ((el.kind === "part" || el.kind === "item") && el.name && actorGroups.has(el.name)) {
          actorAlias.set(el, actorGroups.get(el.name)![0]);
        }
      });
    }
  }

  // collect top-level boxes. Non-box elements (files, packages pruned by the
  // view) are transparent: their box descendants are hoisted to the top level
  const rels: RelNode[] = [];
  const topEls = new Set<SysMLElement>();
  const topCandidates: SysMLElement[] = [];
  const addTop = (el: SysMLElement) => {
    if (actorAlias.has(el)) return; // merged into an actor figure
    if (ctx.asBox(el) && el.kind !== "file") {
      if (spec.topFilter && !spec.topFilter(el)) return;
      topEls.add(el);
      topCandidates.push(el);
    } else {
      el.children.forEach(addTop);
    }
  };
  root.children.forEach(addTop);

  // use case view: wrap use cases in a boundary box named after their subject
  // type (the system boundary of the classic diagram)
  const boundaryEls: SysMLElement[] = [];
  if (spec.ellipse) {
    const bGroups = new Map<string, { boundary?: SysMLElement; members: SysMLElement[] }>();
    const rest: SysMLElement[] = [];
    for (const el of topCandidates) {
      const subj = spec.ellipse.has(el.kind) ? subjectTypeOf(el) : undefined;
      if (subj) {
        let g = bGroups.get(subj);
        if (!g) {
          g = {
            boundary: el.parent ? resolvePath(el.parent, subj, el) : undefined,
            members: [],
          };
          bGroups.set(subj, g);
        }
        g.members.push(el);
      } else {
        rest.push(el);
      }
    }
    rels.push(...rest.map((e) => measure(e, 0, ctx)));
    for (const [name, g] of bGroups) {
      const inner = g.members.map((e) => measure(e, 1, ctx));
      const { childPos, innerW, innerH } = arrangeChildren(inner, options);
      const headerH = HEADER_H + KIND_H;
      let bEl = g.boundary;
      if (!bEl) {
        bEl = createElement("part def");
        bEl.name = name;
      }
      boundaryEls.push(bEl);
      let w = Math.max(MIN_W, innerW + PAD * 2, textWidth(name) + PAD * 2);
      let h = headerH + innerH + PAD * 2;
      const o = options.offsets && options.keyOf ? options.offsets[options.keyOf(bEl)] : undefined;
      w += Math.max(0, o?.dw ?? 0);
      h += Math.max(0, o?.dh ?? 0);
      rels.push({ el: bEl, size: { w, h }, attributes: [], ports: [], children: inner, childPos, headerH });
    }
  } else {
    rels.push(...topCandidates.map((e) => measure(e, 0, ctx)));
  }

  // hoist one figure per actor name (members live inside use case boxes
  // where addTop never descends)
  for (const els of actorGroups.values()) {
    if (!topEls.has(els[0])) rels.push(measure(els[0], 0, ctx));
  }

  // if the root itself is a box-ish element with no box children at top level,
  // render the root itself
  if (!rels.length && ctx.asBox(root)) {
    rels.push(measure(root, 0, ctx));
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
    nodes.push(place(rel, x, y, 0, boxByEl, spec, portsByOwner, options));
    x += rel.size.w + GAP * 1.5;
    rowH = Math.max(rowH, rel.size.h);
  }

  // merged actors / performer parts anchor their edges at the shared figure
  for (const [el, rep] of actorAlias) {
    const fig = boxByEl.get(rep);
    if (fig) boxByEl.set(el, fig);
  }
  // subject boundary boxes show «subject» instead of the def kind
  for (const bEl of boundaryEls) {
    const n = boxByEl.get(bEl);
    if (n) n.kindLabel = "subject";
  }

  // apply manual offsets to top-level boxes (saved diagram layout)
  const { offsets, keyOf } = options;
  if (offsets && keyOf) {
    for (const n of nodes) {
      const o = offsets[keyOf(n.el)];
      if (o) shiftNode(n, o.dx, o.dy);
    }
    // normalize so everything stays in positive coordinates
    const minX = Math.min(GAP, ...nodes.map((n) => n.x));
    const minY = Math.min(GAP, ...nodes.map((n) => n.y));
    if (minX < GAP || minY < GAP) {
      for (const n of nodes) shiftNode(n, GAP - minX, GAP - minY);
    }
  }

  // collect edges anywhere under root (after offsets, so anchors are correct)
  const edges: DiagramEdge[] = [];
  const visit = (el: SysMLElement) => {
    for (const c of el.children) {
      if (isEdgeElement(c) && spec.edges.has(c.kind)) {
        const edge = buildEdge(c, boxByEl, portsByOwner);
        if (edge) edges.push(edge);
      } else if (spec.refEdges?.has(c.kind)) {
        const edge = buildRefEdge(c, boxByEl);
        if (edge) edges.push(edge);
      }
      visit(c);
    }
  };
  visit(root);

  if (spec.specializeEdges) edges.push(...specializeEdges(boxByEl));
  if (spec.composeEdges) edges.push(...composeEdges(root, boxByEl));

  // every actor member keeps an association line from the merged figure to
  // its owning use case
  for (const els of actorGroups.values()) {
    const fig = boxByEl.get(els[0]);
    if (!fig) continue;
    const seen = new Set<string>();
    for (const a of els) {
      const ub = nearestBox(a.parent, boxByEl);
      if (!ub || ub === fig) continue;
      const key = `${ub.x},${ub.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const p1 = rectAnchor(fig, ub);
      const p2 = rectAnchor(ub, fig);
      edges.push({
        el: a,
        kind: "assoc",
        x1: p1.x,
        y1: p1.y,
        x2: p2.x,
        y2: p2.y,
        a: fig,
        b: ub,
        arrow: false,
        dashed: false,
      });
    }
  }

  applyEdgeRouting(edges, options);

  const width = nodes.reduce((m, n) => Math.max(m, n.x + n.w), 0) + GAP;
  const height = nodes.reduce((m, n) => Math.max(m, n.y + n.h), 0) + GAP;
  return { nodes, edges, width, height };
}

/**
 * Resolve a connection end path to its anchor box. Walks the path segment by
 * segment; when a segment cannot be resolved as a child element, it may name
 * a port inherited from the owner's type (`engine.fuelIn` where fuelIn lives
 * on `part def Engine`) — anchor at that port's pseudo box.
 */
function resolveEndBox(
  scope: SysMLElement,
  path: string,
  boxByEl: Map<SysMLElement, DiagramNode>,
  portsByOwner: PortsByOwner
): DiagramNode | undefined {
  const segments = path.split(/::|\./).filter(Boolean);
  if (!segments.length) return undefined;

  let cur: SysMLElement | undefined;
  let s: SysMLElement | undefined = scope;
  while (s && !cur) {
    cur = findByName(s, segments[0]);
    s = s.parent;
  }
  if (!cur) return undefined;
  for (let i = 1; i < segments.length; i++) {
    const next = findByName(cur, segments[i]);
    if (!next) {
      const port = portsByOwner.get(cur)?.get(segments[i]);
      if (port) return port;
      break; // partial resolution: anchor at the deepest box found
    }
    cur = next;
  }
  // the resolved element may not be boxed in this view (e.g. an action's
  // item parameter): anchor at its nearest boxed ancestor instead
  return boxByEl.get(cur) ?? nearestBox(cur, boxByEl);
}

function buildEdge(
  el: SysMLElement,
  boxByEl: Map<SysMLElement, DiagramNode>,
  portsByOwner: PortsByOwner
): DiagramEdge | undefined {
  const scope = el.parent;
  if (!scope) return undefined;

  let a: DiagramNode | undefined;
  let b: DiagramNode | undefined;

  if (el.kind === "transition") {
    const aEl = el.transition?.source ? resolvePath(scope, el.transition.source) : undefined;
    const bEl = el.transition?.target ? resolvePath(scope, el.transition.target) : undefined;
    a = aEl ? boxByEl.get(aEl) ?? nearestBox(aEl, boxByEl) : undefined;
    b = bEl ? boxByEl.get(bEl) ?? nearestBox(bEl, boxByEl) : undefined;
  } else {
    const ends = el.ends ?? [];
    if (ends.length >= 2) {
      a = resolveEndBox(scope, ends[0].path, boxByEl, portsByOwner);
      b = resolveEndBox(scope, ends[1].path, boxByEl, portsByOwner);
    }
  }
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
    a,
    b,
    label,
    arrow: el.kind === "flow" || el.kind === "transition" || el.kind === "allocation",
    dashed: el.kind === "flow" || el.kind === "allocation" || el.kind === "bind",
  };
}

/** satisfy / perform reference usages drawn as dashed dependency arrows */
function buildRefEdge(
  el: SysMLElement,
  boxByEl: Map<SysMLElement, DiagramNode>
): DiagramEdge | undefined {
  const scope = el.parent;
  if (!scope || !el.target) return undefined;

  const targetEl = resolvePath(scope, el.target, el);
  const target = nearestBox(targetEl, boxByEl);
  if (!target) return undefined;

  // `satisfy R by x` names the satisfying element; otherwise the enclosing box
  let source: DiagramNode | undefined;
  if ((el.ends?.length ?? 0) >= 2) {
    source = nearestBox(resolvePath(scope, el.ends![1].path, el), boxByEl);
  }
  source ??= nearestBox(scope, boxByEl);
  if (!source || source === target) return undefined;

  const stereo = el.modifiers.includes("verify")
    ? "verify"
    : el.modifiers.includes("include")
      ? "include"
      : el.kind;

  const p1 = rectAnchor(source, target);
  const p2 = rectAnchor(target, source);
  return {
    el,
    kind: el.kind as "satisfy" | "perform",
    x1: p1.x,
    y1: p1.y,
    x2: p2.x,
    y2: p2.y,
    a: source,
    b: target,
    label: `«${stereo}»`,
    arrow: true,
    dashed: true,
  };
}

/** generalization edges (`:>` / specializes) between rendered boxes */
function specializeEdges(boxByEl: Map<SysMLElement, DiagramNode>): DiagramEdge[] {
  const edges: DiagramEdge[] = [];
  const seen = new Set<string>();
  for (const [el, box] of boxByEl) {
    if (PORT_KINDS.has(el.kind)) continue;
    for (const name of el.specializes) {
      const t = el.parent ? resolvePath(el.parent, name) : undefined;
      const tb = t ? boxByEl.get(t) : undefined;
      if (!tb || tb === box) continue;
      const key = `${box.x},${box.y}->${tb.x},${tb.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const p1 = rectAnchor(box, tb);
      const p2 = rectAnchor(tb, box);
      edges.push({
        el,
        kind: "specialize",
        x1: p1.x,
        y1: p1.y,
        x2: p2.x,
        y2: p2.y,
        a: box,
        b: tb,
        arrow: true,
        dashed: false,
      });
    }
  }
  return edges;
}

/**
 * BDD composition edges: def --(member)--> def of the member's type.
 * Membership is taken from def bodies AND from the internal structure of
 * usages: `part vehicle : Vehicle { part engine : Engine; }` implies that
 * Vehicle composes Engine even when `part def Vehicle` declares no members.
 */
function composeEdges(
  root: SysMLElement,
  boxByEl: Map<SysMLElement, DiagramNode>
): DiagramEdge[] {
  const memberKinds = new Set([
    "part", "item", "port", "action", "state", "ref", "attribute",
    "connection", "occurrence", "requirement", "use case",
  ]);
  // merge parallel edges (several members of the same type) into one labelled edge
  const merged = new Map<string, { a: DiagramNode; b: DiagramNode; el: SysMLElement; labels: string[] }>();

  const boxOfType = (el: SysMLElement, names: string[]): DiagramNode | undefined => {
    for (const tn of names) {
      const t = el.parent ? resolvePath(el.parent, tn, el) : undefined;
      const b = t ? boxByEl.get(t) : undefined;
      if (b) return b;
    }
    return undefined;
  };

  walk(root, (el) => {
    // owner box: a rendered def, or the def a usage is typed by
    const owner = el.kind.endsWith("def")
      ? boxByEl.get(el)
      : el.typedBy.length
        ? boxOfType(el, el.typedBy)
        : undefined;
    if (!owner) return;
    for (const c of el.children) {
      if (!memberKinds.has(c.kind) || !c.typedBy.length) continue;
      const tb = boxOfType(c, c.typedBy);
      if (!tb || tb === owner) continue;
      const key = `${owner.x},${owner.y}->${tb.x},${tb.y}`;
      const label = (c.name ?? "") + (c.multiplicity ? " " + c.multiplicity : "");
      const entry = merged.get(key);
      if (entry) {
        if (label && !entry.labels.includes(label)) entry.labels.push(label);
      } else {
        merged.set(key, { a: owner, b: tb, el: c, labels: label ? [label] : [] });
      }
    }
  });

  const edges: DiagramEdge[] = [];
  for (const { a, b, el, labels } of merged.values()) {
    const p1 = rectAnchor(a, b);
    const p2 = rectAnchor(b, a);
    edges.push({
      el,
      kind: "compose",
      x1: p1.x,
      y1: p1.y,
      x2: p2.x,
      y2: p2.y,
      a,
      b,
      label: labels.slice(0, 3).join(", ") + (labels.length > 3 ? " …" : ""),
      arrow: false,
      dashed: false,
    });
  }
  return edges;
}

// ---- sequence diagram ----------------------------------------------------

const LIFELINE_KINDS = new Set(["part", "item", "occurrence"]);
const SEQ_HEAD_H = HEADER_H + KIND_H;
const SEQ_GAP_X = 40;
const SEQ_MSG_GAP = 36;

/** topmost usages under scope (not nested inside another lifeline candidate) */
function topUsages(scope: SysMLElement): SysMLElement[] {
  const out: SysMLElement[] = [];
  const rec = (el: SysMLElement) => {
    for (const c of el.children) {
      // direction-prefixed features are parameters, not lifelines
      if (LIFELINE_KINDS.has(c.kind) && !c.direction) out.push(c);
      else rec(c);
    }
  };
  rec(scope);
  return out;
}

function layoutSequence(root: SysMLElement, options: LayoutOptions): DiagramLayout {
  // pick the scope: descend while there is exactly one lifeline candidate
  let scope = root;
  let lifelineEls = topUsages(scope);
  for (let i = 0; i < 4 && lifelineEls.length === 1 && lifelineEls[0].children.length; i++) {
    scope = lifelineEls[0];
    lifelineEls = topUsages(scope);
  }
  interface Msg {
    el: SysMLElement;
    from: SysMLElement;
    to: SysMLElement;
    label?: string;
  }
  // messages are item flows (`flow` / `message`) between parts; successions
  // and transitions are control flow and belong to the activity / state views
  const computeMsgs = (els: SysMLElement[]): Msg[] => {
    const set = new Set(els);
    const ownerLifeline = (el: SysMLElement | undefined): SysMLElement | undefined => {
      let cur = el;
      while (cur) {
        if (set.has(cur)) return cur;
        cur = cur.parent;
      }
      return undefined;
    };
    const out: Msg[] = [];
    walk(root, (el) => {
      if (!el.parent) return;
      if (el.kind !== "flow" || (el.ends?.length ?? 0) < 2) return;
      const a = resolvePath(el.parent, el.ends![0].path);
      const b = resolvePath(el.parent, el.ends![1].path);
      const label = el.typedBy.length ? el.typedBy.join(",") : el.name;
      const from = ownerLifeline(a);
      const to = ownerLifeline(b);
      if (from && to && from !== to) out.push({ el, from, to, label });
    });
    out.sort(
      (a, b) => (a.el.fileId ?? 0) - (b.el.fileId ?? 0) || a.el.start - b.el.start
    );
    return out;
  };

  let msgs = computeMsgs(lifelineEls);
  // all flows internal to a single lifeline? expand lifelines one level into
  // their child parts until messages become visible
  for (let round = 0; round < 3 && !msgs.length; round++) {
    const expanded = lifelineEls.flatMap((l) => {
      const inner = topUsages(l);
      return inner.length ? inner : [l];
    });
    if (expanded.length === lifelineEls.length) break;
    lifelineEls = expanded;
    msgs = computeMsgs(lifelineEls);
  }
  lifelineEls.sort((a, b) => (a.fileId ?? 0) - (b.fileId ?? 0) || a.start - b.start);

  // hide lifelines that exchange no messages (when any messages exist)
  if (msgs.length) {
    const participants = new Set<SysMLElement>();
    for (const m of msgs) {
      participants.add(m.from);
      participants.add(m.to);
    }
    lifelineEls = lifelineEls.filter((el) => participants.has(el));
  }

  const height = Math.max(
    SEQ_HEAD_H + 90,
    SEQ_HEAD_H + 40 + msgs.length * SEQ_MSG_GAP + 50
  );

  // lifeline head boxes
  const { offsets, keyOf } = options;
  const boxByLifeline = new Map<SysMLElement, DiagramNode>();
  const nodes: DiagramNode[] = [];
  let x = GAP;
  for (const el of lifelineEls) {
    const label = nodeLabel(el);
    const tLabel = typeLabel(el) ?? "";
    const w = Math.max(100, textWidth(label + " " + tLabel) + PAD * 2);
    // manual horizontal adjustment only (vertical position is fixed)
    const dx = offsets && keyOf ? offsets[keyOf(el)]?.dx ?? 0 : 0;
    const node: DiagramNode = {
      el,
      label,
      kindLabel: kindLabel(el),
      typeLabel: typeLabel(el),
      x: Math.max(GAP, x + dx),
      y: GAP,
      w,
      h: SEQ_HEAD_H,
      rounded: false,
      lifelineEnd: height,
      attributes: [],
      ports: [],
      children: [],
      depth: 0,
    };
    nodes.push(node);
    boxByLifeline.set(el, node);
    x += w + SEQ_GAP_X;
  }

  const edges: DiagramEdge[] = [];
  msgs.forEach((m, i) => {
    const a = boxByLifeline.get(m.from)!;
    const b = boxByLifeline.get(m.to)!;
    const y = GAP + SEQ_HEAD_H + 40 + i * SEQ_MSG_GAP;
    edges.push({
      el: m.el,
      kind: m.el.kind as DiagramEdge["kind"],
      x1: a.x + a.w / 2,
      y1: y,
      x2: b.x + b.w / 2,
      y2: y,
      label: m.label,
      arrow: true,
      dashed: m.el.kind === "flow",
    });
  });

  applyEdgeRouting(edges, options);

  const width = nodes.reduce((m, n) => Math.max(m, n.x + n.w), 0) + GAP;
  return { nodes, edges, width, height: height + GAP };
}
