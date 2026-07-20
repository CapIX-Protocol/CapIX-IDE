/**
 * Capix inline completion — Copilot-style ghost text in the editor.
 *
 * Implements `vscode.InlineCompletionItemProvider` backed by the same
 * completion engine as the Capix Code CLI (`code/src/completion/`):
 *  - debounced, cached, multi-line suggestions built from the current file,
 *    related project context, and recent edits;
 *  - inference streams through the canonical smart-router route
 *    (`/api/v1/inference/chat/completions`) with `capix/auto`, so model
 *    selection stays server-authoritative — the extension never classifies
 *    code or scores models itself;
 *  - Tab accepts, Escape rejects (keybindings contributed in package.json,
 *    wired to the built-in inline-suggest commands).
 *
 * What this module deliberately does NOT do:
 *  - talk to any endpoint other than the canonical inference route;
 *  - hold credentials (the client authenticates through the shared broker);
 *  - persist completions or context across sessions.
 */

import * as vscode from "vscode";
import { createHash } from "node:crypto";
import { logger } from "./logger";
import { registerInlineEdit } from "./inlineEdit";

/** Server-authoritative router target; the gateway picks the model. */
const FALLBACK_MODEL = "capix/auto";

/** System prompt shared with the CLI completion engine. */
const SYSTEM_PROMPT = [
  "You are a code completion engine embedded in an editor.",
  "Output ONLY the code that belongs at the <CURSOR> marker — nothing before it, nothing after it.",
  "Do not repeat code that already appears before <CURSOR>.",
  "Do not wrap the answer in markdown fences, explanations, or commentary.",
  "Match the surrounding style: indentation, naming, quoting, and idioms.",
  "The completion may span multiple lines when the context calls for it.",
  "If no sensible completion exists, output nothing.",
].join(" ");

const MAX_RECENT_EDITS = 10;

/** Structural view of the API client this provider needs (see apiClient). */
export interface CompletionInferenceClient {
  streamAgentChat(
    input: unknown,
    signal: AbortSignal,
    onEvent: (event: Record<string, unknown>) => Promise<void>
  ): Promise<void>;
}

export interface InlineCompletionProviderOptions {
  /** Debounce window (ms). Default: `capix.inlineCompletion.debounceMs` or 300. */
  debounceMs?: number;
  /** Cache entry TTL (ms). Default 60_000. */
  cacheTtlMs?: number;
  /** Max chars of prefix sent as context. Default 4000. */
  prefixChars?: number;
  /** Max chars of suffix sent as context. Default 1000. */
  suffixChars?: number;
  /** Max output tokens per completion. Default 256. */
  maxTokens?: number;
  /** Max lines in a returned completion. Default 12. */
  maxLines?: number;
}

interface CacheEntry {
  text: string;
  expiresAt: number;
}

/**
 * Inline completion provider. One instance serves all documents; VS Code
 * calls `provideInlineCompletionItems` on each keystroke and cancels the
 * previous request via the token, which this provider honors at the debounce
 * boundary and mid-stream.
 */
export class CapixInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly recentEdits: string[] = [];
  private enabledOverride: boolean | null = null;

  constructor(
    private readonly client: CompletionInferenceClient,
    private readonly opts: InlineCompletionProviderOptions = {}
  ) {}

  /** Effective on/off state: session toggle wins, else workspace config. */
  isEnabled(): boolean {
    if (this.enabledOverride !== null) return this.enabledOverride;
    return vscode.workspace.getConfiguration("capix").get<boolean>("inlineCompletion.enabled", true);
  }

  /** Flip the enabled state (command palette / keybinding toggle). */
  async toggle(): Promise<void> {
    const next = !this.isEnabled();
    this.enabledOverride = next;
    await vscode.workspace
      .getConfiguration("capix")
      .update("inlineCompletion.enabled", next, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand("setContext", "capix.inlineCompletion.enabled", next);
    vscode.window.showInformationMessage(
      `Capix: inline completion ${next ? "enabled" : "disabled"}.`
    );
  }

  /** Track a document edit so completions follow the local change pattern. */
  trackEdit(event: vscode.TextDocumentChangeEvent): void {
    for (const change of event.contentChanges) {
      this.recentEdits.push(
        `${event.document.fileName}: inserted ${change.text.length} chars at line ${change.range.start.line + 1}`
      );
    }
    while (this.recentEdits.length > MAX_RECENT_EDITS) this.recentEdits.shift();
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    if (!this.isEnabled() || token.isCancellationRequested) return undefined;

    const content = document.getText();
    const offset = document.offsetAt(position);
    if (offset > content.length || content.trim().length === 0) return undefined;

    const prefixChars = this.opts.prefixChars ?? 4000;
    const suffixChars = this.opts.suffixChars ?? 1000;
    const prefixFull = content.slice(0, offset);
    const prefix = prefixFull.length > prefixChars ? prefixFull.slice(-prefixChars) : prefixFull;
    const suffix = content.slice(offset, offset + suffixChars);

    // Repeat keystrokes that reproduce the same context serve from cache.
    const key = this.cacheKey(document.languageId, document.fileName, prefix, suffix);
    const cached = this.cacheGet(key);
    if (cached) return [this.toItem(cached, position)];

    // Debounce: VS Code cancels the previous call on each keystroke, so a
    // cancelled wait just returns `undefined` — only the pause hits the wire.
    const debounceMs =
      this.opts.debounceMs ??
      vscode.workspace.getConfiguration("capix").get<number>("inlineCompletion.debounceMs", 300);
    if (!(await wait(debounceMs, token))) return undefined;

    try {
      const text = await this.requestCompletion(document, prefix, suffix, token);
      if (!text || token.isCancellationRequested) return undefined;
      this.cacheSet(key, { text, expiresAt: Date.now() + (this.opts.cacheTtlMs ?? 60_000) });
      return [this.toItem(text, position)];
    } catch (err) {
      if (!token.isCancellationRequested) {
        logger.warn("inline completion request failed", { error: String(err) });
      }
      return undefined;
    }
  }

  /** Stream one completion through the canonical smart-router route. */
  private async requestCompletion(
    document: vscode.TextDocument,
    prefix: string,
    suffix: string,
    token: vscode.CancellationToken
  ): Promise<string | null> {
    const preferredModel = vscode.workspace
      .getConfiguration("capix")
      .get<string>("ai.preferredModel", "");
    const sections: string[] = [];
    for (const edit of this.recentEdits.slice(-5)) {
      sections.push(`<recent-edit>${edit}</recent-edit>`);
    }
    sections.push(
      `<file path="${document.fileName}" language="${document.languageId}">\n` +
        `${prefix}<CURSOR>${suffix}\n</file>`
    );

    const input = {
      // `capix/auto` delegates model selection to the smart router; a
      // configured preferred model is a preference, never a hard lock.
      model: preferredModel.trim() || FALLBACK_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: sections.join("\n\n") },
      ],
      stream: true,
      maxTokens: this.opts.maxTokens ?? 256,
      temperature: 0.2,
    };

    const controller = new AbortController();
    const sub = token.onCancellationRequested(() => controller.abort());
    let text = "";
    try {
      await this.client.streamAgentChat(input, controller.signal, async (event) => {
        if (event.type === "delta" && typeof event.content === "string") {
          text += event.content;
        }
      });
    } finally {
      sub.dispose();
    }
    return postProcessCompletion(text, this.opts.maxLines ?? 12);
  }

  private toItem(text: string, position: vscode.Position): vscode.InlineCompletionItem {
    return new vscode.InlineCompletionItem(text, new vscode.Range(position, position));
  }

  private cacheKey(languageId: string, fileName: string, prefix: string, suffix: string): string {
    return createHash("sha256")
      .update(languageId)
      .update(" ")
      .update(fileName)
      .update(" ")
      .update(prefix)
      .update("<CURSOR>")
      .update(suffix)
      .digest("hex");
  }

  private cacheGet(key: string): string | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return null;
    }
    return entry.text;
  }

  private cacheSet(key: string, entry: CacheEntry): void {
    this.cache.set(key, entry);
    while (this.cache.size > 100) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

/**
 * Clean raw model output into insertable text. Mirrors the CLI engine's
 * post-processing: strip a markdown fence wrapper, bound the line count,
 * drop trailing blanks, reject empty output.
 */
export function postProcessCompletion(raw: string, maxLines: number): string | null {
  let text = raw;
  const fenced = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```\s*$/);
  if (fenced) text = fenced[1] ?? "";

  const lines = text.split("\n").slice(0, maxLines);
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
  text = lines.join("\n");

  if (text.trim().length === 0) return null;
  return text;
}

/** Resolve after `ms`, or immediately with `false` when the token cancels. */
function wait(ms: number, token: vscode.CancellationToken): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      sub.dispose();
      resolve(true);
    }, ms);
    const sub = token.onCancellationRequested(() => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/**
 * Register the provider plus its commands and context key. Called once from
 * `activate`. Keybindings (Tab accept / Escape reject) are contributed
 * declaratively in package.json and routed through the accept/reject
 * commands registered here.
 */
export function registerInlineCompletions(
  context: vscode.ExtensionContext,
  client: CompletionInferenceClient
): CapixInlineCompletionProvider {
  const provider = new CapixInlineCompletionProvider(client);
  registerInlineEdit(context, client);
  void vscode.commands.executeCommand(
    "setContext",
    "capix.inlineCompletion.enabled",
    provider.isEnabled()
  );
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, provider),
    vscode.commands.registerCommand("capix.inlineCompletion.toggle", () => provider.toggle()),
    vscode.commands.registerCommand("capix.inlineCompletion.accept", () =>
      vscode.commands.executeCommand("editor.action.inlineSuggest.commit")
    ),
    vscode.commands.registerCommand("capix.inlineCompletion.reject", () =>
      vscode.commands.executeCommand("editor.action.inlineSuggest.hide")
    ),
    vscode.workspace.onDidChangeTextDocument((event) => provider.trackEdit(event))
  );
  return provider;
}
