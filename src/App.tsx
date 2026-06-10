import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DiagramView } from "./components/DiagramView";
import { EditorPane, EditorSelection } from "./components/EditorPane";
import { OutlineTree } from "./components/OutlineTree";
import { RemoteFile, SshDialog } from "./components/SshDialog";
import {
  LoadedFile,
  SYSML_EXT,
  downloadFile,
  filesFromDrop,
  pickDirectory,
  pickFiles,
  writeToHandle,
} from "./fsAccess";
import { SshSession, sshDisconnect, sshWrite } from "./remote/sshClient";
import { parseSysML } from "./sysml/parser";
import { ParseError, SysMLElement, createElement, qualifiedName, walk } from "./sysml/ast";
import { DEFAULT_SAMPLE, SAMPLES, Sample } from "./samples";

interface WorkFile {
  id: number;
  name: string;
  source: string;
  dirty: boolean;
  /** writable handle when opened via the File System Access API */
  handle?: FileSystemFileHandle;
  /** absolute path on the SSH host when loaded remotely */
  remotePath?: string;
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

let nextFileId = 1;
function sampleToFiles(sample: Sample): WorkFile[] {
  return sample.files.map((f) => ({
    id: nextFileId++,
    name: f.name,
    source: f.source,
    dirty: false,
  }));
}

export default function App() {
  const [files, setFiles] = useState<WorkFile[]>(() => sampleToFiles(DEFAULT_SAMPLE));
  const [activeId, setActiveId] = useState<number>(() => files[0]?.id ?? 0);
  const [selected, setSelected] = useState<SysMLElement | undefined>(undefined);
  const [editorSelect, setEditorSelect] = useState<EditorSelection | undefined>(undefined);
  const [diagramRootKey, setDiagramRootKey] = useState<string>("");
  const [sshSession, setSshSession] = useState<SshSession | undefined>(undefined);
  const [sshDialogOpen, setSshDialogOpen] = useState(false);
  const [toast, setToast] = useState("");
  const selectSeq = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 3000);
  }, []);

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
    if (el.fileId !== undefined) setActiveId(el.fileId);
    if (el.kind === "file") return;
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
        fs.map((f) =>
          f.id === activeId && f.source !== value ? { ...f, source: value, dirty: true } : f
        )
      );
    },
    [activeId]
  );

  // ---- workspace operations ----
  const filesRef = useRef(files);
  filesRef.current = files;

  const addLoadedFiles = useCallback((loaded: LoadedFile[], replace = false) => {
    if (!loaded.length) return;
    const base = replace ? [] : filesRef.current.map((f) => ({ ...f }));
    for (const l of loaded) {
      const existing = base.find((f) => f.name === l.name);
      if (existing) {
        existing.source = l.source;
        existing.handle = l.handle;
        existing.dirty = false;
        existing.remotePath = undefined;
      } else {
        base.push({
          id: nextFileId++,
          name: l.name,
          source: l.source,
          dirty: false,
          handle: l.handle,
        });
      }
    }
    setFiles(base);
    setActiveId(base[base.length - 1].id);
    setSelected(undefined);
    setDiagramRootKey("");
  }, []);

  const openFiles = async () => {
    const picked = await pickFiles().catch((e) => {
      showToast("読み込みに失敗: " + (e as Error).message);
      return [];
    });
    if (picked === null) {
      fileInputRef.current?.click(); // no FS Access API – fall back
      return;
    }
    addLoadedFiles(picked);
  };

  const openDirectory = async () => {
    const picked = await pickDirectory().catch((e) => {
      showToast("読み込みに失敗: " + (e as Error).message);
      return [];
    });
    if (picked === null) {
      dirInputRef.current?.click(); // no FS Access API – fall back
      return;
    }
    if (picked.length) addLoadedFiles(picked, /*replace*/ true);
    else showToast(".sysml ファイルが見つかりませんでした");
  };

  const newFile = () => {
    const n = files.filter((f) => f.name.startsWith("untitled")).length + 1;
    const file: WorkFile = {
      id: nextFileId++,
      name: `untitled-${n}.sysml`,
      source: "package NewModel {\n    \n}\n",
      dirty: true,
    };
    setFiles((fs) => [...fs, file]);
    setActiveId(file.id);
  };

  const closeFile = (id: number) => {
    const fs = filesRef.current;
    const target = fs.find((f) => f.id === id);
    if (target?.dirty && !window.confirm(`${target.name} は未保存の変更があります。閉じますか?`)) {
      return;
    }
    const idx = fs.findIndex((f) => f.id === id);
    let next = fs.filter((f) => f.id !== id);
    if (!next.length) {
      next = [{ id: nextFileId++, name: "untitled-1.sysml", source: "", dirty: false }];
    }
    setFiles(next);
    if (!next.some((f) => f.id === activeId)) {
      setActiveId(next[Math.min(Math.max(0, idx - 1), next.length - 1)].id);
    }
    setSelected(undefined);
  };

  // ---- saving ----
  const saveOne = useCallback(
    async (file: WorkFile): Promise<boolean> => {
      try {
        if (file.handle) {
          await writeToHandle(file.handle, file.source);
        } else if (file.remotePath && sshSession) {
          await sshWrite(sshSession.sessionId, file.remotePath, file.source);
        } else if (file.remotePath && !sshSession) {
          throw new Error("SSH セッションが切断されています");
        } else {
          downloadFile(file.name, file.source);
        }
        setFiles((fs) => fs.map((f) => (f.id === file.id ? { ...f, dirty: false } : f)));
        return true;
      } catch (e) {
        showToast(`保存に失敗 (${file.name}): ` + (e as Error).message);
        return false;
      }
    },
    [sshSession, showToast]
  );

  const saveActive = useCallback(async () => {
    const file = filesRef.current.find((f) => f.id === activeId);
    if (!file) return;
    if (await saveOne(file)) {
      const dest = file.handle ? "ローカルファイル" : file.remotePath ? "リモート" : "ダウンロード";
      showToast(`保存しました: ${file.name} (${dest})`);
    }
  }, [activeId, saveOne, showToast]);

  const saveAll = useCallback(async () => {
    const targets = filesRef.current.filter(
      (f) => f.dirty && (f.handle || (f.remotePath && sshSession))
    );
    if (!targets.length) {
      showToast("直接保存できる未保存ファイルはありません");
      return;
    }
    let ok = 0;
    for (const f of targets) {
      if (await saveOne(f)) ok++;
    }
    showToast(`${ok}/${targets.length} ファイルを保存しました`);
  }, [saveOne, sshSession, showToast]);

  // Ctrl+S / Cmd+S
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (e.shiftKey) saveAll();
        else saveActive();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveActive, saveAll]);

  // ---- SSH ----
  const handleSshLoaded = (session: SshSession, remoteFiles: RemoteFile[]) => {
    setSshDialogOpen(false);
    setSshSession(session);
    const base: WorkFile[] = remoteFiles.map((rf) => ({
      id: nextFileId++,
      name: rf.name,
      source: rf.source,
      dirty: false,
      remotePath: rf.path,
    }));
    setFiles(base);
    setActiveId(base[0].id);
    setSelected(undefined);
    setDiagramRootKey("");
    showToast(`${session.label} から ${base.length} ファイルを読み込みました`);
  };

  const disconnectSsh = async () => {
    if (!sshSession) return;
    await sshDisconnect(sshSession.sessionId).catch(() => undefined);
    setSshSession(undefined);
    showToast("SSH 接続を切断しました");
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
  const dirtyCount = files.filter((f) => f.dirty).length;

  return (
    <div
      className="app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        filesFromDrop(e.dataTransfer).then((fs) => addLoadedFiles(fs));
      }}
    >
      <header className="toolbar">
        <span className="logo">⬡ SysML v2 Viewer</span>
        <button onClick={newFile}>新規</button>
        <button onClick={openFiles}>ファイルを開く…</button>
        <button onClick={openDirectory}>フォルダを開く…</button>
        <button onClick={() => (sshSession ? disconnectSsh() : setSshDialogOpen(true))}>
          {sshSession ? `SSH切断 (${sshSession.label})` : "リモート (SSH)…"}
        </button>
        <button onClick={saveActive} title="Ctrl+S">保存</button>
        <button onClick={saveAll} title="Ctrl+Shift+S" disabled={!dirtyCount}>
          全て保存{dirtyCount ? ` (${dirtyCount})` : ""}
        </button>
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
          onChange={async (e) => {
            const list = [...(e.target.files ?? [])];
            const loaded: LoadedFile[] = await Promise.all(
              list.map(async (f) => ({ name: f.name, source: await f.text() }))
            );
            addLoadedFiles(loaded);
            e.target.value = "";
          }}
        />
        <input
          ref={dirInputRef}
          type="file"
          // @ts-expect-error non-standard but widely supported
          webkitdirectory=""
          style={{ display: "none" }}
          onChange={async (e) => {
            const list = [...(e.target.files ?? [])].filter((f) => SYSML_EXT.test(f.name));
            const loaded: LoadedFile[] = await Promise.all(
              list.map(async (f) => ({
                name: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
                source: await f.text(),
              }))
            );
            addLoadedFiles(loaded, /*replace*/ true);
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
                  title={f.remotePath ?? f.name}
                >
                  {f.remotePath && <span className="file-tab-remote">⇅</span>}
                  <span className="file-tab-name">
                    {f.name}
                    {errCount > 0 && <span className="file-tab-err"> ●</span>}
                  </span>
                  <span
                    className={"file-tab-close" + (f.dirty ? " dirty" : "")}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeFile(f.id);
                    }}
                    title={f.dirty ? "未保存の変更あり – 閉じる" : "閉じる"}
                  >
                    {f.dirty ? "●" : "×"}
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
        {sshSession && <span className="ssh-status">⇅ SSH: {sshSession.label}</span>}
        <span className="spacer" />
        <span>ファイル / フォルダをドラッグ&ドロップで読み込み可能 — Ctrl+S で上書き保存</span>
      </footer>

      {sshDialogOpen && (
        <SshDialog onClose={() => setSshDialogOpen(false)} onLoaded={handleSshLoaded} />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
