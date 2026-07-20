/**
 * Capix inline edit — Cursor-style Cmd-K / Ctrl-K "edit this code" loop.
 *
 * Select code (or place the caret on a line), hit the keybinding, describe
 * the change. The instruction plus surrounding file context streams through
 * the canonical smart-router route (`capix/auto`, same as inline completion
 * and chat — model selection stays server-authoritative). The model returns
 * ONLY the replacement block, which is applied in one undo-stop and marked
 * with a highlight + Accept/Reject CodeLens so the user can keep or roll
 * back the hunk with one click.
 *
 * What this module deliberately does NOT do:
 *  - diff multi-hunk output across the file (one contiguous block only);
 *  - hold credentials (the client authenticates through the shared broker);
 *  - talk to any endpoint other than the canonical inference route.
 */

import * as vscode from "vscode";
import { logger } from "./logger";
import type { CompletionInferenceClient } from "./inlineCompletionProvider";

/** Server-authoritative router target; the gateway picks the model. */
const FALLBACK_MODEL = "capix/auto";

const SYSTEM_PROMPT = [
  "You are a code editing engine embedded in an editor.",
  "You are given a file with a marked <SELECTION> region and an instruction.",
  "Output ONLY the code that should replace the selection — no markdown fences,",
  "no explanations, no commentary, no repetition of surrounding code.",
  "Preserve the selection’s leading indentation and the file’s style",
  "(naming, quoting, idioms). If the instruction is unclear, output the",
  "selection unchanged.",
].join(" ");

interface PendingEdit {
  uri: vscode.Uri;
  range: vscode.Range;
  original: string;
  decoration: vscode.TextEditorDecorationType;
}

/** One pending hunk at a time (matches Cursor’s single-block Cmd-K flow). */
let pending: PendingEdit | null = null;
const pendingEmitter = new vscode.EventEmitter<void>();

function clearPending(): void {
  pending?.decoration.dispose();
  pending = null;
  pendingEmitter.fire();
}

/** Strip a markdown fence wrapper if the model added one anyway. */
function stripFences(raw: string): string {
  const fenced = raw.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```\s*$/);
  return fenced ? fenced[1] ?? "" : raw;
}

/** CodeLens actions shown on the pending hunk: keep it or roll it back. */
class InlineEditLensProvider implements vscode.CodeLensProvider {
  readonly onDidChangeCodeLenses = pendingEmitter.event;
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!pending || pending.uri.toString() !== document.uri.toString()) return [];
    const top = new vscode.Range(pending.range.start, pending.range.start);
    return [
      new vscode.CodeLens(top, { title: "✓ Accept", command: "capix.inlineEdit.accept" }),
      new vscode.CodeLens(top, { title: "✗ Reject", command: "capix.inlineEdit.reject" }),
    ];
  }
}

async function runInlineEdit(client: CompletionInferenceClient): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage("Capix: open a file to use inline edit.");
    return;
  }
  const document = editor.document;
  const selection = editor.selection;
  const range = selection.isEmpty
    ? document.lineAt(selection.active.line).range
    : selection;
  const selectedText = document.getText(range);
  if (!selectedText.trim()) {
    vscode.window.showInformationMessage("Capix: select some code (or use a non-empty line) to edit.");
    return;
  }

  const instruction = await vscode.window.showInputBox({
    title: "Capix Inline Edit",
    prompt: "Describe the change",
    placeHolder: "e.g. add error handling · convert to async · add types",
    ignoreFocusOut: true,
  });
  if (instruction === undefined) return; // Escape
  if (!instruction.trim()) {
    vscode.window.showInformationMessage("Capix: describe the change you want.");
    return;
  }

  clearPending();
  const original = selectedText;

  const config = vscode.workspace.getConfiguration("capix");
  const preferredModel = config.get<string>("ai.preferredModel", "");
  const full = document.getText();
  const startOffset = document.offsetAt(range.start);
  const endOffset = document.offsetAt(range.end);
  const prefix = full.slice(Math.max(0, startOffset - 3000), startOffset);
  const suffix = full.slice(endOffset, endOffset + 1500);

  const input = {
    model: preferredModel.trim() || FALLBACK_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `<file path="${document.fileName}" language="${document.languageId}">\n` +
          `${prefix}<SELECTION>\n${selectedText}\n</SELECTION>${suffix}\n</file>\n\n` +
          `<instruction>${instruction.trim()}</instruction>`,
      },
    ],
    stream: true,
    maxTokens: 1024,
    temperature: 0.2,
  };

  let generated = "";
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Capix: editing selection…",
        cancellable: true,
      },
      async (_progress, token) => {
        const controller = new AbortController();
        const sub = token.onCancellationRequested(() => controller.abort());
        try {
          await client.streamAgentChat(input, controller.signal, async (event) => {
            if (event.type === "delta" && typeof event.content === "string") {
              generated += event.content;
            }
          });
        } finally {
          sub.dispose();
        }
      },
    );
  } catch (err) {
    if (!/aborted|cancell?ed/i.test(String(err))) {
      logger.error("Capix inline edit failed", { error: String(err) });
      vscode.window.showErrorMessage(`Capix inline edit failed — ${String(err)}`);
    }
    return;
  }

  const replacement = stripFences(generated).replace(/\n$/, "");
  if (!replacement.trim() || replacement === selectedText) return;

  const applied = await editor.edit((builder) => builder.replace(range, replacement));
  if (!applied) {
    vscode.window.showErrorMessage("Capix: could not apply the edit.");
    return;
  }

  const endLine = range.start.line + replacement.split("\n").length - 1;
  const appliedRange = new vscode.Range(
    range.start,
    new vscode.Position(endLine, document.lineAt(endLine).text.length),
  );

  const decoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: "rgba(20,241,149,0.07)",
    borderWidth: "0 0 0 2px",
    borderStyle: "solid",
    borderColor: "rgba(61,206,214,0.55)",
    overviewRulerColor: "rgba(61,206,214,0.6)",
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  pending = { uri: document.uri, range: appliedRange, original, decoration };
  editor.setDecorations(decoration, [appliedRange]);
  pendingEmitter.fire();
}

/**
 * Register the Cmd-K / Ctrl-K inline edit command plus its Accept/Reject
 * commands and CodeLens. Called from `registerInlineCompletions` (the
 * keybinding itself is contributed declaratively in package.json).
 */
export function registerInlineEdit(
  context: vscode.ExtensionContext,
  client: CompletionInferenceClient,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("capix.inlineEdit", () => runInlineEdit(client)),
    vscode.commands.registerCommand("capix.inlineEdit.accept", () => {
      clearPending();
      vscode.window.showInformationMessage("Capix: edit kept.");
    }),
    vscode.commands.registerCommand("capix.inlineEdit.reject", async () => {
      const p = pending;
      if (!p) return;
      clearPending();
      const document = await vscode.workspace.openTextDocument(p.uri);
      const editor = await vscode.window.showTextDocument(document);
      await editor.edit((builder) => builder.replace(p.range, p.original));
      vscode.window.showInformationMessage("Capix: edit reverted.");
    }),
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, new InlineEditLensProvider()),
    new vscode.Disposable(() => clearPending()),
  );
}
