/**
 * capix-llm/agentDebuggerPanel — the agent debugger surface for CapixIDE.
 *
 * A single webview (registered as `capix.agentDebugger.view`) driven by the
 * SHARED observability engine (`AgentTimeline` + `AgentProfiler` from the
 * vendored `@capix/agent-runtime`) — the same debugger the Capix Code CLI
 * runs from `src/debugging/agent-debugger.ts`, with the same breakpoint
 * semantics (tool, file, error, step-kind) and the same answers.
 *
 * Surface:
 *   • interactive breakpoints: stop on a tool call, a file touch, or an
 *     error; enable/disable and remove without restarting the session
 *   • step-through debugging: continue / step / pause while the agent runs;
 *     the step that tripped a breakpoint is highlighted in place
 *   • variable inspection: click any step to see its arguments and result
 *     plus the accumulated session state at that point (reasoning, content,
 *     tool calls so far, files changed)
 *   • performance profiling: execution time per tool, tokens and cost per
 *     action, and ranked bottlenecks from the shared profiler
 *
 * The host feeds events with `recordEvent()` (tapped from the engine's
 * `sendMessage` stream) and arms execution with `startDebug()`. No external
 * scripts — stays inside the strict CSP (script-src 'nonce-<nonce>').
 *
 * Visual foundation is @capix/ui-tokens dark: canvas `#0a0e14`, brand cyan
 * `#3DCED6`, success green `#14F195`, amber `#FFAE00`, error `#ff5252`.
 */

import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import {
  AgentProfiler,
  AgentTimeline,
  type AgentEvent,
  type AgentProfileReport,
  type TimelineStep,
  type TimelineStepKind,
} from './shared/agent-runtime/index';
import { logger } from './logger';

// ── Breakpoints (same semantics as src/debugging/agent-debugger.ts) ─────────

export interface DebuggerBreakpoint {
  id: string;
  /** Step kinds this breakpoint stops on; omitted = every step kind. */
  kinds?: TimelineStepKind[];
  /** Only stop on tool_call steps for this tool. */
  toolName?: string;
  /** Only stop on steps touching this file path. */
  filePath?: string;
  /** Stop when a step reports an error. */
  onError?: boolean;
  enabled: boolean;
  hits: number;
}

/** True when the step satisfies every condition the breakpoint sets. */
export function matchesBreakpoint(step: TimelineStep, breakpoint: DebuggerBreakpoint): boolean {
  if (breakpoint.kinds && breakpoint.kinds.length > 0 && !breakpoint.kinds.includes(step.kind)) {
    return false;
  }
  if (breakpoint.toolName && step.toolCall?.toolName !== breakpoint.toolName) return false;
  if (
    breakpoint.filePath &&
    step.fileChange?.filePath !== breakpoint.filePath &&
    step.toolCall?.filePath !== breakpoint.filePath
  ) {
    return false;
  }
  if (breakpoint.onError && step.kind !== 'error' && step.toolCall?.isError !== true) {
    return false;
  }
  return Boolean(
    (breakpoint.kinds && breakpoint.kinds.length > 0) ||
      breakpoint.toolName ||
      breakpoint.filePath ||
      breakpoint.onError
  );
}

// ── View state ──────────────────────────────────────────────────────────────

export type DebuggerExecution = 'idle' | 'running' | 'paused';

/** Variable inspection for one selected step, built from timeline state. */
export interface StepInspection {
  stepId: string;
  title: string;
  explanation: string;
  detail?: string;
  /** Accumulated reasoning up to and including this step. */
  reasoning: string;
  /** Accumulated assistant content up to and including this step. */
  content: string;
  /** Tool calls recorded up to and including this step. */
  toolCalls: Array<{
    toolName: string;
    status: string;
    filePath?: string;
    command?: string;
    isError?: boolean;
  }>;
  filesChanged: string[];
}

/** Serializable snapshot posted to the webview. */
export interface AgentDebuggerViewState {
  steps: TimelineStep[];
  profile: AgentProfileReport;
  breakpoints: DebuggerBreakpoint[];
  execution: DebuggerExecution;
  pausedAtStepId: string | null;
  updatedAt: string;
}

/** Build the webview snapshot from the engine instances and debugger state. */
export function toDebuggerViewState(
  timeline: AgentTimeline,
  profiler: AgentProfiler,
  breakpoints: DebuggerBreakpoint[],
  execution: DebuggerExecution,
  pausedAtStepId: string | null
): AgentDebuggerViewState {
  return {
    steps: timeline.getSteps(),
    profile: profiler.getReport(),
    breakpoints,
    execution,
    pausedAtStepId,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Build the variable-inspection view of a step: its own detail plus the
 * session state accumulated up to and including it.
 */
export function inspectStepAt(steps: TimelineStep[], stepId: string): StepInspection | null {
  const index = steps.findIndex((step) => step.stepId === stepId);
  if (index === -1) return null;
  const upto = steps.slice(0, index + 1);
  const step = steps[index]!;
  return {
    stepId,
    title: step.title,
    explanation: step.explanation,
    detail: step.detail,
    reasoning: upto
      .filter((s) => s.kind === 'reasoning')
      .map((s) => s.detail ?? '')
      .join(''),
    content: upto
      .filter((s) => s.kind === 'content')
      .map((s) => s.detail ?? '')
      .join(''),
    toolCalls: upto
      .filter((s) => s.toolCall)
      .map((s) => ({
        toolName: s.toolCall!.toolName,
        status: s.toolCall!.status,
        filePath: s.toolCall!.filePath,
        command: s.toolCall!.command,
        isError: s.toolCall!.isError,
      })),
    filesChanged: upto.filter((s) => s.fileChange).map((s) => s.fileChange!.filePath),
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

// ── Provider ────────────────────────────────────────────────────────────────

export class CapixAgentDebuggerViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'capix.agentDebugger.view';

  private view?: vscode.WebviewView;
  private timeline: AgentTimeline;
  private profiler = new AgentProfiler();
  private readonly breakpoints: DebuggerBreakpoint[] = [];
  private breakpointSeq = 0;
  private execution: DebuggerExecution = 'idle';
  private pausedAtStepId: string | null = null;
  /** Breakpoint/step pairs that already tripped — a step trips once per bp. */
  private readonly tripped = new Set<string>();
  /** Step mode pauses again at the next step-producing event. */
  private stepOnce = false;
  /** When set (agent hub embed), state snapshots go to the sink instead of a view. */
  private stateSink: ((state: AgentDebuggerViewState) => void) | null = null;
  /** When set (agent hub embed), step inspections go to the sink instead of a view. */
  private inspectionSink: ((inspection: StepInspection | null) => void) | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    options: { workspaceRoot?: string } = {}
  ) {
    this.timeline = new AgentTimeline({ workspaceRoot: options.workspaceRoot });
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

  getBreakpoints(): DebuggerBreakpoint[] {
    return [...this.breakpoints];
  }

  getExecution(): DebuggerExecution {
    return this.execution;
  }

  /** Arm the debugger: the next breakpoint hit (or step) pauses execution. */
  startDebug(): void {
    this.execution = 'running';
    this.pausedAtStepId = null;
    this.pushState();
  }

  /**
   * Record one event from the runtime stream. While the debugger is running,
   * a breakpoint hit (or an armed single step) flips execution to `paused`.
   */
  recordEvent(event: AgentEvent): void {
    const step = this.timeline.record(event);
    this.profiler.record(event);
    if (this.execution === 'running' && step) {
      // A step trips a breakpoint once — update events fold into the same
      // step and must not re-trip it (same semantics as the CLI debugger).
      const hit = this.breakpoints.find(
        (bp) =>
          bp.enabled &&
          !this.tripped.has(`${bp.id}:${step.stepId}`) &&
          matchesBreakpoint(step, bp)
      );
      if (hit) {
        this.tripped.add(`${hit.id}:${step.stepId}`);
        hit.hits += 1;
        this.execution = 'paused';
        this.pausedAtStepId = step.stepId;
      } else if (this.stepOnce) {
        this.stepOnce = false;
        this.execution = 'paused';
        this.pausedAtStepId = step.stepId;
      }
    }
    this.pushState();
  }

  /** Route state snapshots to the agent hub instead of a dedicated view. */
  setStateSink(sink: ((state: AgentDebuggerViewState) => void) | null): void {
    this.stateSink = sink;
  }

  /** Route step inspections to the agent hub instead of a dedicated view. */
  setInspectionSink(sink: ((inspection: StepInspection | null) => void) | null): void {
    this.inspectionSink = sink;
  }

  /** Push the current snapshot to the webview. */
  pushState(): void {
    const state = toDebuggerViewState(
      this.timeline,
      this.profiler,
      this.breakpoints,
      this.execution,
      this.pausedAtStepId
    );
    if (this.stateSink) {
      this.stateSink(state);
      return;
    }
    if (!this.view) return;
    void this.view.webview.postMessage({ type: 'state', state });
  }

  public handleMessage(msg: {
    type: string;
    id?: string;
    stepId?: string;
    toolName?: string;
    filePath?: string;
    onError?: boolean;
  }): void {
    try {
      switch (msg.type) {
        case 'ready':
          this.pushState();
          return;
        case 'start':
          this.startDebug();
          return;
        case 'continue':
          this.execution = 'running';
          this.pausedAtStepId = null;
          this.stepOnce = false;
          this.pushState();
          return;
        case 'step':
          // Resume but pause again at the next step-producing event.
          this.execution = 'running';
          this.pausedAtStepId = null;
          this.stepOnce = true;
          this.pushState();
          return;
        case 'pause':
          if (this.execution === 'running') {
            this.execution = 'paused';
            this.pushState();
          }
          return;
        case 'addBreakpoint':
          this.breakpointSeq += 1;
          this.breakpoints.push({
            id: `bp_${this.breakpointSeq}`,
            toolName: msg.toolName || undefined,
            filePath: msg.filePath || undefined,
            onError: msg.onError === true ? true : undefined,
            enabled: true,
            hits: 0,
          });
          this.pushState();
          return;
        case 'removeBreakpoint': {
          const at = this.breakpoints.findIndex((bp) => bp.id === msg.id);
          if (msg.id && at !== -1) this.breakpoints.splice(at, 1);
          this.pushState();
          return;
        }
        case 'toggleBreakpoint': {
          const breakpoint = this.breakpoints.find((bp) => bp.id === msg.id);
          if (breakpoint) breakpoint.enabled = !breakpoint.enabled;
          this.pushState();
          return;
        }
        case 'inspect': {
          if (!msg.stepId) return;
          const inspection = inspectStepAt(this.timeline.getSteps(), msg.stepId);
          if (this.inspectionSink) {
            this.inspectionSink(inspection);
            return;
          }
          if (!this.view) return;
          void this.view.webview.postMessage({ type: 'inspection', inspection });
          return;
        }
      }
    } catch (err) {
      logger.error('AgentDebuggerPanel message failed', { type: msg.type, error: String(err) });
      void vscode.window.showErrorMessage(
        `Debugger: ${err instanceof Error ? err.message : String(err)}`
      );
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
<style>${AGENT_DEBUGGER_STYLES}</style>
</head>
<body>
${AGENT_DEBUGGER_BODY}
  <script nonce="${nonce}">${AGENT_DEBUGGER_SCRIPT}</script>
</body>
</html>`;
  }
}

// ── Webview script (no dependencies; state arrives via postMessage) ─────────


/**
 * Body markup of the panel surface, exported so the agent hub can embed
 * it as a tab body (hub re-prefixes the element ids).
 */
export const AGENT_DEBUGGER_BODY = /* html */ `
  <h2>Debugger</h2>
  <div id="status" class="status idle">idle</div>
  <div class="controls">
    <button id="dbg-start" class="ghost">▶ debug</button>
    <button id="dbg-continue" class="ghost">continue</button>
    <button id="dbg-step" class="ghost">step</button>
    <button id="dbg-pause" class="ghost">pause</button>
  </div>

  <h2>Breakpoints</h2>
  <div class="bp-form">
    <input id="bp-tool" placeholder="tool (e.g. write_file)">
    <input id="bp-file" placeholder="file (e.g. src/app.ts)">
    <label class="ghost" style="padding:2px 8px;border:1px solid var(--border);border-radius:6px;">
      <input type="checkbox" id="bp-error" style="min-width:0;"> on error
    </label>
    <button id="bp-add" class="ghost">add</button>
  </div>
  <div id="breakpoints"></div>

  <h2>Profiler</h2>
  <div id="totals" class="totals"></div>
  <div id="tools"></div>

  <h2>Execution</h2>
  <div id="steps"></div>
  <div id="inspection"></div>
`;

// ── Inline styles (shared by the standalone view and the agent hub embed) ──
export const AGENT_DEBUGGER_STYLES = /* css */ `
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
  .status { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; }
  .status.running { color: var(--green); }
  .status.paused { color: var(--amber); }
  .status.idle { color: var(--muted); }
  .controls { display: flex; gap: 4px; margin: 8px 0; flex-wrap: wrap; }
  button.ghost { padding: 2px 8px; border: 1px solid var(--border); border-radius: 6px;
                 background: transparent; color: var(--muted); cursor: pointer; font-size: 11px; }
  button.ghost:hover { border-color: var(--cyan); color: var(--cyan); }
  button.danger:hover { border-color: var(--red); color: var(--red); }
  .bp-form { display: flex; gap: 4px; margin-bottom: 6px; flex-wrap: wrap; }
  .bp-form input { flex: 1; min-width: 80px; padding: 3px 6px; border: 1px solid var(--border);
                   border-radius: 6px; background: var(--panel); color: var(--text); font-size: 11px; }
  .bp { display: flex; align-items: center; gap: 6px; padding: 4px 6px; margin-bottom: 4px;
        border: 1px solid var(--border); border-radius: 8px; background: var(--panel); font-size: 11px; }
  .bp.disabled { opacity: .5; }
  .bp .cond { flex: 1; }
  .bp .hits { color: var(--amber); }
  .step { border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px;
          margin-bottom: 4px; background: var(--panel); cursor: pointer; }
  .step:hover { border-color: var(--cyan); }
  .step.selected { border-color: var(--cyan); }
  .step.paused-here { border-color: var(--amber); }
  .step.error { border-color: var(--red); }
  .step .title { font-weight: 600; }
  .step .explain { color: var(--muted); font-size: 11px; }
  .detail { margin: 6px 0 0; padding: 6px; border-radius: 6px; background: var(--canvas);
            border: 1px solid var(--border); font-family: var(--vscode-editor-font-family, monospace);
            font-size: 11px; white-space: pre-wrap; word-break: break-all; }
  .detail .key { color: var(--cyan); }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th, td { text-align: left; padding: 2px 4px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 600; }
  .empty { color: var(--muted); }
`;

export const AGENT_DEBUGGER_SCRIPT = /* javascript */ `
const vscode = acquireVsCodeApi();
let state = null;
let selectedStepId = null;
let inspection = null;

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

function renderStatus() {
  const el = document.getElementById("status");
  const execution = state ? state.execution : "idle";
  el.className = "status " + execution;
  el.textContent = execution === "paused" ? "paused — breakpoint hit" : execution;
}

function renderBreakpoints() {
  const el = document.getElementById("breakpoints");
  if (!state || state.breakpoints.length === 0) {
    el.innerHTML = '<span class="empty">No breakpoints set.</span>';
    return;
  }
  el.innerHTML = state.breakpoints.map((bp) => {
    const conds = [];
    if (bp.toolName) conds.push("tool=" + bp.toolName);
    if (bp.filePath) conds.push("file=" + bp.filePath);
    if (bp.onError) conds.push("on error");
    return (
      '<div class="bp' + (bp.enabled ? "" : " disabled") + '">' +
      '<span class="cond">' + esc(conds.join(", ") || "(no conditions)") + "</span>" +
      '<span class="hits">' + bp.hits + " hits</span>" +
      '<button class="ghost" data-toggle="' + bp.id + '">' + (bp.enabled ? "disable" : "enable") + "</button>" +
      '<button class="ghost danger" data-remove="' + bp.id + '">remove</button>' +
      "</div>"
    );
  }).join("");
}

function renderProfiler() {
  const totals = document.getElementById("totals");
  if (!state || (state.profile.totalDurationMs === 0 && state.profile.toolCalls === 0)) {
    totals.innerHTML = '<span class="empty">No activity yet.</span>';
    document.getElementById("tools").innerHTML = "";
    return;
  }
  const p = state.profile;
  totals.textContent =
    p.totalDurationMs + "ms · " + p.totalInputUnits + " in / " + p.totalOutputUnits + " out · " +
    cost(p.totalCostMinor) + " · " + p.toolCalls + " tool calls (" + p.failedToolCalls + " failed)";
  document.getElementById("tools").innerHTML = p.tools.length === 0 ? "" :
    "<table><tr><th>tool</th><th>calls</th><th>time</th><th>avg</th><th>cost</th></tr>" +
    p.tools.map((t) =>
      "<tr><td>" + esc(t.toolName) + "</td><td>" + t.calls +
      (t.failures ? ' <span style="color:var(--red)">(' + t.failures + "✗)</span>" : "") +
      "</td><td>" + t.totalMs + "ms</td><td>" + t.avgMs + "ms</td><td>" +
      cost(t.costMinor) + "</td></tr>"
    ).join("") + "</table>";
}

function renderSteps() {
  const el = document.getElementById("steps");
  if (!state || state.steps.length === 0) {
    el.innerHTML = '<span class="empty">Nothing recorded yet.</span>';
    return;
  }
  el.innerHTML = state.steps.map((step) => {
    const classes = ["step"];
    if (step.stepId === selectedStepId) classes.push("selected");
    if (step.stepId === state.pausedAtStepId) classes.push("paused-here");
    if (step.kind === "error" || (step.toolCall && step.toolCall.isError)) classes.push("error");
    return (
      '<div class="' + classes.join(" ") + '" data-step="' + step.stepId + '">' +
      '<div class="title">' + (KIND_ICON[step.kind] || "") + " " + esc(step.title) + "</div>" +
      '<div class="explain">' + esc(step.explanation) + "</div>" +
      "</div>"
    );
  }).join("");
}

function renderInspection() {
  const el = document.getElementById("inspection");
  if (!inspection || inspection.stepId !== selectedStepId) {
    el.innerHTML = "";
    return;
  }
  const parts = ['<div class="detail">'];
  parts.push('<span class="key">step:</span> ' + esc(inspection.title));
  parts.push('<span class="key">why:</span> ' + esc(inspection.explanation));
  if (inspection.detail) parts.push('<span class="key">detail:</span> ' + esc(inspection.detail));
  if (inspection.reasoning) {
    parts.push('<span class="key">reasoning so far:</span> ' + inspection.reasoning.length + " chars");
  }
  if (inspection.content) parts.push('<span class="key">content so far:</span> ' + esc(inspection.content));
  if (inspection.toolCalls.length > 0) {
    parts.push('<span class="key">tool calls so far:</span>');
    for (const call of inspection.toolCalls) {
      parts.push(
        "  " + esc(call.toolName) + " " + esc(call.filePath || call.command || "") +
        " [" + esc(call.status) + "]" + (call.isError ? " (error)" : "")
      );
    }
  }
  if (inspection.filesChanged.length > 0) {
    parts.push('<span class="key">files changed:</span> ' + esc(inspection.filesChanged.join(", ")));
  }
  parts.push("</div>");
  el.innerHTML = parts.join("\\n");
}

function render() {
  renderStatus();
  renderBreakpoints();
  renderProfiler();
  renderSteps();
  renderInspection();
}

document.getElementById("dbg-start").addEventListener("click", () => {
  vscode.postMessage({ type: "start" });
});
document.getElementById("dbg-continue").addEventListener("click", () => {
  vscode.postMessage({ type: "continue" });
});
document.getElementById("dbg-step").addEventListener("click", () => {
  vscode.postMessage({ type: "step" });
});
document.getElementById("dbg-pause").addEventListener("click", () => {
  vscode.postMessage({ type: "pause" });
});
document.getElementById("bp-add").addEventListener("click", () => {
  vscode.postMessage({
    type: "addBreakpoint",
    toolName: document.getElementById("bp-tool").value.trim(),
    filePath: document.getElementById("bp-file").value.trim(),
    onError: document.getElementById("bp-error").checked,
  });
});
document.getElementById("breakpoints").addEventListener("click", (event) => {
  const toggle = event.target.closest("button[data-toggle]");
  if (toggle) { vscode.postMessage({ type: "toggleBreakpoint", id: toggle.dataset.toggle }); return; }
  const remove = event.target.closest("button[data-remove]");
  if (remove) { vscode.postMessage({ type: "removeBreakpoint", id: remove.dataset.remove }); }
});
document.getElementById("steps").addEventListener("click", (event) => {
  const stepEl = event.target.closest(".step");
  if (!stepEl) return;
  selectedStepId = selectedStepId === stepEl.dataset.step ? null : stepEl.dataset.step;
  if (selectedStepId) vscode.postMessage({ type: "inspect", stepId: selectedStepId });
  else inspection = null;
  render();
});

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg.type === "state") {
    state = msg.state;
    render();
  } else if (msg.type === "inspection") {
    inspection = msg.inspection;
    render();
  }
});

vscode.postMessage({ type: "ready" });
`;
