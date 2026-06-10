import { closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  HighlightStyle,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { lintGutter, lintKeymap, setDiagnostics } from "@codemirror/lint";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import { ParseError } from "../sysml/ast";
import { sysml } from "../editor/sysmlLanguage";

const sysmlHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: "#c586c0", fontWeight: "600" },
  { tag: tags.modifier, color: "#569cd6" },
  { tag: tags.string, color: "#ce9178" },
  { tag: tags.number, color: "#b5cea8" },
  { tag: tags.lineComment, color: "#6a9955", fontStyle: "italic" },
  { tag: tags.blockComment, color: "#6a9955", fontStyle: "italic" },
  { tag: tags.operator, color: "#d4d4d4" },
  { tag: tags.variableName, color: "#9cdcfe" },
  { tag: tags.name, color: "#dcdcaa" },
]);

const editorTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "#1e1e2e",
      color: "#d4d4d4",
      height: "100%",
      fontSize: "13px",
    },
    ".cm-content": { fontFamily: "'SF Mono', Menlo, Consolas, monospace", caretColor: "#fff" },
    ".cm-gutters": { backgroundColor: "#181825", color: "#6c7086", border: "none" },
    ".cm-activeLine": { backgroundColor: "#ffffff0a" },
    ".cm-activeLineGutter": { backgroundColor: "#ffffff10" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
      backgroundColor: "#3a3d5c80",
    },
    ".cm-cursor": { borderLeftColor: "#fff" },
    ".cm-tooltip": { backgroundColor: "#272738", color: "#d4d4d4", border: "1px solid #444" },
    ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "#3a3d5c" },
    ".cm-lintRange-error": { textDecoration: "underline wavy #f38ba8" },
  },
  { dark: true }
);

export interface EditorSelection {
  start: number;
  end: number;
  /** increment to force re-application of the same range */
  seq: number;
}

interface Props {
  /** id of the file being edited – switching ids swaps editor state */
  fileId: number;
  value: string;
  onChange: (value: string) => void;
  errors: ParseError[];
  /** names available for completion */
  names: string[];
  /** externally requested selection (from tree / diagram click) */
  select?: EditorSelection;
  onCursor?: (offset: number) => void;
}

export function EditorPane({ fileId, value, onChange, errors, names, select, onCursor }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const namesRef = useRef<string[]>(names);
  const onChangeRef = useRef(onChange);
  const onCursorRef = useRef(onCursor);
  /** per-file editor states preserving undo history / cursor / scroll */
  const statesRef = useRef(new Map<number, EditorState>());
  const fileIdRef = useRef(fileId);
  namesRef.current = names;
  onChangeRef.current = onChange;
  onCursorRef.current = onCursor;

  const makeState = (doc: string) =>
    EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        foldGutter(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        lintGutter(),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          ...lintKeymap,
          indentWithTab,
        ]),
        sysml(() => namesRef.current),
        syntaxHighlighting(sysmlHighlight),
        editorTheme,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
          if (update.selectionSet) {
            onCursorRef.current?.(update.state.selection.main.head);
          }
        }),
      ],
    });

  // create the editor once
  useEffect(() => {
    if (!containerRef.current) return;
    const view = new EditorView({ state: makeState(value), parent: containerRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // file switches and external value changes
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (fileId !== fileIdRef.current) {
      // park the old file's state, restore (or create) the new one
      statesRef.current.set(fileIdRef.current, view.state);
      fileIdRef.current = fileId;
      const saved = statesRef.current.get(fileId);
      if (saved && saved.doc.toString() === value) {
        view.setState(saved);
      } else {
        view.setState(makeState(value));
      }
      return;
    }
    const current = view.state.doc.toString();
    if (current !== value) {
      // external replacement (sample load etc.) – reset history too
      view.setState(makeState(value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, value]);

  // diagnostics
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const docLen = view.state.doc.length;
    const diagnostics = errors
      .filter((e) => e.start <= docLen)
      .map((e) => ({
        from: Math.min(e.start, docLen),
        to: Math.min(e.end, docLen),
        severity: "error" as const,
        message: e.message,
      }));
    view.dispatch(setDiagnostics(view.state, diagnostics));
  }, [errors]);

  // externally requested selection
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !select) return;
    const docLen = view.state.doc.length;
    const from = Math.min(select.start, docLen);
    const to = Math.min(select.end, docLen);
    view.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
    view.focus();
  }, [select]);

  return <div className="editor-pane" ref={containerRef} />;
}
