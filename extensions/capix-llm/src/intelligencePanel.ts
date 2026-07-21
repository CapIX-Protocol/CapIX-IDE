/**
 * capix-llm/intelligencePanel — the unified Intelligence surface for CapixIDE.
 *
 * One single webview panel (registered as `capix.intelligence.panel`) that
 * replaces all the scattered intelligence views that previously competed for
 * sidebar space (the old tree views from `capix-intelligence`, the separate
 * graph webview, skills runtime view, covenant/memory/graph/agents/plans
 * accordions).
 *
 * Seven tabs:
 *     Overview | Memory | Graph | Skills | Agents | Covenant | Receipts
 *
 * Data is fetched from the Capix Intelligence backend at
 * `/api/v1/*` through the shared {@link CapixClient}. Interactions are posted
 * back to the host from the webview and resolved against the existing
 * intelligence API endpoints.
 *
 * Visual foundation is @capix/ui-tokens dark: canvas `#0a0e14`, brand cyan
 * `#3DCED6`, success green `#14F195`, amber `#FFAE00`, error `#ff5252`. No
 * external scripts — stays inside the strict CSP (script-src 'nonce-<nonce>').
 */

import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import type { CapixClient } from "./apiClient";
import { icon } from "./webviewIcons";
import * as actions from "./intelligencePanelActions";
import {
  COVENANT_TEMPLATES,
  GRAPH_SCRIPT,
  GRAPH_STYLES,
  PANEL_SCRIPT,
  PANEL_STYLES,
  emptySnapshot,
  esc,
  fmtCost,
  memoryConfidence,
  memoryProvenance,
  mergeGraph,
  recency,
  renderGraphSvg,
  truncate,
} from "./intelligencePanelAssets";
import type {
  AgentRecord,
  CodebaseSummary,
  CovenantVersion,
  CovenantViolation,
  GraphData,
  IntelligenceTab,
  MemoryNode,
  PlanRecord,
  SkillRecord,
  WorkReceipt,
  WorkspaceSnapshot,
} from "./intelligencePanelAssets";

// ── Navigation ──────────────────────────────────────────────────────────────

const NAV_TABS: Array<{ id: IntelligenceTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "memory", label: "Memory" },
  { id: "graph", label: "Graph" },
  { id: "skills", label: "Skills" },
  { id: "agents", label: "Agents" },
  { id: "covenant", label: "Covenant" },
  { id: "receipts", label: "Receipts" },
];

// ── Types ───────────────────────────────────────────────────────────────────

const API = "/api/v1";

// ── Provider ────────────────────────────────────────────────────────────────

export class IntelligencePanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  snapshot: WorkspaceSnapshot = emptySnapshot();
  private loading = false;

  constructor(
    readonly client: CapixClient,
    private readonly extensionUri: vscode.Uri,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    view.webview.html = this.getHtml();
    view.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    void this.refresh();
  }

  show(tab: IntelligenceTab = "overview"): void {
    if (this.view) {
      this.view.show?.(true);
      this.post({ type: "activate-tab", tab });
    }
  }

  async refresh(): Promise<void> {
    if (!this.view || this.loading) return;
    this.loading = true;
    this.snapshot.loading = true;
    this.post({ type: "loading", value: true });

    try {
      const configured = await this.client.checkConfigured();
      this.snapshot.configured = configured;
      if (!configured) {
        this.snapshot = { ...emptySnapshot(this.snapshot.activeTab), configured: false };
        this.view.webview.html = this.getHtml();
        return;
      }

      const soft = <T>(empty: T): ((err: unknown) => T) => (err: unknown) => {
        if (err instanceof Error && /^(401|not authenticated)/i.test(err.message)) throw err;
        return empty;
      };
      const emptyGraph: GraphData = { nodes: [], edges: [] };

      const [memoryR, graph, covenantsR, agentsR, plansR, receiptsR, skillsR, codebaseR] =
        await Promise.all([
          this.client.get<{ memory: MemoryNode[] }>(`${API}/memory`).catch(soft({ memory: [] as MemoryNode[] })),
          this.client.post<GraphData>(`${API}/graph`, {}).catch(soft(emptyGraph)),
          this.client.get<{ versions: CovenantVersion[] }>(`${API}/covenants`).catch(soft({ versions: [] as CovenantVersion[] })),
          this.client.get<{ agents: AgentRecord[] }>(`${API}/agents`).catch(soft({ agents: [] as AgentRecord[] })),
          this.client.get<{ plans: PlanRecord[] }>(`${API}/plans`).catch(soft({ plans: [] as PlanRecord[] })),
          this.client.get<{ receipts: WorkReceipt[] }>(`${API}/receipts`).catch(soft({ receipts: [] as WorkReceipt[] })),
          this.client.get<{ skills: SkillRecord[] }>(`${API}/skills`).catch(soft({ skills: [] as SkillRecord[] })),
          this.client.get<CodebaseSummary>(`${API}/codebase/summary`).catch(soft({ filesIndexed: 0, symbolsFound: 0 })),
        ]);

      const pinned = this.snapshot.pinnedMemory;
      const violations = this.extractViolations(covenantsR.versions);

      this.snapshot = {
        configured: true,
        loading: false,
        error: null,
        memory: memoryR.memory ?? [],
        pinnedMemory: pinned,
        graph: graph.nodes ? graph : emptyGraph,
        covenants: covenantsR.versions ?? [],
        violations,
        agents: agentsR.agents ?? [],
        plans: plansR.plans ?? [],
        skills: skillsR.skills ?? [],
        receipts: receiptsR.receipts ?? [],
        codebase: codebaseR ?? { filesIndexed: 0, symbolsFound: 0 },
        activeTab: this.snapshot.activeTab,
        updatedAt: new Date().toISOString(),
      };
    } catch (err) {
      this.snapshot.error = err instanceof Error ? err.message : String(err);
      if (/^(401|not authenticated)/i.test(this.snapshot.error)) {
        this.snapshot.configured = false;
      }
    } finally {
      this.loading = false;
      this.snapshot.loading = false;
      if (this.view) this.view.webview.html = this.getHtml();
    }
  }

  private extractViolations(versions: CovenantVersion[]): CovenantViolation[] {
    const rules = versions[0]?.rules ?? [];
    return rules
      .filter((r) => r.severity === "error")
      .map((r) => ({
        ruleId: r.id,
        rule: r.rule,
        severity: r.severity,
        actor: "system",
        action: "enforce",
        timestamp: versions[0]?.createdAt ?? new Date().toISOString(),
        reason: r.description,
      }));
  }

  // ── message handling ──────────────────────────────────────────────────

  private handleMessage(msg: unknown): void {
    const m = msg as { type?: string; tab?: string; id?: string; query?: string; [k: string]: unknown };
    if (!m?.type) return;

    switch (m.type) {
      case "refresh":
        void this.refresh();
        break;
      case "activate-tab":
        if (m.tab) {
          this.snapshot.activeTab = (m.tab as IntelligenceTab) ?? "overview";
          this.post({ type: "activate-tab", tab: this.snapshot.activeTab });
        }
        break;
      case "nav":
        if (m.tab) this.handleNav(m.tab as IntelligenceTab);
        break;
      case "signIn":
        void vscode.commands.executeCommand("capix.onboarding.start");
        break;
      case "searchMemory":
        void actions.searchMemory(this, String(m.query ?? ""));
        break;
      case "rememberThis":
        void actions.rememberThis(this);
        break;
      case "forgetMemory":
        void actions.forgetMemory(this, m.id);
        break;
      case "pinMemory":
        void actions.pinMemory(this, m.id);
        break;
      case "editMemory":
        void actions.editMemory(this, m.id);
        break;
      case "anchorMemory":
        void actions.anchorMemory(this, m.id);
        break;
      case "installSkill":
        void actions.installSkill(this);
        break;
      case "enableSkill":
        void actions.toggleSkill(this, m.id, "enable");
        break;
      case "disableSkill":
        void actions.toggleSkill(this, m.id, "disable");
        break;
      case "spawnAgent":
        void vscode.commands.executeCommand("capix.intelligence.spawnAgent");
        break;
      case "completeAgent":
        void actions.completeAgent(this, m.id);
        break;
      case "createPlan":
        void vscode.commands.executeCommand("capix.intelligence.createPlan");
        break;
      case "ratifyCovenant":
        void actions.ratifyCovenant(this);
        break;
      case "editCovenantRule":
        void actions.editCovenantRule(this, m.id);
        break;
      case "applyTemplate":
        void actions.applyTemplate(this, String(m.template ?? ""));
        break;
      case "verifyReceipt":
        void actions.verifyReceipt(this, m.id);
        break;
      case "graph:selectNode":
        this.post({ type: "graph:status", message: `Selected node ${String(m.nodeId ?? "").slice(0, 12)}` });
        break;
      case "graph:expand":
        void this.handleGraphExpand(String(m.nodeId ?? ""));
        break;
      case "graph:copyNode":
        void vscode.env.clipboard.writeText(String(m.nodeId ?? ""));
        vscode.window.showInformationMessage("Capix: node id copied to clipboard.");
        break;
    }
  }

  private handleNav(tab: IntelligenceTab): void {
    switch (tab) {
      case "overview":
        void this.refresh();
        break;
      case "memory":
        this.post({ type: "focus-search" });
        break;
      case "graph":
        this.post({ type: "graph:rendered" });
        break;
      default:
        break;
    }
  }

  private async handleGraphExpand(nodeId: string): Promise<void> {
    try {
      const patch = await this.client.post<GraphData>(`${API}/graph`, { query: nodeId, limit: 100 });
      this.snapshot.graph = mergeGraph(this.snapshot.graph, patch);
      this.post({ type: "graph:patch", data: patch });
    } catch (err) {
      this.post({
        type: "graph:status",
        message: `expand failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // ── command flows ─────────────────────────────────────────────────────

  private getHtml(): string {
    const nonce = randomBytes(16).toString("base64");
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">`;
    const tabs = NAV_TABS.map(
      (t) =>
        `<button class="nav-tab${t.id === this.snapshot.activeTab ? " active" : ""}" data-tab="${t.id}">${t.label}</button>`,
    ).join("");

    const body = this.snapshotHtml();

    return `<!DOCTYPE html>
<html lang="en">
<head>
${csp}
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>${PANEL_STYLES}\n${GRAPH_STYLES}</style>
</head>
<body>
  <header class="ws-header">
    <div class="ws-title">
      <span class="ws-mark">${icon("sparkle")}</span>
      <span class="ws-name">Intelligence</span>
      <span class="ws-sub">${esc(this.updatedLabel())}</span>
    </div>
    <div class="ws-actions">
      <button class="btn btn-mini" data-action="refresh" title="Refresh">${icon("refresh")}</button>
    </div>
  </header>
  <nav class="nav-bar">${tabs}</nav>
  <main id="content">${body}</main>
  <script nonce="${nonce}">${GRAPH_SCRIPT}\n${PANEL_SCRIPT}</script>
</body>
</html>`;
  }

  private updatedLabel(): string {
    if (this.snapshot.loading) return "syncing…";
    if (!this.snapshot.configured) return "not signed in";
    const d = new Date(this.snapshot.updatedAt);
    return `updated ${d.toLocaleTimeString()}`;
  }

  // ── per-tab snapshots ─────────────────────────────────────────────────

  private snapshotHtml(): string {
    if (this.snapshot.loading && !this.snapshot.configured && !this.snapshot.error) {
      return `<div class="state loading">Loading intelligence…</div>`;
    }
    if (!this.snapshot.configured) {
      return `<div class="state connect">
        <p>The Capix Intelligence workspace surfaces memory, knowledge graph, covenants, agents, and work receipts.</p>
        <p class="muted">Sign in to Capix to load your project brain.</p>
        <button class="btn btn-primary" data-action="signIn">Sign In</button>
      </div>`;
    }
    if (this.snapshot.error) {
      return `<div class="state error">
        <p>${esc(this.snapshot.error)}</p>
        <button class="btn btn-secondary" data-action="refresh">Retry</button>
      </div>`;
    }
    return `
      <section class="tab-panel${this.snapshot.activeTab === "overview" ? " active" : ""}" data-panel="overview">${this.overviewHtml()}</section>
      <section class="tab-panel${this.snapshot.activeTab === "memory" ? " active" : ""}" data-panel="memory">${this.memoryHtml()}</section>
      <section class="tab-panel${this.snapshot.activeTab === "graph" ? " active" : ""}" data-panel="graph">${this.graphHtml()}</section>
      <section class="tab-panel${this.snapshot.activeTab === "skills" ? " active" : ""}" data-panel="skills">${this.skillsHtml()}</section>
      <section class="tab-panel${this.snapshot.activeTab === "agents" ? " active" : ""}" data-panel="agents">${this.agentsHtml()}</section>
      <section class="tab-panel${this.snapshot.activeTab === "covenant" ? " active" : ""}" data-panel="covenant">${this.covenantHtml()}</section>
      <section class="tab-panel${this.snapshot.activeTab === "receipts" ? " active" : ""}" data-panel="receipts">${this.receiptsHtml()}</section>`;
  }

  // ── Overview ──────────────────────────────────────────────────────────

  private overviewHtml(): string {
    const activePlans = this.snapshot.plans.filter((p) => p.status === "in_progress" || p.status === "approved");
    const activeAgents = this.snapshot.agents.filter((a) => a.status === "running" || a.status === "pending");
    const recentDecisions = this.snapshot.memory.filter((n) => n.type === "decision").slice(0, 5);
    const covenant = this.snapshot.covenants[0];
    const cb = this.snapshot.codebase;
    const enabledSkills = this.snapshot.skills.filter((s) => s.enabled);

    const planRows = activePlans.length
      ? activePlans.map((p) => {
          const done = p.steps.filter((s) => s.status === "done").length;
          const pct = p.steps.length ? Math.round((done / p.steps.length) * 100) : 0;
          return `<div class="ov-row" data-action="createPlan" data-id="${esc(p.id)}">
            <span class="ov-badge badge-${esc(p.status)}">${esc(p.status)}</span>
            <span class="ov-content">${esc(p.title)}</span>
            <div class="ov-progress-bar"><div class="ov-progress-fill" style="width:${pct}%"></div></div>
            <span class="ov-recency">${done}/${p.steps.length}</span>
          </div>`;
        }).join("")
      : `<div class="state subtle">No active plans.</div>`;

    const agentRows = activeAgents.length
      ? activeAgents.map((a) => `
        <div class="ov-row">
          <span class="ov-badge badge-${esc(a.status)}">${esc(a.status)}</span>
          <span class="ov-content">${esc(a.name)} · ${esc(a.role)}</span>
          <span class="ov-recency">${esc(recency(a.createdAt))}</span>
        </div>`).join("")
      : `<div class="state subtle">No active agents.</div>`;

    const decisionRows = recentDecisions.length
      ? recentDecisions.map((n) => `
        <div class="ov-row">
          <span class="ov-type type-decision">decision</span>
          <span class="ov-content">${esc(truncate(n.content, 64))}</span>
        </div>`).join("")
      : `<div class="state subtle">No recent decisions.</div>`;

    const covenantCard = covenant
      ? `<div class="ov-covenant">
          <span class="legend-dot" style="background:var(--capix-cyan)"></span>
          <span>Covenant v${esc(covenant.version)} · ${covenant.rules.length} rules · ${esc(covenant.status)}</span>
          <span class="ov-badge badge-${esc(covenant.status)}">${esc(covenant.status)}</span>
          ${this.snapshot.violations.length ? `<span class="ov-badge badge-failed">${this.snapshot.violations.length} violations</span>` : ""}
        </div>`
      : `<div class="state subtle">No covenant ratified.</div>`;

    const codebaseCard = cb.filesIndexed || cb.symbolsFound
      ? `<div class="ov-covenant">
          <span class="legend-dot" style="background:var(--capix-green)"></span>
          <span>${cb.filesIndexed} files indexed · ${cb.symbolsFound} symbols${cb.language ? ` · ${esc(cb.language)}` : ""}${cb.packages ? ` · ${cb.packages} packages` : ""}</span>
          ${cb.lastSyncedAt ? `<span class="ov-recency">${esc(recency(cb.lastSyncedAt))}</span>` : ""}
        </div>`
      : `<div class="state subtle">No codebase index synced.</div>`;

    return `
      <section class="card stat-row">
        <div class="stat"><div class="stat-value">${this.snapshot.memory.length}</div><div class="stat-label">Memory</div></div>
        <div class="stat"><div class="stat-value">${activeAgents.length}</div><div class="stat-label">Active Agents</div></div>
        <div class="stat"><div class="stat-value">${enabledSkills.length}</div><div class="stat-label">Skills On</div></div>
        <div class="stat"><div class="stat-value">${activePlans.length}</div><div class="stat-label">Active Plans</div></div>
        <div class="stat"><div class="stat-value">${this.snapshot.receipts.length}</div><div class="stat-label">Receipts</div></div>
        <div class="stat"><div class="stat-value">${cb.filesIndexed}</div><div class="stat-label">Files Indexed</div></div>
        <div class="stat"><div class="stat-value">${cb.symbolsFound}</div><div class="stat-label">Symbols</div></div>
      </section>
      <div class="grid-2">
        <section class="card">
          <div class="section-head"><h2>Active Plan</h2><button class="btn btn-mini" data-action="createPlan">+ New</button></div>
          ${planRows}
        </section>
        <section class="card">
          <div class="section-head"><h2>Active Agents</h2><button class="btn btn-mini" data-action="spawnAgent">+ Spawn</button></div>
          ${agentRows}
        </section>
      </div>
      <div class="grid-2">
        <section class="card">
          <div class="section-head"><h2>Recent Decisions</h2><button class="btn btn-mini" data-action="nav" data-tab="memory">Memory →</button></div>
          ${decisionRows}
        </section>
        <section class="card">
          <div class="section-head"><h2>Covenant Status</h2><button class="btn btn-mini" data-action="nav" data-tab="covenant">Covenant →</button></div>
          ${covenantCard}
        </section>
      </div>
      <section class="card">
        <div class="section-head"><h2>Codebase Summary</h2></div>
        ${codebaseCard}
      </section>`;
  }

  // ── Memory ─────────────────────────────────────────────────────────────

  private memoryHtml(): string {
    const pinned = this.snapshot.memory.filter((n) => this.snapshot.pinnedMemory.includes(n.id));
    const unpinned = this.snapshot.memory.filter((n) => !this.snapshot.pinnedMemory.includes(n.id));

    const pinnedSection = pinned.length
      ? `<div class="section-head"><h2>Pinned</h2></div>${pinned.map((n) => this.memoryRowHtml(n, true)).join("")}`
      : "";

    const rows = unpinned.length
      ? unpinned.map((n) => this.memoryRowHtml(n, false)).join("")
      : `<div class="state subtle">No memory nodes. Click "Remember This" to add one.</div>`;

    const types = ["decision", "fact", "observation", "plan", "constraint"];
    const typeFilter = types.map((t) => `<option value="${t}">${t}</option>`).join("");

    return `
      <div class="toolbar">
        <input type="text" id="memory-search" placeholder="Search memory (hybrid retrieval)…" value="" />
        <select id="memory-type-filter"><option value="">All types</option>${typeFilter}</select>
        <button class="btn btn-primary" data-action="searchMemory">Search</button>
        <button class="btn btn-secondary" data-action="rememberThis">+ Remember This</button>
      </div>
      ${pinnedSection ? `<section class="card">${pinnedSection}</section>` : ""}
      <div class="memory-list" id="memory-list">${rows}</div>`;
  }

  private memoryRowHtml(n: MemoryNode, isPinned: boolean): string {
    const confidence = memoryConfidence(n);
    const provChain = memoryProvenance(n);
    return `<div class="mem-card${isPinned ? " pinned" : ""}" data-mem-id="${esc(n.id)}">
      <div class="mem-head">
        <span class="ov-type type-${esc(n.type)}">${esc(n.type)}</span>
        <div class="conf-bar"><div class="conf-fill" style="width:${Math.round(confidence * 100)}%"></div></div>
        <span class="conf-val">${Math.round(confidence * 100)}%</span>
        <span class="ov-recency">${esc(recency(n.createdAt))}</span>
      </div>
      <div class="mem-content" data-truncated="true">${esc(truncate(n.content, 180))}</div>
      <div class="mem-foot">
        <div class="mem-meta">
          <span title="source">src: ${esc(n.source ?? "agent")}</span>
          <span title="provenance chain">${provChain}</span>
        </div>
        <div class="mem-actions">
          <button class="icon-btn" data-action="pinMemory" data-id="${esc(n.id)}" title="${isPinned ? "Unpin" : "Pin important"}">${icon("pin")}</button>
          <button class="icon-btn" data-action="editMemory" data-id="${esc(n.id)}" title="Edit">${icon("edit")}</button>
          <button class="icon-btn danger" data-action="forgetMemory" data-id="${esc(n.id)}" title="Forget">${icon("discard")}</button>
          ${n.anchorTx
            ? `<span class="anchor-pill" title="${esc(n.anchorTx)}">on-chain</span>`
            : `<button class="icon-btn" data-action="anchorMemory" data-id="${esc(n.id)}" title="Anchor on-chain">${icon("link")}</button>`}
        </div>
      </div>
    </div>`;
  }

  // ── Graph ──────────────────────────────────────────────────────────────

  private graphHtml(): string {
    const svg = renderGraphSvg(this.snapshot.graph, { width: 800, height: 560 });
    const toolbar = `<div class="toolbar">
      <input type="text" id="graph-search" placeholder="Filter graph by label or type…" />
      <button class="btn btn-secondary" data-action="refresh">Refresh</button>
    </div>`;
    return `${toolbar}${svg}`;
  }

  // ── Skills ─────────────────────────────────────────────────────────────

  private skillsHtml(): string {
    const installed = this.snapshot.skills;
    const builtin = installed.filter((s) => s.firstParty);
    const thirdParty = installed.filter((s) => !s.firstParty);

    const render = (s: SkillRecord): string => {
      const color = s.provenance?.verified ? "var(--capix-green)" : "var(--capix-amber)";
      return `<div class="skill-card${s.enabled ? " enabled" : ""}" data-skill-id="${esc(s.id)}">
        <div class="skill-head">
          <span class="legend-dot" style="background:${color}" title="${s.provenance?.verified ? "verified" : "unverified"}"></span>
          <span class="skill-name">${esc(s.name)}</span>
          <span class="skill-ver">v${esc(s.version)}</span>
          <span class="ov-badge badge-${esc(s.status ?? (s.enabled ? "enabled" : "disabled"))}">${esc(s.status ?? (s.enabled ? "enabled" : "disabled"))}</span>
          ${s.firstParty ? `<span class="fp-pill">${esc(s.family ?? "first-party")}</span>` : ""}
        </div>
        <div class="skill-desc">${esc(s.description)}</div>
        <div class="skill-meta">
          ${s.riskClass ? `<span>risk: ${esc(s.riskClass)}</span>` : ""}
          ${s.permissions ? `<span>perms: ${s.permissions.length}</span>` : ""}
          ${s.integrityHash ? `<span>${esc(s.integrityHash.slice(0, 16))}…</span>` : ""}
          ${s.lastUsed ? `<span>used ${esc(recency(s.lastUsed))}</span>` : ""}
        </div>
        <div class="skill-actions">
          ${s.enabled
            ? `<button class="btn btn-mini" data-action="disableSkill" data-id="${esc(s.id)}">Disable</button>`
            : `<button class="btn btn-mini" data-action="enableSkill" data-id="${esc(s.id)}">Enable</button>`}
        </div>
      </div>`;
    };

    const builtinNames = ["orientation", "TDD", "refactor", "debug", "review", "deploy"];
    const builtinSection = `<div class="section-head"><h2>Built-In Skills</h2><span class="muted">${builtin.length} registered</span></div>${
      builtin.length ? builtin.map(render).join("") : builtinNames.map((name) =>
        `<div class="skill-card enabled"><div class="skill-head"><span class="legend-dot" style="background:var(--capix-green)"></span><span class="skill-name">${esc(name)}</span><span class="fp-pill">first-party</span></div><div class="skill-desc">Built-in capix skill: ${esc(name)}</div></div>`
      ).join("")
    }`;

    const thirdPartySection = thirdParty.length
      ? `<div class="section-head"><h2>Installed</h2><span class="muted">${thirdParty.length}</span></div>${thirdParty.map(render).join("")}`
      : `<div class="state subtle">No third-party skills installed.</div>`;

    return `
      <div class="toolbar">
        <button class="btn btn-primary" data-action="installSkill">+ Install Skill</button>
        <span class="muted">From URL · registry:name@version · first-party:name · JSON manifest</span>
      </div>
      <div class="grid-2">
        <section class="card">${builtinSection}</section>
        <section class="card">${thirdPartySection}</section>
      </div>`;
  }

  // ── Agents ─────────────────────────────────────────────────────────────

  private agentsHtml(): string {
    const active = this.snapshot.agents.filter((a) => a.status === "running" || a.status === "pending");
    const history = this.snapshot.agents.filter((a) => a.status !== "running" && a.status !== "pending");

    const subtree = (a: AgentRecord, depth = 0): string => {
      const children = this.snapshot.agents.filter((c) => c.parentAgentId === a.id);
      const pad = depth * 16;
      return `<div class="agent-row" style="padding-left:${pad}px">
        <span class="ov-badge badge-${esc(a.status)}">${esc(a.status)}</span>
        <span class="agent-name">${esc(a.name)}</span>
        <span class="agent-role">${esc(a.role)}</span>
        <span class="agent-trust">${esc(a.trustLevel)}</span>
        <span class="ov-recency">${esc(recency(a.createdAt))}</span>
        <span class="gen-pill">gen ${a.generation}</span>
        <div class="agent-actions">
          ${(a.status === "running" || a.status === "pending")
            ? `<button class="btn btn-mini" data-action="completeAgent" data-id="${esc(a.id)}">Complete</button>`
            : ""}
        </div>
      </div>${children.map((c) => subtree(c, depth + 1)).join("")}`;
    };

    const roots = this.snapshot.agents.filter((a) => !a.parentAgentId);
    const activeRows = active.length
      ? roots.filter((a) => a.status === "running" || a.status === "pending").map((a) => subtree(a)).join("")
      : `<div class="state subtle">No active agents.</div>`;
    const historyRows = history.length
      ? history.slice(0, 12).map((a) => subtree(a)).join("")
      : `<div class="state subtle">No agent history yet.</div>`;

    return `
      <div class="toolbar">
        <button class="btn btn-primary" data-action="spawnAgent">+ Spawn Agent</button>
        <span class="muted">${active.length} active · ${history.length} completed</span>
      </div>
      <section class="card">
        <div class="section-head"><h2>Active Sessions</h2></div>
        ${activeRows}
      </section>
      <section class="card">
        <div class="section-head"><h2>Session History</h2></div>
        ${historyRows}
      </section>`;
  }

  // ── Covenant ────────────────────────────────────────────────────────────

  private covenantHtml(): string {
    const covenant = this.snapshot.covenants[0];
    const versions = this.snapshot.covenants;
    const violations = this.snapshot.violations;

    const ruleRows = covenant
      ? covenant.rules.map((r, i) => `
        <div class="cov-rule ov-row">
          <span class="ov-badge badge-${esc(r.severity)}">${esc(r.severity)}</span>
          <span class="cov-prec">${i + 1}</span>
          <span class="ov-content">${esc(r.rule)}</span>
          ${r.description ? `<span class="muted" title="${esc(r.description)}">?</span>` : ""}
          <button class="icon-btn" data-action="editCovenantRule" data-id="${esc(r.id)}" title="Edit rule">${icon("edit")}</button>
        </div>`).join("")
      : `<div class="state subtle">No covenant ratified. Apply a template or ratify custom rules below.</div>`;

    const violationRows = violations.length
      ? violations.map((v) => `
        <div class="ov-row">
          <span class="ov-badge badge-failed">${esc(v.severity)}</span>
          <span class="ov-content">${esc(v.rule)}</span>
          <span class="ov-recency">${esc(recency(v.timestamp))}</span>
          <span class="muted">${esc(v.actor)}</span>
        </div>`).join("")
      : `<div class="state subtle">No violations recorded.</div>`;

    const versionRows = versions.length
      ? versions.slice(0, 5).map((v) => `
        <div class="ov-row">
          <span class="ov-badge badge-${esc(v.status)}">${esc(v.status)}</span>
          <span class="ov-content">Covenant v${esc(v.version)}</span>
          <span class="ov-recency">${esc(recency(v.createdAt))}</span>
          <span class="muted">${v.rules.length} rules</span>
        </div>`).join("")
      : `<div class="state subtle">No covenant versions.</div>`;

    const templates = Object.keys(COVENANT_TEMPLATES).map((name) =>
      `<button class="btn btn-mini" data-action="applyTemplate" data-template="${esc(name)}">${esc(name)}</button>`,
    ).join("");

    return `
      <div class="toolbar">
        <button class="btn btn-primary" data-action="ratifyCovenant">+ Ratify New Covenant</button>
        <span class="muted">Rules are versioned · append-only after ratification</span>
      </div>
      <section class="card">
        <div class="section-head"><h2>Active Rules${covenant ? ` (v${esc(covenant.version)})` : ""}</h2></div>
        <div class="rcpt-head" style="grid-template-columns: auto auto 1fr auto auto;">
          <span>severity</span><span>#</span><span>rule</span><span></span><span></span>
        </div>
        ${ruleRows}
      </section>
      <div class="grid-2">
        <section class="card">
          <div class="section-head"><h2>Precedence</h2></div>
          <div class="cov-precedence">
            ${covenant
              ? covenant.rules.map((r, i) =>
                  `<div class="prec-step"><span class="prec-num">${i + 1}</span><span class="prec-rule">${esc(truncate(r.rule, 40))}</span><span class="prec-sev badge-${esc(r.severity)}">${esc(r.severity)}</span></div>`
                ).join("")
              : `<div class="state subtle">No rules to visualize.</div>`}
          </div>
        </section>
        <section class="card">
          <div class="section-head"><h2>Violations Log</h2></div>
          ${violationRows}
        </section>
      </div>
      <div class="grid-2">
        <section class="card">
          <div class="section-head"><h2>Version History</h2></div>
          ${versionRows}
        </section>
        <section class="card">
          <div class="section-head"><h2>Templates</h2></div>
          <div class="template-grid">${templates}</div>
        </section>
      </div>`;
  }

  // ── Receipts ────────────────────────────────────────────────────────────

  private receiptsHtml(): string {
    const rows = this.snapshot.receipts.length
      ? this.snapshot.receipts.map((r) => {
          const settled = r.status === "confirmed" || r.status === "distributed";
          return `<div class="rcpt-row" data-id="${esc(r.id)}">
            <span class="ov-badge badge-${esc(r.status)}">${esc(r.status)}</span>
            <span class="rcpt-id">#${esc(r.id.slice(0, 10))}</span>
            <span class="rcpt-task">${esc(truncate(r.task, 56))}</span>
            <span class="rcpt-cost">${fmtCost(Number(r.costMinor ?? 0), r.currency ?? "usd")}</span>
            <span class="rcpt-merkle">${settled ? "merkle ✓" : "pending"}</span>
            <span class="rcpt-chain">${settled ? "on-chain" : "—"}</span>
            <button class="btn btn-mini" data-action="verifyReceipt" data-id="${esc(r.id)}">Verify</button>
          </div>`;
        }).join("")
      : `<div class="state subtle">No work receipts yet.</div>`;

    return `
      <section class="card">
        <div class="section-head"><h2>Work Receipts</h2><button class="btn btn-mini" data-action="refresh">${icon("refresh")}</button></div>
        <div class="rcpt-head">
          <span>status</span><span>id</span><span>task</span><span>cost</span><span>merkle</span><span>chain</span><span></span>
        </div>
        ${rows}
      </section>`;
  }

  // ── post ──────────────────────────────────────────────────────────────

  post(msg: unknown): void {
    void this.view?.webview.postMessage(msg);
  }

  /** Re-render the whole webview from the current snapshot (used by action flows). */
  rerender(): void {
    if (this.view) this.view.webview.html = this.getHtml();
  }
}
