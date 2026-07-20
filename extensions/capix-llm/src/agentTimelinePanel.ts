/**
 * capix-llm/agentTimelinePanel — the agent observability surface for CapixIDE.
 *
 * A single webview (registered as `capix.agentTimeline.view`) driven by the
 * SHARED observability engine (`AgentTimeline` + `AgentProfiler` from the
 * vendored `@capix/agent-runtime`) — the same execution timeline, tool-call
 * inspection, decision explanations, rollback and profiling the Capix Code
 * TUI renders from `src/observability/`.
 *
 * Surface:
 *   • real-time timeline: every turn, tool call, file change and checkpoint
 *     with a plain-language explanation of why it happened
 *   • interactive tool-call inspection: click any step to see what file or
 *     command it ran, its arguments, the permission decision, and the result
 *   • one-click rollback: file-changing steps carry a rollback button that
 *     writes the recorded before-image back (a created file is removed)
 *   • step-by-step replay: play / pause / step through the recorded timeline
 *   • profiler strip: execution time per tool, tokens and cost per action,
 *     and ranked bottlenecks
 *
 * The host feeds events with `recordEvent()` (tapped from the engine's
 * `sendMessage` stream) or rebuilds a past session with `hydrateFromStore()`.
 * No external scripts — stays inside the strict CSP
 * (script-src 'nonce-<nonce>').
 *
 * Visual foundation is @capix/ui-tokens dark: canvas `#0a0e14`, brand cyan
 * `#3DCED6`, success green `#14F195`, amber `#FFAE00`, error `#ff5252`.
 */

import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import {
  AgentTimeline,
  AgentProfiler,
  CapixAgentError,
  type AgentEvent,
  type AgentProfileReport,
  type RuntimeStore,
  type TimelineStep,
} from './shared/agent-runtime/index';
import { logger } from './logger';

// ── View state ──────────────────────────────────────────────────────────────

/** Serializable snapshot posted to the webview. */
export interface AgentTimelineViewState {
  steps: TimelineStep[];
  profile: AgentProfileReport;
  /** Step the operator expanded for inspection (client-side highlight). */
  updatedAt: string;
}

/** Build the webview snapshot from the shared engine instances. */
export function toViewState(
  timeline: AgentTimeline,
  profiler: AgentProfiler
): AgentTimelineViewState {
  return {
    steps: timeline.getSteps(),
    profile: profiler.getReport(),
    updatedAt: new Date().toISOString(),
  };
}

/** Escape user/agent text before interpolating into webview HTML. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** `12.340000` from integer USDC minor units (scale 6) — string math. */
export function formatCostMinor(costMinor: string, scale = 6): string {
  const negative = costMinor.startsWith('-');
  const digits = (negative ? costMinor.slice(1) : costMinor).padStart(scale + 1, '0');
  const major = digits.slice(0, -scale) || '0';
  const minor = digits.slice(-scale);
  return `${negative ? '-' : ''}${major}.${minor}`;
}

// ── Provider ────────────────────────────────────────────────────────────────

export class CapixAgentTimelineViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'capix.agentTimeline.view';

  private view?: vscode.WebviewView;
  private timeline: AgentTimeline;
  private profiler: AgentProfiler;
  /** When set (agent hub embed), state snapshots go to the sink instead of a view. */
  private stateSink: ((state: AgentTimelineViewState) => void) | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    options: { workspaceRoot?: string } = {}
  ) {
    this.timeline = new AgentTimeline({ workspaceRoot: options.workspaceRoot });
    this.profiler = new AgentProfiler();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    view.webview.html = this.getHtml();
    view.webview.onDidReceiveMessage((msg) => void this.handleMessage(msg));
    this.pushState();
  }

  /** Expand/focus the view. */
  show(): void {
    this.view?.show?.(true);
  }

  dispose(): void {
    this.view = undefined;
  }

  /** The shared timeline instance (engine hosts tap events into it). */
  getTimeline(): AgentTimeline {
    return this.timeline;
  }

  /** The shared profiler instance. */
  getProfiler(): AgentProfiler {
    return this.profiler;
  }

  /** Record one event from the runtime stream and repaint. */
  recordEvent(event: AgentEvent): void {
    this.timeline.record(event);
    this.profiler.record(event);
    this.pushState();
  }

  /** Rebuild the panel from the durable store for a past session. */
  hydrateFromStore(store: RuntimeStore, sessionId: string, workspaceRoot?: string): void {
    this.timeline = AgentTimeline.hydrateFromStore(store, sessionId, { workspaceRoot });
    this.profiler = AgentProfiler.hydrateFromStore(store, sessionId);
    this.pushState();
  }

  /** Route state snapshots to the agent hub instead of a dedicated view. */
  setStateSink(sink: ((state: AgentTimelineViewState) => void) | null): void {
    this.stateSink = sink;
  }

  /** Push the current engine snapshot to the webview. */
  pushState(): void {
    const state = toViewState(this.timeline, this.profiler);
    if (this.stateSink) {
      this.stateSink(state);
      return;
    }
    if (!this.view) return;
    void this.view.webview.postMessage({ type: 'state', state });
  }

  public async handleMessage(msg: { type: string; stepId?: string }): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready':
          this.pushState();
          return;
        case 'rollback': {
          if (!msg.stepId) return;
          const step = await this.timeline.rollbackStep(msg.stepId);
          this.pushState();
          void vscode.window.showInformationMessage(
            `Rolled back ${step.fileChange?.filePath ?? step.title}`
          );
          return;
        }
      }
    } catch (err) {
      logger.error('AgentTimelinePanel message failed', { type: msg.type, error: String(err) });
      const detail =
        err instanceof CapixAgentError
          ? err.problem.detail
          : err instanceof Error
            ? err.message
            : String(err);
      void vscode.window.showErrorMessage(`Timeline: ${detail}`);
    }
  }

  // ── HTML ────────────────────────────────────────────────────────────────

  private getHtml(): string {
    const nonce = randomBytes(16).toString('base64');
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
${csp}
<style>${AGENT_TIMELINE_STYLES}</style>
</head>
<body>
${AGENT_TIMELINE_BODY}
  <script nonce="${nonce}">${AGENT_TIMELINE_SCRIPT}</script>
</body>
</html>`;
  }
}

// ── Webview script (no dependencies; state arrives via postMessage) ─────────


/**
 * Body markup of the panel surface, exported so the agent hub can embed
 * it as a tab body (hub re-prefixes the element ids).
 */
export const AGENT_TIMELINE_BODY = /* html */ `
  <h2>Profiler</h2>
  <div id="totals" class="totals"></div>
  <div id="tools"></div>
  <div id="bottlenecks"></div>

  <h2>Timeline</h2>
  <div class="replay">
    <button id="replay-play" class="ghost">▶ replay</button>
    <button id="replay-step" class="ghost">step</button>
    <button id="replay-stop" class="ghost">stop</button>
  </div>
  <div id="steps"></div>
`;

// ── Inline styles (shared by the standalone view and the agent hub embed) ──
export const AGENT_TIMELINE_STYLES = /* css */ `
  :root {
    --canvas: #0a0e14;
    --panel: #11161f;
    --border: #1f2632;
    --text: #d7dde6;
    --muted: #7a8699;
    --cyan: #3DCED6;
    --green: #14F195;
    --amber: #FFAE00;
    --red: #ff5252;
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 12px; background: var(--canvas); color: var(--text);
         font: 12px/1.5 var(--vscode-font-family, system-ui, sans-serif); }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em;
       color: var(--muted); margin: 16px 0 6px; }
  h2:first-child { margin-top: 0; }
  .totals { color: var(--muted); font-size: 11px; }
  .replay { display: flex; gap: 4px; margin: 8px 0; }
  button.ghost { padding: 2px 8px; border: 1px solid var(--border); border-radius: 6px;
                 background: transparent; color: var(--muted); cursor: pointer; font-size: 11px; }
  button.ghost:hover { border-color: var(--cyan); color: var(--cyan); }
  button.danger:hover { border-color: var(--red); color: var(--red); }
  .step { border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px;
          margin-bottom: 4px; background: var(--panel); cursor: pointer; }
  .step:hover { border-color: var(--cyan); }
  .step.selected { border-color: var(--cyan); }
  .step.replaying { border-color: var(--green); }
  .step.error { border-color: var(--red); }
  .step.rolled-back { opacity: .55; }
  .step .title { font-weight: 600; }
  .step .explain { color: var(--muted); font-size: 11px; }
  .step .actions { margin-top: 4px; display: none; }
  .step.selected .actions { display: block; }
  .detail { margin: 6px 0 0; padding: 6px; border-radius: 6px; background: var(--canvas);
            border: 1px solid var(--border); font-family: var(--vscode-editor-font-family, monospace);
            font-size: 11px; white-space: pre-wrap; word-break: break-all; display: none; }
  .step.selected .detail { display: block; }
  .detail .key { color: var(--cyan); }
  .diff-add { color: var(--green); }
  .diff-del { color: var(--red); }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th, td { text-align: left; padding: 2px 4px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 600; }
  .bottleneck { padding: 4px 0; border-bottom: 1px solid var(--border); font-size: 11px; }
  .bottleneck .kind { color: var(--amber); text-transform: uppercase; font-size: 10px;
                      letter-spacing: .06em; }
  .empty { color: var(--muted); }
`;

export const AGENT_TIMELINE_SCRIPT = /* javascript */ `
const vscode = acquireVsCodeApi();
let state = null;
let selectedStepId = null;
let replayIndex = -1;
let replayTimer = null;

const KIND_ICON = {
  turn: "◆", reasoning: "…", content: "›", tool_call: "⚙",
  file_change: "✎", checkpoint: "▣", error: "✗",
};

function esc(text) {
  const div = document.createElement("div");
  div.textContent = String(text ?? "");
  return div.innerHTML;
}

function cost(minor) {
  const digits = String(minor ?? "0");
  const padded = digits.padStart(7, "0");
  return "$" + (padded.slice(0, -6) || "0") + "." + padded.slice(-6);
}

function renderProfiler() {
  const totals = document.getElementById("totals");
  if (!state || (state.profile.totalDurationMs === 0 && state.profile.toolCalls === 0)) {
    totals.innerHTML = '<span class="empty">No activity yet — send the agent a task.</span>';
    document.getElementById("tools").innerHTML = "";
    document.getElementById("bottlenecks").innerHTML = "";
    return;
  }
  const p = state.profile;
  totals.textContent =
    p.totalDurationMs + "ms · " + p.totalInputUnits + " in / " + p.totalOutputUnits + " out · " +
    cost(p.totalCostMinor) + " · " + p.toolCalls + " tool calls (" + p.failedToolCalls + " failed)";

  document.getElementById("tools").innerHTML = p.tools.length === 0 ? "" :
    "<table><tr><th>tool</th><th>calls</th><th>time</th><th>avg</th><th>units</th><th>cost</th></tr>" +
    p.tools.map((t) =>
      "<tr><td>" + esc(t.toolName) + "</td><td>" + t.calls +
      (t.failures ? ' <span style="color:var(--red)">(' + t.failures + "✗)</span>" : "") +
      "</td><td>" + t.totalMs + "ms</td><td>" + t.avgMs + "ms</td><td>" +
      (t.inputUnits + t.outputUnits) + "</td><td>" + cost(t.costMinor) + "</td></tr>"
    ).join("") + "</table>";

  document.getElementById("bottlenecks").innerHTML = p.bottlenecks.map((b) =>
    '<div class="bottleneck"><span class="kind">' + esc(b.kind) + "</span> " + esc(b.detail) + "</div>"
  ).join("");
}

function detailHtml(step) {
  const parts = [];
  if (step.toolCall) {
    const tc = step.toolCall;
    if (tc.filePath) parts.push('<span class="key">file:</span> ' + esc(tc.filePath));
    if (tc.command) parts.push('<span class="key">command:</span> ' + esc(tc.command));
    parts.push('<span class="key">args:</span> ' + esc(JSON.stringify(tc.args, null, 2)));
    if (tc.decisionReason) parts.push('<span class="key">decision:</span> ' + esc(tc.decisionReason));
    if (tc.output !== undefined) {
      parts.push('<span class="key">result' + (tc.isError ? " (error)" : "") + ":</span> " + esc(tc.output));
    }
  }
  if (step.fileChange) {
    const lines = step.fileChange.diff.split("\\n").map((line) => {
      const cls = line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-del" : "";
      return '<span class="' + cls + '">' + esc(line) + "</span>";
    });
    parts.push('<span class="key">diff:</span>\\n' + lines.join("\\n"));
  }
  if (step.detail && !step.toolCall && !step.fileChange) parts.push(esc(step.detail));
  return parts.join("\\n");
}

function renderSteps() {
  const el = document.getElementById("steps");
  if (!state || state.steps.length === 0) {
    el.innerHTML = '<span class="empty">Nothing recorded yet.</span>';
    return;
  }
  el.innerHTML = state.steps.map((step, i) => {
    const classes = ["step"];
    if (step.stepId === selectedStepId) classes.push("selected");
    if (i === replayIndex) classes.push("replaying");
    if (step.kind === "error" || (step.toolCall && step.toolCall.isError)) classes.push("error");
    if (step.rolledBack) classes.push("rolled-back");
    const rollback = step.kind === "file_change" && !step.rolledBack
      ? '<button class="ghost danger" data-rollback="' + step.stepId + '">rollback</button>'
      : "";
    return (
      '<div class="' + classes.join(" ") + '" data-step="' + step.stepId + '">' +
      '<div class="title">' + (KIND_ICON[step.kind] || "") + " " + esc(step.title) + "</div>" +
      '<div class="explain">' + esc(step.explanation) + "</div>" +
      '<div class="actions">' + rollback + "</div>" +
      '<div class="detail">' + detailHtml(step) + "</div>" +
      "</div>"
    );
  }).join("");
}

function stopReplay() {
  clearTimeout(replayTimer);
  replayTimer = null;
  replayIndex = -1;
  renderSteps();
}

function stepReplay() {
  if (!state || replayIndex + 1 >= state.steps.length) {
    stopReplay();
    return;
  }
  replayIndex += 1;
  renderSteps();
}

document.getElementById("replay-play").addEventListener("click", () => {
  if (replayTimer) { stopReplay(); return; }
  const tick = () => {
    if (!state || replayIndex + 1 >= state.steps.length) { stopReplay(); return; }
    stepReplay();
    replayTimer = setTimeout(tick, 600);
  };
  replayTimer = setTimeout(tick, 0);
});

document.getElementById("replay-step").addEventListener("click", () => {
  clearTimeout(replayTimer);
  replayTimer = null;
  stepReplay();
});

document.getElementById("replay-stop").addEventListener("click", stopReplay);

document.getElementById("steps").addEventListener("click", (event) => {
  const rollbackBtn = event.target.closest("button[data-rollback]");
  if (rollbackBtn) {
    vscode.postMessage({ type: "rollback", stepId: rollbackBtn.dataset.rollback });
    return;
  }
  const stepEl = event.target.closest(".step");
  if (!stepEl) return;
  selectedStepId = selectedStepId === stepEl.dataset.step ? null : stepEl.dataset.step;
  renderSteps();
});

function render() {
  renderProfiler();
  renderSteps();
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg.type === "state") {
    state = msg.state;
    render();
  }
});

vscode.postMessage({ type: "ready" });
`;
