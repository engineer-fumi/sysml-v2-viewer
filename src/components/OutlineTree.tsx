import { useState } from "react";
import { SysMLElement, elementLabel } from "../sysml/ast";

interface Props {
  root: SysMLElement;
  selected?: SysMLElement;
  onSelect: (el: SysMLElement) => void;
}

const KIND_ICONS: Record<string, { glyph: string; color: string }> = {
  file: { glyph: "▤", color: "#89b4fa" },
  package: { glyph: "P", color: "#f9e2af" },
  "library package": { glyph: "P", color: "#f9e2af" },
  namespace: { glyph: "N", color: "#f9e2af" },
  "part def": { glyph: "D", color: "#89b4fa" },
  part: { glyph: "p", color: "#89b4fa" },
  "attribute def": { glyph: "A", color: "#a6e3a1" },
  attribute: { glyph: "a", color: "#a6e3a1" },
  "port def": { glyph: "O", color: "#fab387" },
  port: { glyph: "o", color: "#fab387" },
  "item def": { glyph: "I", color: "#94e2d5" },
  item: { glyph: "i", color: "#94e2d5" },
  "action def": { glyph: "F", color: "#cba6f7" },
  action: { glyph: "f", color: "#cba6f7" },
  "state def": { glyph: "S", color: "#f5c2e7" },
  state: { glyph: "s", color: "#f5c2e7" },
  transition: { glyph: "→", color: "#f5c2e7" },
  "requirement def": { glyph: "R", color: "#f38ba8" },
  requirement: { glyph: "r", color: "#f38ba8" },
  "constraint def": { glyph: "C", color: "#f38ba8" },
  constraint: { glyph: "c", color: "#f38ba8" },
  "interface def": { glyph: "X", color: "#fab387" },
  interface: { glyph: "x", color: "#fab387" },
  "connection def": { glyph: "K", color: "#74c7ec" },
  connection: { glyph: "k", color: "#74c7ec" },
  connect: { glyph: "—", color: "#74c7ec" },
  bind: { glyph: "=", color: "#74c7ec" },
  flow: { glyph: "⇢", color: "#74c7ec" },
  import: { glyph: "↧", color: "#6c7086" },
  alias: { glyph: "@", color: "#6c7086" },
  doc: { glyph: "“", color: "#6a9955" },
  comment: { glyph: "“", color: "#6a9955" },
  "enum def": { glyph: "E", color: "#a6e3a1" },
  perform: { glyph: "f", color: "#cba6f7" },
  exhibit: { glyph: "s", color: "#f5c2e7" },
  satisfy: { glyph: "r", color: "#f38ba8" },
  ref: { glyph: "·", color: "#9399b2" },
  unknown: { glyph: "?", color: "#6c7086" },
};

function icon(kind: string) {
  return KIND_ICONS[kind] ?? { glyph: "·", color: "#9399b2" };
}

function TreeNode({
  el,
  depth,
  selected,
  onSelect,
}: {
  el: SysMLElement;
  depth: number;
  selected?: SysMLElement;
  onSelect: (el: SysMLElement) => void;
}) {
  const [open, setOpen] = useState(depth < 3);
  const hasChildren = el.children.length > 0;
  const isSelected = selected === el;
  const { glyph, color } = icon(el.kind);

  const detail = [
    el.typedBy.length ? ": " + el.typedBy.join(", ") : "",
    el.specializes.length ? " :> " + el.specializes.join(", ") : "",
    el.multiplicity ?? "",
  ]
    .join("")
    .trim();

  return (
    <div>
      <div
        className={"tree-row" + (isSelected ? " selected" : "")}
        style={{ paddingLeft: depth * 14 + 6 }}
        onClick={() => onSelect(el)}
        title={`${el.kind}${el.doc ? "\n" + el.doc : ""}`}
      >
        <span
          className={"tree-caret" + (hasChildren ? "" : " hidden")}
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!open);
          }}
        >
          {open ? "▾" : "▸"}
        </span>
        <span className="tree-icon" style={{ backgroundColor: color + "33", color }}>
          {glyph}
        </span>
        <span className="tree-label">{elementLabel(el)}</span>
        {detail && <span className="tree-detail">{detail}</span>}
      </div>
      {open &&
        el.children.map((c, i) => (
          <TreeNode key={i} el={c} depth={depth + 1} selected={selected} onSelect={onSelect} />
        ))}
    </div>
  );
}

export function OutlineTree({ root, selected, onSelect }: Props) {
  if (!root.children.length) {
    return <div className="tree-empty">モデル要素がありません</div>;
  }
  return (
    <div className="outline-tree">
      {root.children.map((c, i) => (
        <TreeNode key={i} el={c} depth={0} selected={selected} onSelect={onSelect} />
      ))}
    </div>
  );
}
