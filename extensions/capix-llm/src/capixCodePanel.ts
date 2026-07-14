/**
 * Capix Code — the native right auxiliary-sidebar coding experience.
 *
 * This panel talks to the LOCAL Capix Code engine (the `capix-code` process,
 * managed by `CapixCodeEngine`) instead of the raw `/api/v1/chat/completions`
 * SSE endpoint. That means full agentic capabilities in the IDE: tools, file
 * editing, agent loops, plans, approval gates, checkpoints, and diffs.
 *
 * Rendered events:
 *  • text            → markdown streaming
 *  • tool_call       → collapsible card ("Editing app/api/v1/deployments/route.ts")
 *  • tool_result     → output appended to the originating tool card
 *  • file_changed    → chip in the message + entry in the bottom diff panel
 *  • plan            → a checklist
 *  • approval_request→ modal dialog (Approve / Deny)
 *  • usage           → subtle cost indicator
 *
 * Composer: multiline with @ context selector, slash commands, mode selector
 * (Ask/Plan/Build/Debug/Review), model picker, cost estimate. When the agent
 * is working, a "Working…" indicator + cancel button replace the send button.
 *
 * Design tokens (@capix/ui-tokens): dark foundation, cyan accents (#3DCED6),
 * green primary (#14F195), amber (#FFAE00), red (#FF6464).
 */

import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { CapixClient } from "./apiClient";
import { CapixCodeEngine, type EngineEvent, type EngineMode } from "./capixCodeEngine";
import { logger } from "./logger";

type ComposerMode = EngineMode;

interface AttachedContext {
  name: string;
  language: string;
  snippet: string;
}

const MODES: Array<{ id: ComposerMode; label: string }> = [
  { id: "ask", label: "Ask" },
  { id: "plan", label: "Plan" },
  { id: "build", label: "Build" },
  { id: "debug", label: "Debug" },
  { id: "review", label: "Review" },
];

const SLASH_COMMANDS: Array<{ cmd: string; desc: string }> = [
  { cmd: "/explain", desc: "Explain the selected code" },
  { cmd: "/test", desc: "Generate tests" },
  { cmd: "/review", desc: "Review changes" },
  { cmd: "/fix", desc: "Fix the error" },
  { cmd: "/refactor", desc: "Refactor the code" },
];

export class CapixCodePanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private configured = false;
  private streaming = false;
  private model = "auto";
  private mode: ComposerMode = "ask";
  private costUsd = 0;
  private attached: AttachedContext | null = null;
  private engineStarted = false;

  private readonly engine: CapixCodeEngine;

  /** Debounce handle for refreshing the diff panel after file_changed events. */
  private diffRefreshTimer: NodeJS.Timeout | null = null;

  constructor(
    private client: CapixClient,
    private extensionUri: vscode.Uri,
    extensionPath: string,
  ) {
    this.engine = new CapixCodeEngine({ extensionPath });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    view.webview.html = this.getHtml();
    view.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    this.bootState();
  }

  /** Density hint from the active layout preset (compact rail / focus mode). */
  notifyDensity(compact: boolean, focus: boolean): void {
    this.view?.webview.postMessage({ type: "density", compact, focus });
  }

  /** Start a fresh session. */
  newSession(): void {
    this.costUsd = 0;
    this.attached = null;
    this.streaming = false;
    this.view?.webview.postMessage({ type: "cleared" });
    this.view?.webview.postMessage({ type: "diffPanel", files: [] });
    this.pushState();
  }

  /** Expand/focus the panel. */
  focus(): void {
    vscode.commands.executeCommand("capix.code.focus");
  }

  /** Send a starter message into the panel (used by onboarding). */
  sendTestMessage(text: string): void {
    void this.focus();
    if (!this.configured) {
      this.view?.webview.postMessage({
        type: "error",
        message: "Sign in to start a Capix Code session.",
      });
      return;
    }
    this.handleSubmit(text, "ask").catch((err) =>
      logger.error("CapixCode sendTestMessage failed", { error: String(err) }),
    );
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

  /** Create a checkpoint and notify the user. */
  async checkpoint(): Promise<void> {
    try {
      const id = await this.engine.checkpoint();
      this.view?.webview.postMessage({ type: "checkpointCreated", id });
      vscode.window.showInformationMessage(`Capix Code: checkpoint created (${id}).`);
    } catch (err) {
      this.reportError("Could not create checkpoint", err);
    }
  }

  /** Cancel the current agent turn. */
  async cancelTurn(): Promise<void> {
    try {
      await this.engine.cancel();
    } catch (err) {
      logger.error("CapixCode cancel failed", { error: String(err) });
    }
  }

  // ── State ────────────────────────────────────────────────────────────────

  private async bootState(): Promise<void> {
    const config = vscode.workspace.getConfiguration("capix");
    this.model = config.get<string>("ai.model") || "auto";
    this.configured = await this.client.checkConfigured();
    this.pushState();
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
      messages: state.messages,
    });
  }

  private reportError(prefix: string, err: unknown): void {
    const message = `${prefix} — ${String(err)}`;
    logger.error("CapixCode", { error: message });
    this.view?.webview.postMessage({ type: "error", message });
  }

  // ── Engine wiring ────────────────────────────────────────────────────────

  private workspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  }

  /**
   * Ensure the capix-code engine is running for this workspace. The IDE sets
   * CAPIX_API_KEY / CAPIX_BASE_URL in the host environment (via the auth
   * broker) before starting the child; the child inherits them.
   */
  private async ensureEngine(): Promise<void> {
    if (this.engineStarted) return;
    const configured = await this.client.checkConfigured();
    if (!configured) {
      this.view?.webview.postMessage({
        type: "error",
        message: "Sign in to start a Capix Code session.",
      });
      return;
    }

    const config = vscode.workspace.getConfiguration("capix");
    const baseUrl = config.get<string>("ai.baseUrl") || `${this.client.getBaseUrl()}/api/v1`;

    let apiKey = (await this.client.getSecret("capix.ai.apiKey")) || "";
    if (!apiKey) {
      const token = await this.client.getStoredToken();
      if (token) apiKey = token;
    }
    if (!apiKey) {
      this.view?.webview.postMessage({
        type: "error",
        message: "Capix Code: no API key configured. Connect your wallet or deploy an LLM first.",
      });
      return;
    }

    process.env.CAPIX_BASE_URL = baseUrl;
    process.env.CAPIX_API_KEY = apiKey;

    const root = this.workspaceRoot();
    if (!root) {
      this.view?.webview.postMessage({
        type: "error",
        message: "Capix Code: open a workspace folder to begin.",
      });
      return;
    }

    try {
      await this.engine.start(root);
      this.engineStarted = true;
      this.pushState();
    } catch (err) {
      this.reportError("Could not start the Capix Code engine", err);
    }
  }

  // ── Incoming webview messages ────────────────────────────────────────────

  private handleMessage(msg: {
    type: string;
    text?: string;
    mode?: ComposerMode;
    model?: string;
    callId?: string;
    approved?: boolean;
    filePath?: string;
  }): void {
    switch (msg.type) {
      case "submit":
        if (msg.text) void this.handleSubmit(msg.text, msg.mode ?? this.mode);
        break;
      case "stop":
        void this.cancelTurn();
        break;
      case "retry":
        break;
      case "newSession":
        this.newSession();
        break;
      case "focus":
        this.focus();
        break;
      case "setMode":
        if (msg.mode) {
          this.mode = msg.mode;
          this.pushState();
        }
        break;
      case "setModel":
        if (msg.model) this.model = msg.model;
        break;
      case "attach":
        void this.attachActiveEditor();
        break;
      case "clearAttach":
        this.attached = null;
        this.view?.webview.postMessage({ type: "attachCleared" });
        break;
      case "pickModel":
        vscode.commands.executeCommand("capix.selectModel");
        break;
      case "history":
        this.showHistory();
        break;
      case "signIn":
        vscode.commands.executeCommand("capix.resetSessionAndSignIn");
        break;
      case "configureRouting":
        vscode.commands.executeCommand("capix.setRouteMode");
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

  // ── Submit / stream ──────────────────────────────────────────────────────

  private async handleSubmit(text: string, mode: ComposerMode): Promise<void> {
    if (this.streaming) return;
    await this.ensureEngine();
    if (!this.engineStarted) return;

    this.mode = mode;

    let content = text;
    let contextFiles: string[] | undefined;
    if (this.attached) {
      content += `\n\n<file name="${this.attached.name}">\n\`\`\`${this.attached.language}\n${this.attached.snippet}\n\`\`\``;
      contextFiles = [this.attached.name];
    }
    this.attached = null;

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
        this.onEngineEvent(evt, mode);
        if (evt.type === "done" || evt.type === "error") break;
      }
      this.view?.webview.postMessage({ type: "streamDone" });
    } catch (err) {
      const message = `Capix Code request failed — ${String(err)}`;
      this.view?.webview.postMessage({ type: "error", message });
    } finally {
      this.streaming = false;
      this.view?.webview.postMessage({ type: "streaming", value: false });
      this.pushState();
    }
  }

  private onEngineEvent(evt: EngineEvent, mode: ComposerMode): void {
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
    } else if (evt.type === "done" && mode === "plan") {
      // Plans also surface via the `plan` event; nothing extra here.
    }
  }

  // ── Diff panel ───────────────────────────────────────────────────────────

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
      logger.error("CapixCode getDiff failed", { error: String(err) });
    }
  }

  // ── Context attach + history + model picker ───────────────────────────────

  private async attachActiveEditor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage("Capix Code: Open a file to attach it as context.");
      return;
    }
    const doc = editor.document;
    const snippet = doc.getText(editor.selection.isEmpty ? undefined : editor.selection);
    this.attached = {
      name: vscode.workspace.asRelativePath(doc.uri),
      language: doc.languageId,
      snippet: snippet.length > 4000 ? snippet.slice(0, 4000) + "\n…(truncated)" : snippet,
    };
    this.view?.webview.postMessage({ type: "attached", name: this.attached.name });
  }

  private showHistory(): void {
    const state = this.engine.getSessionState();
    if (state.messages === 0) {
      vscode.window.showInformationMessage("Capix Code: No prior turns in this session.");
      return;
    }
    vscode.window
      .showInformationMessage(`Capix Code: ${state.messages} turn(s) in session ${state.sessionId ?? "(none)"}.`);
  }

  // ── HTML ──────────────────────────────────────────────────────────────────

  private getHtml(): string {
    const nonce = randomBytes(16).toString("base64");
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
${csp}
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>${PANEL_STYLES}</style>
</head>
<body>
  <header class="panel-header">
    <div class="header-left">
      <span class="session-title" id="session-title">Capix Code</span>
      <span class="conn-dot" id="conn-dot" title="Engine status"></span>
    </div>
    <div class="header-actions">
      <button class="hdr-btn" data-cmd="newSession" title="New session">$(add)</button>
      <button class="hdr-btn" data-cmd="history" title="History">$(history)</button>
      <button class="hdr-btn" data-cmd="checkpoint" title="Checkpoint">$(save)</button>
      <button class="hdr-btn" data-cmd="focus" title="Expand / focus">$(chrome-maximize)</button>
    </div>
  </header>

  <div class="meta-row" id="meta-row">
    <span class="meta-chip" id="chip-project" title="Project">—</span>
    <span class="meta-chip" id="chip-model" title="Model">auto</span>
    <span class="meta-chip" id="chip-mode" title="Mode">Ask</span>
  </div>

  <main class="conversation" id="conversation">
    <div class="empty-state" id="empty-state">
      <div class="empty-glyph">$(comment-discussion)</div>
      <p>Ask Capix Code anything. The agent can read, edit, and run code in this workspace. Use @ to add file context, or / for commands.</p>
    </div>
  </main>

  <div class="attach-bar" id="attach-bar" hidden>
    <span class="attach-chip" id="attach-chip"></span>
    <button class="attach-x" data-cmd="clearAttach">$(close)</button>
  </div>

  <div class="slash-menu" id="slash-menu" hidden></div>

  <div class="diff-panel" id="diff-panel" hidden>
    <div class="diff-head">
      <span class="diff-title" id="diff-title">Agent changes</span>
      <span class="diff-actions">
        <button class="diff-btn accept" data-cmd="acceptAll" title="Accept all changes">$(check) Accept all</button>
        <button class="diff-btn revert" data-cmd="revertAll" title="Revert all changes">$(discard) Revert all</button>
        <button class="diff-btn expand" id="diff-toggle" data-cmd="toggleDiff">$(chevron-down)</button>
      </span>
    </div>
    <div class="diff-files" id="diff-files"></div>
  </div>

  <footer class="composer">
    <div class="mode-row">
      ${MODES.map((m) => `<button class="mode-btn${m.id === "ask" ? " active" : ""}" data-mode="${m.id}">${m.label}</button>`).join("")}
    </div>
    <textarea id="composer-input" class="composer-input" placeholder="Ask, plan, build…" rows="1"></textarea>
    <div class="composer-foot">
      <div class="foot-left">
        <button class="foot-btn" data-cmd="attach" title="Attach file">$(attachment)</button>
        <span class="cost" id="cost-estimate">$0.0000</span>
      </div>
      <div class="foot-right">
        <button class="send-btn working" id="stop-btn" hidden data-cmd="stop" title="Cancel agent">
          <span class="spinner"></span> Working…
        </button>
        <button class="send-btn" id="send-btn" data-cmd="submit">$(arrow-up)</button>
      </div>
    </div>
  </footer>

  <div class="modal-layer" id="modal-layer"></div>

  <script nonce="${nonce}">${PANEL_SCRIPT}</script>
</body>
</html>`;
  }
}

const SLASH_HTML = SLASH_COMMANDS.map(
  (s) => `<div class="slash-item" data-slash="${s.cmd}"><span class="slash-cmd">${s.cmd}</span><span class="slash-desc">${s.desc}</span></div>`,
).join("");

// ── Inline styles + script ──────────────────────────────────────────────────
// @capix/ui-tokens: dark foundation, cyan accents, green primary.
const PANEL_STYLES = `
  :root {
    --capix-bg: var(--vscode-sideBar-background, #14161a);
    --capix-surface: var(--vscode-sideBarSectionHeader-background, rgba(255,255,255,0.03));
    --capix-border: var(--vscode-panel-border, rgba(255,255,255,0.08));
    --capix-fg: var(--vscode-foreground, #d4d4d4);
    --capix-muted: rgba(212,212,212,0.55);
    --capix-cyan: #3DCED6;
    --capix-green: #14F195;
    --capix-amber: #FFAE00;
    --capix-red: #FF6464;
    --capix-blue: #5A9DFF;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    color: var(--capix-fg); background: var(--capix-bg);
    display: flex; flex-direction: column; font-size: 12px;
    overflow: hidden;
  }
  .panel-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 10px; border-bottom: 1px solid var(--capix-border);
  }
  .header-left { display: flex; align-items: center; gap: 8px; }
  .session-title { font-weight: 600; font-size: 12px; }
  .conn-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--capix-muted); flex: none; }
  .conn-dot.online { background: var(--capix-green); box-shadow: 0 0 6px rgba(20,241,149,0.6); }
  .conn-dot.offline { background: var(--capix-amber); }
  .header-actions { display: flex; gap: 2px; }
  .hdr-btn {
    background: transparent; border: none; cursor: pointer; color: var(--capix-muted);
    font-family: inherit; font-size: 13px; padding: 3px 6px; border-radius: 5px;
  }
  .hdr-btn:hover { background: rgba(255,255,255,0.08); color: var(--capix-fg); }
  .meta-row { display: flex; gap: 4px; padding: 6px 10px; flex-wrap: wrap; }
  .meta-chip {
    font-size: 9px; padding: 2px 8px; border-radius: 999px;
    background: var(--capix-surface); border: 1px solid var(--capix-border);
    color: var(--capix-muted); text-transform: uppercase; letter-spacing: .04em;
  }
  #chip-mode { color: var(--capix-cyan); }
  .conversation { flex: 1; overflow-y: auto; padding: 10px; }
  .empty-state { text-align: center; color: var(--capix-muted); padding: 40px 16px; }
  .empty-glyph { font-size: 28px; opacity: .4; margin-bottom: 8px; }
  .msg { margin-bottom: 12px; }
  .msg-role {
    font-size: 9px; text-transform: uppercase; letter-spacing: .1em;
    color: var(--capix-muted); margin-bottom: 3px; display: flex; align-items: center; gap: 6px;
  }
  .msg.user .msg-role { color: var(--capix-cyan); }
  .msg.assistant .msg-role { color: var(--capix-green); }
  .msg-role .working-dot {
    width: 6px; height: 6px; border-radius: 50%; background: var(--capix-cyan);
    animation: pulse 1s ease-in-out infinite;
  }
  @keyframes pulse { 0%,100% { opacity: .3; } 50% { opacity: 1; } }
  .msg-body { line-height: 1.5; word-break: break-word; }
  .msg-body p { margin: 0 0 6px; white-space: pre-wrap; }
  .text-block { white-space: normal; }
  .text-block .cursor::after { content: '▋'; color: var(--capix-cyan); animation: blink 1s steps(2) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  .msg-body pre.code-block {
    background: rgba(0,0,0,0.32); border: 1px solid var(--capix-border); border-radius: 6px;
    padding: 8px; overflow-x: auto; margin: 6px 0; position: relative;
  }
  .msg-body pre.code-block::before {
    content: attr(data-lang); position: absolute; top: 4px; right: 8px;
    font-size: 8px; color: var(--capix-muted); text-transform: uppercase; letter-spacing: .08em;
  }
  .msg-body code, .msg-body pre code {
    font-family: var(--vscode-editor-font-family, monospace); font-size: 11px;
  }
  .msg-body code.inline {
    background: rgba(61,206,214,0.12); color: var(--capix-cyan);
    padding: 1px 4px; border-radius: 4px; font-size: 11px;
  }
  .msg-body strong { color: var(--capix-fg); font-weight: 700; }

  /* Tool cards */
  .tool-card {
    border: 1px solid var(--capix-border); border-radius: 8px;
    background: var(--capix-surface); margin: 6px 0; overflow: hidden;
  }
  .tool-head {
    display: flex; align-items: center; gap: 6px; padding: 6px 10px; cursor: pointer;
    font-size: 11px; color: var(--capix-cyan); font-family: var(--vscode-editor-font-family, monospace);
  }
  .tool-head .tool-glyph { font-size: 12px; opacity: .9; }
  .tool-head .tool-label { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tool-head .tool-chev { color: var(--capix-muted); font-size: 10px; }
  .tool-card.collapsed .tool-out { display: none; }
  .tool-out {
    font-family: var(--vscode-editor-font-family, monospace); font-size: 10px;
    white-space: pre-wrap; word-break: break-word; color: var(--capix-muted);
    padding: 8px 10px; border-top: 1px solid var(--capix-border); max-height: 180px; overflow-y: auto;
  }

  /* File change chips */
  .file-chip {
    display: inline-flex; align-items: center; gap: 5px; font-size: 10px;
    background: rgba(20,241,149,0.1); color: var(--capix-green);
    padding: 2px 8px; border-radius: 5px; margin: 3px 4px 0 0;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .file-chip.created { color: var(--capix-green); background: rgba(20,241,149,0.1); }
  .file-chip.modified { color: var(--capix-amber); background: rgba(255,174,0,0.1); }
  .file-chip.deleted { color: var(--capix-red); background: rgba(255,100,100,0.1); }

  /* Plan checklist */
  .plan-list { margin: 6px 0; padding-left: 0; list-style: none; }
  .plan-item {
    display: flex; align-items: flex-start; gap: 6px; padding: 4px 0;
    font-size: 11px; color: var(--capix-fg);
  }
  .plan-item .plan-check {
    width: 12px; height: 12px; border-radius: 3px; border: 1px solid var(--capix-border);
    flex: none; margin-top: 2px; display: inline-block; position: relative;
  }
  .plan-item.done .plan-check { background: var(--capix-green); border-color: var(--capix-green); }
  .plan-item.done .plan-check::after {
    content: '✓'; position: absolute; inset: 0; color: #000; font-size: 9px; text-align: center; line-height: 12px;
  }
  .plan-item.done .plan-text { color: var(--capix-muted); text-decoration: line-through; }

  /* Attach + slash */
  .attach-bar { padding: 4px 10px; }
  .attach-chip {
    display: inline-flex; align-items: center; gap: 6px; font-size: 10px;
    background: rgba(61,206,214,0.1); color: var(--capix-cyan);
    padding: 3px 8px; border-radius: 5px;
  }
  .attach-x { background: transparent; border: none; cursor: pointer; color: var(--capix-muted); font-family: inherit; }
  .slash-menu { margin: 0 10px; border: 1px solid var(--capix-border); border-radius: 6px; background: var(--capix-surface); overflow: hidden; }
  .slash-item { display: flex; justify-content: space-between; padding: 6px 10px; cursor: pointer; font-size: 11px; }
  .slash-item:hover { background: rgba(61,206,214,0.1); }
  .slash-cmd { color: var(--capix-cyan); font-family: var(--vscode-editor-font-family, monospace); }
  .slash-desc { color: var(--capix-muted); }

  /* Diff panel */
  .diff-panel {
    border-top: 1px solid var(--capix-border); background: var(--capix-surface);
    max-height: 40%; display: flex; flex-direction: column;
  }
  .diff-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 6px 10px; border-bottom: 1px solid var(--capix-border);
  }
  .diff-title { font-size: 10px; color: var(--capix-green); text-transform: uppercase; letter-spacing: .06em; font-weight: 600; }
  .diff-actions { display: flex; gap: 4px; align-items: center; }
  .diff-btn {
    background: transparent; border: 1px solid var(--capix-border); cursor: pointer;
    color: var(--capix-muted); font-family: inherit; font-size: 10px;
    padding: 3px 8px; border-radius: 5px;
  }
  .diff-btn:hover { color: var(--capix-fg); }
  .diff-btn.accept { color: var(--capix-green); border-color: rgba(20,241,149,0.3); }
  .diff-btn.revert { color: var(--capix-red); border-color: rgba(255,100,100,0.3); }
  .diff-files { overflow-y: auto; }
  .diff-file {
    border-bottom: 1px solid var(--capix-border); padding: 6px 10px;
  }
  .diff-file-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
  .diff-file-path {
    flex: 1; font-size: 10px; font-family: var(--vscode-editor-font-family, monospace);
    color: var(--capix-fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .diff-file-tag { font-size: 8px; padding: 1px 5px; border-radius: 3px; text-transform: uppercase; }
  .diff-file-tag.created { background: rgba(20,241,149,0.15); color: var(--capix-green); }
  .diff-file-tag.modified { background: rgba(255,174,0,0.15); color: var(--capix-amber); }
  .diff-file-tag.deleted { background: rgba(255,100,100,0.15); color: var(--capix-red); }
  .diff-file-actions { display: flex; gap: 4px; }
  .diff-mini {
    background: transparent; border: 1px solid var(--capix-border); cursor: pointer;
    color: var(--capix-muted); font-family: inherit; font-size: 9px; padding: 2px 6px; border-radius: 4px;
  }
  .diff-mini.acc { color: var(--capix-green); border-color: rgba(20,241,149,0.3); }
  .diff-mini.rev { color: var(--capix-red); border-color: rgba(255,100,100,0.3); }
  .diff-mini:hover { color: var(--capix-fg); }
  .diff-file pre {
    background: rgba(0,0,0,0.32); border-radius: 4px; padding: 6px; overflow-x: auto;
    font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; margin: 0;
    max-height: 160px; overflow-y: auto; color: var(--capix-fg);
  }
  .diff-panel.collapsed .diff-files { display: none; }

  /* Composer */
  .composer { border-top: 1px solid var(--capix-border); padding: 8px 10px; flex: none; }
  .mode-row { display: flex; gap: 2px; margin-bottom: 6px; flex-wrap: wrap; }
  .mode-btn {
    background: transparent; border: 1px solid transparent; cursor: pointer;
    color: var(--capix-muted); font-family: inherit; font-size: 10px;
    padding: 3px 8px; border-radius: 999px;
  }
  .mode-btn:hover { color: var(--capix-fg); }
  .mode-btn.active { background: rgba(61,206,214,0.14); color: var(--capix-cyan); border-color: rgba(61,206,214,0.3); }
  .composer-input {
    width: 100%; resize: none; border: 1px solid var(--capix-border); border-radius: 8px;
    background: var(--capix-surface); color: var(--capix-fg);
    font-family: inherit; font-size: 12px; padding: 8px 10px; min-height: 44px; max-height: 160px;
  }
  .composer-input:focus { outline: none; border-color: rgba(61,206,214,0.4); }
  .composer-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 6px; }
  .foot-left { display: flex; align-items: center; gap: 8px; }
  .foot-btn { background: transparent; border: none; cursor: pointer; color: var(--capix-muted); font-family: inherit; font-size: 13px; padding: 2px 4px; }
  .foot-btn:hover { color: var(--capix-fg); }
  .cost { font-size: 10px; color: var(--capix-muted); font-family: var(--vscode-editor-font-family, monospace); }
  .send-btn {
    background: var(--capix-cyan); border: none; color: #000; border-radius: 6px; cursor: pointer;
    font-family: inherit; font-size: 12px; padding: 5px 10px; display: inline-flex; align-items: center; gap: 6px;
  }
  .send-btn:hover { opacity: .88; }
  .send-btn.working { background: var(--capix-amber); }
  .spinner {
    width: 10px; height: 10px; border: 2px solid rgba(0,0,0,0.3); border-top-color: #000;
    border-radius: 50%; animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Approval modal */
  .modal-layer { position: relative; }
  .approval {
    border: 1px solid var(--capix-amber); border-radius: 8px; background: rgba(255,174,0,0.06);
    padding: 8px 10px; margin: 6px 0;
  }
  .approval-head { font-size: 10px; color: var(--capix-amber); text-transform: uppercase; letter-spacing: .06em; font-weight: 600; margin-bottom: 4px; }
  .approval-desc { font-size: 11px; color: var(--capix-fg); margin-bottom: 8px; }
  .approval-actions { display: flex; gap: 6px; }
  .approval-btn {
    border: 1px solid var(--capix-border); background: var(--capix-surface); color: var(--capix-fg);
    cursor: pointer; font-family: inherit; font-size: 11px; padding: 4px 12px; border-radius: 5px;
  }
  .approval-btn.approve { background: var(--capix-green); color: #000; border-color: var(--capix-green); }
  .approval-btn.deny { background: transparent; color: var(--capix-red); border-color: rgba(255,100,100,0.3); }

  .route-pill {
    display: inline-block; font-size: 9px; padding: 1px 6px; border-radius: 999px;
    background: rgba(61,206,214,0.12); color: var(--capix-cyan); margin-bottom: 4px;
  }

  body.compact .meta-row, body.compact .mode-row { display: none; }
  body.compact .composer-input { min-height: 28px; }
`;

const PANEL_SCRIPT = `
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let streaming = false;
  let currentMode = 'ask';
  let activeAssistant = null;
  let activeTextRaw = '';
  let activeTools = new Map();   // callId -> tool-card element
  let diffExpanded = true;

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  const conversation = $('conversation');
  const emptyState = $('empty-state');
  const input = $('composer-input');

  function clearEmpty() { if (emptyState) emptyState.remove(); }

  function appendTurn(role, content) {
    clearEmpty();
    const div = document.createElement('div');
    div.className = 'msg ' + (role === 'user' ? 'user' : 'assistant');
    div.innerHTML = '<div class="msg-role">' + (role === 'user' ? 'You' : 'Capix Code') + '</div><div class="msg-body"></div>';
    conversation.appendChild(div);
    conversation.scrollTop = conversation.scrollHeight;
    return div.querySelector('.msg-body');
  }

  function startAssistant(mode) {
    clearEmpty();
    const div = document.createElement('div');
    div.className = 'msg assistant';
    if (mode === 'plan') div.insertAdjacentHTML('afterbegin', '<span class="route-pill">Planning</span>');
    div.innerHTML = '<div class="msg-role"><span class="working-dot"></span> Capix Code · Working…</div><div class="msg-body"></div>';
    conversation.appendChild(div);
    activeAssistant = div.querySelector('.msg-body');
    activeTextRaw = '';
    activeTools = new Map();
    conversation.scrollTop = conversation.scrollHeight;
    return div;
  }

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  }

  function setStreaming(v) {
    streaming = v;
    $('send-btn').hidden = v;
    $('stop-btn').hidden = !v;
  }

  function pickMode(mode) {
    currentMode = mode;
    document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    $('chip-mode').textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
  }

  function showSlashMenu(show) {
    const menu = $('slash-menu');
    menu.hidden = !show;
    if (show && !menu.children.length) menu.innerHTML = ${JSON.stringify(SLASH_HTML)} || '';
  }

  // ── Markdown (code fences + inline code/bold + line breaks) ──────────────
  function renderInlineMd(text) {
    let s = esc(text);
    s = s.replace(/\`([^\`]+)\`/g, '<code class="inline">$1</code>');
    s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
    return s.replace(/\\n/g, '<br>');
  }
  function renderMarkdown(text) {
    let html = '';
    let i = 0;
    while (i < text.length) {
      const fence = text.indexOf('\`\`\`', i);
      if (fence === -1) { html += '<p>' + renderInlineMd(text.slice(i)) + '</p>'; break; }
      if (fence > i) html += '<p>' + renderInlineMd(text.slice(i, fence)) + '</p>';
      const afterFence = text.slice(fence + 3);
      const nl = afterFence.indexOf('\\n');
      const lang = nl >= 0 ? afterFence.slice(0, nl) : afterFence;
      const codeStart = nl >= 0 ? fence + 3 + nl + 1 : fence + 3;
      const close = text.indexOf('\`\`\`', codeStart);
      if (close === -1) {
        const code = text.slice(codeStart);
        html += '<pre class="code-block" data-lang="' + esc(lang || 'code') + '"><code>' + esc(code) + '</code></pre>';
        i = text.length;
      } else {
        const code = text.slice(codeStart, close);
        html += '<pre class="code-block" data-lang="' + esc(lang || 'code') + '"><code>' + esc(code) + '</code></pre>';
        i = close + 3;
      }
    }
    return html;
  }

  function appendText(content) {
    if (!activeAssistant) startAssistant(currentMode);
    activeTextRaw += content;
    let block = activeAssistant.querySelector('.text-block');
    if (!block) {
      block = document.createElement('div');
      block.className = 'text-block cursor';
      activeAssistant.appendChild(block);
    }
    block.innerHTML = renderMarkdown(activeTextRaw);
    conversation.scrollTop = conversation.scrollHeight;
  }

  function toolLabel(tool, args) {
    if (!args || typeof args !== 'object') return tool;
    const a = args;
    const fp = a.file_path || a.path || a.file || a.target;
    const cmd = a.command || a.cmd;
    const pat = a.pattern || a.query || a.glob;
    if (fp) {
      if (/edit|write|str_replace|update|patch|apply/i.test(tool)) return 'Editing ' + fp;
      if (/read|view|cat|open/i.test(tool)) return 'Reading ' + fp;
      if (/delete|remove|rm/i.test(tool)) return 'Deleting ' + fp;
      return (tool + ' · ' + fp);
    }
    if (cmd) return 'Running: ' + cmd;
    if (pat) return 'Searching: ' + pat;
    return tool;
  }

  function appendToolCall(evt) {
    if (!activeAssistant) startAssistant(currentMode);
    const label = toolLabel(evt.tool, evt.args);
    const card = document.createElement('div');
    card.className = 'tool-card collapsed';
    card.dataset.callId = evt.callId;
    card.innerHTML = '<div class="tool-head"><span class="tool-glyph">$(tool)</span><span class="tool-label">' + esc(label) + '</span><span class="tool-chev">$(chevron-right)</span></div><div class="tool-out"></div>';
    activeAssistant.appendChild(card);
    activeTools.set(evt.callId, card);
    conversation.scrollTop = conversation.scrollHeight;
  }

  function appendToolResult(evt) {
    const card = activeTools.get(evt.callId);
    if (!card) return;
    const out = card.querySelector('.tool-out');
    if (out) out.textContent += evt.output + '\\n';
    card.classList.remove('collapsed');
    conversation.scrollTop = conversation.scrollHeight;
  }

  function appendFileChanged(evt) {
    if (!activeAssistant) startAssistant(currentMode);
    const chip = document.createElement('span');
    chip.className = 'file-chip ' + evt.changeType;
    const glyph = evt.changeType === 'created' ? '$(add)' : evt.changeType === 'deleted' ? '$(trash)' : '$(edit)';
    chip.innerHTML = '<span>' + glyph + '</span>' + esc(evt.filePath);
    activeAssistant.appendChild(chip);
    conversation.scrollTop = conversation.scrollHeight;
  }

  function appendPlan(evt) {
    if (!activeAssistant) startAssistant(currentMode);
    const wrap = document.createElement('div');
    wrap.className = 'plan-wrap';
    const steps = Array.isArray(evt.plan) ? evt.plan
      : (evt.plan && Array.isArray(evt.plan.steps)) ? evt.plan.steps
      : (evt.plan && Array.isArray(evt.plan.items)) ? evt.plan.items : null;
    const items = steps ? steps.map((s) => {
      const isObj = s && typeof s === 'object';
      const text = isObj ? (s.description || s.text || s.summary || JSON.stringify(s)) : String(s);
      const done = isObj ? !!s.done : false;
      return '<li class="plan-item' + (done ? ' done' : '') + '"><span class="plan-check"></span><span class="plan-text">' + esc(text) + '</span></li>';
    }).join('') : '<li class="plan-item"><span class="plan-check"></span><span class="plan-text">' + esc(typeof evt.plan === 'string' ? evt.plan : JSON.stringify(evt.plan)) + '</span></li>';
    wrap.innerHTML = '<ul class="plan-list">' + items + '</ul>';
    activeAssistant.appendChild(wrap);
    conversation.scrollTop = conversation.scrollHeight;
  }

  function showApproval(evt) {
    if (!activeAssistant) startAssistant(currentMode);
    const modal = document.createElement('div');
    modal.className = 'approval';
    modal.dataset.callId = evt.callId;
    modal.innerHTML = '<div class="approval-head">Approval required</div>' +
      '<div class="approval-desc"><b>' + esc(evt.tool) + '</b> — ' + esc(evt.description) + '</div>' +
      '<div class="approval-actions">' +
        '<button class="approval-btn approve" data-approve="1" data-call-id="' + esc(evt.callId) + '">Approve</button>' +
        '<button class="approval-btn deny" data-approve="0" data-call-id="' + esc(evt.callId) + '">Deny</button>' +
      '</div>';
    activeAssistant.appendChild(modal);
    conversation.scrollTop = conversation.scrollHeight;
  }

  function dismissApproval(callId) {
    const m = activeAssistant && activeAssistant.querySelector('.approval[data-call-id="' + cssAttr(callId) + '"]');
    if (m) m.remove();
  }
  function cssAttr(s) { return String(s).replace(/"/g, ''); }

  function finishAssistant(msg) {
    const msgEl = activeAssistant && activeAssistant.closest('.msg');
    if (msgEl) {
      const role = msgEl.querySelector('.msg-role');
      if (role) role.innerHTML = 'Capix Code';
    }
    const tb = activeAssistant && activeAssistant.querySelector('.text-block');
    if (tb) tb.classList.remove('cursor');
    if (msg) appendText('\\n' + msg);
  }

  // ── Diff panel ───────────────────────────────────────────────────────────
  function renderDiffPanel(files) {
    const panel = $('diff-panel');
    const list = $('diff-files');
    if (!files || !files.length) { panel.hidden = true; list.innerHTML = ''; return; }
    panel.hidden = false;
    $('diff-title').textContent = 'Agent changes (' + files.length + ')';
    list.innerHTML = files.map((f) => {
      const tag = f.changeType || 'modified';
      return '<div class="diff-file">' +
        '<div class="diff-file-head">' +
          '<span class="diff-file-path">' + esc(f.filePath) + '</span>' +
          '<span class="diff-file-tag ' + tag + '">' + tag + '</span>' +
          '<span class="diff-file-actions">' +
            '<button class="diff-mini acc" data-accept-file="' + esc(f.filePath) + '">Accept</button>' +
            '<button class="diff-mini rev" data-revert-file="' + esc(f.filePath) + '">Revert</button>' +
          '</span>' +
        '</div>' +
        '<pre>' + esc(f.diff || '') + '</pre>' +
      '</div>';
    }).join('');
  }

  // ── Event delegation (CSP-safe) ───────────────────────────────────────────
  document.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;

    // Tool card collapse toggle (header click)
    const head = t && t.closest('.tool-head');
    if (head && !e.target.closest('.tool-out')) {
      head.closest('.tool-card').classList.toggle('collapsed');
      return;
    }

    // Approval buttons
    const appr = t && t.closest('[data-approve]');
    if (appr) {
      const callId = appr.getAttribute('data-call-id');
      const approved = appr.getAttribute('data-approve') === '1';
      dismissApproval(callId);
      vscode.postMessage({ type: 'approve', callId, approved });
      return;
    }

    // Per-file accept/revert in diff panel
    const accFile = t && t.closest('[data-accept-file]');
    if (accFile) {
      vscode.postMessage({ type: 'acceptFile', filePath: accFile.getAttribute('data-accept-file') });
      return;
    }
    const revFile = t && t.closest('[data-revert-file]');
    if (revFile) {
      vscode.postMessage({ type: 'revertFile', filePath: revFile.getAttribute('data-revert-file') });
      return;
    }

    const tgt = t && t.closest('[data-cmd],[data-mode],[data-slash]');
    if (!tgt) return;
    if (t && t.dataset && t.dataset.mode) { pickMode(t.dataset.mode); vscode.postMessage({ type: 'setMode', mode: t.dataset.mode }); return; }

    const el = tgt;
    if (el.dataset.mode) { pickMode(el.dataset.mode); vscode.postMessage({ type: 'setMode', mode: el.dataset.mode }); return; }
    if (el.dataset.slash) { input.value = el.dataset.slash + ' '; showSlashMenu(false); autoGrow(); input.focus(); return; }
    if (el.dataset.cmd === 'toggleDiff') {
      diffExpanded = !diffExpanded;
      $('diff-panel').classList.toggle('collapsed', !diffExpanded);
      return;
    }
    if (el.dataset.cmd === 'submit') {
      const text = input.value.trim();
      if (!text || streaming) return;
      appendTurn('user', text);
      activeAssistant = null; activeTextRaw = ''; activeTools = new Map();
      input.value = ''; autoGrow();
      vscode.postMessage({ type: 'submit', text, mode: currentMode });
      setStreaming(true);
    } else if (el.dataset.cmd === 'stop') {
      vscode.postMessage({ type: 'stop' });
    } else {
      vscode.postMessage({ type: el.dataset.cmd });
    }
  });

  input.addEventListener('input', () => {
    autoGrow();
    const v = input.value;
    showSlashMenu(v.startsWith('/') && !v.includes(' '));
  });
  input.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      $('send-btn').click();
    }
  });

  // ── Messages from extension host ─────────────────────────────────────────
  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'state':
        $('conn-dot').className = 'conn-dot ' + (msg.engineStatus === 'online' ? 'online' : (msg.configured ? 'offline' : 'offline'));
        $('session-title').textContent = msg.sessionId ? ('Session ' + String(msg.sessionId).slice(0, 8)) : 'Capix Code';
        $('chip-project').textContent = msg.project || '—';
        $('chip-model').textContent = msg.model || 'auto';
        if (msg.mode) pickMode(msg.mode);
        if (msg.streaming) setStreaming(true);
        break;
      case 'turn':
        appendTurn(msg.role, msg.content);
        activeAssistant = null; activeTextRaw = ''; activeTools = new Map();
        break;
      case 'streamStart':
        startAssistant(msg.mode);
        break;
      case 'engineEvent': {
        const evt = msg.event;
        if (!evt) break;
        if (evt.type === 'text') appendText(evt.content);
        else if (evt.type === 'tool_call') appendToolCall(evt);
        else if (evt.type === 'tool_result') appendToolResult(evt);
        else if (evt.type === 'file_changed') appendFileChanged(evt);
        else if (evt.type === 'plan') appendPlan(evt);
        else if (evt.type === 'approval_request') showApproval(evt);
        break;
      }
      case 'usage':
        $('cost-estimate').textContent = '$' + Number(msg.costUsd || 0).toFixed(4);
        break;
      case 'streamDone':
        finishAssistant();
        setStreaming(false);
        break;
      case 'streaming':
        setStreaming(msg.value);
        if (!msg.value) finishAssistant();
        break;
      case 'error':
        setStreaming(false);
        appendTurn('assistant', '⚠ ' + esc(msg.message));
        activeAssistant = null;
        break;
      case 'cleared':
        conversation.innerHTML = '';
        activeAssistant = null; activeTextRaw = ''; activeTools = new Map();
        if (!$('empty-state')) {
          const es = document.createElement('div');
          es.className = 'empty-state'; es.id = 'empty-state';
          es.innerHTML = '<div class="empty-glyph">$(comment-discussion)</div><p>Ask Capix Code anything. The agent can read, edit, and run code in this workspace.</p>';
          conversation.appendChild(es);
        }
        break;
      case 'attached':
        $('attach-bar').hidden = false;
        $('attach-chip').textContent = '📎 ' + msg.name;
        break;
      case 'attachCleared':
        $('attach-bar').hidden = true;
        break;
      case 'compose':
        input.value = msg.text; autoGrow(); input.focus();
        break;
      case 'density':
        document.body.classList.toggle('compact', !!msg.compact);
        break;
      case 'diffPanel':
        renderDiffPanel(msg.files);
        break;
      case 'checkpointCreated':
        appendTurn('assistant', '✓ Checkpoint created: ' + esc(msg.id));
        activeAssistant = null;
        break;
    }
  });

  autoGrow();
`;
