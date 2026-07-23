/**
 * Capix Code — the native right auxiliary-sidebar coding experience.
 *
 * This panel runs on the SHARED Capix agent runtime (`@capix/agent-runtime`)
 * via `AgentRuntimeEngine` — the same runtime, durable session store and
 * permission model as the Capix Code CLI/TUI — instead of spawning an
 * external binary. That means full agentic capabilities in the IDE: tools,
 * file editing, agent loops, approval gates, checkpoints, and diffs, with
 * sessions shared across clients.
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
import { AgentRuntimeEngine, type EngineEvent, type EngineMode } from "./agentRuntimeEngine";
import { logger } from "./logger";
import type { ToolDefinition } from "./shared/agent-runtime/index";
import { icon } from "./webviewIcons";
import { PANEL_STYLES } from "./capixCodePanelStyles";
import { PANEL_SCRIPT } from "./capixCodePanelScript";

type ComposerMode = EngineMode;
type ProviderPreference = "auto" | "usepod" | "openrouter" | "surplus";
type CodeTab = "chat" | "sessions" | "agents";

interface CodeSessionSummary {
  id: string;
  modelId?: string;
  messages?: unknown[];
  costMinor?: string;
  currency?: string;
}

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

export class CapixCodePanelProvider implements vscode.WebviewViewProvider {
  private static readonly AUTH_BOOT_TIMEOUT_MS = 8_000;
  private view?: vscode.WebviewView;
  private configured = false;
  private streaming = false;
  private model = "auto";
  private preferredProvider: ProviderPreference = "auto";
  private preferredModel = "";
  private mode: ComposerMode = "ask";
  private costUsd = 0;
  private attached: AttachedContext | null = null;
  private engineStarted = false;
  private activeTab: CodeTab = "chat";

  private readonly engine: AgentRuntimeEngine;

  /** Debounce handle for refreshing the diff panel after file_changed events. */
  private diffRefreshTimer: NodeJS.Timeout | null = null;

  constructor(
    private client: CapixClient,
    private extensionUri: vscode.Uri,
    // Kept for signature compatibility with activation; the shared runtime
    // needs no bundled binary path.
    _extensionPath: string,
    /** Extra host tools (e.g. web-control browser tools) registered on the runtime. */
    extraTools: ToolDefinition[] = [],
  ) {
    this.engine = new AgentRuntimeEngine({ client, extraTools });
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

  /** Synchronize this view with the shared browser-login broker. */
  async refreshAuthentication(): Promise<void> {
    try {
      this.configured = await this.checkConfiguredWithinDeadline();
      if (!this.configured) this.engineStarted = false;
    } catch (err) {
      this.configured = false;
      this.engineStarted = false;
      logger.warn("CapixCode authentication refresh failed", { error: String(err) });
    }
    this.pushState();
    if (this.activeTab === "sessions") await this.loadSessions();
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
    this.preferredProvider = config.get<ProviderPreference>("ai.preferredProvider") || "auto";
    this.preferredModel = config.get<string>("ai.preferredModel") || "";
    try {
      this.configured = await this.checkConfiguredWithinDeadline();
    } catch (err) {
      this.configured = false;
      logger.warn("CapixCode authentication restore timed out", { error: String(err) });
      this.view?.webview.postMessage({
        type: "error",
        message: "Capix Code could not restore your session. Sign in again to reconnect.",
      });
    }
    this.pushState();
  }

  /** Never leave the native panel indefinitely waiting on keychain/network I/O. */
  private async checkConfiguredWithinDeadline(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.client.checkConfigured(),
        new Promise<boolean>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("authentication_restore_timeout")),
            CapixCodePanelProvider.AUTH_BOOT_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private pushState(): void {
    const state = this.engine.getSessionState();
    this.view?.webview.postMessage({
      type: "state",
      configured: this.configured,
      model: this.model,
      preferredProvider: this.preferredProvider,
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
   * Ensure the shared agent runtime has a session for this workspace.
   * Inference auth rides on the broker-backed CapixClient — no credentials
   * are placed into any child-process environment.
   */
  private async ensureEngine(): Promise<void> {
    if (this.engineStarted) return;
    let configured = false;
    try {
      configured = await this.checkConfiguredWithinDeadline();
    } catch (err) {
      logger.warn("CapixCode authentication check timed out", { error: String(err) });
    }
    if (!configured) {
      this.view?.webview.postMessage({
        type: "error",
        message: "Sign in to start a Capix Code session.",
      });
      return;
    }

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
      this.reportError("Could not start the Capix agent runtime", err);
    }
  }

  // ── Incoming webview messages ────────────────────────────────────────────

  private handleMessage(msg: {
    type: string;
    text?: string;
    mode?: ComposerMode;
    model?: string;
    provider?: ProviderPreference;
    callId?: string;
    mentions?: string[];
    query?: string;
    approved?: boolean;
    filePath?: string;
    id?: string;
    tab?: CodeTab;
  }): void {
    switch (msg.type) {
      case "submit":
        if (msg.text) void this.handleSubmit(msg.text, msg.mode ?? this.mode, msg.mentions);
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
      case "setProvider":
        if (msg.provider && ["auto", "usepod", "openrouter", "surplus"].includes(msg.provider)) {
          this.preferredProvider = msg.provider;
          void vscode.workspace.getConfiguration("capix").update(
            "ai.preferredProvider",
            msg.provider,
            vscode.ConfigurationTarget.Global,
          );
          this.pushState();
        }
        break;
      case "listFiles":
        void this.listFiles(String(msg.query ?? ""));
        break;
      case "runOnGpu":
        void vscode.commands.executeCommand("capix.runOn");
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
        vscode.commands.executeCommand("capix.connectWallet");
        break;
      case "selectCodeTab":
        if (msg.tab && ["chat", "sessions", "agents"].includes(msg.tab)) {
          this.activeTab = msg.tab;
          if (msg.tab === "sessions") void this.loadSessions();
        }
        break;
      case "refreshSessions":
        void this.loadSessions();
        break;
      case "startAgentSession":
        void vscode.commands.executeCommand("capix.agent.startSession").then(() => this.loadSessions());
        break;
      case "resumeAgentSession":
        if (msg.id) void vscode.commands.executeCommand("capix.agent.resumeSessionById", msg.id);
        break;
      case "selectAgentModel":
        void vscode.commands.executeCommand("capix.agent.selectModel");
        break;
      case "openAgentIntelligence":
        void vscode.commands.executeCommand("capix.intelligence.openPanel", "agents");
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

  private async loadSessions(): Promise<void> {
    try {
      const sessions = await vscode.commands.executeCommand<CodeSessionSummary[]>("capix.agent.listSessions");
      this.view?.webview.postMessage({
        type: "sessions",
        sessions: Array.isArray(sessions) ? sessions : [],
      });
    } catch (err) {
      logger.error("CapixCode session tab failed", { error: String(err) });
      this.view?.webview.postMessage({
        type: "sessions",
        sessions: [],
        error: "Sessions could not be loaded. Refresh or sign in again.",
      });
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

  private async handleSubmit(text: string, mode: ComposerMode, mentions?: string[]): Promise<void> {
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

    if (mentions?.length) {
      const blocks = await this.readMentionedFiles(mentions.slice(0, 5));
      if (blocks.length) {
        content += "\n\n" + blocks.map((b) => b.block).join("\n\n");
        contextFiles = [...(contextFiles ?? []), ...blocks.map((b) => b.name)];
      }
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
        preferredProvider: this.preferredProvider,
        preferredModel: this.preferredModel,
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

  /** Fuzzy file lookup for the composer @-mention menu. */
  private async listFiles(query: string): Promise<void> {
    try {
      const pattern = query ? `**/*${query}*` : "**/*";
      const uris = await vscode.workspace.findFiles(pattern, "**/{node_modules,.git,dist,out,build,target}/**", 60);
      let rels = uris.map((u) => vscode.workspace.asRelativePath(u, false));
      if (query) {
        const q = query.toLowerCase();
        rels = rels.filter((r) => r.toLowerCase().includes(q));
        rels.sort((a, b) => {
          const an = (a.split("/").pop() ?? a).toLowerCase();
          const bn = (b.split("/").pop() ?? b).toLowerCase();
          const as = an.startsWith(q) ? 0 : 1;
          const bs = bn.startsWith(q) ? 0 : 1;
          return as - bs || a.length - b.length;
        });
      }
      this.view?.webview.postMessage({ type: "fileList", files: rels.slice(0, 8) });
    } catch {
      this.view?.webview.postMessage({ type: "fileList", files: [] });
    }
  }

  /** Read @-mentioned files (capped) into shared <file> context blocks. */
  private async readMentionedFiles(paths: string[]): Promise<Array<{ name: string; block: string }>> {
    const root = this.workspaceRoot();
    if (!root) return [];
    const out: Array<{ name: string; block: string }> = [];
    for (const rel of paths) {
      try {
        const uri = vscode.Uri.file(`${root}/${rel}`);
        const bytes = await vscode.workspace.fs.readFile(uri);
        let text = Buffer.from(bytes).toString("utf8");
        if (text.length > 4000) text = text.slice(0, 4000) + "\n…(truncated)";
        const lang = rel.includes(".") ? rel.split(".").pop() ?? "" : "";
        out.push({ name: rel, block: `<file name="${rel}">\n\`\`\`${lang}\n${text}\n\`\`\`` });
      } catch {
        // Skip unreadable mentions (deleted mid-compose, binary, etc.)
      }
    }
    return out;
  }

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
      <button class="hdr-btn" data-cmd="newSession" title="New session">${icon("add")}</button>
      <button class="hdr-btn" data-cmd="history" title="History">${icon("history")}</button>
      <button class="hdr-btn" data-cmd="checkpoint" title="Checkpoint">${icon("save")}</button>
      <button class="hdr-btn" data-cmd="runOnGpu" title="Run target — your GPU or Capix Cloud">${icon("vm")}</button>
      <button class="hdr-btn" data-cmd="focus" title="Expand / focus">${icon("chrome-maximize")}</button>
    </div>
  </header>

  <nav class="code-tabs" aria-label="Capix Code">
    <button class="code-tab active" data-code-tab="chat">Chat</button>
    <button class="code-tab" data-code-tab="sessions">Sessions</button>
    <button class="code-tab" data-code-tab="agents">Agent Hub</button>
  </nav>

  <section class="code-pane active" data-code-pane="chat">
  <div class="meta-row" id="meta-row">
    <span class="meta-chip" id="chip-project" title="Project">—</span>
    <span class="meta-chip" id="chip-model" title="Model">auto</span>
    <span class="meta-chip" id="chip-mode" title="Mode">Ask</span>
    <label class="route-control" title="Preferred route; Capix automatically falls back">
      <span>Route</span>
      <select id="provider-select" aria-label="Preferred inference provider">
        <option value="auto">Balanced (automatic)</option>
        <option value="usepod">Speed preferred</option>
        <option value="openrouter">Cost preferred</option>
        <option value="surplus" disabled>Market paused</option>
      </select>
    </label>
  </div>

  <div class="auth-banner" id="auth-banner" hidden>
    <div>
      <strong>Connect Capix Code</strong>
      <span>Sign in through your browser to use your Capix models and balance.</span>
    </div>
    <button data-cmd="signIn">Sign in</button>
  </div>

  <main class="conversation" id="conversation">
    <div class="empty-state" id="empty-state">
      <div class="empty-glyph">✦</div>
      <span class="empty-kicker">Workspace agent</span>
      <h2>Build from here.</h2>
      <p>Capix Code can understand the project, edit files, run commands and verify the result.</p>
      <div class="starter-prompts">
        <button data-prompt="Map this codebase and tell me where to start">Map this codebase <span>→</span></button>
        <button data-prompt="Find the highest-impact bug in this workspace and fix it">Find and fix a bug <span>→</span></button>
        <button data-prompt="Review the current changes and identify production risks">Review current changes <span>→</span></button>
      </div>
      <small><kbd>@</kbd> add context <span>·</span> <kbd>/</kbd> commands <span>·</span> <kbd>⌘↵</kbd> send</small>
    </div>
  </main>

  <div class="attach-bar" id="attach-bar" hidden>
    <span class="attach-chip" id="attach-chip"></span>
    <button class="attach-x" data-cmd="clearAttach">${icon("close")}</button>
  </div>

  <div class="slash-menu" id="slash-menu" hidden></div>

  <div class="mention-menu" id="mention-menu" hidden></div>

  <div class="diff-panel" id="diff-panel" hidden>
    <div class="diff-head">
      <span class="diff-title" id="diff-title">Agent changes</span>
      <span class="diff-actions">
        <button class="diff-btn accept" data-cmd="acceptAll" title="Accept all changes">${icon("check")} Accept all</button>
        <button class="diff-btn revert" data-cmd="revertAll" title="Revert all changes">${icon("discard")} Revert all</button>
        <button class="diff-btn expand" id="diff-toggle" data-cmd="toggleDiff">${icon("chevron-down")}</button>
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
        <button class="foot-btn" data-cmd="attach" title="Attach file">${icon("attachment")}</button>
        <span class="cost" id="cost-estimate">$0.0000</span>
      </div>
      <div class="foot-right">
        <button class="send-btn working" id="stop-btn" hidden data-cmd="stop" title="Cancel agent">
          <span class="spinner"></span> Working…
        </button>
        <button class="send-btn" id="send-btn" data-cmd="submit">${icon("arrow-up")}</button>
      </div>
    </div>
  </footer>

  <div class="modal-layer" id="modal-layer"></div>
  </section>

  <section class="code-pane management-pane" data-code-pane="sessions">
    <div class="management-head">
      <div><span class="eyebrow">Durable work</span><h2>Sessions</h2></div>
      <div class="management-actions">
        <button class="quiet-action" data-cmd="refreshSessions">${icon("refresh")} Refresh</button>
        <button class="primary-action" data-cmd="startAgentSession">${icon("add")} New</button>
      </div>
    </div>
    <div id="sessions-list" class="management-list">
      <div class="management-empty">Open this tab to load your Capix Code sessions.</div>
    </div>
  </section>

  <section class="code-pane management-pane" data-code-pane="agents">
    <div class="management-head">
      <div><span class="eyebrow">Orchestration</span><h2>Agent Hub</h2></div>
    </div>
    <div class="agent-hero">
      <span class="agent-mark">✦</span>
      <h3>Coordinate work without leaving Code.</h3>
      <p>Start a durable agent session, choose its routed model, or inspect the shared Intelligence agent graph.</p>
    </div>
    <div class="agent-actions-grid">
      <button data-cmd="startAgentSession"><strong>New agent session</strong><span>Start a routed coding task →</span></button>
      <button data-cmd="selectAgentModel"><strong>Select model</strong><span>Choose the agent lane →</span></button>
      <button data-cmd="openAgentIntelligence"><strong>Agent intelligence</strong><span>Plans, delegation and receipts →</span></button>
    </div>
  </section>

  <script nonce="${nonce}">${PANEL_SCRIPT}</script>
</body>
</html>`;
  }
}
