/**
 * Capix Assistant — the redesigned webview chat surface.
 *
 * A modern, Cursor-grade chat interface rendered in a webview and driven by
 * the SHARED Capix agent runtime (`AgentRuntimeEngine`) — the same runtime,
 * durable session store and permission model as the Capix Code CLI/TUI.
 *
 * Surface:
 *   • streaming markdown chat with dependency-free rendering
 *   • code blocks with lightweight syntax highlighting and a copy button
 *   • inline diff previews with per-file accept / reject
 *   • tool cards and approval gates with clear Approve / Deny actions
 *   • per-turn cost + receipt display and session spend in the composer
 *   • model / mode / connection indicators in the header
 *   • context attachments (active file, selection, project, diagnostics,
 *     terminal) assembled by `CapixContextProvider`
 *
 * Styling lives in `src/styles/assistant.css` (token-driven, dark/light/HC)
 * and is linked as a webview resource; the inline script below is rendering
 * logic only. All colors flow from CSS custom properties so the panel sits
 * natively inside any workbench theme.
 *
 * Design tokens (@capix/ui-tokens): dark foundation, cyan accents (#3DCED6),
 * green primary (#14F195), amber (#FFAE00), red (#FF6464).
 */

import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { CapixClient } from "./apiClient";
import { AgentRuntimeEngine, type EngineEvent, type EngineMode } from "./agentRuntimeEngine";
import { CapixContextProvider } from "./contextProvider";
import { queryMcpInfraContext, type McpToolHost } from "./mcpInfraContext";
import { logger } from "./logger";

type ComposerMode = EngineMode;

/** A pending context attachment, inlined into the next submitted message. */
interface PendingContext {
  id: string;
  label: string;
  block: string;
}

const MODES: Array<{ id: ComposerMode; label: string; color: string }> = [
  { id: "ask", label: "Ask", color: "#3dced6" },
  { id: "plan", label: "Plan", color: "#8fd9de" },
  { id: "build", label: "Build", color: "#14f195" },
  { id: "debug", label: "Debug", color: "#ffae00" },
  { id: "review", label: "Review", color: "#b48cff" },
];

let nextContextId = 1;

export class CapixAssistantPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "capix.assistant.panel";

  private view?: vscode.WebviewView;
  private configured = false;
  private streaming = false;
  private model = "auto";
  private mode: ComposerMode = "ask";
  private costUsd = 0;
  private engineStarted = false;
  private pendingContext: PendingContext[] = [];

  private readonly engine: AgentRuntimeEngine;
  private readonly context = new CapixContextProvider();

  /** Debounce handle for refreshing the diff dock after file_changed events. */
  private diffRefreshTimer: NodeJS.Timeout | null = null;

  constructor(
    private client: CapixClient,
    private extensionUri: vscode.Uri,
  ) {
    this.engine = new AgentRuntimeEngine({ client });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    this.bootState();
  }

  /** Start a fresh session and clear the visible conversation. */
  newSession(): void {
    this.costUsd = 0;
    this.streaming = false;
    this.pendingContext = [];
    this.view?.webview.postMessage({ type: "cleared" });
    this.view?.webview.postMessage({ type: "diffPanel", files: [] });
    this.pushState();
  }

  /** Expand/focus the panel. */
  focus(): void {
    vscode.commands.executeCommand("capix.code.focus");
  }

  /** Update the active model from the global model picker. */
  setModel(model: string): void {
    this.model = model;
    this.pushState();
  }

  /** Accept all agent file changes. */
  async acceptAll(): Promise<void> {
    try {
      await this.engine.acceptAll();
      await this.refreshDiffPanel();
    } catch (err) {
      this.reportError("Could not accept changes", err);
    }
  }

  /** Revert all agent file changes. */
  async revertAll(): Promise<void> {
    try {
      await this.engine.revertAll();
      await this.refreshDiffPanel();
    } catch (err) {
      this.reportError("Could not revert changes", err);
    }
  }

  /** Cancel the current agent turn. */
  async cancelTurn(): Promise<void> {
    try {
      await this.engine.cancel();
    } catch (err) {
      logger.error("CapixAssistant cancel failed", { error: String(err) });
    }
  }

  // ── State ────────────────────────────────────────────────────────────────

  private async bootState(): Promise<void> {
    const config = vscode.workspace.getConfiguration("capix");
    this.model = config.get<string>("ai.model") || "auto";
    this.configured = await this.client.checkConfigured();
    this.pushState();
    this.pushContextSnapshot();
    void this.pushInfraContext();
  }

  private pushState(): void {
    const state = this.engine.getSessionState();
    this.view?.webview.postMessage({
      type: "state",
      configured: this.configured,
      model: this.model,
      mode: this.mode,
      project: vscode.workspace.workspaceFolders?.[0]?.name ?? "—",
      streaming: this.streaming,
      engineStatus: this.engineStarted ? "online" : "offline",
      sessionId: state.sessionId ?? "",
      costUsd: this.costUsd,
    });
  }

  /** Push the ambient IDE context indicators (active file, git, diagnostics). */
  private async pushContextSnapshot(): Promise<void> {
    try {
      const snapshot = await this.context.collect();
      this.view?.webview.postMessage({
        type: "ideContext",
        activeFile: snapshot.activeFile
          ? {
              path: snapshot.activeFile.path,
              language: snapshot.activeFile.language,
              hasSelection: Boolean(snapshot.activeFile.selection),
            }
          : undefined,
        git: snapshot.git
          ? { branch: snapshot.git.branch, changes: snapshot.git.changes.length }
          : undefined,
        diagnostics: snapshot.diagnostics.length,
      });
    } catch (err) {
      logger.info("CapixAssistant context snapshot failed", { error: String(err) });
    }
  }

  /**
   * Push the infra context indicator (deployments, nodes, wallet, marketplace)
   * sourced from the Capix MCP server's read-only infra-context tools — the
   * panel never calls the infra API directly. When the MCP server is not
   * registered (signed out / older editor) the snapshot is null and the
   * webview hides the indicator.
   */
  private async pushInfraContext(): Promise<void> {
    try {
      const lm = (vscode as { lm?: McpToolHost }).lm;
      if (!lm || typeof lm.invokeTool !== "function") return;
      const snapshot = await queryMcpInfraContext(lm, (message) =>
        logger.info("CapixAssistant infra context", { error: message }),
      );
      this.view?.webview.postMessage({ type: "infraContext", snapshot });
    } catch (err) {
      logger.info("CapixAssistant infra context failed", { error: String(err) });
    }
  }

  private reportError(prefix: string, err: unknown): void {
    const message = `${prefix} — ${String(err)}`;
    logger.error("CapixAssistant", { error: message });
    this.view?.webview.postMessage({ type: "error", message });
  }

  // ── Engine wiring ────────────────────────────────────────────────────────

  private workspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  }

  /**
   * Ensure the shared agent runtime has a session for this workspace.
   * Inference auth rides on the broker-backed CapixClient — no credentials
   * are placed into any child-process environment.
   */
  private async ensureEngine(): Promise<void> {
    if (this.engineStarted) return;
    const configured = await this.client.checkConfigured();
    if (!configured) {
      this.view?.webview.postMessage({
        type: "error",
        message: "Sign in to start a Capix session.",
      });
      return;
    }

    const root = this.workspaceRoot();
    if (!root) {
      this.view?.webview.postMessage({
        type: "error",
        message: "Open a workspace folder to begin.",
      });
      return;
    }

    try {
      await this.engine.start(root);
      this.engineStarted = true;
      this.pushState();
    } catch (err) {
      this.reportError("Could not start the Capix agent runtime", err);
    }
  }

  // ── Incoming webview messages ────────────────────────────────────────────

  private handleMessage(msg: {
    type: string;
    text?: string;
    mode?: ComposerMode;
    model?: string;
    kind?: string;
    chipId?: string;
    callId?: string;
    approved?: boolean;
    filePath?: string;
    copyText?: string;
  }): void {
    switch (msg.type) {
      case "submit":
        if (msg.text) void this.handleSubmit(msg.text, msg.mode ?? this.mode);
        break;
      case "stop":
        void this.cancelTurn();
        break;
      case "newSession":
        this.newSession();
        break;
      case "setMode":
        if (msg.mode) {
          this.mode = msg.mode;
          this.pushState();
        }
        break;
      case "setModel":
        if (msg.model) {
          this.model = msg.model;
          this.pushState();
        }
        break;
      case "attach":
        void this.attach(msg.kind ?? "file");
        break;
      case "clearChip":
        this.pendingContext = this.pendingContext.filter((c) => c.id !== msg.chipId);
        this.pushChips();
        break;
      case "approve":
        if (msg.callId) void this.engine.approveTool(msg.callId, !!msg.approved);
        break;
      case "acceptFile":
        if (msg.filePath) void this.acceptFile(msg.filePath);
        break;
      case "revertFile":
        if (msg.filePath) void this.revertFile(msg.filePath);
        break;
      case "acceptAll":
        void this.acceptAll();
        break;
      case "revertAll":
        void this.revertAll();
        break;
      case "checkpoint":
        void this.checkpoint();
        break;
      case "copy":
        // Fallback when the webview clipboard API is unavailable.
        if (msg.copyText) void vscode.env.clipboard.writeText(msg.copyText);
        break;
      case "refreshContext":
        void this.pushContextSnapshot();
        void this.pushInfraContext();
        break;
      case "signIn":
        vscode.commands.executeCommand("capix.resetSessionAndSignIn");
        break;
    }
  }

  private async acceptFile(filePath: string): Promise<void> {
    try {
      await this.engine.acceptFile(filePath);
      await this.refreshDiffPanel();
    } catch (err) {
      this.reportError("Could not accept file", err);
    }
  }

  private async revertFile(filePath: string): Promise<void> {
    try {
      await this.engine.revertFile(filePath);
      await this.refreshDiffPanel();
    } catch (err) {
      this.reportError("Could not revert file", err);
    }
  }

  private async checkpoint(): Promise<void> {
    try {
      const id = await this.engine.checkpoint();
      this.view?.webview.postMessage({ type: "checkpointCreated", id });
    } catch (err) {
      this.reportError("Could not create checkpoint", err);
    }
  }

  // ── Context attachments ──────────────────────────────────────────────────

  private pushChips(): void {
    this.view?.webview.postMessage({
      type: "chips",
      chips: this.pendingContext.map((c) => ({ id: c.id, label: c.label })),
    });
  }

  /** Build a context attachment of the requested kind and pin it as a chip. */
  private async attach(kind: string): Promise<void> {
    try {
      if (kind === "file" || kind === "selection") {
        const active = this.context.getActiveFileContext();
        if (!active) {
          vscode.window.showInformationMessage("Capix: open a file to attach it as context.");
          return;
        }
        if (kind === "selection" && !active.selection) {
          vscode.window.showInformationMessage("Capix: select code first to attach a selection.");
          return;
        }
        const sel = active.selection;
        const body = kind === "selection" && sel ? sel.text : active.snippet;
        const label =
          kind === "selection" && sel
            ? `${active.path} L${sel.startLine}-${sel.endLine}`
            : active.path;
        this.pendingContext.push({
          id: `ctx-${nextContextId++}`,
          label,
          block: `<context kind="${kind}" name="${label}" language="${active.language}">\n${body}\n</context>`,
        });
      } else if (kind === "project") {
        const snapshot = await this.context.collect();
        const block = this.context.formatForPrompt({
          ...snapshot,
          activeFile: undefined,
          terminal: { terminals: [] },
          diagnostics: [],
          symbols: [],
        });
        this.pendingContext.push({
          id: `ctx-${nextContextId++}`,
          label: "Project structure",
          block,
        });
      } else if (kind === "diagnostics") {
        const diagnostics = this.context.getDiagnostics();
        if (!diagnostics.length) {
          vscode.window.showInformationMessage("Capix: no diagnostics in the workspace.");
          return;
        }
        const lines = diagnostics.map(
          (d) => `${d.severity} ${d.path}:${d.line} ${d.message}`,
        );
        this.pendingContext.push({
          id: `ctx-${nextContextId++}`,
          label: `${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"}`,
          block: `<context kind="diagnostics">\n${lines.join("\n")}\n</context>`,
        });
      } else if (kind === "terminal") {
        const terminal = this.context.getTerminalContext();
        if (!terminal.lastOutput) {
          vscode.window.showInformationMessage(
            "Capix: no terminal output captured yet.",
          );
          return;
        }
        this.pendingContext.push({
          id: `ctx-${nextContextId++}`,
          label: "Terminal output",
          block: `<context kind="terminal">\n${terminal.lastOutput}\n</context>`,
        });
      }
      this.pushChips();
    } catch (err) {
      this.reportError("Could not attach context", err);
    }
  }

  // ── Submit / stream ──────────────────────────────────────────────────────

  private async handleSubmit(text: string, mode: ComposerMode): Promise<void> {
    if (this.streaming) return;
    await this.ensureEngine();
    if (!this.engineStarted) return;

    this.mode = mode;

    let content = text;
    let contextFiles: string[] | undefined;
    if (this.pendingContext.length) {
      content += `\n\n${this.pendingContext.map((c) => c.block).join("\n")}`;
      contextFiles = this.pendingContext.map((c) => c.label);
      this.pendingContext = [];
      this.pushChips();
    }

    this.streaming = true;
    this.view?.webview.postMessage({ type: "turn", role: "user", content: text });
    this.view?.webview.postMessage({ type: "streamStart", mode });
    this.view?.webview.postMessage({ type: "streaming", value: true });
    this.pushState();

    try {
      for await (const evt of this.engine.sendMessage(content, {
        mode,
        model: this.model,
        contextFiles,
      })) {
        this.onEngineEvent(evt);
        if (evt.type === "done" || evt.type === "error") break;
      }
      this.view?.webview.postMessage({ type: "streamDone" });
    } catch (err) {
      this.view?.webview.postMessage({
        type: "error",
        message: `Capix request failed — ${String(err)}`,
      });
    } finally {
      this.streaming = false;
      this.view?.webview.postMessage({ type: "streaming", value: false });
      this.pushState();
      void this.pushContextSnapshot();
    }
  }

  private onEngineEvent(evt: EngineEvent): void {
    // Forward every event to the webview for rendering.
    this.view?.webview.postMessage({ type: "engineEvent", event: evt });

    if (evt.type === "usage") {
      const costMinor = Number(evt.costMinor || 0);
      // costMinor is in micro-units (1/10000 dollar) per the gateway.
      this.costUsd += costMinor / 10000;
      this.view?.webview.postMessage({
        type: "usage",
        inputTokens: evt.inputTokens,
        outputTokens: evt.outputTokens,
        costUsd: this.costUsd,
      });
    } else if (evt.type === "file_changed") {
      this.scheduleDiffRefresh();
    }
  }

  // ── Diff dock ────────────────────────────────────────────────────────────

  private scheduleDiffRefresh(): void {
    if (this.diffRefreshTimer) clearTimeout(this.diffRefreshTimer);
    this.diffRefreshTimer = setTimeout(() => {
      void this.refreshDiffPanel();
    }, 400);
  }

  private async refreshDiffPanel(): Promise<void> {
    try {
      const files = await this.engine.getDiff();
      this.view?.webview.postMessage({ type: "diffPanel", files });
    } catch (err) {
      logger.error("CapixAssistant getDiff failed", { error: String(err) });
    }
  }

  // ── HTML ──────────────────────────────────────────────────────────────────

  private getHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString("base64");
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "src", "styles", "assistant.css"),
    );
    const csp =
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ` +
      `style-src ${webview.cspSource} 'unsafe-inline'; ` +
      `font-src ${webview.cspSource}; img-src ${webview.cspSource} data:; ` +
      `script-src 'nonce-${nonce}';">`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
${csp}
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${cssUri}">
</head>
<body>
  <div class="cpx-app">
    <header class="cpx-header">
      <div class="cpx-brand">
        <span class="cpx-brand__mark"></span>
        <span class="cpx-brand__name">Capix</span>
      </div>
      <span class="cpx-conn" id="conn-dot" title="Engine status"></span>
      <button class="cpx-hbtn" data-cmd="checkpoint" title="Create checkpoint">&#128190;</button>
      <button class="cpx-hbtn" data-cmd="newSession" title="New session">&#65291;</button>
    </header>

    <div class="cpx-indicators" id="indicators">
      <span class="cpx-indicator" id="ind-project" title="Project"><span class="cpx-indicator__label">—</span></span>
      <span class="cpx-indicator cpx-indicator--mode" id="ind-mode" title="Mode"><span class="cpx-indicator__dot"></span><span class="cpx-indicator__label">Ask</span></span>
      <span class="cpx-indicator cpx-indicator--model" id="ind-model" title="Model"><span class="cpx-indicator__label">auto</span></span>
      <span class="cpx-indicator" id="ind-infra" title="Capix infra (via MCP)" hidden><span class="cpx-indicator__label"></span></span>
      <span class="cpx-indicator" id="ind-git" title="Git" hidden><span class="cpx-indicator__label"></span></span>
      <span class="cpx-indicator" id="ind-file" title="Active file" hidden><span class="cpx-indicator__label"></span></span>
    </div>

    <div id="banner-slot"></div>

    <main class="cpx-conversation" id="conversation" aria-live="polite">
      <div class="cpx-empty" id="empty-state">
        <div class="cpx-empty__glyph">&#10022;</div>
        <div class="cpx-empty__title">Build from here.</div>
        <div class="cpx-empty__sub">Capix understands your project, edits files, runs commands and verifies the result.</div>
        <div class="cpx-empty__starters">
          <button class="cpx-starter" data-prompt="Map this codebase and tell me where to start">Map this codebase <span class="cpx-starter__arrow">&rarr;</span></button>
          <button class="cpx-starter" data-prompt="Find the highest-impact bug in this workspace and fix it">Find and fix a bug <span class="cpx-starter__arrow">&rarr;</span></button>
          <button class="cpx-starter" data-prompt="Review the current changes and identify production risks">Review current changes <span class="cpx-starter__arrow">&rarr;</span></button>
        </div>
        <div class="cpx-empty__hint"><kbd>&#8984;&#8629;</kbd> send &nbsp;&middot;&nbsp; <kbd>@</kbd> attach context</div>
      </div>
    </main>

    <section class="cpx-diffdock" id="diff-dock" hidden></section>

    <footer class="cpx-composer">
      <div class="cpx-composer__modes" id="mode-row">
        ${MODES.map(
          (m) =>
            `<button class="cpx-mode${m.id === "ask" ? " cpx-mode--active" : ""}" data-mode="${m.id}"><span class="cpx-mode__dot" style="background:${m.color}"></span>${m.label}</button>`,
        ).join("")}
      </div>
      <div class="cpx-attachbar" id="attach-bar"></div>
      <div class="cpx-composer__box">
        <textarea id="composer-input" class="cpx-composer__input" placeholder="Ask, plan, build&hellip;" rows="1" aria-label="Message Capix"></textarea>
        <div class="cpx-composer__bar">
          <button class="cpx-iconbtn" id="attach-btn" title="Attach context" aria-label="Attach context">&#128206;</button>
          <select class="cpx-composer__model" id="model-select" title="Model" aria-label="Model">
            <option value="auto">Auto &middot; task-aware</option>
          </select>
          <button class="cpx-stop" id="stop-btn" data-cmd="stop" hidden><i></i><span>Stop</span></button>
          <button class="cpx-send" id="send-btn" data-cmd="submit" title="Send (Enter)" aria-label="Send message">&uarr;</button>
        </div>
      </div>
      <div class="cpx-composer__meta">
        <span class="cpx-cost" id="cost-line"></span>
        <span class="cpx-composer__hint"><kbd>&#8629;</kbd> send &middot; <kbd>&#8679;&#8629;</kbd> newline</span>
      </div>
    </footer>
  </div>

  <script nonce="${nonce}">${PANEL_SCRIPT}</script>
</body>
</html>`;
  }
}

// ── Inline webview script ───────────────────────────────────────────────────
// Rendering logic only; all styling lives in styles/assistant.css. Written
// without template literals so it can embed inside the HTML template above.
const PANEL_SCRIPT = `
(function () {
  "use strict";
  var vscode = acquireVsCodeApi();
  var conversation = document.getElementById("conversation");
  var emptyState = document.getElementById("empty-state");
  var input = document.getElementById("composer-input");
  var sendBtn = document.getElementById("send-btn");
  var stopBtn = document.getElementById("stop-btn");
  var costLine = document.getElementById("cost-line");
  var connDot = document.getElementById("conn-dot");
  var attachBar = document.getElementById("attach-bar");
  var diffDock = document.getElementById("diff-dock");
  var bannerSlot = document.getElementById("banner-slot");
  var modelSelect = document.getElementById("model-select");
  var indFile = document.getElementById("ind-file");
  var indGit = document.getElementById("ind-git");
  var indInfra = document.getElementById("ind-infra");

  var streaming = false;
  var currentBubble = null;   // assistant bubble receiving streamed text
  var currentText = "";
  var currentBody = null;     // .cpx-md element inside currentBubble
  var toolCards = {};         // callId -> card element
  var copiedTimer = null;
  var renderQueued = false;
  var codeStore = [];         // raw code for copy buttons
  var stickToBottom = true;
  var sessionIdShort = "";

  // ── Helpers ─────────────────────────────────────────────────────────────

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function post(msg) { vscode.postMessage(msg); }

  function hideEmpty() { if (emptyState) emptyState.style.display = "none"; }

  function noteStick() {
    stickToBottom =
      conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 48;
  }

  function scrollIfStuck() {
    if (stickToBottom) conversation.scrollTop = conversation.scrollHeight;
  }

  function fmtCost(usd) {
    return "$" + (usd || 0).toFixed(4);
  }

  // ── Markdown (dependency-free, escape-first) ────────────────────────────

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  var KEYWORDS =
    "^(?:abstract|async|await|break|case|catch|class|const|continue|default|defer|do|else|enum|export|extends|false|finally|for|from|func|function|go|if|implements|import|in|interface|let|match|new|null|package|private|protected|public|return|static|struct|super|switch|this|throw|true|try|type|typeof|undefined|var|void|while|yield)$";

  function highlight(escaped) {
    // Order matters: comments and strings become placeholders first so
    // keyword/number passes never touch them.
    var kept = [];
    function keep(html) {
      kept.push(html);
      return "\\u0000" + (kept.length - 1) + "\\u0000";
    }
    var out = escaped;
    out = out.replace(/(\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*|#[^\\n]*)/g, function (m) {
      return keep('<span class="tok-c">' + m + "</span>");
    });
    out = out.replace(/(&quot;[^&]*?&quot;|"[^"\\n]*"|'[^'\\n]*'|\`[^\`]*\`)/g, function (m) {
      return keep('<span class="tok-s">' + m + "</span>");
    });
    out = out.replace(/\\b(\\d[\\d_]*(?:\\.\\d+)?(?:x[0-9a-fA-F]+)?)\\b/g, '<span class="tok-n">$1</span>');
    out = out.replace(/\\b([A-Za-z_][A-Za-z0-9_]*)\\b(?=\\s*\\()/g, '<span class="tok-f">$1</span>');
    out = out.replace(/\\b([A-Za-z_][A-Za-z0-9_]*)\\b/g, function (m) {
      return new RegExp(KEYWORDS).test(m) ? '<span class="tok-k">' + m + "</span>" : m;
    });
    out = out.replace(/\\u0000(\\d+)\\u0000/g, function (_m, i) { return kept[Number(i)]; });
    return out;
  }

  function inlineMd(escaped) {
    var out = escaped;
    out = out.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
    out = out.replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[^*])\\*([^*\\n]+)\\*/g, "$1<em>$2</em>");
    out = out.replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    return out;
  }

  /** Render markdown text into HTML. Raw code blocks are stored for copy. */
  function renderMarkdown(text) {
    var blocks = [];
    var src = text.replace(/\`\`\`([A-Za-z0-9_+#.-]*)\\n?([\\s\\S]*?)(?:\`\`\`|$)/g, function (_m, lang, code) {
      blocks.push({ lang: (lang || "").toLowerCase(), code: code.replace(/\\n$/, "") });
      return "\\u0001" + (blocks.length - 1) + "\\u0001";
    });

    var lines = escapeHtml(src).split("\\n");
    var html = [];
    var para = [];
    var list = null;

    function flushPara() {
      if (para.length) {
        html.push("<p>" + inlineMd(para.join("\\n")) + "</p>");
        para = [];
      }
    }
    function flushList() {
      if (list) {
        html.push("<" + list.tag + ">" + list.items.map(function (i) { return "<li>" + inlineMd(i) + "</li>"; }).join("") + "</" + list.tag + ">");
        list = null;
      }
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      // Code-block placeholders survived escaping (control chars are untouched).
      var rawPh = new RegExp("^\\\\u0001(\\\\d+)\\\\u0001$").exec(line.trim());

      if (rawPh) {
        flushPara(); flushList();
        var b = blocks[Number(rawPh[1])];
        var idx = codeStore.push(b.code) - 1;
        html.push(
          '<div class="cpx-code"><div class="cpx-code__bar"><span class="cpx-code__lang">' +
            (b.lang || "code") +
            '</span><button class="cpx-code__copy" data-code-idx="' + idx + '">Copy</button></div><pre><code>' +
            highlight(escapeHtml(b.code)) +
            "</code></pre></div>"
        );
        continue;
      }

      var h = /^(#{1,4})\\s+(.*)$/.exec(line);
      if (h) {
        flushPara(); flushList();
        var level = h[1].length;
        html.push("<h" + level + ">" + inlineMd(h[2]) + "</h" + level + ">");
        continue;
      }
      if (/^\\s*(-{3,}|\\*{3,})\\s*$/.test(line)) {
        flushPara(); flushList();
        html.push("<hr>");
        continue;
      }
      var quote = /^&gt;\\s?(.*)$/.exec(line);
      if (quote) {
        flushPara(); flushList();
        html.push("<blockquote>" + inlineMd(quote[1]) + "</blockquote>");
        continue;
      }
      var ul = /^\\s*[-*]\\s+(.*)$/.exec(line);
      var ol = /^\\s*\\d+\\.\\s+(.*)$/.exec(line);
      if (ul || ol) {
        flushPara();
        var tag = ul ? "ul" : "ol";
        if (!list || list.tag !== tag) { flushList(); list = { tag: tag, items: [] }; }
        list.items.push((ul || ol)[1]);
        continue;
      }
      if (line.trim() === "") {
        flushPara(); flushList();
        continue;
      }
      flushList();
      para.push(line);
    }
    flushPara(); flushList();
    return html.join("");
  }

  // ── Conversation primitives ─────────────────────────────────────────────

  function addEntry(node) {
    hideEmpty();
    noteStick();
    conversation.appendChild(node);
    scrollIfStuck();
    return node;
  }

  function addUserMessage(text) {
    var msg = el("div", "cpx-entry cpx-msg cpx-msg--user");
    msg.appendChild(el("div", "cpx-msg__role", "You"));
    msg.appendChild(el("div", "cpx-msg__bubble", text));
    addEntry(msg);
  }

  function startAssistantMessage() {
    var msg = el("div", "cpx-entry cpx-msg cpx-msg--assistant");
    var role = el("div", "cpx-msg__role", "Capix");
    var dot = el("span", "cpx-conn cpx-conn--working");
    role.appendChild(dot);
    currentBubble = el("div", "cpx-msg__bubble");
    currentBody = el("div", "cpx-md");
    var typing = el("span", "cpx-typing");
    typing.appendChild(el("i")); typing.appendChild(el("i")); typing.appendChild(el("i"));
    currentBody.appendChild(typing);
    currentBubble.appendChild(currentBody);
    msg.appendChild(role);
    msg.appendChild(currentBubble);
    currentText = "";
    addEntry(msg);
  }

  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(function () {
      renderQueued = false;
      if (!currentBody) return;
      noteStick();
      currentBody.innerHTML = renderMarkdown(currentText);
      if (streaming) {
        var cursor = el("span", "cpx-cursor");
        currentBody.appendChild(cursor);
      }
      bindCopyButtons(currentBody);
      scrollIfStuck();
    });
  }

  function finishAssistantMessage() {
    if (currentBody) {
      currentBody.innerHTML = renderMarkdown(currentText);
      bindCopyButtons(currentBody);
    }
    currentBubble = null;
    currentBody = null;
    currentText = "";
  }

  function bindCopyButtons(scope) {
    var buttons = scope.querySelectorAll(".cpx-code__copy");
    for (var i = 0; i < buttons.length; i++) {
      (function (btn) {
        if (btn.dataset.bound) return;
        btn.dataset.bound = "1";
        btn.addEventListener("click", function () {
          var idx = Number(btn.getAttribute("data-code-idx"));
          var code = codeStore[idx] || "";
          function done() {
            btn.textContent = "Copied";
            btn.classList.add("cpx-code__copy--done");
            if (copiedTimer) clearTimeout(copiedTimer);
            copiedTimer = setTimeout(function () {
              btn.textContent = "Copy";
              btn.classList.remove("cpx-code__copy--done");
            }, 1400);
          }
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(code).then(done, function () {
              post({ type: "copy", copyText: code });
              done();
            });
          } else {
            post({ type: "copy", copyText: code });
            done();
          }
        });
      })(buttons[i]);
    }
  }

  // ── Tool cards / approvals / plans ───────────────────────────────────────

  function toolLabel(args) {
    if (!args || typeof args !== "object") return "";
    var a = args;
    return a.path || a.filePath || a.file || a.command || a.cmd || a.query || a.description || "";
  }

  function addToolCard(evt) {
    var card = el("div", "cpx-entry cpx-tool");
    var head = el("div", "cpx-tool__head");
    head.appendChild(el("span", "cpx-tool__spinner"));
    head.appendChild(el("span", "cpx-tool__name", evt.tool));
    head.appendChild(el("span", "cpx-tool__label", String(toolLabel(evt.args) || "")));
    head.appendChild(el("span", "cpx-badge cpx-badge--accent", "running"));
    card.appendChild(head);
    head.addEventListener("click", function () { card.classList.toggle("cpx-tool--open"); });
    toolCards[evt.callId] = card;
    addEntry(card);
  }

  function resolveToolCard(evt) {
    var card = toolCards[evt.callId];
    if (!card) return;
    var spinner = card.querySelector(".cpx-tool__spinner");
    if (spinner) spinner.remove();
    var badge = card.querySelector(".cpx-badge");
    if (badge) {
      badge.textContent = "done";
      badge.className = "cpx-badge cpx-badge--success";
    }
    if (evt.output) {
      var body = card.querySelector(".cpx-tool__body") || el("div", "cpx-tool__body");
      var out = el("pre", "cpx-tool__out", evt.output.length > 4000 ? evt.output.slice(0, 4000) + "\\n…(truncated)" : evt.output);
      body.appendChild(out);
      card.appendChild(body);
    }
  }

  function addApprovalCard(evt) {
    var card = el("div", "cpx-entry cpx-approval");
    var head = el("div", "cpx-approval__head");
    head.appendChild(el("span", undefined, "&#9888;"));
    head.appendChild(el("span", undefined, "Approval required — " + evt.tool));
    card.appendChild(head);
    card.appendChild(el("div", "cpx-approval__desc", evt.description || ""));
    var actions = el("div", "cpx-approval__actions");
    var approve = el("button", "cpx-approval__btn cpx-approval__btn--approve", "Approve");
    var deny = el("button", "cpx-approval__btn cpx-approval__btn--deny", "Deny");
    function resolve(approved, btn) {
      post({ type: "approve", callId: evt.callId, approved: approved });
      card.classList.add("cpx-approval--resolved");
      head.lastChild.textContent =
        "Approval " + (approved ? "granted" : "denied") + " — " + evt.tool;
    }
    approve.addEventListener("click", function () { resolve(true, approve); });
    deny.addEventListener("click", function () { resolve(false, deny); });
    actions.appendChild(approve);
    actions.appendChild(deny);
    card.appendChild(actions);
    addEntry(card);
  }

  function normalizePlan(plan) {
    // Accepts: string[] | { steps: [{label|title, status?}] } | { title, steps }
    if (Array.isArray(plan)) {
      return {
        title: "Plan",
        steps: plan.map(function (s) {
          return { label: typeof s === "string" ? s : String(s.label || s.title || s), status: "todo" };
        }),
      };
    }
    if (plan && typeof plan === "object") {
      var steps = Array.isArray(plan.steps) ? plan.steps : [];
      return {
        title: plan.title || "Plan",
        steps: steps.map(function (s) {
          return {
            label: String(s.label || s.title || s.description || s),
            status: s.status === "completed" || s.status === "done" ? "done"
              : s.status === "in-progress" || s.status === "active" ? "active"
              : s.status === "failed" ? "failed" : "todo",
          };
        }),
      };
    }
    return { title: "Plan", steps: [] };
  }

  var PLAN_MARKERS = { done: "✓", active: "◐", failed: "✗", todo: "○" };

  function addPlanCard(plan) {
    var normalized = normalizePlan(plan);
    var card = el("div", "cpx-entry cpx-plan cpx-plan--open");
    var head = el("div", "cpx-plan__head");
    head.appendChild(el("span", "cpx-plan__chev", "▶"));
    head.appendChild(el("span", undefined, normalized.title));
    var doneCount = normalized.steps.filter(function (s) { return s.status === "done"; }).length;
    head.appendChild(el("span", "cpx-badge cpx-badge--muted", doneCount + "/" + normalized.steps.length));
    head.addEventListener("click", function () { card.classList.toggle("cpx-plan--open"); });
    var body = el("div", "cpx-plan__body");
    normalized.steps.forEach(function (step) {
      var row = el("div", "cpx-plan__step cpx-plan__step--" + step.status);
      row.appendChild(el("span", "cpx-plan__marker", PLAN_MARKERS[step.status] || "○"));
      row.appendChild(el("span", undefined, step.label));
      body.appendChild(row);
    });
    var progress = el("div", "cpx-plan__progress");
    var fill = el("i");
    fill.style.width = normalized.steps.length ? (doneCount / normalized.steps.length) * 100 + "%" : "0%";
    progress.appendChild(fill);
    body.appendChild(progress);
    card.appendChild(head);
    card.appendChild(body);
    addEntry(card);
  }

  function addFileChip(evt) {
    var chip = el("div", "cpx-entry cpx-diffcard");
    var head = el("div", "cpx-diffcard__head");
    var tag = el(
      "span",
      "cpx-diffcard__tag cpx-diffcard__tag--" + evt.changeType,
      evt.changeType
    );
    head.appendChild(tag);
    head.appendChild(el("span", "cpx-diffcard__path", evt.filePath));
    chip.appendChild(head);
    addEntry(chip);
  }

  function addReceipt(inputTokens, outputTokens, costUsd) {
    var receipt = el(
      "div",
      "cpx-entry cpx-receipt",
      "turn " + inputTokens + "→" + outputTokens + " tok · " + fmtCost(costUsd) +
        (sessionIdShort ? " · ref " + sessionIdShort : "")
    );
    addEntry(receipt);
  }

  function showBanner(kind, message, actions) {
    bannerSlot.textContent = "";
    var banner = el("div", "cpx-banner cpx-banner--" + kind);
    banner.appendChild(el("div", "cpx-banner__text", message));
    (actions || []).forEach(function (action) {
      var btn = el("button", "cpx-banner__btn", action.label);
      btn.addEventListener("click", action.run);
      banner.appendChild(btn);
    });
    bannerSlot.appendChild(banner);
  }

  function addErrorCard(message) {
    var card = el("div", "cpx-entry cpx-approval");
    card.style.borderColor = "var(--cpx-danger-line)";
    card.style.background = "var(--cpx-danger-soft)";
    var head = el("div", "cpx-approval__head");
    head.style.color = "var(--cpx-danger-fg)";
    head.appendChild(el("span", undefined, "✗"));
    head.appendChild(el("span", undefined, message));
    card.appendChild(head);
    addEntry(card);
  }

  // ── Diff dock ────────────────────────────────────────────────────────────

  function renderDiffDock(files) {
    diffDock.textContent = "";
    if (!files || !files.length) {
      diffDock.hidden = true;
      return;
    }
    diffDock.hidden = false;
    files.forEach(function (file) {
      var card = el("div", "cpx-diffcard");
      card.style.margin = "8px 12px";
      var head = el("div", "cpx-diffcard__head");
      head.appendChild(el("span", "cpx-diffcard__path", file.filePath));
      head.appendChild(el("span", "cpx-badge cpx-badge--warning", "changed"));
      card.appendChild(head);

      var body = el("pre", "cpx-diffcard__body");
      var lines = String(file.diff || "").split("\\n").slice(0, 120);
      lines.forEach(function (line) {
        if (/^(\\+\\+\\+|---|@@|diff |index )/.test(line)) return;
        var cls = line.startsWith("+") ? "cpx-diffcard__line--add"
          : line.startsWith("-") ? "cpx-diffcard__line--del"
          : "cpx-diffcard__line--ctx";
        body.appendChild(el("div", "cpx-diffcard__line " + cls, line || " "));
      });
      card.appendChild(body);

      var actions = el("div", "cpx-diffcard__actions");
      var accept = el("button", "cpx-diffcard__btn cpx-diffcard__btn--accept", "Accept");
      var reject = el("button", "cpx-diffcard__btn cpx-diffcard__btn--reject", "Reject");
      accept.addEventListener("click", function () {
        post({ type: "acceptFile", filePath: file.filePath });
        card.classList.add("cpx-diffcard--resolved");
        head.querySelector(".cpx-badge").className = "cpx-badge cpx-badge--success";
        head.querySelector(".cpx-badge").textContent = "accepted";
      });
      reject.addEventListener("click", function () {
        post({ type: "revertFile", filePath: file.filePath });
        card.classList.add("cpx-diffcard--resolved");
        head.querySelector(".cpx-badge").className = "cpx-badge cpx-badge--danger";
        head.querySelector(".cpx-badge").textContent = "rejected";
      });
      actions.appendChild(accept);
      actions.appendChild(reject);
      card.appendChild(actions);
      diffDock.appendChild(card);
    });
  }

  // ── Engine events ────────────────────────────────────────────────────────

  function onEngineEvent(evt) {
    switch (evt.type) {
      case "text":
        if (!currentBody) startAssistantMessage();
        currentText += evt.content || "";
        queueRender();
        break;
      case "tool_call":
        addToolCard(evt);
        break;
      case "tool_result":
        resolveToolCard(evt);
        break;
      case "approval_request":
        addApprovalCard(evt);
        break;
      case "plan":
        addPlanCard(evt.plan);
        break;
      case "file_changed":
        addFileChip(evt);
        break;
      case "usage":
        // costMinor is in micro-units (1/10000 dollar) per the gateway.
        lastCostUsd += Number(evt.costMinor || 0) / 10000;
        addReceipt(evt.inputTokens || 0, evt.outputTokens || 0, lastCostUsd);
        break;
      case "error":
        addErrorCard(evt.message || "Capix inference was interrupted.");
        break;
      case "done":
        finishAssistantMessage();
        break;
    }
  }

  // ── State / indicators ───────────────────────────────────────────────────

  var lastCostUsd = 0;

  function setStreaming(value) {
    streaming = value;
    sendBtn.hidden = value;
    stopBtn.hidden = !value;
    connDot.className = "cpx-conn " + (value ? "cpx-conn--working" : "cpx-conn--online");
    if (!value) finishAssistantMessage();
  }

  function applyState(msg) {
    if (msg.engineStatus) {
      connDot.className =
        "cpx-conn " + (streaming ? "cpx-conn--working" : msg.engineStatus === "online" ? "cpx-conn--online" : "cpx-conn--offline");
      connDot.title = "Engine " + msg.engineStatus;
    }
    if (msg.project) document.querySelector("#ind-project .cpx-indicator__label").textContent = msg.project;
    if (msg.mode) {
      var label = msg.mode.charAt(0).toUpperCase() + msg.mode.slice(1);
      document.querySelector("#ind-mode .cpx-indicator__label").textContent = label;
      var pills = document.querySelectorAll(".cpx-mode");
      for (var i = 0; i < pills.length; i++) {
        pills[i].classList.toggle("cpx-mode--active", pills[i].getAttribute("data-mode") === msg.mode);
      }
    }
    if (msg.model) document.querySelector("#ind-model .cpx-indicator__label").textContent = msg.model;
    if (msg.sessionId) sessionIdShort = String(msg.sessionId).slice(0, 8);
    if (typeof msg.costUsd === "number") {
      lastCostUsd = msg.costUsd;
      costLine.textContent = msg.costUsd > 0 ? "session " + fmtCost(msg.costUsd) : "";
    }
    if (msg.configured === false) {
      showBanner("info", "Sign in to start a Capix session.", [
        { label: "Sign in", run: function () { post({ type: "signIn" }); } },
      ]);
    } else if (bannerSlot.firstChild) {
      bannerSlot.textContent = "";
    }
  }

  // ── Message pump ─────────────────────────────────────────────────────────

  window.addEventListener("message", function (event) {
    var msg = event.data;
    switch (msg.type) {
      case "state":
        applyState(msg);
        break;
      case "turn":
        if (msg.role === "user") addUserMessage(msg.content || "");
        break;
      case "streamStart":
        startAssistantMessage();
        break;
      case "streamDone":
        finishAssistantMessage();
        break;
      case "streaming":
        setStreaming(!!msg.value);
        break;
      case "engineEvent":
        onEngineEvent(msg.event);
        break;
      case "usage":
        lastCostUsd = msg.costUsd;
        costLine.textContent = "session " + fmtCost(msg.costUsd);
        break;
      case "diffPanel":
        renderDiffDock(msg.files);
        break;
      case "chips":
        attachBar.textContent = "";
        (msg.chips || []).forEach(function (chip) {
          var node = el("span", "cpx-chip");
          node.appendChild(el("span", "cpx-chip__label", chip.label));
          var x = el("button", "cpx-chip__x", "×");
          x.setAttribute("aria-label", "Remove " + chip.label);
          x.addEventListener("click", function () { post({ type: "clearChip", chipId: chip.id }); });
          node.appendChild(x);
          attachBar.appendChild(node);
        });
        break;
      case "ideContext":
        if (msg.activeFile) {
          indFile.hidden = false;
          indFile.querySelector(".cpx-indicator__label").textContent =
            msg.activeFile.path + (msg.activeFile.hasSelection ? " · sel" : "");
        } else {
          indFile.hidden = true;
        }
        if (msg.git) {
          indGit.hidden = false;
          indGit.querySelector(".cpx-indicator__label").textContent =
            "⎇ " + msg.git.branch + (msg.git.changes ? " · " + msg.git.changes + "Δ" : "");
        } else {
          indGit.hidden = true;
        }
        break;
      case "infraContext":
        (function () {
          var s = msg.snapshot;
          if (!s) { indInfra.hidden = true; return; }
          var parts = [];
          if (typeof s.deploymentCount === "number") parts.push(s.deploymentCount + " dep");
          if (typeof s.nodesTotal === "number") parts.push((s.nodesOnline || 0) + "/" + s.nodesTotal + " nodes");
          if (s.walletUsd) parts.push("$" + s.walletUsd);
          if (!parts.length) { indInfra.hidden = true; return; }
          indInfra.hidden = false;
          indInfra.querySelector(".cpx-indicator__label").textContent = "⛁ " + parts.join(" · ");
          var tip = ["Capix infra (via MCP)"];
          if (typeof s.marketplaceOffers === "number") tip.push("marketplace offers: " + s.marketplaceOffers +
            (typeof s.cheapestOfferUsdPerHr === "number" ? " (from $" + s.cheapestOfferUsdPerHr.toFixed(4) + "/hr)" : ""));
          if (typeof s.modelCount === "number") tip.push("models: " + s.modelCount);
          if (typeof s.devTokenBalance === "number") tip.push("dev tokens: " + s.devTokenBalance);
          if (s.fetchedAt) tip.push("fetched: " + s.fetchedAt);
          indInfra.title = tip.join("\n");
        })();
        break;
      case "error":
        showBanner("error", msg.message || "Something went wrong.", [
          { label: "Dismiss", run: function () { bannerSlot.textContent = ""; } },
        ]);
        break;
      case "checkpointCreated":
        showBanner("info", "Checkpoint created (" + String(msg.id).slice(0, 8) + ").", [
          { label: "OK", run: function () { bannerSlot.textContent = ""; } },
        ]);
        break;
      case "cleared":
        conversation.textContent = "";
        conversation.appendChild(emptyState);
        emptyState.style.display = "";
        attachBar.textContent = "";
        diffDock.hidden = true;
        codeStore = [];
        toolCards = {};
        break;
    }
  });

  // ── Composer wiring ──────────────────────────────────────────────────────

  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
  }

  function currentMode() {
    var active = document.querySelector(".cpx-mode--active");
    return active ? active.getAttribute("data-mode") : "ask";
  }

  function submit() {
    var text = input.value.trim();
    if (!text || streaming) return;
    input.value = "";
    autosize();
    post({ type: "submit", text: text, mode: currentMode() });
  }

  input.addEventListener("input", autosize);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  sendBtn.addEventListener("click", submit);

  document.querySelectorAll(".cpx-mode").forEach(function (pill) {
    pill.addEventListener("click", function () {
      document.querySelectorAll(".cpx-mode").forEach(function (p) {
        p.classList.remove("cpx-mode--active");
      });
      pill.classList.add("cpx-mode--active");
      post({ type: "setMode", mode: pill.getAttribute("data-mode") });
    });
  });

  modelSelect.addEventListener("change", function () {
    post({ type: "setModel", model: modelSelect.value });
  });

  document.querySelectorAll("[data-cmd]").forEach(function (btn) {
    var cmd = btn.getAttribute("data-cmd");
    if (cmd === "submit" || cmd === "stop") {
      btn.addEventListener("click", function () {
        post({ type: cmd === "stop" ? "stop" : "submit" });
      });
      return;
    }
    btn.addEventListener("click", function () { post({ type: cmd }); });
  });

  // Attach popover.
  var ATTACH_KINDS = [
    { kind: "file", label: "◈ Active file" },
    { kind: "selection", label: "✂ Current selection" },
    { kind: "project", label: "◆ Project structure" },
    { kind: "diagnostics", label: "⚠ Diagnostics" },
    { kind: "terminal", label: "›_ Terminal output" },
  ];
  var attachMenu = null;
  document.getElementById("attach-btn").addEventListener("click", function () {
    if (attachMenu) { attachMenu.remove(); attachMenu = null; return; }
    attachMenu = el("div");
    attachMenu.style.cssText =
      "position:absolute;bottom:110px;left:12px;z-index:40;background:var(--cpx-surface-2);" +
      "border:1px solid var(--cpx-border-strong);border-radius:10px;box-shadow:var(--cpx-shadow);" +
      "padding:4px;min-width:190px;animation:cpx-enter 160ms var(--cpx-ease);";
    ATTACH_KINDS.forEach(function (item) {
      var row = el("button", undefined, item.label);
      row.style.cssText =
        "display:block;width:100%;text-align:left;background:none;border:none;color:var(--cpx-fg-2);" +
        "padding:7px 10px;border-radius:6px;cursor:pointer;font-size:12px;";
      row.addEventListener("mouseenter", function () { row.style.background = "var(--cpx-surface-3)"; });
      row.addEventListener("mouseleave", function () { row.style.background = "none"; });
      row.addEventListener("click", function () {
        post({ type: "attach", kind: item.kind });
        attachMenu.remove();
        attachMenu = null;
      });
      attachMenu.appendChild(row);
    });
    document.body.appendChild(attachMenu);
    document.addEventListener("mousedown", function onDoc(e) {
      if (attachMenu && !attachMenu.contains(e.target)) {
        attachMenu.remove();
        attachMenu = null;
        document.removeEventListener("mousedown", onDoc);
      }
    });
  });

  // Starter prompts fill the composer.
  document.querySelectorAll(".cpx-starter").forEach(function (btn) {
    btn.addEventListener("click", function () {
      input.value = btn.getAttribute("data-prompt") || "";
      autosize();
      input.focus();
    });
  });

  // Refresh ambient context when the panel becomes visible again.
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) post({ type: "refreshContext" });
  });

  conversation.addEventListener("scroll", noteStick);
  autosize();
})();
`;
