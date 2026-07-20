/**
 * intelligencePanelAssets — pure assets for the Intelligence surface:
 * shared types, covenant templates, graph renderer, styles, client script,
 * and formatting helpers. No vscode imports — safe to unit test.
 */

interface MemoryNode {
  id: string;
  type: string;
  content: string;
  source?: string;
  anchorTx?: string;
  anchorSlot?: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
}

interface GraphNode {
  id: string;
  type: string;
  label: string;
  properties?: Record<string, unknown>;
}

interface GraphEdge {
  source: string;
  target: string;
  type: string;
}

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface CovenantRule {
  id: string;
  rule: string;
  severity: "error" | "warning" | "info";
  description?: string;
}

// ── Covenant templates ──────────────────────────────────────────────────────

export const COVENANT_TEMPLATES: Record<string, CovenantRule[]> = {
  "Solo Dev": [
    { id: "r1", rule: "no-deploy-without-tests", severity: "error", description: "All deploys must pass tests first." },
    { id: "r2", rule: "commit-before-deploy", severity: "warning", description: "Commit changes before deploying." },
    { id: "r3", rule: "single-agent-auto-scale", severity: "info", description: "Agent may auto-scale but must report to user." },
  ],
  "Team Lead": [
    { id: "r1", rule: "require-approval-for-billable", severity: "error", description: "All billable tool calls require explicit approval." },
    { id: "r2", rule: "no-breaking-changes-after-release", severity: "error", description: "Breaking changes blocked after a release tag." },
    { id: "r3", rule: "code-review-required", severity: "warning", description: "Code review required before merge." },
    { id: "r4", rule: "max-3-concurrent-agents", severity: "warning", description: "Limit concurrent agents to 3." },
  ],
  "Production Guard": [
    { id: "r1", rule: "no-direct-prod-mutation", severity: "error", description: "No direct production mutations from agents." },
    { id: "r2", rule: "require-checkpoint-before-deploy", severity: "error", description: "Create a checkpoint before deploying." },
    { id: "r3", rule: "receipt-required-for-every-action", severity: "warning", description: "Every billable action must produce a work receipt." },
  ],
};

// ── Inline graph SVG renderer ────────────────────────────────────────────────

const GRAPH_NODE_COLORS: Record<string, string> = {
  decision: "#3DCED6",
  fact: "#14F195",
  observation: "#5B8DEF",
  plan: "#FFAE00",
  constraint: "#ff5252",
  pattern: "#14F195",
  feedback: "#FFAE00",
  context: "#5B8DEF",
  relationship: "#f472b6",
  anchor: "#f472b6",
  agent: "#3DCED6",
  covenant: "#a78bfa",
  receipt: "#14F195",
  skill: "#fbbf24",
  checkpoint: "#fbbf24",
  other: "#64748b",
};

function graphColor(type: string): string {
  return GRAPH_NODE_COLORS[type] ?? GRAPH_NODE_COLORS.other;
}

export function renderGraphSvg(graph: GraphData, opts: { width: number; height: number }): string {
  const { width, height } = opts;
  const nodes = graph.nodes;
  const edges = graph.edges;
  if (!nodes.length) {
    return `<div class="graph-empty">No graph data. Memory and decisions will populate the knowledge graph.</div>`;
  }

  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) / 2 - 60;

  const positions = new Map<string, { x: number; y: number }>();
  nodes.forEach((node, i) => {
    const angle = (i / nodes.length) * 2 * Math.PI;
    const r = nodes.length === 1 ? 0 : radius * (0.5 + Math.random() * 0.5);
    positions.set(node.id, {
      x: cx + r * Math.cos(angle),
      y: cy + r * Math.sin(angle),
    });
  });

  const adj = new Map<string, string[]>();
  for (const edge of edges) {
    if (!adj.has(edge.source)) adj.set(edge.source, []);
    adj.get(edge.source)!.push(edge.target);
  }

  for (let iter = 0; iter < 80; iter++) {
    const forces = new Map<string, { fx: number; fy: number }>();
    for (const node of nodes) {
      forces.set(node.id, { fx: 0, fy: 0 });
    }

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = positions.get(nodes[i].id)!;
        const b = positions.get(nodes[j].id)!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const force = 4000 / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        forces.get(nodes[i].id)!.fx -= fx;
        forces.get(nodes[i].id)!.fy -= fy;
        forces.get(nodes[j].id)!.fx += fx;
        forces.get(nodes[j].id)!.fy += fy;
      }
    }

    for (const edge of edges) {
      const a = positions.get(edge.source);
      const b = positions.get(edge.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const force = (dist - 80) * 0.05;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      if (forces.has(edge.source)) {
        forces.get(edge.source)!.fx += fx;
        forces.get(edge.source)!.fy += fy;
      }
      if (forces.has(edge.target)) {
        forces.get(edge.target)!.fx -= fx;
        forces.get(edge.target)!.fy -= fy;
      }
    }

    for (const node of nodes) {
      const pos = positions.get(node.id)!;
      const f = forces.get(node.id)!;
      pos.x = Math.max(20, Math.min(width - 20, pos.x + f.fx * 0.1));
      pos.y = Math.max(20, Math.min(height - 20, pos.y + f.fy * 0.1));
    }
  }

  const edgePaths = edges.map((e) => {
    const a = positions.get(e.source);
    const b = positions.get(e.target);
    if (!a || !b) return "";
    return `<line class="graph-edge" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="rgba(255,255,255,0.10)" stroke-width="1" data-source="${esc(e.source)}" data-target="${esc(e.target)}" data-type="${esc(e.type)}" />`;
  }).join("");

  const nodeCircles = nodes.map((n) => {
    const pos = positions.get(n.id);
    if (!pos) return "";
    const color = graphColor(n.type);
    return `<g class="graph-node" data-node-id="${esc(n.id)}" data-node-type="${esc(n.type)}" data-node-label="${esc(n.label)}" transform="translate(${pos.x.toFixed(1)},${pos.y.toFixed(1)})" style="cursor:pointer">
      <circle r="6" fill="${color}" stroke="${color}" stroke-opacity="0.3" stroke-width="3" />
      <text y="-10" text-anchor="middle" fill="var(--capix-muted)" font-size="9" font-family="var(--vscode-editor-font-family, sans-serif)">${esc(truncate(n.label, 20))}</text>
    </g>`;
  }).join("");

  return `<div class="graph-container" id="graph-container">
    <svg id="graph-svg" viewBox="0 0 ${width} ${height}" width="100%" style="max-height:560px" xmlns="http://www.w3.org/2000/svg">
      ${edgePaths}
      ${nodeCircles}
    </svg>
    <div class="graph-legend" id="graph-legend">
      ${Object.entries(GRAPH_NODE_COLORS).slice(0, 8).map(([t, c]) =>
        `<span class="legend-item"><span class="legend-dot" style="background:${c}"></span>${esc(t)}</span>`
      ).join("")}
    </div>
    <div class="graph-status" id="graph-status">Ready · ${nodes.length} nodes · ${edges.length} edges</div>
  </div>`;
}

// ── Graph styles ────────────────────────────────────────────────────────────

export const GRAPH_STYLES = `
  .graph-container { position: relative; }
  .graph-empty { padding: 40px; text-align: center; color: var(--capix-muted); }
  .graph-legend { display: flex; flex-wrap: wrap; gap: 8px; padding: 8px 0; font-size: 10px; color: var(--capix-muted); }
  .legend-item { display: flex; align-items: center; gap: 4px; }
  .graph-status { position: absolute; bottom: 0; right: 0; font-size: 10px; color: var(--capix-dim); font-family: var(--vscode-editor-font-family, 'JetBrains Mono', monospace); padding: 4px 8px; background: rgba(10,14,20,0.8); border-radius: 4px; }
  #graph-svg { background: transparent; border: 1px solid var(--capix-border); border-radius: 8px; }
  .graph-node:hover circle { r: 9; }
  .graph-node circle { transition: r 0.15s ease; }
`;

// ── Graph client script ─────────────────────────────────────────────────────

export const GRAPH_SCRIPT = `
(function(){
  var scale = 1, panX = 0, panY = 0;
  var svg = document.getElementById('graph-svg');
  var container = document.getElementById('graph-container');
  if (!svg || !container) return;
  var isDragging = false, startX = 0, startY = 0;

  svg.addEventListener('mousedown', function(e){
    isDragging = true; startX = e.clientX; startY = e.clientY;
  });
  window.addEventListener('mousemove', function(e){
    if (!isDragging) return;
    panX += (e.clientX - startX);
    panY += (e.clientY - startY);
    startX = e.clientX; startY = e.clientY;
    svg.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + scale + ')';
  });
  window.addEventListener('mouseup', function(){ isDragging = false; });

  svg.addEventListener('wheel', function(e){
    e.preventDefault();
    scale = Math.max(0.3, Math.min(3, scale + (e.deltaY > 0 ? -0.1 : 0.1)));
    svg.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + scale + ')';
  });

  document.querySelectorAll('.graph-node').forEach(function(node){
    node.addEventListener('click', function(){
      var id = node.getAttribute('data-node-id');
      var type = node.getAttribute('data-node-type');
      var label = node.getAttribute('data-node-label');
      var st = document.getElementById('graph-status');
      if (st) st.textContent = type + ' · ' + label + ' (' + (id||'').slice(0,12) + ')';
      var vscode = acquireVsCodeApi();
      vscode.postMessage({ type: 'graph:selectNode', nodeId: id, nodeType: type });
    });
    node.addEventListener('dblclick', function(){
      var id = node.getAttribute('data-node-id');
      var vscode = acquireVsCodeApi();
      vscode.postMessage({ type: 'graph:expand', nodeId: id });
    });
  });

  window.__capixGraphFilter = function(query){
    var q = query.toLowerCase();
    document.querySelectorAll('.graph-node').forEach(function(node){
      var label = (node.getAttribute('data-node-label') || '').toLowerCase();
      var type = (node.getAttribute('data-node-type') || '').toLowerCase();
      var match = !q || label.includes(q) || type.includes(q);
      node.style.opacity = match ? '1' : '0.15';
    });
  };
})();
`;

// ── Panel styles (@capix/ui-tokens dark foundation) ──────────────────────────

export const PANEL_STYLES = `
  :root{--capix-bg:#0a0e14;--capix-chrome-deep:#070b10;--capix-fg:#f1efe9;--capix-muted:#94a3b8;--capix-dim:#64748b;--capix-cyan:#3DCED6;--capix-green:#14F195;--capix-amber:#FFAE00;--capix-red:#ff5252;--capix-border:rgba(255,255,255,0.07);--capix-border-accent:rgba(61,206,214,0.35);--capix-panel:rgba(255,255,255,0.035);--capix-panel-2:rgba(255,255,255,0.055);--capix-input:#0d1117}
  *{box-sizing:border-box}
  body{font-family:var(--vscode-font-family,'Plus Jakarta Sans',system-ui,sans-serif);color:var(--capix-fg);background:var(--capix-bg);margin:0;padding:14px 14px 28px;font-size:13px;line-height:1.45;-webkit-font-smoothing:antialiased}
  .ws-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
  .ws-title{display:flex;align-items:baseline;gap:8px}
  .ws-mark{color:var(--capix-cyan);font-size:15px}
  .ws-name{font-weight:700;font-size:15px;letter-spacing:-0.01em}
  .ws-sub{font-size:11px;color:var(--capix-dim);font-variant-numeric:tabular-nums}
  .ws-actions{display:flex;gap:6px}
  .btn{border:none;border-radius:8px;cursor:pointer;font-weight:600;font-size:12px;padding:8px 14px;font-family:inherit;transition:background .12s ease,border-color .12s ease,color .12s ease,filter .12s ease}
  .btn[disabled]{opacity:0.4;cursor:not-allowed}
  .btn:active{filter:brightness(0.92)}
  .btn-primary{background:var(--capix-cyan);color:#04252b}
  .btn-primary:hover{filter:brightness(1.1)}
  .btn-secondary{background:var(--capix-panel-2);color:var(--capix-fg);border:1px solid var(--capix-border)}
  .btn-secondary:hover{border-color:var(--capix-border-accent)}
  .btn-mini{background:transparent;color:var(--capix-muted);padding:4px 10px;font-size:11px;font-weight:600;border:1px solid var(--capix-border);border-radius:7px}
  .btn-mini:hover{background:rgba(61,206,214,0.10);color:var(--capix-cyan);border-color:var(--capix-border-accent)}
  .nav-bar{display:flex;flex-wrap:wrap;gap:2px;border-bottom:1px solid var(--capix-border);margin-bottom:16px}
  .nav-tab{background:transparent;border:none;cursor:pointer;color:var(--capix-muted);font-family:inherit;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.07em;padding:8px 12px;border-bottom:2px solid transparent;transition:color .12s ease,border-color .12s ease}
  .nav-tab:hover{color:var(--capix-fg)}
  .nav-tab.active{color:var(--capix-cyan);border-bottom-color:var(--capix-cyan)}
  .tab-panel{display:none}
  .tab-panel.active{display:block}
  .card{background:var(--capix-panel);border:1px solid var(--capix-border);border-radius:12px;padding:14px 16px;margin-bottom:12px}
  .grid-2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  @media (max-width:720px){.grid-2{grid-template-columns:1fr}
  .stat-row{display:grid;grid-template-columns:repeat(7,1fr);gap:10px}
  @media (max-width:720px){.stat-row{grid-template-columns:repeat(4,1fr)}
  @media (max-width:480px){.stat-row{grid-template-columns:repeat(3,1fr)}
  .stat{text-align:center;padding:4px 0}
  .stat-value{font-size:18px;font-weight:700;color:var(--capix-cyan);font-family:inherit;font-variant-numeric:tabular-nums;letter-spacing:-0.01em}
  .stat-label{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.07em;color:var(--capix-dim);margin-top:3px}
  .section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:8px}
  .section-head h2{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--capix-dim);margin:0}
  .muted{color:var(--capix-muted);font-size:11px}
  .toolbar{display:flex;gap:6px;align-items:center;margin-bottom:12px;flex-wrap:wrap}
  .toolbar input[type="text"],.toolbar select{flex:1;min-width:120px;background:var(--capix-input);color:var(--capix-fg);border:1px solid var(--capix-border);padding:7px 10px;font-size:12px;border-radius:8px;font-family:inherit}
  .toolbar input:focus,.toolbar select:focus{outline:none;border-color:var(--capix-border-accent)}
  .state{padding:20px 10px;text-align:center;color:var(--capix-muted)}
  .state.connect p{margin:0 0 4px}
  .state.connect .muted{margin-bottom:12px;display:block}
  .state.subtle{padding:14px;text-align:center;opacity:0.6;font-size:12px}
  .state.loading{color:var(--capix-cyan)}
  .state.error{color:var(--capix-red)}
  .ov-row{display:grid;grid-template-columns:auto auto 1fr auto auto;gap:8px;align-items:center;padding:8px 6px;border-radius:8px;border-bottom:1px solid rgba(255,255,255,0.045);cursor:pointer;transition:background .12s ease}
  .ov-row:hover{background:rgba(61,206,214,0.05)}
  .ov-content{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ov-recency{font-size:11px;color:var(--capix-dim);font-variant-numeric:tabular-nums}
  .ov-progress-bar{width:60px;height:4px;background:rgba(255,255,255,0.07);border-radius:2px;overflow:hidden}
  .ov-progress-fill{height:100%;background:var(--capix-cyan);border-radius:2px}
  .ov-type{font-size:9px;font-weight:600;text-transform:uppercase;padding:2px 8px;border-radius:999px;letter-spacing:0.05em;background:rgba(255,255,255,0.06);color:var(--capix-muted)}
  .type-decision{background:rgba(61,206,214,0.10);color:var(--capix-cyan)}
  .type-fact,.type-pattern{background:rgba(20,241,149,0.10);color:var(--capix-green)}
  .type-feedback,.type-constraint,.type-plan{background:rgba(255,174,0,0.10);color:var(--capix-amber)}
  .type-context,.type-observation{background:rgba(91,141,239,0.10);color:#5B8DEF}
  .type-relationship,.type-anchor{background:rgba(244,114,182,0.10);color:#f472b6}
  .type-instruction{background:rgba(167,139,250,0.10);color:#a78bfa}
  .ov-badge{font-size:9px;font-weight:600;text-transform:uppercase;padding:2px 8px;border-radius:999px;letter-spacing:0.05em}
  .badge-running,.badge-pending,.badge-active,.badge-in_progress,.badge-installed,.badge-enabled,.badge-submitted,.badge-draft{background:rgba(61,206,214,0.10);color:var(--capix-cyan)}
  .badge-done,.badge-completed,.badge-confirmed,.badge-distributed,.badge-approved,.badge-ratified{background:rgba(20,241,149,0.10);color:var(--capix-green)}
  .badge-deprecated,.badge-superseded{background:rgba(255,174,0,0.10);color:var(--capix-amber)}
  .badge-failed,.badge-cancelled,.badge-error{background:rgba(255,82,82,0.10);color:var(--capix-red)}
  .badge-disabled,.badge-pinned{background:rgba(255,255,255,0.06);color:var(--capix-muted)}
  .badge-warning,.badge-info{background:rgba(255,174,0,0.10);color:var(--capix-amber)}
  .ov-covenant{display:flex;align-items:center;gap:8px;padding:6px 0;flex-wrap:wrap}
  .legend-dot{width:9px;height:9px;border-radius:50%;display:inline-block}
  .memory-list{display:flex;flex-direction:column;gap:8px}
  .mem-card{background:var(--capix-panel);border:1px solid var(--capix-border);border-radius:10px;padding:12px 14px}
  .mem-card.pinned{border-color:rgba(255,174,0,0.30);background:rgba(255,174,0,0.03)}
  .mem-head{display:grid;grid-template-columns:auto 1fr auto auto;gap:8px;align-items:center;margin-bottom:6px}
  .conf-bar{background:rgba(255,255,255,0.07);height:4px;border-radius:2px;overflow:hidden}
  .conf-fill{height:100%;background:var(--capix-cyan)}
  .conf-val{font-size:10px;color:var(--capix-muted);font-variant-numeric:tabular-nums}
  .mem-content{color:var(--capix-fg);font-size:12.5px;line-height:1.5;cursor:pointer}
  .mem-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px;flex-wrap:wrap}
  .mem-meta{display:flex;gap:12px;font-size:10px;color:var(--capix-dim)}
  .mem-actions{display:flex;align-items:center;gap:4px}
  .anchor-pill{font-size:9px;font-weight:600;text-transform:uppercase;padding:2px 7px;border-radius:999px;background:rgba(20,241,149,0.10);color:var(--capix-green)}
  .skill-card{background:var(--capix-panel);border:1px solid var(--capix-border);border-radius:10px;padding:12px 14px;margin-bottom:8px;opacity:0.7}
  .skill-card.enabled{opacity:1;border-color:rgba(61,206,214,0.20)}
  .skill-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
  .skill-name{font-weight:600}
  .skill-ver{font-size:10px;color:var(--capix-dim);font-variant-numeric:tabular-nums}
  .skill-desc{font-size:11.5px;color:var(--capix-muted);margin:4px 0 6px}
  .skill-meta{display:flex;gap:10px;font-size:10px;color:var(--capix-dim);flex-wrap:wrap}
  .skill-actions{display:flex;gap:4px}
  .fp-pill{font-size:9px;font-weight:600;text-transform:uppercase;padding:2px 7px;border-radius:999px;background:rgba(167,139,250,0.10);color:#a78bfa}
  .agent-row{display:flex;align-items:center;gap:8px;padding:8px 6px;border-radius:8px;border-bottom:1px solid rgba(255,255,255,0.045);flex-wrap:wrap}
  .agent-row:hover{background:rgba(61,206,214,0.05)}
  .agent-name{font-weight:600}
  .agent-role{font-size:11px;color:var(--capix-dim)}
  .agent-trust{font-size:9px;font-weight:600;text-transform:uppercase;color:var(--capix-amber);padding:2px 6px;border-radius:5px;background:rgba(255,174,0,0.10)}
  .gen-pill{font-size:10px;color:var(--capix-muted);font-variant-numeric:tabular-nums}
  .agent-actions{margin-left:auto}
  .cov-rule{cursor:pointer}
  .cov-prec{font-size:11px;color:var(--capix-cyan);font-variant-numeric:tabular-nums;text-align:center}
  .cov-precedence{display:flex;flex-direction:column;gap:4px}
  .prec-step{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04)}
  .prec-num{font-size:11px;color:var(--capix-cyan);font-variant-numeric:tabular-nums;width:20px}
  .prec-rule{font-size:12px}
  .prec-sev{font-size:9px}
  .template-grid{display:flex;flex-direction:column;gap:8px}
  .rcpt-head,.rcpt-row{display:grid;grid-template-columns:1.2fr 1fr 3fr 0.9fr 0.9fr 0.9fr 0.7fr;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.045)}
  .rcpt-head{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.07em;color:var(--capix-dim);border-bottom:1px solid var(--capix-border)}
  .rcpt-id{font-size:11px;color:var(--capix-cyan);font-variant-numeric:tabular-nums}
  .rcpt-task{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .rcpt-cost{color:var(--capix-green);font-size:11px;font-variant-numeric:tabular-nums}
  .rcpt-merkle{font-size:10px;color:var(--capix-muted)}
  .rcpt-chain{font-size:10px;color:var(--capix-green)}
  .rcpt-row.verified{background:rgba(20,241,149,0.04)}
  .icon-btn{background:transparent;border:none;cursor:pointer;color:var(--capix-dim);font-family:inherit;font-size:12px;padding:4px 6px;border-radius:6px;transition:background .12s ease,color .12s ease}
  .icon-btn:hover{background:rgba(255,255,255,0.08);color:var(--capix-fg)}
`;

// ── Panel client script ─────────────────────────────────────────────────────

export const PANEL_SCRIPT = `
(function(){
  var vscode = acquireVsCodeApi();
  function esc(s){ if(s===null||s===undefined) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

  function activate(tab){
    document.querySelectorAll('.tab-panel').forEach(function(p){ p.classList.toggle('active', p.dataset.panel === tab); });
    document.querySelectorAll('.nav-tab').forEach(function(t){ t.classList.toggle('active', t.dataset.tab === tab); });
    if (tab === 'graph') {
      window.dispatchEvent(new CustomEvent('graph:visible'));
      setTimeout(function(){ var st = document.getElementById('graph-status'); if (st) st.textContent = st.textContent || 'Ready'; }, 50);
    }
    if (tab === 'memory') { var s = document.getElementById('memory-search'); if (s) setTimeout(function(){ s.focus(); }, 50); }
  }

  document.addEventListener('click', function(e){
    var t = e.target instanceof Element ? e.target.closest('[data-action],[data-tab],[data-mem-id]') : null;
    if (!t) return;
    if (t.dataset.tab) {
      vscode.postMessage({ type: 'activate-tab', tab: t.dataset.tab });
      activate(t.dataset.tab);
      return;
    }
    var a = t.dataset.action;
    if (!a) return;
    vscode.postMessage({
      type: a,
      id: t.dataset.id || (t.closest('[data-skill-id]') ? t.closest('[data-skill-id]').dataset.skillId : undefined) || (t.closest('[data-mem-id]') ? t.closest('[data-mem-id]').dataset.memId : undefined) || undefined,
      template: t.dataset.template || undefined,
    });
  });

  function bindSearch(){
    var s = document.getElementById('memory-search');
    if (!s) return;
    s.addEventListener('keydown', function(e){ if (e.key === 'Enter') vscode.postMessage({ type: 'searchMemory', query: s.value }); });
    if (window.__capixGraphFilter) {
      var g = document.getElementById('graph-search');
      if (g) g.addEventListener('input', function(){ window.__capixGraphFilter(g.value); });
    }
  }
  bindSearch();

  window.addEventListener('message', function(e){
    var m = e.data; if (!m || !m.type) return;
    switch (m.type) {
      case 'loading':
        document.body.classList.toggle('loading', !!m.value);
        break;
      case 'activate-tab':
        activate(m.tab);
        break;
      case 'focus-search':
        var s = document.getElementById('memory-search'); if (s) s.focus();
        break;
      case 'searchResults':
        vscode.postMessage({ type: 'activate-tab', tab: 'memory' }); activate('memory');
        break;
      case 'graph:status':
        var st = document.getElementById('graph-status'); if (st) st.textContent = m.message;
        break;
      case 'graph:rendered':
        window.dispatchEvent(new CustomEvent('graph:visible'));
        break;
      case 'graph:patch':
        break;
      case 'receipt:verified':
        var row = document.querySelector('.rcpt-row[data-id="' + m.id + '"]');
        if (row) { row.classList.add('verified'); }
        break;
    }
  });
  activate(document.querySelector('.tab-panel.active') ? document.querySelector('.tab-panel.active').dataset.panel : 'overview');
})();
`;

// ── Helpers ──────────────────────────────────────────────────────────────────

export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function recency(iso: string): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const secs = Math.max(0, (Date.now() - then) / 1000);
  if (secs < 60) return `${Math.floor(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  if (secs < 2_592_000) return `${Math.floor(secs / 86400)}d`;
  return new Date(iso).toLocaleDateString();
}

export function fmtCost(minor: number, currency: string): string {
  const major = (minor / 1_000_000).toFixed(minor % 1_000_000 === 0 ? 0 : 2);
  return `${major} ${(currency || "usd").toUpperCase()}`;
}

export function memoryConfidence(n: MemoryNode): number {
  const meta = n.metadata as Record<string, unknown> | undefined;
  const c = meta?.confidence;
  if (typeof c === "number" && c >= 0 && c <= 1) return c;
  if (typeof c === "string") {
    const parsed = Number(c);
    if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 1) return parsed;
  }
  return n.anchorTx ? 0.95 : 0.8;
}

export function memoryProvenance(n: MemoryNode): string {
  const meta = n.metadata as Record<string, unknown> | undefined;
  const authoredBy = meta?.authoredBy ? String(meta.authoredBy) : n.source ?? "agent";
  if (n.anchorTx) {
    return `chain: ${authoredBy} → anchor(${n.anchorTx.slice(0, 10)}…)`;
  }
  return `local: ${authoredBy}`;
}

export function mergeGraph(base: GraphData, patch: GraphData): GraphData {
  const nodes = new Map(base.nodes.map((n) => [n.id, n]));
  for (const n of patch.nodes) nodes.set(n.id, n);
  const seen = new Set(base.edges.map((e) => `${e.source}->${e.target}:${e.type}`));
  const edges = [...base.edges];
  for (const e of patch.edges) {
    const k = `${e.source}->${e.target}:${e.type}`;
    if (!seen.has(k)) {
      seen.add(k);
      edges.push(e);
    }
  }
  return { nodes: Array.from(nodes.values()), edges };
}
