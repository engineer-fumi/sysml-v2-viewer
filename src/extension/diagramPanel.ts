import * as vscode from "vscode";
import { SerializedModelFile, stripParents } from "../core/serialize";
import { ModelIndex } from "./modelIndex";

/** Messages exchanged with the webview (see src/webview/DiagramApp.tsx). */
interface SelectMessage {
  type: "select";
  fileId: number;
  start: number;
  end: number;
}

interface ReadyMessage {
  type: "ready";
}

type FromWebview = SelectMessage | ReadyMessage;

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
      (msg: FromWebview) => {
        if (msg.type === "ready") this.postModel();
        if (msg.type === "select") this.revealInEditor(msg);
      },
      null,
      this.disposables
    );

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
    this.postTimer = setTimeout(() => this.postModel(), 200);
  }

  private postModel(): void {
    const files: SerializedModelFile[] = this.index.all().map((f) => ({
      uri: f.uri.toString(),
      name: f.name,
      ast: stripParents(f.result.root),
    }));
    this.panel.webview.postMessage({ type: "model", files });
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
