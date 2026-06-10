import * as vscode from "vscode";
import { DiagramPanel } from "./diagramPanel";
import {
  registerCompletion,
  registerDefinition,
  registerDiagnostics,
  registerDocumentSymbols,
  registerHover,
} from "./languageFeatures";
import { ModelIndex } from "./modelIndex";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const index = new ModelIndex();
  context.subscriptions.push(index);
  await index.initialize();

  registerDiagnostics(context, index);
  registerCompletion(context, index);
  registerDocumentSymbols(context, index);
  registerDefinition(context, index);
  registerHover(context, index);

  context.subscriptions.push(
    vscode.commands.registerCommand("sysml.openDiagram", () => {
      DiagramPanel.createOrShow(context, index);
    })
  );
}

export function deactivate(): void {
  // disposables are handled via context.subscriptions
}
