import {
  Completion,
  CompletionContext,
  CompletionResult,
  autocompletion,
} from "@codemirror/autocomplete";
import {
  LanguageSupport,
  StreamLanguage,
  StringStream,
} from "@codemirror/language";
import { KEYWORDS } from "../sysml/lexer";

/** Keywords that introduce a definition (highlighted more prominently). */
const DEFINITION_KEYWORDS = new Set([
  "package", "part", "attribute", "port", "item", "action", "state",
  "requirement", "constraint", "interface", "connection", "allocation",
  "analysis", "verification", "concern", "view", "viewpoint", "rendering",
  "enum", "occurrence", "metadata", "calc", "case", "flow", "def", "library",
  "namespace", "use",
]);

interface SysMLStreamState {
  inBlockComment: boolean;
}

const sysmlStream = StreamLanguage.define<SysMLStreamState>({
  name: "sysml",
  startState: () => ({ inBlockComment: false }),
  token(stream: StringStream, state: SysMLStreamState): string | null {
    if (state.inBlockComment) {
      if (stream.match(/^.*?\*\//)) {
        state.inBlockComment = false;
      } else {
        stream.skipToEnd();
      }
      return "blockComment";
    }
    if (stream.eatSpace()) return null;
    if (stream.match("//")) {
      stream.skipToEnd();
      return "lineComment";
    }
    if (stream.match("/*")) {
      if (!stream.match(/^.*?\*\//)) {
        state.inBlockComment = true;
        stream.skipToEnd();
      }
      return "blockComment";
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
    if (stream.match(/^'(?:[^'\\]|\\.)*'?/)) return "name";
    if (stream.match(/^\d[\d_]*(\.\d+)?([eE][+-]?\d+)?/)) return "number";
    if (stream.match(/^(:>>|::>|:>|::|:=|\.\.)/)) return "operator";
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*(-unique)?/)) {
      const word = stream.current();
      if (KEYWORDS.has(word)) {
        return DEFINITION_KEYWORDS.has(word) ? "keyword" : "modifier";
      }
      return "variableName";
    }
    stream.next();
    return null;
  },
  languageData: {
    commentTokens: { line: "//", block: { open: "/*", close: "*/" } },
    closeBrackets: { brackets: ["(", "[", "{", "'", '"'] },
    indentOnInput: /^\s*\}$/,
  },
});

/** Snippet-ish completions for common SysML v2 constructs. */
const SNIPPETS: Completion[] = [
  { label: "package", type: "keyword", detail: "package <name> { ... }", apply: "package " },
  { label: "part def", type: "class", detail: "part definition", apply: "part def " },
  { label: "part", type: "variable", detail: "part usage", apply: "part " },
  { label: "attribute def", type: "class", apply: "attribute def " },
  { label: "attribute", type: "property", apply: "attribute " },
  { label: "port def", type: "class", apply: "port def " },
  { label: "port", type: "property", apply: "port " },
  { label: "item def", type: "class", apply: "item def " },
  { label: "item", type: "variable", apply: "item " },
  { label: "action def", type: "class", apply: "action def " },
  { label: "action", type: "function", apply: "action " },
  { label: "state def", type: "class", apply: "state def " },
  { label: "state", type: "variable", apply: "state " },
  { label: "requirement def", type: "class", apply: "requirement def " },
  { label: "requirement", type: "variable", apply: "requirement " },
  { label: "constraint", type: "function", apply: "constraint " },
  { label: "interface def", type: "class", apply: "interface def " },
  { label: "connection def", type: "class", apply: "connection def " },
  { label: "connect", type: "keyword", detail: "connect <a> to <b>;", apply: "connect " },
  { label: "bind", type: "keyword", detail: "bind <a> = <b>;", apply: "bind " },
  { label: "flow", type: "keyword", detail: "flow from <a> to <b>;", apply: "flow " },
  { label: "import", type: "keyword", apply: "import " },
  { label: "doc", type: "keyword", detail: "doc /* ... */", apply: "doc /* */" },
  { label: "perform action", type: "keyword", apply: "perform action " },
  { label: "exhibit state", type: "keyword", apply: "exhibit state " },
  { label: "satisfy requirement", type: "keyword", apply: "satisfy requirement " },
  { label: "transition", type: "keyword", detail: "transition first <s> then <t>;", apply: "transition " },
  { label: "use case def", type: "class", apply: "use case def " },
];

/**
 * Completion source: keywords/snippets + identifiers already present in the
 * document (so model element names complete as you type).
 */
function sysmlCompletions(getNames: () => string[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/[\w']*/);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    const names = getNames();
    const nameCompletions: Completion[] = names.map((n) => ({
      label: n,
      type: "variable",
    }));
    const keywordCompletions: Completion[] = [...KEYWORDS].map((k) => ({
      label: k,
      type: "keyword",
    }));
    return {
      from: word.from,
      options: [...SNIPPETS, ...nameCompletions, ...keywordCompletions],
      validFor: /^[\w']*$/,
    };
  };
}

export function sysml(getNames: () => string[]): LanguageSupport {
  return new LanguageSupport(sysmlStream, [
    autocompletion({ override: [sysmlCompletions(getNames)] }),
  ]);
}
