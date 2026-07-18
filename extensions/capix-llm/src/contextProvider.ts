/**
 * Capix IDE context provider — assembles the workspace signal the assistant
 * needs to answer with precision:
 *
 *   • active file: path, language, cursor position, selection and a snippet
 *   • project structure: workspace folders and a depth-limited file tree
 *   • git: branch, ahead/behind and the working-tree change set
 *   • LSP: diagnostics (errors/warnings per file) and document symbols
 *   • terminal: open terminals plus an optional output-capture hook
 *
 * Everything is read-only and best-effort — each collector degrades to an
 * empty result when the underlying source is unavailable (no workspace, no
 * git extension, no language server) so a single failure never blanks the
 * whole context payload. Sizes are capped aggressively; the provider is a
 * signal extractor, not a file dumper.
 */

import * as vscode from "vscode";
import { logger } from "./logger";

/** Snippet / list caps — the context payload must stay small and high-signal. */
const MAX_FILE_SNIPPET_CHARS = 6000;
const MAX_SELECTION_CHARS = 4000;
const MAX_TREE_ENTRIES = 120;
const MAX_TREE_DEPTH = 3;
const MAX_DIAGNOSTIC_FILES = 8;
const MAX_DIAGNOSTICS_PER_FILE = 5;
const MAX_SYMBOLS = 40;
const MAX_TERMINAL_LINES = 80;

/** Directories never descended into while walking the project tree. */
const TREE_IGNORE = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  "build",
  ".next",
  "target",
  "coverage",
  "__pycache__",
]);

export interface CapixActiveFileContext {
  path: string;
  language: string;
  /** 1-based cursor line. */
  line: number;
  character: number;
  selection?: {
    startLine: number;
    endLine: number;
    text: string;
  };
  /** Text around the cursor (or the selection when present), capped. */
  snippet: string;
  /** Total line count so the model knows how much of the file it is seeing. */
  lineCount: number;
}

export interface CapixGitContext {
  branch: string;
  ahead: number;
  behind: number;
  /** Working-tree changes: `M path`, `A path`, `D path`, `? path`. */
  changes: Array<{ status: string; path: string }>;
  /** Short `git diff --stat`-style summary of unstaged changes, when available. */
  diffStat?: string;
}

export interface CapixDiagnosticItem {
  path: string;
  severity: "error" | "warning";
  line: number;
  message: string;
  source?: string;
}

export interface CapixSymbolItem {
  name: string;
  kind: string;
  line: number;
  children?: CapixSymbolItem[];
}

export interface CapixTerminalContext {
  terminals: Array<{ name: string; isActive: boolean }>;
  /** Recent output of the active terminal, when a capture hook is installed. */
  lastOutput?: string;
}

export interface CapixIdeContext {
  activeFile?: CapixActiveFileContext;
  project: {
    folders: string[];
    tree: string[];
    truncated: boolean;
  };
  git?: CapixGitContext;
  diagnostics: CapixDiagnosticItem[];
  symbols: CapixSymbolItem[];
  terminal: CapixTerminalContext;
}

/**
 * Optional terminal-output capture hook. VS Code's stable API does not expose
 * terminal buffer text; the extension host can install a collector here (for
 * example one fed by a shell-integration data stream) and the provider will
 * attach its most recent chunk to the context payload.
 */
export type TerminalOutputCapture = () => string | undefined;

/** Minimal structural type for the built-in Git extension API (avoids a hard dependency). */
interface GitExtensionApi {
  repositories: Array<{
    state: {
      HEAD?: { name?: string; ahead?: number; behind?: number };
      workingTreeChanges: Array<{ uri: vscode.Uri; status: number }>;
      indexChanges: Array<{ uri: vscode.Uri; status: number }>;
    };
    rootUri: vscode.Uri;
  }>;
}

/** Built-in git status enum ordinals (vscode.git extension, stable). */
const GIT_STATUS: Record<number, string> = {
  0: "M", // INDEX_MODIFIED
  1: "A", // INDEX_ADDED
  2: "D", // INDEX_DELETED
  3: "R", // INDEX_RENAMED
  5: "M", // MODIFIED
  6: "D", // DELETED
  7: "?", // UNTRACKED
};

export class CapixContextProvider {
  private terminalCapture: TerminalOutputCapture | undefined;

  /** Install a terminal-output collector (see `TerminalOutputCapture`). */
  setTerminalCapture(capture: TerminalOutputCapture | undefined): void {
    this.terminalCapture = capture;
  }

  // ── Active file + selection ─────────────────────────────────────────────

  /** Active editor content, cursor and selection. Undefined with no editor. */
  getActiveFileContext(): CapixActiveFileContext | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    const doc = editor.document;
    if (doc.uri.scheme !== "file" && doc.uri.scheme !== "untitled") return undefined;

    const path = vscode.workspace.asRelativePath(doc.uri);
    const pos = editor.selection.active;
    const hasSelection = !editor.selection.isEmpty;

    let snippet: string;
    let selection: CapixActiveFileContext["selection"];
    if (hasSelection) {
      const raw = doc.getText(editor.selection);
      const text =
        raw.length > MAX_SELECTION_CHARS
          ? raw.slice(0, MAX_SELECTION_CHARS) + "\n…(truncated)"
          : raw;
      selection = {
        startLine: editor.selection.start.line + 1,
        endLine: editor.selection.end.line + 1,
        text,
      };
      snippet = text;
    } else {
      // A window around the cursor beats a head-truncated dump for large files.
      const radius = 120;
      const start = Math.max(0, pos.line - radius);
      const end = Math.min(doc.lineCount - 1, pos.line + radius);
      const range = new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
      const raw = doc.getText(range);
      snippet =
        raw.length > MAX_FILE_SNIPPET_CHARS
          ? raw.slice(0, MAX_FILE_SNIPPET_CHARS) + "\n…(truncated)"
          : raw;
      if (start > 0) snippet = `…(${start} lines above)\n${snippet}`;
      if (end < doc.lineCount - 1) snippet += `\n…(${doc.lineCount - 1 - end} lines below)`;
    }

    return {
      path,
      language: doc.languageId,
      line: pos.line + 1,
      character: pos.character + 1,
      selection,
      snippet,
      lineCount: doc.lineCount,
    };
  }

  // ── Project structure ───────────────────────────────────────────────────

  /** Workspace folders plus a depth-limited, ignore-aware file tree. */
  async getProjectStructure(): Promise<CapixIdeContext["project"]> {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.name);
    const tree: string[] = [];
    let truncated = false;

    const roots = vscode.workspace.workspaceFolders ?? [];
    for (const root of roots) {
      tree.push(`${root.name}/`);
      truncated = (await this.walkTree(root.uri, root.name, 0, tree)) || truncated;
      if (tree.length >= MAX_TREE_ENTRIES) {
        truncated = true;
        break;
      }
    }
    return { folders, tree, truncated };
  }

  /** Depth-first walk; returns true when the entry cap stopped the walk early. */
  private async walkTree(
    dir: vscode.Uri,
    prefix: string,
    depth: number,
    out: string[],
  ): Promise<boolean> {
    if (depth >= MAX_TREE_DEPTH) return false;
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return false;
    }
    entries.sort((a, b) => {
      const dirA = (a[1] & vscode.FileType.Directory) !== 0;
      const dirB = (b[1] & vscode.FileType.Directory) !== 0;
      if (dirA !== dirB) return dirA ? -1 : 1;
      return a[0].localeCompare(b[0]);
    });

    let truncated = false;
    for (const [name, type] of entries) {
      if (out.length >= MAX_TREE_ENTRIES) return true;
      if (TREE_IGNORE.has(name)) continue;
      if (name.startsWith(".") && name !== ".github") continue;
      const isDir = (type & vscode.FileType.Directory) !== 0;
      out.push(`${prefix}/${name}${isDir ? "/" : ""}`);
      if (isDir) {
        truncated =
          (await this.walkTree(vscode.Uri.joinPath(dir, name), `${prefix}/${name}`, depth + 1, out)) ||
          truncated;
      }
    }
    return truncated;
  }

  // ── Git ─────────────────────────────────────────────────────────────────

  /** Branch, ahead/behind and the working-tree change set via the built-in Git extension. */
  async getGitContext(): Promise<CapixGitContext | undefined> {
    try {
      const gitExt = vscode.extensions.getExtension<{ getAPI(version: 1): GitExtensionApi }>("vscode.git");
      if (!gitExt) return undefined;
      const api = gitExt.isActive ? gitExt.exports.getAPI(1) : (await gitExt.activate()).getAPI(1);
      const repo = api.repositories[0];
      if (!repo) return undefined;

      const head = repo.state.HEAD;
      const seen = new Map<string, string>();
      for (const change of [...repo.state.indexChanges, ...repo.state.workingTreeChanges]) {
        const rel = vscode.workspace.asRelativePath(change.uri);
        seen.set(rel, GIT_STATUS[change.status] ?? "M");
      }
      const changes = [...seen.entries()]
        .slice(0, 40)
        .map(([path, status]) => ({ status, path }));

      return {
        branch: head?.name ?? "(detached)",
        ahead: head?.ahead ?? 0,
        behind: head?.behind ?? 0,
        changes,
      };
    } catch (err) {
      logger.info("CapixContext git unavailable", { error: String(err) });
      return undefined;
    }
  }

  // ── LSP: diagnostics + symbols ──────────────────────────────────────────

  /** Errors and warnings across the workspace, capped and flattened. */
  getDiagnostics(): CapixDiagnosticItem[] {
    const out: CapixDiagnosticItem[] = [];
    const all = vscode.languages.getDiagnostics();
    let files = 0;
    for (const [uri, diagnostics] of all) {
      if (files >= MAX_DIAGNOSTIC_FILES) break;
      const relevant = diagnostics.filter(
        (d) => d.severity <= vscode.DiagnosticSeverity.Warning,
      );
      if (!relevant.length) continue;
      files += 1;
      const path = vscode.workspace.asRelativePath(uri);
      for (const d of relevant.slice(0, MAX_DIAGNOSTICS_PER_FILE)) {
        out.push({
          path,
          severity: d.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning",
          line: d.range.start.line + 1,
          message: d.message.split("\n")[0].slice(0, 200),
          source: d.source,
        });
      }
    }
    return out;
  }

  /** Top-level symbols of the active file via the registered language server. */
  async getActiveFileSymbols(): Promise<CapixSymbolItem[]> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return [];
    try {
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        "vscode.executeDocumentSymbolProvider",
        editor.document.uri,
      );
      if (!symbols) return [];
      const toItem = (s: vscode.DocumentSymbol): CapixSymbolItem => ({
        name: s.name,
        kind: vscode.SymbolKind[s.kind] ?? "Symbol",
        line: s.range.start.line + 1,
        children: s.children.length ? s.children.slice(0, 8).map(toItem) : undefined,
      });
      return symbols.slice(0, MAX_SYMBOLS).map(toItem);
    } catch (err) {
      logger.info("CapixContext symbols unavailable", { error: String(err) });
      return [];
    }
  }

  // ── Terminal ────────────────────────────────────────────────────────────

  /** Open terminals plus captured output of the active one, when available. */
  getTerminalContext(): CapixTerminalContext {
    const active = vscode.window.activeTerminal;
    const terminals = vscode.window.terminals.map((t) => ({
      name: t.name,
      isActive: t === active,
    }));
    let lastOutput = this.terminalCapture?.();
    if (lastOutput) {
      const lines = lastOutput.split("\n");
      if (lines.length > MAX_TERMINAL_LINES) {
        lastOutput = `…(${lines.length - MAX_TERMINAL_LINES} lines omitted)\n${lines.slice(-MAX_TERMINAL_LINES).join("\n")}`;
      }
    }
    return { terminals, lastOutput };
  }

  // ── Assembly ────────────────────────────────────────────────────────────

  /** Collect the full IDE context snapshot. Every collector is failure-isolated. */
  async collect(): Promise<CapixIdeContext> {
    const [project, git, symbols] = await Promise.all([
      this.getProjectStructure().catch(() => ({
        folders: [] as string[],
        tree: [] as string[],
        truncated: false,
      })),
      this.getGitContext().catch(() => undefined),
      this.getActiveFileSymbols().catch(() => [] as CapixSymbolItem[]),
    ]);
    return {
      activeFile: this.getActiveFileContext(),
      project,
      git,
      diagnostics: this.getDiagnostics(),
      symbols,
      terminal: this.getTerminalContext(),
    };
  }

  /**
   * Render a context snapshot as a compact prompt block for inlining into an
   * outbound assistant message.
   */
  formatForPrompt(context: CapixIdeContext): string {
    const parts: string[] = [];

    if (context.activeFile) {
      const f = context.activeFile;
      const sel = f.selection
        ? ` selection L${f.selection.startLine}-${f.selection.endLine}`
        : ` cursor L${f.line}:${f.character}`;
      parts.push(
        `<active-file path="${f.path}" language="${f.language}" lines="${f.lineCount}"${sel}>\n${f.snippet}\n</active-file>`,
      );
    }

    if (context.project.tree.length) {
      const suffix = context.project.truncated ? "\n…(tree truncated)" : "";
      parts.push(
        `<project folders="${context.project.folders.join(", ")}">\n${context.project.tree.join("\n")}${suffix}\n</project>`,
      );
    }

    if (context.git) {
      const g = context.git;
      const sync = g.ahead || g.behind ? ` (ahead ${g.ahead}, behind ${g.behind})` : "";
      const changes = g.changes.length
        ? `\n${g.changes.map((c) => `${c.status} ${c.path}`).join("\n")}`
        : " (clean working tree)";
      parts.push(`<git branch="${g.branch}"${sync}>${changes}\n</git>`);
    }

    if (context.diagnostics.length) {
      const lines = context.diagnostics.map(
        (d) => `${d.severity} ${d.path}:${d.line} ${d.message}${d.source ? ` [${d.source}]` : ""}`,
      );
      parts.push(`<diagnostics>\n${lines.join("\n")}\n</diagnostics>`);
    }

    if (context.symbols.length) {
      const lines = context.symbols.map((s) => `${s.kind} ${s.name} (L${s.line})`);
      parts.push(`<symbols>\n${lines.join("\n")}\n</symbols>`);
    }

    if (context.terminal.lastOutput) {
      parts.push(`<terminal>\n${context.terminal.lastOutput}\n</terminal>`);
    }

    return parts.join("\n\n");
  }
}
