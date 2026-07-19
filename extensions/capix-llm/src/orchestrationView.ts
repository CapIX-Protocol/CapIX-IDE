/**
 * capix-llm/orchestrationView — the epic orchestration surface for CapixIDE.
 *
 * A single webview (registered as `capix.orchestration.view`) driven by the
 * SHARED orchestration engine (`OrchestrationEngine` from the vendored
 * `@capix/agent-runtime`) — the same pipeline state machine, delegation
 * history and per-specialist cost tracking the Capix Code TUI renders.
 *
 * Surface:
 *   • pipeline flow: plan → implement → test → review → deploy, with live
 *     per-stage status and handoff summaries
 *   • real-time agent cards: state, current task, progress, model, spend
 *   • delegation composer with smart specialist suggestions and a cost
 *     estimate BEFORE delegating (integer minor units, never floats)
 *   • delegation history with outcomes
 *
 * The host mirrors engine state on every orchestration event and posts it to
 * the webview; the webview posts operator intents (delegate, pipeline,
 * cancel, retry/skip stage) back. No external scripts — stays inside the
 * strict CSP (script-src 'nonce-<nonce>').
 *
 * Visual foundation is @capix/ui-tokens dark: canvas `#0a0e14`, brand cyan
 * `#3DCED6`, success green `#14F195`, amber `#FFAE00`, error `#ff5252`.
 */

import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import {
  OrchestrationEngine,
  estimateDelegationCost,
  suggestSpecialists,
  type AgentPipeline,
  type Delegation,
  type DelegationCostEstimate,
  type SpecialistCost,
  type SpecialistStatus,
  type SpecialistSuggestion,
  type TaskComplexity,
} from './shared/agent-runtime/index';
import { logger } from './logger';

// ── View state ──────────────────────────────────────────────────────────────

/** Serializable snapshot posted to the webview. */
export interface OrchestrationViewState {
  pipeline: AgentPipeline | null;
  pipelines: number;
  specialists: SpecialistStatus[];
  active: Delegation[];
  queued: Delegation[];
  history: Delegation[];
  costs: SpecialistCost[];
  /** Smart suggestions for the composer's current draft task. */
  suggestions: SpecialistSuggestion[];
  /** Cost estimate for the draft task + resolved role; null without a draft. */
  estimate: DelegationCostEstimate | null;
  updatedAt: string;
}

/** Build the webview snapshot from the engine plus the composer's draft. */
export function toViewState(
  engine: OrchestrationEngine,
  draft: { task?: string; role?: string; complexity?: TaskComplexity } = {}
): OrchestrationViewState {
  const pipelines = engine.listPipelines();
  const task = draft.task?.trim() ?? '';
  const suggestions = task ? suggestSpecialists(task, { max: 3 }) : [];
  const role = draft.role ?? suggestions[0]?.role ?? null;
  return {
    pipeline: pipelines[0] ?? null,
    pipelines: pipelines.length,
    specialists: engine.getSpecialistStatuses(),
    active: engine.getActiveDelegations(),
    queued: engine.getQueuedDelegations(),
    history: engine.getHistory({ limit: 12 }),
    costs: engine.getCostBreakdown(),
    suggestions,
    estimate: role ? estimateDelegationCost(role, { complexity: draft.complexity }) : null,
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

/** `12.34` from integer USD minor units (cents) — string math, no floats. */
export function formatUsdMinor(amountMinor: string): string {
  const negative = amountMinor.startsWith('-');
  const digits = negative ? amountMinor.slice(1) : amountMinor;
  const padded = digits.padStart(3, '0');
  const major = padded.slice(0, -2) || '0';
  const minor = padded.slice(-2);
  return `${negative ? '-' : ''}${major}.${minor}`;
}

// ── Provider ────────────────────────────────────────────────────────────────

export class CapixOrchestrationViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'capix.orchestration.view';

  private view?: vscode.WebviewView;
  private draftTask = '';
  private draftRole: string | undefined;
  private readonly engine: OrchestrationEngine;
  private readonly unsubscribeEngine: () => void;

  constructor(
    engine: OrchestrationEngine,
    private readonly extensionUri: vscode.Uri
  ) {
    this.engine = engine;
    this.unsubscribeEngine = this.engine.subscribe(() => this.pushState());
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
    this.unsubscribeEngine();
  }

  /** Push the current engine snapshot to the webview. */
  pushState(): void {
    if (!this.view) return;
    const state = toViewState(this.engine, { task: this.draftTask, role: this.draftRole });
    void this.view.webview.postMessage({ type: 'state', state });
  }

  private async handleMessage(msg: {
    type: string;
    task?: string;
    role?: string;
    goal?: string;
    id?: string;
    stage?: AgentPipeline['stages'][number]['stage'];
  }): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready':
          this.pushState();
          return;
        case 'draft':
          this.draftTask = msg.task ?? '';
          if (msg.role !== undefined) this.draftRole = msg.role || undefined;
          this.pushState();
          return;
        case 'delegate': {
          const task = (msg.task ?? this.draftTask).trim();
          if (!task) return;
          const role =
            msg.role ||
            this.draftRole ||
            suggestSpecialists(task, { max: 1 })[0]?.role ||
            'implement';
          this.engine.delegate({ role, task });
          this.draftTask = '';
          this.draftRole = undefined;
          this.pushState();
          return;
        }
        case 'startPipeline': {
          const goal = (msg.goal ?? '').trim();
          if (!goal) return;
          const pipeline = this.engine.createPipeline(goal);
          await this.engine.startPipeline(pipeline.id);
          return;
        }
        case 'cancelDelegation':
          if (msg.id) await this.engine.cancelDelegation(msg.id);
          return;
        case 'retryStage': {
          const pipeline = this.engine.listPipelines()[0];
          if (pipeline && msg.stage) await this.engine.retryStage(pipeline.id, msg.stage);
          return;
        }
        case 'skipStage': {
          const pipeline = this.engine.listPipelines()[0];
          if (pipeline && msg.stage) this.engine.skipStage(pipeline.id, msg.stage);
          return;
        }
      }
    } catch (err) {
      logger.error('OrchestrationView message failed', { type: msg.type, error: String(err) });
      void vscode.window.showErrorMessage(
        `Orchestration: ${err instanceof Error ? err.message : String(err)}`
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
<style>
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
  .pipeline { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
  .stage { padding: 3px 8px; border: 1px solid var(--border); border-radius: 10px;
           background: var(--panel); white-space: nowrap; }
  .stage.running { border-color: var(--cyan); color: var(--cyan); }
  .stage.completed { border-color: var(--green); color: var(--green); }
  .stage.failed, .stage.blocked { border-color: var(--red); color: var(--red); }
  .stage.skipped { opacity: .5; }
  .arrow { color: var(--muted); }
  .stage-actions button { margin-left: 4px; }
  .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .card { border: 1px solid var(--border); border-radius: 8px; padding: 8px; background: var(--panel); }
  .card.running { border-color: var(--cyan); }
  .card .name { font-weight: 600; }
  .card .model, .card .task, .card .cost { color: var(--muted); font-size: 11px; }
  .card .task { color: var(--text); margin-top: 4px; }
  .bar { height: 4px; border-radius: 2px; background: var(--border); margin-top: 6px; overflow: hidden; }
  .bar > div { height: 100%; background: var(--cyan); }
  .state-running { color: var(--cyan); }
  .state-queued { color: var(--amber); }
  .state-idle { color: var(--muted); }
  .composer { display: flex; flex-direction: column; gap: 6px; }
  .composer input, .composer select { width: 100%; padding: 6px 8px; border-radius: 6px;
    border: 1px solid var(--border); background: var(--panel); color: var(--text); }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip { padding: 2px 8px; border-radius: 10px; border: 1px solid var(--cyan);
          background: transparent; color: var(--cyan); cursor: pointer; font-size: 11px; }
  .chip.selected { background: var(--cyan); color: var(--canvas); }
  .estimate { color: var(--amber); font-size: 11px; }
  button.primary { padding: 6px 12px; border: none; border-radius: 6px;
                   background: var(--green); color: var(--canvas); font-weight: 600; cursor: pointer; }
  button.ghost { padding: 2px 8px; border: 1px solid var(--border); border-radius: 6px;
                 background: transparent; color: var(--muted); cursor: pointer; font-size: 11px; }
  .history-item { padding: 6px 0; border-bottom: 1px solid var(--border); }
  .history-item .meta { color: var(--muted); font-size: 11px; }
  .ok { color: var(--green); } .fail { color: var(--red); } .partial { color: var(--amber); }
  .empty { color: var(--muted); }
</style>
</head>
<body>
  <h2>Pipeline</h2>
  <div id="pipeline" class="pipeline"></div>

  <h2>Agents</h2>
  <div id="agents" class="cards"></div>

  <h2>Delegate</h2>
  <div class="composer">
    <input id="task" type="text" placeholder="Describe the task — specialists are suggested automatically" />
    <div id="chips" class="chips"></div>
    <div id="estimate" class="estimate"></div>
    <div>
      <button id="delegate" class="primary">Delegate</button>
      <button id="pipeline-start" class="ghost">Run full pipeline</button>
    </div>
  </div>

  <h2>History</h2>
  <div id="history"></div>

  <script nonce="${nonce}">${ORCHESTRATION_SCRIPT}</script>
</body>
</html>`;
  }
}

// ── Webview script (no dependencies; state arrives via postMessage) ─────────

const ORCHESTRATION_SCRIPT = /* javascript */ `
const vscode = acquireVsCodeApi();
let state = null;
let selectedRole = "";

const STAGE_ICON = { plan: "📋", implement: "⚡", test: "🧪", review: "👀", deploy: "🚀" };
const OUTCOME_CLASS = { success: "ok", partial: "partial", failed: "fail" };

function esc(text) {
  const div = document.createElement("div");
  div.textContent = String(text ?? "");
  return div.innerHTML;
}

function usd(minor) {
  const digits = String(minor ?? "0");
  const padded = digits.padStart(3, "0");
  return "$" + (padded.slice(0, -2) || "0") + "." + padded.slice(-2);
}

function renderPipeline() {
  const el = document.getElementById("pipeline");
  if (!state || !state.pipeline) {
    el.innerHTML = '<span class="empty">No pipeline — run one with "Run full pipeline".</span>';
    return;
  }
  const parts = [];
  for (const s of state.pipeline.stages) {
    const actions =
      s.status === "failed" || s.status === "blocked"
        ? '<span class="stage-actions"><button class="ghost" data-retry="' + s.stage + '">retry</button>' +
          '<button class="ghost" data-skip="' + s.stage + '">skip</button></span>'
        : "";
    parts.push(
      '<span class="stage ' + s.status + '" title="' + esc(s.summary || s.status) + '">' +
      (STAGE_ICON[s.stage] || "") + " " + s.stage + " " + esc(s.specialistRole) + actions + "</span>"
    );
  }
  el.innerHTML = parts.join('<span class="arrow">→</span>');
}

function renderAgents() {
  const el = document.getElementById("agents");
  if (!state || state.specialists.length === 0) {
    el.innerHTML = '<span class="empty">No specialists registered.</span>';
    return;
  }
  el.innerHTML = state.specialists.map((s) => {
    const pct = s.progress === null ? 0 : Math.round(s.progress * 100);
    const bar = s.state === "running"
      ? '<div class="bar"><div style="width:' + pct + '%"></div></div>'
      : "";
    const cancel = s.activeDelegationId
      ? '<button class="ghost" data-cancel="' + s.activeDelegationId + '">cancel</button>'
      : "";
    return (
      '<div class="card ' + s.state + '">' +
      '<div class="name">' + s.icon + " " + esc(s.name) + ' <span class="state-' + s.state + '">' + s.state + "</span></div>" +
      '<div class="model">' + esc(s.model) + "</div>" +
      (s.currentTask ? '<div class="task">' + esc(s.currentTask) + (s.currentStep ? " · " + esc(s.currentStep) : "") + "</div>" : "") +
      bar +
      '<div class="cost">' + usd(s.costMinor) + " spent " + cancel + "</div>" +
      "</div>"
    );
  }).join("");
}

function renderChips() {
  const el = document.getElementById("chips");
  if (!state || state.suggestions.length === 0) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = state.suggestions.map((s) =>
    '<button class="chip' + (s.role === selectedRole ? " selected" : "") + '" data-role="' + s.role + '">' +
    s.icon + " " + esc(s.name) + " " + Math.round(s.score * 100) + "%</button>"
  ).join("");
}

function renderEstimate() {
  const el = document.getElementById("estimate");
  if (!state || !state.estimate) {
    el.textContent = "";
    return;
  }
  el.textContent =
    "est. " + usd(state.estimate.estimatedMinor) + " (ceiling " + usd(state.estimate.ceilingMinor) + ") · " + state.estimate.role;
}

function renderHistory() {
  const el = document.getElementById("history");
  if (!state || state.history.length === 0) {
    el.innerHTML = '<span class="empty">Nothing delegated yet.</span>';
    return;
  }
  el.innerHTML = state.history.map((d) => {
    const cls = d.outcome ? OUTCOME_CLASS[d.outcome] : "";
    const mark = d.outcome === "success" ? "✓" : d.outcome === "failed" ? "✗" : d.outcome === "partial" ? "◐" : "…";
    return (
      '<div class="history-item">' +
      '<span class="' + cls + '">' + mark + "</span> <strong>" + esc(d.role) + "</strong> — " + esc(d.summary || d.error || d.status) +
      '<div class="meta">' + esc(d.task) + " · " + usd(d.costMinor) + "</div>" +
      "</div>"
    );
  }).join("");
}

function render() {
  renderPipeline();
  renderAgents();
  renderChips();
  renderEstimate();
  renderHistory();
}

const taskInput = document.getElementById("task");
let draftTimer = null;
taskInput.addEventListener("input", () => {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    vscode.postMessage({ type: "draft", task: taskInput.value, role: selectedRole });
  }, 150);
});

document.getElementById("delegate").addEventListener("click", () => {
  const task = taskInput.value.trim();
  if (!task) return;
  vscode.postMessage({ type: "delegate", task, role: selectedRole });
  taskInput.value = "";
  selectedRole = "";
});

document.getElementById("pipeline-start").addEventListener("click", () => {
  const goal = taskInput.value.trim();
  if (!goal) return;
  vscode.postMessage({ type: "startPipeline", goal });
  taskInput.value = "";
});

document.body.addEventListener("click", (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  if (target.dataset.role) {
    selectedRole = target.dataset.role === selectedRole ? "" : target.dataset.role;
    vscode.postMessage({ type: "draft", task: taskInput.value, role: selectedRole });
  } else if (target.dataset.cancel) {
    vscode.postMessage({ type: "cancelDelegation", id: target.dataset.cancel });
  } else if (target.dataset.retry) {
    vscode.postMessage({ type: "retryStage", stage: target.dataset.retry });
  } else if (target.dataset.skip) {
    vscode.postMessage({ type: "skipStage", stage: target.dataset.skip });
  }
});

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg.type === "state") {
    state = msg.state;
    if (state.estimate) selectedRole = state.estimate.role;
    render();
  }
});

vscode.postMessage({ type: "ready" });
`;
