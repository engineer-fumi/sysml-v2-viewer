import * as vscode from "vscode";
import { SysMLElement, walk } from "../core/ast";
import { SerializedModelFile, stripParents } from "../core/serialize";
import { IndexedFile, ModelIndex } from "./modelIndex";

/** Messages exchanged with the webview (see src/webview/DiagramApp.tsx). */
interface SelectMessage {
  type: "select";
  fileId: number;
  start: number;
  end: number;
}

interface AddConnectMessage {
  type: "edit";
  action: "addConnect";
  fileId: number;
  /** start offset of the scope element (file scope when < 0) */
  scopeStart: number;
  source: string;
  target: string;
}

interface AddElementMessage {
  type: "edit";
  action: "addElement";
  kind: string;
  fileId: number;
  containerStart: number;
}

interface RenameMessage {
  type: "edit";
  action: "rename";
  fileId: number;
  nameStart: number;
  nameEnd: number;
  oldName: string;
}

interface DeleteMessage {
  type: "edit";
  action: "delete";
  fileId: number;
  start: number;
  end: number;
  label: string;
}

interface SaveLayoutMessage {
  type: "saveLayout";
  rootKey: string;
  offsets: Record<string, { dx: number; dy: number }>;
}

type FromWebview =
  | SelectMessage
  | AddConnectMessage
  | AddElementMessage
  | RenameMessage
  | DeleteMessage
  | SaveLayoutMessage
  | { type: "ready" };

const LAYOUT_FILE = ".sysml-layout.json";

type Layouts = Record<string, Record<string, { dx: number; dy: number }>>;

export class DiagramPanel {
  static current: DiagramPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private postTimer: NodeJS.Timeout | undefined;
  /** suppress cursor-sync right after we changed the selection ourselves */
  private suppressCursorSync = 0;

  static createOrShow(context: vscode.ExtensionContext, index: ModelIndex): void {
    if (DiagramPanel.current) {
      DiagramPanel.current.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "sysmlDiagram",
      "SysML ダイアグラム",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")],
      }
    );
    DiagramPanel.current = new DiagramPanel(panel, context, index);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private index: ModelIndex
  ) {
    this.panel = panel;
    panel.webview.html = this.html(context);

    panel.onDidDispose(() => this.dispose(), null, this.disposables);

    panel.webview.onDidReceiveMessage(
      async (msg: FromWebview) => {
        try {
          switch (msg.type) {
            case "ready":
              await this.postModel();
              break;
            case "select":
              await this.revealInEditor(msg);
              break;
            case "saveLayout":
              await this.saveLayout(msg);
              break;
            case "edit":
              await this.applyEdit(msg);
              break;
          }
        } catch (e) {
          vscode.window.showErrorMessage(
            "SysML ダイアグラム操作に失敗しました: " + (e as Error).message
          );
        }
      },
      null,
      this.disposables
    );

    // reflect external edits to the layout sidecar (git pull, manual edits ...)
    const layoutWatcher = vscode.workspace.createFileSystemWatcher(`**/${LAYOUT_FILE}`);
    layoutWatcher.onDidChange(() => this.schedulePostModel());
    layoutWatcher.onDidCreate(() => this.schedulePostModel());
    layoutWatcher.onDidDelete(() => this.schedulePostModel());
    this.disposables.push(layoutWatcher);

    this.disposables.push(
      this.index.onDidChangeModel(() => this.schedulePostModel()),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor.document.languageId !== "sysml") return;
        if (Date.now() < this.suppressCursorSync) return;
        const entry = this.index.get(e.textEditor.document.uri);
        if (!entry) return;
        const offset = e.textEditor.document.offsetAt(e.selections[0].active);
        this.panel.webview.postMessage({
          type: "highlight",
          fileId: entry.fileId,
          offset,
        });
      })
    );
  }

  private schedulePostModel(): void {
    clearTimeout(this.postTimer);
    this.postTimer = setTimeout(() => void this.postModel(), 200);
  }

  private async postModel(): Promise<void> {
    const files: SerializedModelFile[] = this.index.all(false).map((f) => ({
      uri: f.uri.toString(),
      name: f.name,
      ast: stripParents(f.result.root),
    }));
    const layouts = await this.loadLayouts();
    await this.panel.webview.postMessage({ type: "model", files, layouts });
  }

  // ---- layout sidecar ----------------------------------------------------

  private layoutUri(): vscode.Uri | undefined {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return undefined;
    return vscode.Uri.joinPath(ws.uri, LAYOUT_FILE);
  }

  private async loadLayouts(): Promise<Layouts> {
    const uri = this.layoutUri();
    if (!uri) return {};
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return JSON.parse(Buffer.from(bytes).toString("utf8")) as Layouts;
    } catch {
      return {};
    }
  }

  private async saveLayout(msg: SaveLayoutMessage): Promise<void> {
    const uri = this.layoutUri();
    if (!uri) return;
    const layouts = await this.loadLayouts();
    // drop zero offsets to keep the file small
    const cleaned: Record<string, { dx: number; dy: number }> = {};
    for (const [k, v] of Object.entries(msg.offsets)) {
      if (Math.abs(v.dx) > 0.5 || Math.abs(v.dy) > 0.5) {
        cleaned[k] = { dx: Math.round(v.dx), dy: Math.round(v.dy) };
      }
    }
    if (Object.keys(cleaned).length) layouts[msg.rootKey] = cleaned;
    else delete layouts[msg.rootKey];
    await vscode.workspace.fs.writeFile(
      uri,
      Buffer.from(JSON.stringify(layouts, null, 2) + "\n", "utf8")
    );
  }

  // ---- model edits ---------------------------------------------------------

  private findElementAtStart(file: IndexedFile, start: number): SysMLElement | undefined {
    let found: SysMLElement | undefined;
    walk(file.result.root, (el) => {
      if (el.start === start && !found && el !== file.result.root) found = el;
    });
    return found;
  }

  private indentOfLine(doc: vscode.TextDocument, offset: number): string {
    const line = doc.lineAt(doc.positionAt(offset).line);
    return line.text.slice(0, line.firstNonWhitespaceCharacterIndex);
  }

  /** Insert a member statement into an element body (or at end of file). */
  private async insertInto(
    file: IndexedFile,
    scopeStart: number,
    statement: string
  ): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(file.uri);
    const edit = new vscode.WorkspaceEdit();

    if (scopeStart < 0) {
      // file scope: append at the end
      const endPos = doc.positionAt(doc.getText().length);
      edit.insert(file.uri, endPos, `\n${statement}\n`);
    } else {
      const el = this.findElementAtStart(file, scopeStart);
      if (!el) throw new Error("挿入先の要素が見つかりません (再描画後にやり直してください)");
      const text = doc.getText();
      const indent = this.indentOfLine(doc, el.start);
      const lastChar = text.slice(el.end - 1, el.end);
      if (lastChar === "}") {
        // insert before the closing brace
        edit.insert(file.uri, doc.positionAt(el.end - 1), `    ${statement}\n${indent}`);
      } else {
        // `;` body – convert to a braced body
        edit.replace(
          file.uri,
          new vscode.Range(doc.positionAt(el.end - 1), doc.positionAt(el.end)),
          ` {\n${indent}    ${statement}\n${indent}}`
        );
      }
    }

    await vscode.workspace.applyEdit(edit);
  }

  private async applyEdit(msg: AddConnectMessage | AddElementMessage | RenameMessage | DeleteMessage): Promise<void> {
    let file = this.index.getByFileId(msg.fileId);
    if (!file && msg.action === "addElement" && msg.fileId < 0) {
      // no target file (combined-model background click): ask the user
      const files = this.index.all(false);
      if (!files.length) return;
      const picked = await vscode.window.showQuickPick(
        files.map((f) => ({ label: f.name, file: f })),
        { placeHolder: `${msg.kind} を追加するファイルを選択` }
      );
      if (!picked) return;
      file = picked.file;
    }
    if (!file) return;

    switch (msg.action) {
      case "addConnect": {
        await this.insertInto(file, msg.scopeStart, `connect ${msg.source} to ${msg.target};`);
        break;
      }
      case "addElement": {
        const input = await vscode.window.showInputBox({
          prompt: `${msg.kind} の名前 (任意で「名前 : 型」)`,
          placeHolder: msg.kind === "part" ? "engine : Engine" : "name : Type",
          validateInput: (v) => (v.trim() ? undefined : "名前を入力してください"),
        });
        if (!input) return;
        await this.insertInto(file, msg.containerStart, `${msg.kind} ${input.trim()};`);
        break;
      }
      case "rename": {
        const newName = await vscode.window.showInputBox({
          prompt: `'${msg.oldName}' の新しい名前 (宣言のみ変更されます)`,
          value: msg.oldName,
          validateInput: (v) => (v.trim() ? undefined : "名前を入力してください"),
        });
        if (!newName || newName === msg.oldName) return;
        const doc = await vscode.workspace.openTextDocument(file.uri);
        const safe = /^[A-Za-z_][A-Za-z0-9_]*$/.test(newName.trim())
          ? newName.trim()
          : `'${newName.trim()}'`;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
          file.uri,
          new vscode.Range(doc.positionAt(msg.nameStart), doc.positionAt(msg.nameEnd)),
          safe
        );
        await vscode.workspace.applyEdit(edit);
        break;
      }
      case "delete": {
        const doc = await vscode.workspace.openTextDocument(file.uri);
        const text = doc.getText();
        // expand to whole lines when the element is alone on them
        let start = msg.start;
        while (start > 0 && (text[start - 1] === " " || text[start - 1] === "\t")) start--;
        let end = msg.end;
        if (text[end] === "\n") end++;
        const edit = new vscode.WorkspaceEdit();
        edit.delete(file.uri, new vscode.Range(doc.positionAt(start), doc.positionAt(end)));
        await vscode.workspace.applyEdit(edit);
        break;
      }
    }
  }

  private async revealInEditor(msg: SelectMessage): Promise<void> {
    const file = this.index.getByFileId(msg.fileId);
    if (!file) return;
    const doc = await vscode.workspace.openTextDocument(file.uri);
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
    });
    const len = doc.getText().length;
    const range = new vscode.Range(
      doc.positionAt(Math.min(msg.start, len)),
      doc.positionAt(Math.min(msg.end, len))
    );
    this.suppressCursorSync = Date.now() + 500;
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private html(context: vscode.ExtensionContext): string {
    const webview = this.panel.webview;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, "dist", "webview.js")
    );
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, "dist", "webview.css")
    );
    const nonce = Math.random().toString(36).slice(2);
    return /* html */ `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${cssUri}">
  <title>SysML ダイアグラム</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    DiagramPanel.current = undefined;
    clearTimeout(this.postTimer);
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}
