import { useCallback, useMemo, useRef, useState } from "react";
import { DiagramView } from "./components/DiagramView";
import { EditorPane, EditorSelection } from "./components/EditorPane";
import { OutlineTree } from "./components/OutlineTree";
import { parseSysML } from "./sysml/parser";
import { SysMLElement, qualifiedName, walk } from "./sysml/ast";
import { DEFAULT_SOURCE, SAMPLES } from "./samples";

function offsetToLineCol(src: string, offset: number): { line: number; col: number } {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src[i] === "\n") {
      line++;
      col = 1;
    } else col++;
  }
  return { line, col };
}

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

/** elements that make sense as a diagram root */
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

export default function App() {
  const [source, setSource] = useState(DEFAULT_SOURCE);
  const [fileName, setFileName] = useState("Vehicle.sysml");
  const [selected, setSelected] = useState<SysMLElement | undefined>(undefined);
  const [editorSelect, setEditorSelect] = useState<EditorSelection | undefined>(undefined);
  const [diagramRootName, setDiagramRootName] = useState<string>("");
  const selectSeq = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const parsed = useMemo(() => parseSysML(source), [source]);

  const names = useMemo(() => {
    const set = new Set<string>();
    walk(parsed.root, (el) => {
      if (el.name) set.add(el.name);
    });
    return [...set];
  }, [parsed]);

  const rootCandidates = useMemo(() => diagramRootCandidates(parsed.root), [parsed]);

  const diagramRoot = useMemo(() => {
    if (diagramRootName) {
      const found = rootCandidates.find((el) => qualifiedName(el) === diagramRootName);
      if (found) return found;
    }
    return parsed.root;
  }, [parsed, rootCandidates, diagramRootName]);

  const handleSelect = useCallback((el: SysMLElement) => {
    setSelected(el);
    const start = el.nameStart ?? el.start;
    const end = el.nameEnd ?? Math.min(el.end, el.start + 1);
    selectSeq.current++;
    setEditorSelect({ start, end, seq: selectSeq.current });
  }, []);

  const handleCursor = useCallback(
    (offset: number) => {
      setSelected(elementAt(parsed.root, offset));
    },
    [parsed]
  );

  const openFile = (file: File) => {
    file.text().then((text) => {
      setSource(text);
      setFileName(file.name);
      setSelected(undefined);
      setDiagramRootName("");
    });
  };

  const saveFile = () => {
    const blob = new Blob([source], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fileName || "model.sysml";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const newFile = () => {
    setSource("package NewModel {\n    \n}\n");
    setFileName("NewModel.sysml");
    setSelected(undefined);
    setDiagramRootName("");
  };

  const loadSample = (idx: number) => {
    const s = SAMPLES[idx];
    if (!s) return;
    setSource(s.source);
    setFileName(s.name.split(" ")[0] + ".sysml");
    setSelected(undefined);
    setDiagramRootName("");
  };

  return (
    <div
      className="app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files[0];
        if (f) openFile(f);
      }}
    >
      <header className="toolbar">
        <span className="logo">⬡ SysML v2 Viewer</span>
        <button onClick={newFile}>新規</button>
        <button onClick={() => fileInputRef.current?.click()}>開く…</button>
        <button onClick={saveFile}>保存 (.sysml)</button>
        <select
          value=""
          onChange={(e) => {
            if (e.target.value !== "") loadSample(Number(e.target.value));
          }}
        >
          <option value="">サンプルを読み込む…</option>
          {SAMPLES.map((s, i) => (
            <option key={i} value={i}>
              {s.name}
            </option>
          ))}
        </select>
        <span className="file-name">{fileName}</span>
        <span className={"parse-status" + (parsed.errors.length ? " has-errors" : "")}>
          {parsed.errors.length ? `⚠ ${parsed.errors.length} 件のエラー` : "✓ 構文OK"}
        </span>
        <input
          ref={fileInputRef}
          type="file"
          accept=".sysml,.kerml,.txt"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) openFile(f);
            e.target.value = "";
          }}
        />
      </header>

      <div className="main">
        <aside className="sidebar">
          <div className="panel-title">モデルツリー</div>
          <div className="sidebar-tree">
            <OutlineTree root={parsed.root} selected={selected} onSelect={handleSelect} />
          </div>
          {parsed.errors.length > 0 && (
            <div className="error-panel">
              <div className="panel-title">問題 ({parsed.errors.length})</div>
              <div className="error-list">
                {parsed.errors.slice(0, 50).map((err, i) => {
                  const { line, col } = offsetToLineCol(source, err.start);
                  return (
                    <div
                      key={i}
                      className="error-row"
                      onClick={() => {
                        selectSeq.current++;
                        setEditorSelect({ start: err.start, end: err.end, seq: selectSeq.current });
                      }}
                    >
                      <span className="error-pos">{line}:{col}</span> {err.message}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </aside>

        <section className="editor-section">
          <div className="panel-title">
            テキスト (Authoring)
          </div>
          <EditorPane
            value={source}
            onChange={setSource}
            errors={parsed.errors}
            names={names}
            select={editorSelect}
            onCursor={handleCursor}
          />
        </section>

        <section className="diagram-section">
          <div className="panel-title diagram-title">
            ダイアグラム (Visualization)
            <select
              className="root-select"
              value={diagramRoot === parsed.root ? "" : qualifiedName(diagramRoot)}
              onChange={(e) => setDiagramRootName(e.target.value)}
            >
              <option value="">モデル全体</option>
              {rootCandidates.map((el, i) => (
                <option key={i} value={qualifiedName(el)}>
                  {" ".repeat(0)}{qualifiedName(el)} ({el.kind})
                </option>
              ))}
            </select>
          </div>
          <DiagramView root={diagramRoot} selected={selected} onSelect={handleSelect} />
        </section>
      </div>

      <footer className="statusbar">
        <span>SysML v2 textual notation (subset) — packages, parts, ports, connections, flows, states, requirements</span>
        <span className="spacer" />
        <span>ファイルをドラッグ&ドロップで読み込み可能</span>
      </footer>
    </div>
  );
}
