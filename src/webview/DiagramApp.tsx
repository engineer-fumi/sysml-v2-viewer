import { useEffect, useMemo, useState } from "react";
import { SysMLElement, createElement, qualifiedName, walk } from "../core/ast";
import { SerializedModelFile, restoreParents } from "../core/serialize";
import { DiagramView } from "./DiagramView";

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

interface ModelMessage {
  type: "model";
  files: SerializedModelFile[];
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

export function DiagramApp() {
  const [files, setFiles] = useState<SerializedModelFile[]>([]);
  const [rootKey, setRootKey] = useState<string>("");
  const [selected, setSelected] = useState<SysMLElement | undefined>(undefined);

  // combined model from all files
  const combinedRoot = useMemo(() => {
    const root = createElement("namespace");
    for (const f of files) {
      const ast = restoreParents(f.ast);
      ast.kind = "file";
      ast.name = f.name;
      ast.parent = root;
      root.children.push(ast);
    }
    return root;
  }, [files]);

  const rootCandidates = useMemo(() => diagramRootCandidates(combinedRoot), [combinedRoot]);
  const candidateKey = (el: SysMLElement) => `${el.fileId}:${qualifiedName(el)}`;

  const diagramRoot = useMemo(() => {
    if (rootKey) {
      const found = rootCandidates.find((el) => candidateKey(el) === rootKey);
      if (found) return found;
    }
    return combinedRoot;
  }, [combinedRoot, rootCandidates, rootKey]);

  const [pendingHighlight, setPendingHighlight] = useState<
    { fileId: number; offset: number } | undefined
  >(undefined);

  useEffect(() => {
    const onMessage = (e: MessageEvent<FromExtension>) => {
      const msg = e.data;
      if (msg.type === "model") {
        setFiles(msg.files);
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

  const handleSelect = (el: SysMLElement) => {
    setSelected(el);
    if (el.fileId === undefined || el.kind === "file") return;
    vscode.postMessage({
      type: "select",
      fileId: el.fileId,
      start: el.nameStart ?? el.start,
      end: el.nameEnd ?? Math.min(el.end, el.start + 1),
    });
  };

  return (
    <div className="app">
      <div className="header">
        <span className="title">SysML ダイアグラム</span>
        <select
          className="root-select"
          value={diagramRoot === combinedRoot ? "" : candidateKey(diagramRoot)}
          onChange={(e) => setRootKey(e.target.value)}
        >
          <option value="">モデル全体 (全ファイル)</option>
          {rootCandidates.map((el, i) => (
            <option key={i} value={candidateKey(el)}>
              {qualifiedName(el)} ({el.kind})
            </option>
          ))}
        </select>
        <span className="file-count">{files.length} ファイル</span>
      </div>
      <DiagramView root={diagramRoot} selected={selected} onSelect={handleSelect} />
    </div>
  );
}
