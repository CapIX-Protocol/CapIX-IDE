/**
 * intelligencePanelAssets — pure assets for the Intelligence surface:
 * shared types, covenant templates, graph renderer, styles, client script,
 * and formatting helpers. No vscode imports — safe to unit test.
 */

export interface MemoryNode {
  id: string;
  text: string;
  tags: string[];
  pinned?: boolean;
  anchoredAt?: string;
  updatedAt?: string;
  provenance?: string;
  confidence?: number;
  [k: string]: unknown;
}

export interface GraphNode {
  id: string;
  label?: string;
  type?: string;
  [k: string]: unknown;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface CovenantRule {
  id: string;
  rule: string;
  severity: "error" | "warning" | "info";
  description?: string;
}

// ── Panel state types ───────────────────────────────────────────────

export type IntelligenceTab =
  | "overview"
  | "memory"
  | "graph"
  | "skills"
  | "agents"
  | "covenant"
  | "receipts";

export interface CovenantVersion {
  id: string;
  version: number;
  rules: CovenantRule[];
  ratifiedAt?: string;
  ratifiedBy?: string;
  [k: string]: unknown;
}

export interface AgentRecord {
  id: string;
  name: string;
  status: "running" | "completed" | "failed" | "queued";
  task?: string;
  cost?: number;
  startedAt?: string;
  completedAt?: string;
  [k: string]: unknown;
}

export interface PlanStep {
  id: string;
  title: string;
  status: "pending" | "active" | "done" | "skipped";
}

export interface PlanRecord {
  id: string;
  title: string;
  steps: PlanStep[];
  createdAt?: string;
  [k: string]: unknown;
}

export interface WorkReceipt {
  id: string;
  agentId?: string;
  summary: string;
  cost?: number;
  verified?: boolean;
  hash?: string;
  createdAt?: string;
  [k: string]: unknown;
}

export interface SkillRecord {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  version?: string;
  source?: string;
  [k: string]: unknown;
}

export interface CodebaseSummary {
  filesIndexed: number;
  symbolsFound: number;
  lastIndexedAt?: string;
}

export interface CovenantViolation {
  ruleId: string;
  rule: string;
  severity: "error" | "warning" | "info";
  reason: string;
}

export interface WorkspaceSnapshot {
  configured: boolean;
  loading: boolean;
  error: string | null;
  memory: MemoryNode[];
  pinnedMemory: string[];
  graph: GraphData;
  covenants: CovenantVersion[];
  violations: CovenantViolation[];
  agents: AgentRecord[];
  plans: PlanRecord[];
  skills: SkillRecord[];
  receipts: WorkReceipt[];
  codebase: CodebaseSummary | null;
  activeTab: IntelligenceTab;
  lastRefreshAt: string | null;
}

export function emptySnapshot(tab: IntelligenceTab = "overview"): WorkspaceSnapshot {
  return {
    configured: false,
    loading: false,
    error: null,
    memory: [],
    pinnedMemory: [],
    graph: { nodes: [], edges: [] },
    covenants: [],
    violations: [],
    agents: [],
    plans: [],
    skills: [],
    receipts: [],
    codebase: null,
    activeTab: tab,
    lastRefreshAt: new Date().toISOString(),
  };
}

// ── Covenant templates ──────────────────────────────────────────────────────

export const COVENANT_TEMPLATES: Record<string, CovenantRule[]> = {
  "Solo Dev": [
    { id: "solo-1", rule: "Prefer small, reviewable diffs over sweeping rewrites.", severity: "info" },
    { id: "solo-2", rule: "Never commit secrets, tokens, or .env contents.", severity: "error" },
    { id: "solo-3", rule: "Run the test suite before marking any task complete.", severity: "warning" },
  ],
  "Team Lead": [
    { id: "team-1", rule: "Every agent change must reference a plan step or ticket id.", severity: "warning" },
    { id: "team-2", rule: "Public API changes require a migration note in the receipt.", severity: "error" },
    { id: "team-3", rule: "Keep module boundaries: no cross-feature imports without an adapter.", severity: "warning" },
    { id: "team-4", rule: "Never commit secrets, tokens, or .env contents.", severity: "error" },
  ],
  "Production Guard": [
    { id: "prod-1", rule: "No schema migrations without a reversible rollback script.", severity: "error" },
    { id: "prod-2", rule: "All external network calls must have timeouts and retries.", severity: "error" },
    { id: "prod-3", rule: "Log structured events for every state-changing operation.", severity: "warning" },
    { id: "prod-4", rule: "Feature flags guard every new user-facing behavior.", severity: "warning" },
    { id: "prod-5", rule: "Never commit secrets, tokens, or .env contents.", severity: "error" },
  ],
};

// ── Graph renderer (pure SVG, no deps) ──────────────────────────────────────

const GRAPH_NODE_COLORS: Record<string, string> = {
  file: "#3DCED6",
  symbol: "#14F195",
  memory: "#FFAE00",
  agent: "#b48cf2",
  concept: "#7f8c98",
};

function graphColor(type: string | undefined): string {
  return GRAPH_NODE_COLORS[type ?? ""] ?? "#7f8c98";
}

export function renderGraphSvg(graph: GraphData, opts: { width: number; height: number }): string {
  const { width, height } = opts;
  const nodes = graph.nodes.slice(0, 60);
  if (!nodes.length) {
    return `<div class="graph-empty">No graph data yet — expand a memory or index the codebase.</div>`;
  }
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  const edges = graph.edges.filter((e) => idx.has(e.source) && idx.has(e.target)).slice(0, 120);

  // deterministic pseudo-random seed from id so layout is stable per render
  const seedOf = (id: string): number => {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return h / 0xffffffff;
  };

  const cx = width / 2;
  const cy = height / 2;
  const pos = nodes.map((n, i) => {
    const a = seedOf(n.id) * Math.PI * 2;
    const r = Math.min(width, height) * 0.32 * (0.4 + 0.6 * seedOf(n.id + "r"));
    return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, vx: 0, vy: 0, i };
  });

  // simple force-directed relaxation
  for (let iter = 0; iter < 80; iter++) {
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const dx = pos[j].x - pos[i].x;
        const dy = pos[j].y - pos[i].y;
        const d2 = dx * dx + dy * dy + 0.01;
        const f = 900 / d2;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        pos[i].vx -= fx; pos[i].vy -= fy;
        pos[j].vx += fx; pos[j].vy += fy;
      }
    }
    for (const e of edges) {
      const s = pos[idx.get(e.source)!];
      const t = pos[idx.get(e.target)!];
      const dx = t.x - s.x;
      const dy = t.y - s.y;
      const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const f = (d - 90) * 0.02;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      s.vx += fx; s.vy += fy;
      t.vx -= fx; t.vy -= fy;
    }
    for (const p of pos) {
      p.x += Math.max(-6, Math.min(6, p.vx));
      p.y += Math.max(-6, Math.min(6, p.vy));
      p.vx *= 0.6; p.vy *= 0.6;
      p.x = Math.max(24, Math.min(width - 24, p.x));
      p.y = Math.max(24, Math.min(height - 24, p.y));
    }
  }

  const parts: string[] = [];
  parts.push(`<svg class="graph-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Context graph">`);
  for (const e of edges) {
    const s = pos[idx.get(e.source)!];
    const t = pos[idx.get(e.target)!];
    parts.push(`<line x1="${s.x.toFixed(1)}" y1="${s.y.toFixed(1)}" x2="${t.x.toFixed(1)}" y2="${t.y.toFixed(1)}" class="graph-edge"/>`);
  }
  nodes.forEach((n, i) => {
    const p = pos[i];
    const label = truncate(n.label ?? n.id, 18);
    parts.push(
      `<g class="graph-node" data-node="${esc(n.id)}" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})">` +
      `<circle r="9" fill="${graphColor(n.type)}"/>` +
      `<text y="20" text-anchor="middle" class="graph-label">${esc(label)}</text></g>`,
    );
  });
  parts.push("</svg>");
  return parts.join("");
}

export const GRAPH_STYLES = `
.graph-wrap { position: relative; border: 1px solid rgba(255,255,255,0.07); border-radius: 12px; background: rgba(255,255,255,0.03); overflow: hidden; }
.graph-svg { display: block; width: 100%; height: 340px; }
.graph-edge { stroke: rgba(255,255,255,0.14); stroke-width: 1; }
.graph-node { cursor: pointer; }
.graph-node circle { stroke: rgba(0,0,0,0.4); stroke-width: 1.5; transition: r 120ms ease; }
.graph-node:hover circle { r: 12; }
.graph-label { fill: #9aa7b4; font-size: 9px; pointer-events: none; }
.graph-empty { padding: 32px; text-align: center; color: #7f8c98; font-size: 12px; }
.graph-toolbar { display: flex; gap: 8px; margin-bottom: 10px; align-items: center; }
.graph-status { font-size: 11px; color: #7f8c98; min-height: 14px; margin-top: 8px; }
.graph-legend { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 10px; }
.graph-legend span { display: inline-flex; align-items: center; gap: 5px; font-size: 10px; color: #9aa7b4; }
.graph-legend i { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
`;

export const GRAPH_SCRIPT = `
let selectedNode = null;
document.querySelectorAll('.graph-node').forEach(function (el) {
  el.addEventListener('click', function () {
    const id = el.getAttribute('data-node');
    if (!id) return;
    if (selectedNode === id) {
      selectedNode = null;
      vscodeApi.postMessage({ type: 'graph:expand', nodeId: id });
    } else {
      selectedNode = id;
      vscodeApi.postMessage({ type: 'graph:selectNode', nodeId: id });
    }
  });
  el.addEventListener('contextmenu', function (ev) {
    ev.preventDefault();
    const id = el.getAttribute('data-node');
    if (id) vscodeApi.postMessage({ type: 'graph:copyNode', nodeId: id });
  });
});
`;

// ── Styles ──────────────────────────────────────────────────────────────────

export const PANEL_STYLES = `
:root {
  --capix-canvas: #0a0e14;
  --capix-surface: rgba(255,255,255,0.035);
  --capix-surface-2: rgba(255,255,255,0.055);
  --capix-border: rgba(255,255,255,0.07);
  --capix-text: #d7dee6;
  --capix-muted: #8b98a5;
  --capix-cyan: #3DCED6;
  --capix-cyan-ink: #04252b;
  --capix-green: #14F195;
  --capix-amber: #FFAE00;
  --capix-red: #ff5252;
  --capix-purple: #b48cf2;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: transparent; color: var(--capix-text); font-family: var(--vscode-font-family, -apple-system, "Segoe UI", sans-serif); font-size: 12.5px; line-height: 1.45; }
button { font-family: inherit; }
.panel { display: flex; flex-direction: column; min-height: 100vh; }
.panel-header { padding: 14px 14px 10px; border-bottom: 1px solid var(--capix-border); }
.panel-title { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 700; letter-spacing: 0.01em; }
.panel-title .pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--capix-green); box-shadow: 0 0 8px rgba(20,241,149,0.7); }
.panel-subtitle { margin-top: 3px; font-size: 11px; color: var(--capix-muted); }
.nav { display: flex; gap: 2px; padding: 8px 10px; border-bottom: 1px solid var(--capix-border); overflow-x: auto; scrollbar-width: none; }
.nav::-webkit-scrollbar { display: none; }
.nav-tab { appearance: none; border: 0; background: transparent; color: var(--capix-muted); font-size: 11px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; padding: 7px 10px; border-radius: 7px; cursor: pointer; white-space: nowrap; border-bottom: 2px solid transparent; }
.nav-tab:hover { color: var(--capix-text); background: var(--capix-surface-2); }
.nav-tab.active { color: var(--capix-cyan); border-bottom-color: var(--capix-cyan); background: rgba(61,206,214,0.08); }
.tab-body { padding: 14px; display: flex; flex-direction: column; gap: 12px; }
.card { background: var(--capix-surface); border: 1px solid var(--capix-border); border-radius: 12px; padding: 13px 14px; }
.card-title { font-size: 11px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; color: var(--capix-muted); margin: 0 0 10px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.stat-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.stat { background: var(--capix-surface); border: 1px solid var(--capix-border); border-radius: 10px; padding: 10px 12px; }
.stat-value { font-size: 17px; font-weight: 700; font-variant-numeric: tabular-nums; font-family: inherit; }
.stat-label { font-size: 10.5px; color: var(--capix-muted); margin-top: 2px; }
.stat.accent .stat-value { color: var(--capix-cyan); }
.stat.good .stat-value { color: var(--capix-green); }
.stat.warn .stat-value { color: var(--capix-amber); }
.stat.bad .stat-value { color: var(--capix-red); }
.btn { appearance: none; border: 1px solid transparent; border-radius: 8px; padding: 7px 12px; font-size: 12px; font-weight: 600; cursor: pointer; transition: filter 120ms ease, background 120ms ease, border-color 120ms ease; }
.btn:hover { filter: brightness(1.08); }
.btn:disabled { opacity: 0.5; cursor: default; }
.btn-primary { background: var(--capix-cyan); color: var(--capix-cyan-ink); }
.btn-secondary { background: var(--capix-surface-2); color: var(--capix-text); border-color: var(--capix-border); }
.btn-mini { padding: 4px 9px; font-size: 11px; border-radius: 7px; background: transparent; color: var(--capix-cyan); border: 1px solid rgba(61,206,214,0.35); }
.btn-mini:hover { background: rgba(61,206,214,0.12); }
.btn-mini.danger { color: var(--capix-red); border-color: rgba(255,82,82,0.35); }
.btn-mini.danger:hover { background: rgba(255,82,82,0.1); }
.btn-row { display: flex; gap: 8px; flex-wrap: wrap; }
.input, .search-input { width: 100%; background: var(--capix-surface); border: 1px solid var(--capix-border); color: var(--capix-text); border-radius: 8px; padding: 8px 11px; font-size: 12.5px; font-family: inherit; outline: none; }
.input:focus, .search-input:focus { border-color: rgba(61,206,214,0.5); }
.memory-row { display: flex; flex-direction: column; gap: 6px; padding: 11px 12px; background: var(--capix-surface); border: 1px solid var(--capix-border); border-radius: 10px; }
.memory-row.pinned { border-color: rgba(255,174,0,0.35); }
.memory-text { font-size: 12.5px; white-space: pre-wrap; word-break: break-word; }
.memory-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 10.5px; color: var(--capix-muted); }
.memory-actions { display: flex; gap: 6px; margin-left: auto; }
.tag { display: inline-block; padding: 1px 7px; border-radius: 999px; background: var(--capix-surface-2); border: 1px solid var(--capix-border); font-size: 10px; color: var(--capix-muted); }
.badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px; font-size: 10px; font-weight: 600; letter-spacing: 0.03em; }
.badge.good { color: var(--capix-green); background: rgba(20,241,149,0.1); }
.badge.warn { color: var(--capix-amber); background: rgba(255,174,0,0.1); }
.badge.bad { color: var(--capix-red); background: rgba(255,82,82,0.1); }
.badge.info { color: var(--capix-cyan); background: rgba(61,206,214,0.1); }
.badge.muted { color: var(--capix-muted); background: var(--capix-surface-2); }
.list { display: flex; flex-direction: column; gap: 8px; }
.list-row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: var(--capix-surface); border: 1px solid var(--capix-border); border-radius: 10px; }
.list-row:hover { background: var(--capix-surface-2); }
.list-main { flex: 1; min-width: 0; }
.list-title { font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.list-sub { font-size: 11px; color: var(--capix-muted); margin-top: 2px; font-variant-numeric: tabular-nums; }
.rule-row { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; background: var(--capix-surface); border: 1px solid var(--capix-border); border-radius: 10px; }
.rule-sev { flex-shrink: 0; margin-top: 1px; }
.rule-text { flex: 1; font-size: 12.5px; }
.rule-desc { font-size: 11px; color: var(--capix-muted); margin-top: 3px; }
.empty-state { padding: 26px 18px; text-align: center; color: var(--capix-muted); }
.empty-state .empty-icon { font-size: 22px; margin-bottom: 8px; opacity: 0.7; }
.empty-state .empty-title { font-size: 12.5px; font-weight: 600; color: var(--capix-text); margin-bottom: 4px; }
.empty-state .empty-sub { font-size: 11.5px; }
.banner { padding: 12px 14px; border-radius: 10px; font-size: 12px; border: 1px solid; }
.banner.warn { color: var(--capix-amber); background: rgba(255,174,0,0.08); border-color: rgba(255,174,0,0.3); }
.banner.info { color: var(--capix-cyan); background: rgba(61,206,214,0.08); border-color: rgba(61,206,214,0.3); }
.banner.error { color: var(--capix-red); background: rgba(255,82,82,0.08); border-color: rgba(255,82,82,0.3); }
.steps { display: flex; flex-direction: column; gap: 6px; }
.step { display: flex; gap: 9px; align-items: center; font-size: 12px; }
.step-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--capix-surface-2); border: 1px solid var(--capix-border); flex-shrink: 0; }
.step.done .step-dot { background: var(--capix-green); border-color: var(--capix-green); }
.step.active .step-dot { background: var(--capix-cyan); border-color: var(--capix-cyan); box-shadow: 0 0 6px rgba(61,206,214,0.6); }
.step.done { color: var(--capix-muted); text-decoration: line-through; }
.footer-bar { margin-top: auto; padding: 10px 14px; border-top: 1px solid var(--capix-border); display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 10.5px; color: var(--capix-muted); }
.cost { font-variant-numeric: tabular-nums; }
.mono { font-family: var(--vscode-editor-font-family, ui-monospace, monospace); font-size: 11px; }
.loading-bar { height: 2px; background: var(--capix-surface-2); overflow: hidden; }
.loading-bar::after { content: ""; display: block; height: 100%; width: 40%; background: var(--capix-cyan); animation: capix-slide 1.1s ease-in-out infinite; }
@keyframes capix-slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(250%); } }
.violation { border-left: 3px solid var(--capix-red); }
.violation.warn { border-left-color: var(--capix-amber); }
.switch { position: relative; width: 30px; height: 17px; border-radius: 999px; background: var(--capix-surface-2); border: 1px solid var(--capix-border); cursor: pointer; flex-shrink: 0; transition: background 120ms ease; }
.switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 11px; height: 11px; border-radius: 50%; background: var(--capix-muted); transition: transform 120ms ease, background 120ms ease; }
.switch.on { background: rgba(61,206,214,0.25); border-color: rgba(61,206,214,0.5); }
.switch.on::after { transform: translateX(13px); background: var(--capix-cyan); }
`;

// ── Client script ───────────────────────────────────────────────────────────

export const PANEL_SCRIPT = `
const vscodeApi = acquireVsCodeApi();

document.querySelectorAll('.nav-tab').forEach(function (tab) {
  tab.addEventListener('click', function () {
    vscodeApi.postMessage({ type: 'nav', tab: tab.getAttribute('data-tab') });
    document.querySelectorAll('.nav-tab').forEach(function (t) { t.classList.remove('active'); });
    tab.classList.add('active');
  });
});

document.querySelectorAll('[data-cmd]').forEach(function (el) {
  el.addEventListener('click', function () {
    const cmd = el.getAttribute('data-cmd');
    const id = el.getAttribute('data-id');
    const msg = { type: cmd };
    if (id) msg.id = id;
    if (cmd === 'applyTemplate') msg.template = el.getAttribute('data-template');
    if (cmd === 'searchMemory') {
      const input = document.getElementById('memory-search');
      msg.query = input ? input.value : '';
    }
    vscodeApi.postMessage(msg);
  });
});

const searchInput = document.getElementById('memory-search');
if (searchInput) {
  let debounce = null;
  searchInput.addEventListener('input', function () {
    clearTimeout(debounce);
    debounce = setTimeout(function () {
      vscodeApi.postMessage({ type: 'searchMemory', query: searchInput.value });
    }, 350);
  });
  searchInput.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') vscodeApi.postMessage({ type: 'searchMemory', query: searchInput.value });
  });
}

document.querySelectorAll('.switch[data-skill]').forEach(function (el) {
  el.addEventListener('click', function () {
    const on = el.classList.toggle('on');
    vscodeApi.postMessage({ type: on ? 'enableSkill' : 'disableSkill', id: el.getAttribute('data-skill') });
  });
});

window.addEventListener('message', function (event) {
  const msg = event.data;
  if (!msg || !msg.type) return;
  if (msg.type === 'activate-tab') {
    document.querySelectorAll('.nav-tab').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-tab') === msg.tab);
    });
  }
  if (msg.type === 'focus-search') {
    const input = document.getElementById('memory-search');
    if (input) input.focus();
  }
  if (msg.type === 'graph:status') {
    const el = document.getElementById('graph-status');
    if (el) el.textContent = msg.message || '';
  }
});
`;

// ── Formatting helpers ──────────────────────────────────────────────────────

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function recency(iso: string | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function fmtCost(cost: number | undefined): string {
  if (cost === undefined || cost === null) return "—";
  if (cost === 0) return "$0.00";
  if (cost < 0.01) return "<$0.01";
  return `$${cost.toFixed(2)}`;
}

export function memoryConfidence(m: MemoryNode): number {
  const c = typeof m.confidence === "number" ? m.confidence : 0.5;
  return Math.max(0, Math.min(1, c));
}

export function memoryProvenance(m: MemoryNode): string {
  if (typeof m.provenance === "string" && m.provenance) return m.provenance;
  if (m.anchoredAt) return "anchored";
  return "observed";
}

export function mergeGraph(base: GraphData, patch: GraphData): GraphData {
  const nodes = new Map<string, GraphNode>();
  for (const n of base.nodes) nodes.set(n.id, n);
  for (const n of patch.nodes) nodes.set(n.id, n);
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const e of [...base.edges, ...patch.edges]) {
    const k = `${e.source}->${e.target}:${e.type}`;
    if (!seen.has(k)) {
      seen.add(k);
      edges.push(e);
    }
  }
  return { nodes: Array.from(nodes.values()), edges };
}
