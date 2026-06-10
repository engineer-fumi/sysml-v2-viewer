import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DiagramView } from "./components/DiagramView";
import { EditorPane, EditorSelection } from "./components/EditorPane";
import { OutlineTree } from "./components/OutlineTree";
import { parseSysML } from "./sysml/parser";
import { ParseError, SysMLElement, createElement, qualifiedName, walk } from "./sysml/ast";
import { DEFAULT_SAMPLE, SAMPLES, Sample } from "./samples";

interface WorkFile {
  id: number;
  name: string;
  source: string;
}

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

const SYSML_EXT = /\.(sysml|kerml)$/i;

/** Recursively collect .sysml files from a drag&drop item list. */
async function collectDroppedFiles(dt: DataTransfer): Promise<File[]> {
  const out: File[] = [];

  const readEntries = (reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> =>
    new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));

  const fileOf = (entry: FileSystemFileEntry): Promise<File | null> =>
    new Promise((resolve) => entry.file(resolve, () => resolve(null)));

  const visit = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      if (SYSML_EXT.test(entry.name)) {
        const f = await fileOf(entry as FileSystemFileEntry);
        if (f) out.push(f);
      }
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await readEntries(reader);
        if (!batch.length) break;
        for (const e of batch) await visit(e);
      }
    }
  };

  const entries = [...dt.items]
    .map((item) => item.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => !!e);

  if (entries.length) {
    for (const e of entries) await visit(e);
  } else {
    for (const f of [...dt.files]) {
      if (SYSML_EXT.test(f.name)) out.push(f);
    }
  }
  return out;
}

let nextFileId = 1;
function sampleToFiles(sample: Sample): WorkFile[] {
  return sample.files.map((f) => ({ id: nextFileId++, name: f.name, source: f.source }));
}

export default function App() {
  const [files, setFiles] = useState<WorkFile[]>(() => sampleToFiles(DEFAULT_SAMPLE));
  const [activeId, setActiveId] = useState<number>(() => files[0]?.id ?? 0);
  const [selected, setSelected] = useState<SysMLElement | undefined>(undefined);
  const [editorSelect, setEditorSelect] = useState<EditorSelection | undefined>(undefined);
  const [diagramRootKey, setDiagramRootKey] = useState<string>("");
  const selectSeq = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);

  // ---- resizable panes ----
  const DEFAULT_SIDEBAR_W = 290;
  const defaultEditorW = () => Math.max(420, Math.round(window.innerWidth * 0.34));
  const [sidebarW, setSidebarW] = useState(DEFAULT_SIDEBAR_W);
  const [editorW, setEditorW] = useState(defaultEditorW);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ which: 1 | 2; startX: number; startW: number } | null>(null);

  const startDrag = (which: 1 | 2) => (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { which, startX: e.clientX, startW: which === 1 ? sidebarW : editorW };
    setDragging(true);
  };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      if (d.which === 1) {
        const max = window.innerWidth - 700;
        setSidebarW(Math.min(Math.max(160, d.startW + dx), Math.max(160, max)));
      } else {
        const max = window.innerWidth - sidebarW - 340;
        setEditorW(Math.min(Math.max(280, d.startW + dx), Math.max(280, max)));
      }
    };
    const onUp = () => {
      dragRef.current = null;
      setDragging(false);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging, sidebarW]);

  // ---- parsing: each file separately, combined into one model ----
  const parsedFiles = useMemo(
    () => files.map((f) => ({ file: f, result: parseSysML(f.source) })),
    [files]
  );

  const combinedRoot = useMemo(() => {
    const root = createElement("namespace");
    for (const pf of parsedFiles) {
      const fileEl = pf.result.root;
      fileEl.kind = "file";
      fileEl.name = pf.file.name;
      fileEl.parent = root;
      walk(fileEl, (el) => {
        el.fileId = pf.file.id;
      });
      root.children.push(fileEl);
    }
    return root;
  }, [parsedFiles]);

  const activeFile = files.find((f) => f.id === activeId) ?? files[0];
  const activeParsed = parsedFiles.find((pf) => pf.file.id === activeFile?.id);

  const allErrors = useMemo(() => {
    const out: { file: WorkFile; error: ParseError }[] = [];
    for (const pf of parsedFiles) {
      for (const error of pf.result.errors) out.push({ file: pf.file, error });
    }
    return out;
  }, [parsedFiles]);

  const names = useMemo(() => {
    const set = new Set<string>();
    walk(combinedRoot, (el) => {
      if (el.name && el.kind !== "file") set.add(el.name);
    });
    return [...set];
  }, [combinedRoot]);

  const rootCandidates = useMemo(() => diagramRootCandidates(combinedRoot), [combinedRoot]);
  const candidateKey = (el: SysMLElement) => `${el.fileId}:${qualifiedName(el)}`;

  const diagramRoot = useMemo(() => {
    if (diagramRootKey) {
      const found = rootCandidates.find((el) => candidateKey(el) === diagramRootKey);
      if (found) return found;
    }
    return combinedRoot;
  }, [combinedRoot, rootCandidates, diagramRootKey]);

  // ---- selection ----
  const handleSelect = useCallback((el: SysMLElement) => {
    setSelected(el);
    if (el.kind === "file") {
      if (el.fileId !== undefined) setActiveId(el.fileId);
      return;
    }
    if (el.fileId !== undefined) setActiveId(el.fileId);
    const start = el.nameStart ?? el.start;
    const end = el.nameEnd ?? Math.min(el.end, el.start + 1);
    selectSeq.current++;
    setEditorSelect({ start, end, seq: selectSeq.current });
  }, []);

  const handleCursor = useCallback(
    (offset: number) => {
      const fileRoot = activeParsed?.result.root;
      if (fileRoot) setSelected(elementAt(fileRoot, offset));
    },
    [activeParsed]
  );

  const handleChange = useCallback(
    (value: string) => {
      setFiles((fs) =>
        fs.map((f) => (f.id === activeId && f.source !== value ? { ...f, source: value } : f))
      );
    },
    [activeId]
  );

  // ---- workspace operations ----
  const filesRef = useRef(files);
  filesRef.current = files;

  const addOrUpdateFiles = useCallback(async (incoming: File[], replace = false) => {
    if (!incoming.length) return;
    const loaded = await Promise.all(
      incoming.map(async (f) => ({ name: f.name, source: await f.text() }))
    );
    const base = replace ? [] : filesRef.current.map((f) => ({ ...f }));
    for (const l of loaded) {
      const existing = base.find((f) => f.name === l.name);
      if (existing) existing.source = l.source;
      else base.push({ id: nextFileId++, name: l.name, source: l.source });
    }
    if (!base.length) return;
    setFiles(base);
    setActiveId(base[base.length - 1].id);
    setSelected(undefined);
    setDiagramRootKey("");
  }, []);

  const newFile = () => {
    const n = files.filter((f) => f.name.startsWith("untitled")).length + 1;
    const file: WorkFile = {
      id: nextFileId++,
      name: `untitled-${n}.sysml`,
      source: "package NewModel {\n    \n}\n",
    };
    setFiles((fs) => [...fs, file]);
    setActiveId(file.id);
  };

  const closeFile = (id: number) => {
    const fs = filesRef.current;
    const idx = fs.findIndex((f) => f.id === id);
    let next = fs.filter((f) => f.id !== id);
    if (!next.length) {
      next = [{ id: nextFileId++, name: "untitled-1.sysml", source: "" }];
    }
    setFiles(next);
    if (!next.some((f) => f.id === activeId)) {
      setActiveId(next[Math.min(Math.max(0, idx - 1), next.length - 1)].id);
    }
    setSelected(undefined);
  };

  const saveFile = () => {
    if (!activeFile) return;
    const blob = new Blob([activeFile.source], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = activeFile.name;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const loadSample = (idx: number) => {
    const s = SAMPLES[idx];
    if (!s) return;
    const fs = sampleToFiles(s);
    setFiles(fs);
    setActiveId(fs[0].id);
    setSelected(undefined);
    setDiagramRootKey("");
  };

  const activeErrors = activeParsed?.result.errors ?? [];

  return (
    <div
      className="app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        collectDroppedFiles(e.dataTransfer).then((fs) => addOrUpdateFiles(fs));
      }}
    >
      <header className="toolbar">
        <span className="logo">⬡ SysML v2 Viewer</span>
        <button onClick={newFile}>新規</button>
        <button onClick={() => fileInputRef.current?.click()}>ファイルを開く…</button>
        <button onClick={() => dirInputRef.current?.click()}>フォルダを開く…</button>
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
        <span className="file-name">{files.length} ファイル</span>
        <span className={"parse-status" + (allErrors.length ? " has-errors" : "")}>
          {allErrors.length ? `⚠ ${allErrors.length} 件のエラー` : "✓ 構文OK"}
        </span>
        <input
          ref={fileInputRef}
          type="file"
          accept=".sysml,.kerml,.txt"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            addOrUpdateFiles([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <input
          ref={dirInputRef}
          type="file"
          // @ts-expect-error non-standard but widely supported
          webkitdirectory=""
          style={{ display: "none" }}
          onChange={(e) => {
            const fs = [...(e.target.files ?? [])].filter((f) => SYSML_EXT.test(f.name));
            addOrUpdateFiles(fs, /*replace*/ true);
            e.target.value = "";
          }}
        />
      </header>

      <div className={"main" + (dragging ? " dragging" : "")}>
        <aside className="sidebar" style={{ width: sidebarW }}>
          <div className="panel-title">モデルツリー</div>
          <div className="sidebar-tree">
            <OutlineTree root={combinedRoot} selected={selected} onSelect={handleSelect} />
          </div>
          {allErrors.length > 0 && (
            <div className="error-panel">
              <div className="panel-title">問題 ({allErrors.length})</div>
              <div className="error-list">
                {allErrors.slice(0, 50).map(({ file, error }, i) => {
                  const { line, col } = offsetToLineCol(file.source, error.start);
                  return (
                    <div
                      key={i}
                      className="error-row"
                      onClick={() => {
                        setActiveId(file.id);
                        selectSeq.current++;
                        setEditorSelect({ start: error.start, end: error.end, seq: selectSeq.current });
                      }}
                    >
                      <span className="error-pos">
                        {file.name} {line}:{col}
                      </span>{" "}
                      {error.message}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </aside>

        <div
          className="splitter"
          onMouseDown={startDrag(1)}
          onDoubleClick={() => setSidebarW(DEFAULT_SIDEBAR_W)}
          title="ドラッグでリサイズ / ダブルクリックでリセット"
        />

        <section className="editor-section" style={{ width: editorW }}>
          <div className="file-tabs">
            {files.map((f) => {
              const errCount = parsedFiles.find((pf) => pf.file.id === f.id)?.result.errors.length ?? 0;
              return (
                <div
                  key={f.id}
                  className={"file-tab" + (f.id === activeFile?.id ? " active" : "")}
                  onClick={() => setActiveId(f.id)}
                  title={f.name}
                >
                  <span className="file-tab-name">
                    {f.name}
                    {errCount > 0 && <span className="file-tab-err"> ●</span>}
                  </span>
                  <span
                    className="file-tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeFile(f.id);
                    }}
                    title="閉じる"
                  >
                    ×
                  </span>
                </div>
              );
            })}
            <button className="file-tab-new" onClick={newFile} title="新規ファイル">
              +
            </button>
          </div>
          {activeFile && (
            <EditorPane
              fileId={activeFile.id}
              value={activeFile.source}
              onChange={handleChange}
              errors={activeErrors}
              names={names}
              select={editorSelect}
              onCursor={handleCursor}
            />
          )}
        </section>

        <div
          className="splitter"
          onMouseDown={startDrag(2)}
          onDoubleClick={() => setEditorW(defaultEditorW())}
          title="ドラッグでリサイズ / ダブルクリックでリセット"
        />

        <section className="diagram-section">
          <div className="panel-title diagram-title">
            ダイアグラム (Visualization)
            <select
              className="root-select"
              value={diagramRoot === combinedRoot ? "" : candidateKey(diagramRoot)}
              onChange={(e) => setDiagramRootKey(e.target.value)}
            >
              <option value="">モデル全体 (全ファイル)</option>
              {rootCandidates.map((el, i) => (
                <option key={i} value={candidateKey(el)}>
                  {qualifiedName(el)} ({el.kind})
                </option>
              ))}
            </select>
          </div>
          <DiagramView root={diagramRoot} selected={selected} onSelect={handleSelect} />
        </section>
      </div>

      <footer className="statusbar">
        <span>SysML v2 textual notation (subset) — 複数ファイルの import を横断して可視化</span>
        <span className="spacer" />
        <span>ファイル / フォルダをドラッグ&ドロップで読み込み可能</span>
      </footer>
    </div>
  );
}
