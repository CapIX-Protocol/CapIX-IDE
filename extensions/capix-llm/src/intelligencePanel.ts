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

// ── Navigation ──────────────────────────────────────────────────────────────

export type IntelligenceTab =
  | "overview"
  | "memory"
  | "graph"
  | "skills"
  | "agents"
  | "covenant"
  | "receipts";

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

interface CovenantVersion {
  version: string;
  rules: CovenantRule[];
  createdAt: string;
  status: "draft" | "ratified" | "superseded";
}

interface AgentRecord {
  id: string;
  name: string;
  role: string;
  status: string;
  trustLevel: string;
  generation: number;
  parentAgentId?: string;
  projectId?: string;
  createdAt: string;
  completedAt?: string;
  result?: unknown;
}

interface PlanStep {
  id: string;
  description: string;
  status: string;
  order: number;
}

interface PlanRecord {
  id: string;
  title: string;
  description: string;
  status: string;
  steps: PlanStep[];
  projectId?: string;
  createdAt: string;
  updatedAt: string;
}

interface WorkReceipt {
  id: string;
  agentId: string;
  task: string;
  result?: unknown;
  costMinor?: string;
  currency?: string;
  devTokens?: number;
  status: string;
  createdAt: string;
}

interface SkillRecord {
  id: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  firstParty?: boolean;
  family?: string;
  status?: string;
  riskClass?: string;
  permissions?: string[];
  requiredTools?: string[];
  networkPolicy?: { allowedHosts: string[] };
  integrityHash?: string;
  provenance?: { verified?: boolean };
  lastUsed?: string;
  handler?: string;
  registeredAt?: string;
}

interface CodebaseSummary {
  filesIndexed: number;
  symbolsFound: number;
  lastSyncedAt?: string;
  language?: string;
  packages?: number;
}

interface CovenantViolation {
  ruleId: string;
  rule: string;
  severity: string;
  actor: string;
  action: string;
  timestamp: string;
  reason?: string;
}

interface WorkspaceSnapshot {
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
  codebase: CodebaseSummary;

  activeTab: IntelligenceTab;
  updatedAt: string;
}

function emptySnapshot(tab: IntelligenceTab = "overview"): WorkspaceSnapshot {
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
    codebase: { filesIndexed: 0, symbolsFound: 0 },
    activeTab: tab,
    updatedAt: new Date().toISOString(),
  };
}

const API = "/api/v1";

// ── Provider ────────────────────────────────────────────────────────────────

export class IntelligencePanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private snapshot: WorkspaceSnapshot = emptySnapshot();
  private loading = false;

  constructor(
    private readonly client: CapixClient,
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
        void this.searchMemory(String(m.query ?? ""));
        break;
      case "rememberThis":
        void this.rememberThis();
        break;
      case "forgetMemory":
        void this.forgetMemory(m.id);
        break;
      case "pinMemory":
        void this.pinMemory(m.id);
        break;
      case "editMemory":
        void this.editMemory(m.id);
        break;
      case "anchorMemory":
        void this.anchorMemory(m.id);
        break;
      case "installSkill":
        void this.installSkill();
        break;
      case "enableSkill":
        void this.toggleSkill(m.id, "enable");
        break;
      case "disableSkill":
        void this.toggleSkill(m.id, "disable");
        break;
      case "spawnAgent":
        void vscode.commands.executeCommand("capix.intelligence.spawnAgent");
        break;
      case "completeAgent":
        void this.completeAgent(m.id);
        break;
      case "createPlan":
        void vscode.commands.executeCommand("capix.intelligence.createPlan");
        break;
      case "ratifyCovenant":
        void this.ratifyCovenant();
        break;
      case "editCovenantRule":
        void this.editCovenantRule(m.id);
        break;
      case "applyTemplate":
        void this.applyTemplate(String(m.template ?? ""));
        break;
      case "verifyReceipt":
        void this.verifyReceipt(m.id);
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

  private async searchMemory(query: string): Promise<void> {
    if (!query.trim()) return;
    this.post({ type: "loading", value: true });
    try {
      const res = await this.client.post<{ results: Array<{ node: MemoryNode; score: number }> }>(
        `${API}/memory/retrieve`,
        { query, topK: 25 },
      );
      this.snapshot.memory = res.results.map((r) => r.node);
      this.post({ type: "searchResults", count: res.results.length });
      if (this.view) this.view.webview.html = this.getHtml();
    } catch (err) {
      vscode.window.showErrorMessage(`Capix memory search failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.post({ type: "loading", value: false });
    }
  }

  private async rememberThis(): Promise<void> {
    const content = await vscode.window.showInputBox({
      prompt: "What should be remembered?",
      placeHolder: "Enter a fact, decision, observation, or constraint…",
    });
    if (!content) return;
    const type = await vscode.window.showQuickPick(
      ["decision", "fact", "observation", "plan", "constraint"],
      { placeHolder: "Memory type", title: "Capix: Remember This" },
    );
    try {
      await this.client.post(`${API}/memory`, {
        type: type ?? "fact",
        content,
        source: "user",
        metadata: { confidence: 1.0 },
      });
      await this.refresh();
      vscode.window.showInformationMessage("Capix: memory written.");
    } catch (err) {
      vscode.window.showErrorMessage(`Capix write memory failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async forgetMemory(id: string | undefined): Promise<void> {
    if (!id) return;
    const node = this.snapshot.memory.find((n) => n.id === id);
    if (!node) return;
    const choice = await vscode.window.showWarningMessage(
      node.anchorTx
        ? `Memory ${node.id.slice(0, 8)} is anchored and immutable. Supersede with corrected content?`
        : `Forget memory ${node.id.slice(0, 8)}? It will be superseded (memory is append-only).`,
      { modal: true },
      "Forget",
    );
    if (choice !== "Forget") return;
    try {
      await this.client.post(`${API}/memory`, {
        type: node.type,
        content: `[forgotten] ${node.content}`,
        source: `${node.source ?? "agent"} (forget)`,
        metadata: { ...(node.metadata ?? {}), supersedes: node.id, forgotten: true },
      });
      this.snapshot.pinnedMemory = this.snapshot.pinnedMemory.filter((pid) => pid !== id);
      await this.refresh();
      vscode.window.showInformationMessage("Capix: memory superseded.");
    } catch (err) {
      vscode.window.showErrorMessage(`Capix forget memory failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async pinMemory(id: string | undefined): Promise<void> {
    if (!id) return;
    if (this.snapshot.pinnedMemory.includes(id)) {
      this.snapshot.pinnedMemory = this.snapshot.pinnedMemory.filter((pid) => pid !== id);
    } else {
      this.snapshot.pinnedMemory.push(id);
    }
    if (this.view) this.view.webview.html = this.getHtml();
  }

  private async editMemory(id: string | undefined): Promise<void> {
    if (!id) return;
    const node = this.snapshot.memory.find((n) => n.id === id);
    if (!node) return;
    const content = await vscode.window.showInputBox({
      prompt: `Update memory (${node.type})`,
      value: node.content,
      placeHolder: "What should be remembered?",
    });
    if (!content) return;
    try {
      await this.client.post(`${API}/memory`, {
        type: node.type,
        content,
        source: node.source ? `${node.source} (edit)` : "user-edit",
        metadata: { ...(node.metadata ?? {}), supersedes: node.id },
      });
      await this.refresh();
      vscode.window.showInformationMessage("Capix: memory updated.");
    } catch (err) {
      vscode.window.showErrorMessage(`Capix edit memory failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async anchorMemory(id: string | undefined): Promise<void> {
    if (!id) return;
    try {
      const res = await this.client.post<{ txSignature: string; slot: number }>(`${API}/memory/anchor`, {
        memoryId: id,
      });
      vscode.window.showInformationMessage(
        `Capix: memory anchored (tx ${res.txSignature.slice(0, 12)}… slot ${res.slot}).`,
      );
      await this.refresh();
    } catch (err) {
      vscode.window.showErrorMessage(`Capix anchor memory failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async installSkill(): Promise<void> {
    const source = await vscode.window.showInputBox({
      prompt: "Install skill from URL, registry:name@version, first-party:name, or JSON manifest",
      placeHolder: "https://capix.network/skills/my-skill.json",
    });
    if (!source) return;
    try {
      await this.client.post(`${API}/skills`, { source });
      await this.refresh();
      vscode.window.showInformationMessage(`Capix: skill installed from ${source}.`);
    } catch (err) {
      vscode.window.showErrorMessage(`Capix install skill failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async toggleSkill(id: string | undefined, action: "enable" | "disable"): Promise<void> {
    if (!id) return;
    try {
      await this.client.post(`${API}/skills/${encodeURIComponent(id)}`, { action });
      await this.refresh();
    } catch (err) {
      vscode.window.showErrorMessage(`Capix ${action} skill failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async completeAgent(id: string | undefined): Promise<void> {
    if (!id) return;
    try {
      await this.client.post(`${API}/agents/${encodeURIComponent(id)}`, { status: "completed" });
      await this.refresh();
      vscode.window.showInformationMessage("Capix: agent completed.");
    } catch (err) {
      vscode.window.showErrorMessage(`Capix complete agent failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async ratifyCovenant(): Promise<void> {
    const activeCovenant = this.snapshot.covenants[0];
    if (!activeCovenant) return;
    const rulesJson = await vscode.window.showInputBox({
      prompt: `Ratify new covenant (v${activeCovenant.version}): paste rules as JSON array`,
      placeHolder: JSON.stringify([{ id: "r1", rule: "no-breaking-changes-after-release", severity: "error" }]),
    });
    if (!rulesJson) return;
    let rules: CovenantRule[];
    try {
      rules = JSON.parse(rulesJson);
    } catch {
      vscode.window.showErrorMessage("Capix: invalid JSON.");
      return;
    }
    try {
      await this.client.post(`${API}/covenants`, { rules });
      await this.refresh();
      vscode.window.showInformationMessage("Capix: covenant ratified.");
    } catch (err) {
      vscode.window.showErrorMessage(`Capix ratify covenant failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async editCovenantRule(id: string | undefined): Promise<void> {
    if (!id) return;
    const covenant = this.snapshot.covenants[0];
    const rule = covenant?.rules.find((r) => r.id === id);
    if (!rule) return;
    const newRule = await vscode.window.showInputBox({
      prompt: `Edit covenant rule ${rule.id}`,
      value: rule.rule,
    });
    if (!newRule) return;
    const newRules = covenant.rules.map((r) => (r.id === id ? { ...r, rule: newRule } : r));
    try {
      await this.client.post(`${API}/covenants`, { rules: newRules });
      await this.refresh();
      vscode.window.showInformationMessage("Capix: covenant rule updated (new version ratified).");
    } catch (err) {
      vscode.window.showErrorMessage(`Capix edit covenant rule failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async applyTemplate(templateName: string): Promise<void> {
    const template = COVENANT_TEMPLATES[templateName];
    if (!template) return;
    try {
      await this.client.post(`${API}/covenants`, { rules: template });
      await this.refresh();
      vscode.window.showInformationMessage(`Capix: applied covenant template "${templateName}".`);
    } catch (err) {
      vscode.window.showErrorMessage(`Capix apply template failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async verifyReceipt(id: string | undefined): Promise<void> {
    if (!id) return;
    const r = this.snapshot.receipts.find((x) => x.id === id);
    if (!r) return;
    const settled = r.status === "confirmed" || r.status === "distributed";
    const v: string[] = [
      `receipt ${r.id.slice(0, 8)}`,
      `status=${r.status}`,
      `cost=${fmtCost(Number(r.costMinor ?? 0), r.currency ?? "usd")}`,
      `devTokens=${r.devTokens ?? 0}`,
      `merkle=${settled ? "root-anchored" : "pending"}`,
      `on-chain=${settled ? "settled" : "not-settled"}`,
    ];
    vscode.window.showInformationMessage(`Capix local verification: ${v.join(" · ")}`);
    this.post({ type: "receipt:verified", id, anchored: settled });
  }

  // ── HTML ──────────────────────────────────────────────────────────────

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
      <span class="ws-mark">$(sparkle)</span>
      <span class="ws-name">Intelligence</span>
      <span class="ws-sub">${esc(this.updatedLabel())}</span>
    </div>
    <div class="ws-actions">
      <button class="btn btn-mini" data-action="refresh" title="Refresh">$(refresh)</button>
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
          <button class="icon-btn" data-action="pinMemory" data-id="${esc(n.id)}" title="${isPinned ? "Unpin" : "Pin important"}">$(pin)</button>
          <button class="icon-btn" data-action="editMemory" data-id="${esc(n.id)}" title="Edit">$(edit)</button>
          <button class="icon-btn danger" data-action="forgetMemory" data-id="${esc(n.id)}" title="Forget">$(discard)</button>
          ${n.anchorTx
            ? `<span class="anchor-pill" title="${esc(n.anchorTx)}">on-chain</span>`
            : `<button class="icon-btn" data-action="anchorMemory" data-id="${esc(n.id)}" title="Anchor on-chain">$(link)</button>`}
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
          <button class="icon-btn" data-action="editCovenantRule" data-id="${esc(r.id)}" title="Edit rule">$(edit)</button>
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
            <span class="rcpt-merkle">${settled ? "merkle \u2713" : "pending"}</span>
            <span class="rcpt-chain">${settled ? "on-chain" : "\u2014"}</span>
            <button class="btn btn-mini" data-action="verifyReceipt" data-id="${esc(r.id)}">Verify</button>
          </div>`;
        }).join("")
      : `<div class="state subtle">No work receipts yet.</div>`;

    return `
      <section class="card">
        <div class="section-head"><h2>Work Receipts</h2><button class="btn btn-mini" data-action="refresh">$(refresh)</button></div>
        <div class="rcpt-head">
          <span>status</span><span>id</span><span>task</span><span>cost</span><span>merkle</span><span>chain</span><span></span>
        </div>
        ${rows}
      </section>`;
  }

  // ── post ──────────────────────────────────────────────────────────────

  private post(msg: unknown): void {
    void this.view?.webview.postMessage(msg);
  }
}

// ── Covenant templates ──────────────────────────────────────────────────────

const COVENANT_TEMPLATES: Record<string, CovenantRule[]> = {
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

function renderGraphSvg(graph: GraphData, opts: { width: number; height: number }): string {
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

const GRAPH_STYLES = `
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

const GRAPH_SCRIPT = `
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

const PANEL_STYLES = `
  :root {
    --capix-bg: #0a0e14;
    --capix-chrome-deep: #070b10;
    --capix-fg: #f1efe9;
    --capix-muted: #94a3b8;
    --capix-dim: #64748b;
    --capix-cyan: #3DCED6;
    --capix-green: #14F195;
    --capix-amber: #FFAE00;
    --capix-red: #ff5252;
    --capix-border: rgba(255,255,255,0.08);
    --capix-border-accent: rgba(61,206,214,0.30);
    --capix-panel: rgba(255,255,255,0.03);
    --capix-input: #0d1117;
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family, 'Plus Jakarta Sans', system-ui, sans-serif);
    color: var(--capix-fg);
    background: var(--capix-bg);
    margin: 0; padding: 12px 14px 24px;
    font-size: 12px;
    -webkit-font-smoothing: antialiased;
  }
  .ws-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .ws-title { display: flex; align-items: baseline; gap: 8px; }
  .ws-mark { color: var(--capix-cyan); font-size: 14px; }
  .ws-name { font-weight: 700; font-size: 14px; letter-spacing: 0.01em; }
  .ws-sub { font-size: 10px; color: var(--capix-muted); font-family: var(--vscode-editor-font-family, 'JetBrains Mono', monospace); }
  .ws-actions { display: flex; gap: 6px; }
  .btn { border: none; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 11px; padding: 7px 14px; font-family: inherit; }
  .btn[disabled] { opacity: 0.4; cursor: not-allowed; }
  .btn-primary { background: var(--capix-green); color: #042b18; }
  .btn-secondary { background: rgba(255,255,255,0.07); color: var(--capix-fg); }
  .btn-mini { background: transparent; color: var(--capix-muted); padding: 4px 9px; font-size: 11px; border: 1px solid var(--capix-border); }
  .btn-mini:hover { background: rgba(61,206,214,0.10); color: var(--capix-cyan); border-color: var(--capix-border-accent); }
  .btn:hover { opacity: 0.9; }
  .nav-bar { display: flex; flex-wrap: wrap; gap: 2px; border-bottom: 1px solid var(--capix-border); margin-bottom: 14px; padding-bottom: 4px; }
  .nav-tab { background: transparent; border: none; cursor: pointer; color: var(--capix-muted); font-family: inherit; font-size: 11px; padding: 6px 12px; border-radius: 6px 6px 0 0; letter-spacing: 0.04em; border-bottom: 2px solid transparent; }
  .nav-tab:hover { color: var(--capix-cyan); }
  .nav-tab.active { color: var(--capix-cyan); border-bottom-color: var(--capix-cyan); }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }
  .card { background: var(--capix-panel); border: 1px solid var(--capix-border); border-radius: 10px; padding: 14px; margin-bottom: 12px; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 720px) { .grid-2 { grid-template-columns: 1fr; } }
  .stat-row { display: grid; grid-template-columns: repeat(7, 1fr); gap: 8px; }
  @media (max-width: 720px) { .stat-row { grid-template-columns: repeat(4, 1fr); } }
  @media (max-width: 480px) { .stat-row { grid-template-columns: repeat(3, 1fr); } }
  .stat { text-align: center; }
  .stat-value { font-size: 16px; font-weight: 700; color: var(--capix-cyan); font-family: var(--vscode-editor-font-family, 'JetBrains Mono', monospace); }
  .stat-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.10em; color: var(--capix-muted); margin-top: 2px; }
  .section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; gap: 8px; }
  .section-head h2 { font-size: 10px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--capix-muted); margin: 0; font-weight: 600; }
  .muted { color: var(--capix-muted); font-size: 10px; }
  .toolbar { display: flex; gap: 6px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  .toolbar input[type="text"], .toolbar select { flex: 1; min-width: 120px; background: var(--capix-input); color: var(--capix-fg); border: 1px solid var(--capix-border); padding: 6px 9px; font-size: 12px; border-radius: 6px; font-family: inherit; }
  .toolbar input:focus, .toolbar select:focus { outline: none; border-color: var(--capix-border-accent); }
  .state { padding: 18px 8px; text-align: center; color: var(--capix-muted); }
  .state.connect p { margin: 0 0 4px; }
  .state.connect .muted { margin-bottom: 12px; display: block; }
  .state.subtle { padding: 12px; text-align: center; opacity: 0.55; }
  .state.loading { color: var(--capix-cyan); }
  .state.error { color: var(--capix-red); }
  .ov-row { display: grid; grid-template-columns: auto auto 1fr auto auto; gap: 8px; align-items: center; padding: 7px 0; border-bottom: 1px solid rgba(255,255,255,0.045); cursor: pointer; }
  .ov-row:hover { background: rgba(61,206,214,0.04); }
  .ov-content { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ov-recency { font-size: 10px; color: var(--capix-dim); font-family: var(--vscode-editor-font-family, 'JetBrains Mono', monospace); }
  .ov-progress-bar { width: 60px; height: 4px; background: rgba(255,255,255,0.06); border-radius: 2px; overflow: hidden; }
  .ov-progress-fill { height: 100%; background: var(--capix-green); border-radius: 2px; }
  .ov-type { font-size: 8px; text-transform: uppercase; padding: 2px 7px; border-radius: 999px; letter-spacing: 0.06em; background: rgba(255,255,255,0.05); color: var(--capix-muted); }
  .type-decision { background: rgba(61,206,214,0.12); color: var(--capix-cyan); }
  .type-fact, .type-pattern { background: rgba(20,241,149,0.12); color: var(--capix-green); }
  .type-feedback, .type-constraint, .type-plan { background: rgba(255,174,0,0.12); color: var(--capix-amber); }
  .type-context, .type-observation { background: rgba(91,141,239,0.12); color: #5B8DEF; }
  .type-relationship, .type-anchor { background: rgba(244,114,182,0.12); color: #f472b6; }
  .type-instruction { background: rgba(167,139,250,0.12); color: #a78bfa; }
  .ov-badge { font-size: 8px; text-transform: uppercase; padding: 2px 7px; border-radius: 999px; letter-spacing: 0.04em; }
  .badge-running, .badge-pending, .badge-active, .badge-in_progress, .badge-installed, .badge-enabled, .badge-submitted, .badge-draft { background: rgba(61,206,214,0.12); color: var(--capix-cyan); }
  .badge-done, .badge-completed, .badge-confirmed, .badge-distributed, .badge-approved, .badge-ratified { background: rgba(20,241,149,0.12); color: var(--capix-green); }
  .badge-deprecated, .badge-superseded { background: rgba(255,174,0,0.12); color: var(--capix-amber); }
  .badge-failed, .badge-cancelled, .badge-error { background: rgba(255,82,82,0.12); color: var(--capix-red); }
  .badge-disabled, .badge-pinned { background: rgba(255,255,255,0.06); color: var(--capix-muted); }
  .badge-warning, .badge-info { background: rgba(255,174,0,0.12); color: var(--capix-amber); }
  .ov-covenant { display: flex; align-items: center; gap: 8px; padding: 6px 0; flex-wrap: wrap; }
  .legend-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
  .memory-list { display: flex; flex-direction: column; gap: 8px; }
  .mem-card { background: var(--capix-panel); border: 1px solid var(--capix-border); border-radius: 8px; padding: 10px 12px; }
  .mem-card.pinned { border-color: rgba(255,174,0,0.30); background: rgba(255,174,0,0.03); }
  .mem-head { display: grid; grid-template-columns: auto 1fr auto auto; gap: 8px; align-items: center; margin-bottom: 6px; }
  .conf-bar { background: rgba(255,255,255,0.06); height: 4px; border-radius: 2px; overflow: hidden; }
  .conf-fill { height: 100%; background: var(--capix-cyan); }
  .conf-val { font-size: 9px; color: var(--capix-muted); font-family: var(--vscode-editor-font-family, 'JetBrains Mono', monospace); }
  .mem-content { color: var(--capix-fg); font-size: 12px; line-height: 1.5; cursor: pointer; }
  .mem-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
  .mem-meta { display: flex; gap: 12px; font-size: 10px; color: var(--capix-dim); }
  .mem-actions { display: flex; align-items: center; gap: 4px; }
  .anchor-pill { font-size: 8px; text-transform: uppercase; padding: 2px 6px; border-radius: 999px; background: rgba(20,241,149,0.12); color: var(--capix-green); }
  .skill-card { background: var(--capix-panel); border: 1px solid var(--capix-border); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; opacity: 0.7; }
  .skill-card.enabled { opacity: 1; border-color: rgba(61,206,214,0.18); }
  .skill-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .skill-name { font-weight: 600; }
  .skill-ver { font-size: 10px; color: var(--capix-dim); font-family: var(--vscode-editor-font-family, 'JetBrains Mono', monospace); }
  .skill-desc { font-size: 11px; color: var(--capix-muted); margin: 4px 0 6px; }
  .skill-meta { display: flex; gap: 10px; font-size: 10px; color: var(--capix-dim); flex-wrap: wrap; }
  .skill-actions { display: flex; gap: 4px; }
  .fp-pill { font-size: 8px; text-transform: uppercase; padding: 1px 6px; border-radius: 999px; background: rgba(167,139,250,0.12); color: #a78bfa; }
  .agent-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.045); flex-wrap: wrap; }
  .agent-name { font-weight: 500; }
  .agent-role { font-size: 10px; color: var(--capix-dim); }
  .agent-trust { font-size: 9px; text-transform: uppercase; color: var(--capix-amber); padding: 1px 5px; border-radius: 4px; background: rgba(255,174,0,0.10); }
  .gen-pill { font-size: 9px; color: var(--capix-muted); font-family: var(--vscode-editor-font-family, 'JetBrains Mono', monospace); }
  .agent-actions { margin-left: auto; }
  .cov-rule { cursor: pointer; }
  .cov-prec { font-size: 10px; color: var(--capix-cyan); font-family: var(--vscode-editor-font-family, 'JetBrains Mono', monospace); text-align: center; }
  .cov-precedence { display: flex; flex-direction: column; gap: 4px; }
  .prec-step { display: grid; grid-template-columns: auto 1fr auto; gap: 8px; align-items: center; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
  .prec-num { font-size: 10px; color: var(--capix-cyan); font-family: var(--vscode-editor-font-family, 'JetBrains Mono', monospace); width: 20px; }
  .prec-rule { font-size: 11px; }
  .prec-sev { font-size: 8px; }
  .template-grid { display: flex; flex-direction: column; gap: 8px; }
  .rcpt-head, .rcpt-row { display: grid; grid-template-columns: 1.2fr 1fr 3fr 0.9fr 0.9fr 0.9fr 0.7fr; gap: 8px; align-items: center; padding: 7px 0; border-bottom: 1px solid rgba(255,255,255,0.045); }
  .rcpt-head { font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--capix-dim); border-bottom: 1px solid var(--capix-border); }
  .rcpt-id { font-family: var(--vscode-editor-font-family, 'JetBrains Mono', monospace); font-size: 10px; color: var(--capix-cyan); }
  .rcpt-task { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rcpt-cost { color: var(--capix-green); font-family: var(--vscode-editor-font-family, 'JetBrains Mono', monospace); font-size: 11px; }
  .rcpt-merkle { font-size: 10px; color: var(--capix-muted); }
  .rcpt-chain { font-size: 10px; color: var(--capix-green); }
  .rcpt-row.verified { background: rgba(20,241,149,0.04); }
  .icon-btn { background: transparent; border: none; cursor: pointer; color: var(--capix-muted); font-family: inherit; font-size: 12px; padding: 2px 4px; border-radius: 4px; }
  .icon-btn:hover { background: rgba(255,255,255,0.08); color: var(--capix-fg); }
  .icon-btn.danger:hover { color: var(--capix-red); }
`;

// ── Panel client script ─────────────────────────────────────────────────────

const PANEL_SCRIPT = `
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

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
}

function recency(iso: string): string {
  if (!iso) return "\u2014";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "\u2014";
  const secs = Math.max(0, (Date.now() - then) / 1000);
  if (secs < 60) return `${Math.floor(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  if (secs < 2_592_000) return `${Math.floor(secs / 86400)}d`;
  return new Date(iso).toLocaleDateString();
}

function fmtCost(minor: number, currency: string): string {
  const major = (minor / 1_000_000).toFixed(minor % 1_000_000 === 0 ? 0 : 2);
  return `${major} ${(currency || "usd").toUpperCase()}`;
}

function memoryConfidence(n: MemoryNode): number {
  const meta = n.metadata as Record<string, unknown> | undefined;
  const c = meta?.confidence;
  if (typeof c === "number" && c >= 0 && c <= 1) return c;
  if (typeof c === "string") {
    const parsed = Number(c);
    if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 1) return parsed;
  }
  return n.anchorTx ? 0.95 : 0.8;
}

function memoryProvenance(n: MemoryNode): string {
  const meta = n.metadata as Record<string, unknown> | undefined;
  const authoredBy = meta?.authoredBy ? String(meta.authoredBy) : n.source ?? "agent";
  if (n.anchorTx) {
    return `chain: ${authoredBy} \u2192 anchor(${n.anchorTx.slice(0, 10)}\u2026)`;
  }
  return `local: ${authoredBy}`;
}

function mergeGraph(base: GraphData, patch: GraphData): GraphData {
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
