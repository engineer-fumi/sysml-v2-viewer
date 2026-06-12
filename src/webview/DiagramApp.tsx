import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SysMLElement, createElement, qualifiedName, walk } from "../core/ast";
import { DIAGRAM_KINDS, DiagramKind, EdgeStyle, LayoutOffsets, PortSide } from "../core/layout";
import { SerializedModelFile, restoreParents } from "../core/serialize";
import { DiagramView, EditMode } from "./DiagramView";

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

type Layouts = Record<string, LayoutOffsets>;

interface ModelMessage {
  type: "model";
  files: SerializedModelFile[];
  layouts?: Layouts;
  /** initial diagram kind (sent only with the first model message) */
  kind?: DiagramKind;
}

interface HighlightMessage {
  type: "highlight";
  fileId: number;
  offset: number;
}

type FromExtension = ModelMessage | HighlightMessage;

/** deepest element whose range contains the offset */
function elementAt(root: SysMLElement, offset: number): SysMLElement | undefined {
  let best: SysMLElement | undefined;
  walk(root, (el) => {
    if (el === root) return;
    if (el.start <= offset && offset <= el.end) {
      if (!best || el.end - el.start <= best.end - best.start) best = el;
    }
  });
  return best;
}

function diagramRootCandidates(root: SysMLElement): SysMLElement[] {
  const out: SysMLElement[] = [];
  walk(root, (el) => {
    if (el === root) return;
    if (
      (el.kind === "package" || el.kind === "library package" || el.kind === "namespace" ||
        el.kind === "part" || el.kind === "part def" ||
        el.kind === "action def" || el.kind === "state def" ||
        el.kind === "use case def") &&
      el.name &&
      el.children.length > 0
    ) {
      out.push(el);
    }
  });
  return out;
}

function ancestorsOf(el: SysMLElement): SysMLElement[] {
  const out: SysMLElement[] = [];
  let cur = el.parent;
  while (cur) {
    out.push(cur);
    cur = cur.parent;
  }
  return out;
}

/** dotted path from `scope` (exclusive) down to `el` */
function pathFrom(scope: SysMLElement, el: SysMLElement): string {
  const parts: string[] = [];
  let cur: SysMLElement | undefined = el;
  while (cur && cur !== scope) {
    if (cur.name) parts.unshift(cur.name);
    cur = cur.parent;
  }
  return parts.join(".");
}

const ADD_USAGE_KINDS = ["part", "port", "attribute", "item", "action", "state", "requirement", "constraint"];
const ADD_DEF_KINDS = [
  "package", "part def", "port def", "attribute def", "item def",
  "action def", "state def", "requirement def", "enum def", "use case def",
];

export function DiagramApp() {
  const [files, setFiles] = useState<SerializedModelFile[]>([]);
  const [layouts, setLayouts] = useState<Layouts>({});
  const [rootKey, setRootKey] = useState<string>("");
  const [kind, setKind] = useState<DiagramKind>("general");
  const kindInitialized = useRef(false);
  const [selected, setSelected] = useState<SysMLElement | undefined>(undefined);
  const [mode, setMode] = useState<EditMode>("select");
  const [connectSource, setConnectSource] = useState<SysMLElement | undefined>(undefined);
  const [pendingHighlight, setPendingHighlight] = useState<
    { fileId: number; offset: number } | undefined
  >(undefined);

  // combined model from all files
  const { combinedRoot, fileNameById } = useMemo(() => {
    const root = createElement("namespace");
    const names = new Map<number, string>();
    for (const f of files) {
      const ast = restoreParents(f.ast);
      ast.kind = "file";
      ast.name = f.name;
      ast.parent = root;
      root.children.push(ast);
      if (ast.fileId !== undefined) names.set(ast.fileId, f.name);
    }
    return { combinedRoot: root, fileNameById: names };
  }, [files]);

  /** stable element key: fileName#qualifiedName (survives reloads) */
  const keyOf = useCallback(
    (el: SysMLElement) =>
      `${el.fileId !== undefined ? fileNameById.get(el.fileId) ?? el.fileId : ""}#${qualifiedName(el)}`,
    [fileNameById]
  );

  const rootCandidates = useMemo(() => diagramRootCandidates(combinedRoot), [combinedRoot]);

  const diagramRoot = useMemo(() => {
    if (rootKey) {
      const found = rootCandidates.find((el) => keyOf(el) === rootKey);
      if (found) return found;
    }
    return combinedRoot;
  }, [combinedRoot, rootCandidates, rootKey, keyOf]);

  // manual layouts are stored per (diagram kind, root); the general view keeps
  // the plain rootKey for backward compatibility with existing sidecar files
  const layoutKey = kind === "general" ? rootKey : `${kind}|${rootKey}`;
  const offsets = layouts[layoutKey] ?? {};

  useEffect(() => {
    const onMessage = (e: MessageEvent<FromExtension>) => {
      const msg = e.data;
      if (msg.type === "model") {
        setFiles(msg.files);
        if (msg.layouts) setLayouts(msg.layouts);
        if (msg.kind && !kindInitialized.current) {
          kindInitialized.current = true;
          setKind(msg.kind);
        }
      } else if (msg.type === "highlight") {
        setPendingHighlight({ fileId: msg.fileId, offset: msg.offset });
      }
    };
    window.addEventListener("message", onMessage);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (!pendingHighlight) return;
    const fileEl = combinedRoot.children.find((c) => c.fileId === pendingHighlight.fileId);
    if (fileEl) {
      const el = elementAt(fileEl, pendingHighlight.offset);
      if (el) setSelected(el);
    }
    setPendingHighlight(undefined);
  }, [pendingHighlight, combinedRoot]);

  // ESC resets the edit mode; Delete removes the selected element
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMode("select");
        setConnectSource(undefined);
      }
      if (e.key === "Delete" && selected && selected.kind !== "file" && selected.fileId !== undefined) {
        vscode.postMessage({
          type: "edit",
          action: "delete",
          fileId: selected.fileId,
          start: selected.start,
          end: selected.end,
          label: selected.name ?? selected.kind,
        });
        setSelected(undefined);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  // ---- element interactions ------------------------------------------------

  const requestConnect = (src: SysMLElement, tgt: SysMLElement) => {
    if (src === tgt || src.fileId === undefined || tgt.fileId === undefined) return;
    const srcAncestors = new Set<SysMLElement>(ancestorsOf(src));
    let scope: SysMLElement | undefined;
    for (let cur = tgt.parent; cur; cur = cur.parent) {
      if (srcAncestors.has(cur)) {
        scope = cur;
        break;
      }
    }
    if (!scope || scope === combinedRoot) {
      // different files: insert at the end of the source file, qualified target
      const fileEl = combinedRoot.children.find((c) => c.fileId === src.fileId);
      if (!fileEl) return;
      vscode.postMessage({
        type: "edit",
        action: "addConnect",
        fileId: src.fileId,
        scopeStart: -1,
        source: qualifiedName(src),
        target: qualifiedName(tgt),
      });
      return;
    }
    const insertAtFile = scope.kind === "file";
    vscode.postMessage({
      type: "edit",
      action: "addConnect",
      fileId: scope.fileId ?? src.fileId,
      scopeStart: insertAtFile ? -1 : scope.start,
      source: pathFrom(scope, src),
      target: pathFrom(scope, tgt),
    });
  };

  const handleElementClick = (el: SysMLElement) => {
    if (mode === "connect") {
      if (!connectSource) {
        setConnectSource(el);
        setSelected(el);
      } else {
        requestConnect(connectSource, el);
        setConnectSource(undefined);
        setMode("select");
      }
      return;
    }
    if (mode.startsWith("add:")) {
      const kind = mode.slice(4);
      if (el.fileId !== undefined) {
        vscode.postMessage({
          type: "edit",
          action: "addElement",
          kind,
          fileId: el.fileId,
          containerStart: el.kind === "file" ? -1 : el.start,
        });
      }
      setMode("select");
      return;
    }
    // select mode: sync to editor
    setSelected(el);
    if (el.fileId === undefined || el.kind === "file") return;
    vscode.postMessage({
      type: "select",
      fileId: el.fileId,
      start: el.nameStart ?? el.start,
      end: el.nameEnd ?? Math.min(el.end, el.start + 1),
    });
  };

  const handleElementDoubleClick = (el: SysMLElement) => {
    if (el.fileId === undefined || el.nameStart === undefined || !el.name) return;
    vscode.postMessage({
      type: "edit",
      action: "rename",
      fileId: el.fileId,
      nameStart: el.nameStart,
      nameEnd: el.nameEnd ?? el.nameStart + el.name.length,
      oldName: el.name,
    });
  };

  /** add-mode click on the empty canvas: insert at the diagram root scope */
  const handleBackgroundClick = () => {
    if (!mode.startsWith("add:")) return;
    const kind = mode.slice(4);
    if (diagramRoot === combinedRoot) {
      // no specific root: let the extension ask which file to extend
      vscode.postMessage({ type: "edit", action: "addElement", kind, fileId: -1, containerStart: -1 });
    } else if (diagramRoot.kind === "file") {
      vscode.postMessage({
        type: "edit",
        action: "addElement",
        kind,
        fileId: diagramRoot.fileId ?? -1,
        containerStart: -1,
      });
    } else if (diagramRoot.fileId !== undefined) {
      vscode.postMessage({
        type: "edit",
        action: "addElement",
        kind,
        fileId: diagramRoot.fileId,
        containerStart: diagramRoot.start,
      });
    }
    setMode("select");
  };

  const handleMoveBox = (key: string, ddx: number, ddy: number) => {
    const cur = offsets[key] ?? { dx: 0, dy: 0 };
    const next = { ...offsets, [key]: { ...cur, dx: cur.dx + ddx, dy: cur.dy + ddy } };
    setLayouts((prev) => ({ ...prev, [layoutKey]: next }));
    vscode.postMessage({ type: "saveLayout", rootKey: layoutKey, offsets: next });
  };

  const handleResizeBox = (key: string, ddw: number, ddh: number, fromTop: boolean) => {
    const cur = offsets[key] ?? { dx: 0, dy: 0 };
    const dw = Math.max(0, (cur.dw ?? 0) + ddw);
    // resizing from the top grows the upper edge: the box shifts up by the
    // height actually gained (height never shrinks below the content)
    const dh = Math.max(0, (cur.dh ?? 0) + (fromTop ? -ddh : ddh));
    const dy = fromTop ? cur.dy - (dh - (cur.dh ?? 0)) : cur.dy;
    const next = { ...offsets, [key]: { ...cur, dy, dw, dh } };
    setLayouts((prev) => ({ ...prev, [layoutKey]: next }));
    vscode.postMessage({ type: "saveLayout", rootKey: layoutKey, offsets: next });
  };

  const resetLayout = () => {
    setLayouts((prev) => ({ ...prev, [layoutKey]: {} }));
    vscode.postMessage({ type: "saveLayout", rootKey: layoutKey, offsets: {} });
  };

  const handleMovePort = (key: string, side: PortSide, t: number) => {
    const next = { ...offsets, [key]: { dx: 0, dy: 0, side, t } };
    setLayouts((prev) => ({ ...prev, [layoutKey]: next }));
    vscode.postMessage({ type: "saveLayout", rootKey: layoutKey, offsets: next });
  };

  const handleRouteEdge = (key: string, points: { x: number; y: number }[]) => {
    const cur = offsets[key];
    const next = { ...offsets };
    if (points.length) {
      next[key] = {
        ...(cur ?? { dx: 0, dy: 0 }),
        wp: points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })),
        rel: true, // relative to the endpoint boxes (follows box moves)
      };
    } else if (cur?.style && cur.style !== "straight") {
      // keep the line-style override even when the waypoints are cleared
      next[key] = { dx: 0, dy: 0, style: cur.style };
    } else {
      delete next[key];
    }
    setLayouts((prev) => ({ ...prev, [layoutKey]: next }));
    vscode.postMessage({ type: "saveLayout", rootKey: layoutKey, offsets: next });
  };

  const handleEdgeStyle = (key: string, style: EdgeStyle) => {
    const cur = offsets[key] ?? { dx: 0, dy: 0 };
    const next = { ...offsets };
    if (style === "straight" && !cur.wp?.length) {
      delete next[key]; // straight without waypoints is the default
    } else {
      next[key] = { ...cur, style: style === "straight" ? undefined : style };
    }
    setLayouts((prev) => ({ ...prev, [layoutKey]: next }));
    vscode.postMessage({ type: "saveLayout", rootKey: layoutKey, offsets: next });
  };

  const changeKind = (k: DiagramKind) => {
    kindInitialized.current = true;
    setKind(k);
    vscode.postMessage({ type: "kindChanged", kind: k });
  };

  const modeButton = (m: EditMode, label: string, title: string) => (
    <button
      className={mode === m ? "mode-btn active" : "mode-btn"}
      onClick={() => {
        setMode(mode === m ? "select" : m);
        setConnectSource(undefined);
      }}
      title={title}
    >
      {label}
    </button>
  );

  return (
    <div className="app">
      <div className="header">
        <span className="title">SysML ダイアグラム</span>
        <select
          className="root-select kind-select"
          value={kind}
          onChange={(e) => changeKind(e.target.value as DiagramKind)}
          title="図の種類"
        >
          {DIAGRAM_KINDS.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
        <select
          className="root-select"
          value={diagramRoot === combinedRoot ? "" : keyOf(diagramRoot)}
          onChange={(e) => setRootKey(e.target.value)}
        >
          <option value="">モデル全体 (全ファイル)</option>
          {rootCandidates.map((el, i) => (
            <option key={i} value={keyOf(el)}>
              {qualifiedName(el)} ({el.kind})
            </option>
          ))}
        </select>
        <span className="file-count">{files.length} ファイル</span>
      </div>
      <div className="edit-toolbar">
        {modeButton("select", "⬚ 選択", "クリックで選択、名前付きブロックはドラッグで配置変更")}
        {modeButton("connect", "⌁ 接続", "2 つの要素を順にクリックして connect 文を挿入")}
        <select
          className="add-select"
          value={mode.startsWith("add:") ? mode.slice(4) : ""}
          onChange={(e) => {
            setConnectSource(undefined);
            setMode(e.target.value ? (`add:${e.target.value}` as EditMode) : "select");
          }}
          title="追加する要素の種類を選び、追加先 (コンテナ or 空白=図ルート) をクリック"
        >
          <option value="">+ 追加…</option>
          <optgroup label="使用 (usage)">
            {ADD_USAGE_KINDS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </optgroup>
          <optgroup label="定義 (def)">
            {ADD_DEF_KINDS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </optgroup>
        </select>
        <button className="mode-btn" onClick={resetLayout} title="この図の手動配置をリセット">
          ⟲ 配置リセット
        </button>
        <span className="mode-hint">
          {mode === "connect"
            ? connectSource
              ? `接続元: ${connectSource.name ?? connectSource.kind} → 接続先をクリック`
              : "接続元をクリック"
            : mode.startsWith("add:")
              ? `${mode.slice(4)} の追加先をクリック — コンテナ or 空白 (図ルートへ) / Esc で取消`
              : "ドラッグで配置変更 (port は辺に沿って / 線は中継点を追加) / 右下・右上ハンドルでサイズ変更 / ダブルクリックでリネーム (中継点は削除) / Delete で削除"}
        </span>
      </div>
      <DiagramView
        root={diagramRoot}
        kind={kind}
        selected={selected}
        marked={connectSource}
        mode={mode}
        offsets={offsets}
        keyOf={keyOf}
        onElementClick={handleElementClick}
        onElementDoubleClick={handleElementDoubleClick}
        onMoveBox={handleMoveBox}
        onResizeBox={handleResizeBox}
        onMovePort={handleMovePort}
        onRouteEdge={handleRouteEdge}
        onEdgeStyle={handleEdgeStyle}
        onBackgroundClick={handleBackgroundClick}
      />
    </div>
  );
}
