/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-intelligence/intelligenceWorkspace - the "Intelligence" destination
 *  for CapixIDE. One unified webview that replaces the permanent sidebar
 *  accordions (memory, graph, covenants, agents, plans, checkpoints,
 *  receipts) with a spacious seven-tab workspace:
 *
 *     Overview | Memory | Graph | Skills | Agents | Plans | Receipts
 *
 *  Data is fetched from the {@link IntelligenceClient} in parallel on refresh
 *  and rendered as a server-side snapshot; interactions are posted back to the
 *  host and resolved against the existing intelligence API calls. The Graph tab
 *  embeds the dependency-free {@link renderGraphSvg} renderer + controller.
 *
 *  Visual foundation is @capix/ui-tokens dark: canvas `#0a0e14`, brand cyan
 *  `#3DCED6`, success green `#14F195`, amber `#FFAE00`, error `#ff5252`. No
 *  external scripts — stays inside the strict CSP (script-src 'nonce-<nonce>').
 *-------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import type { IntelligenceClient } from "./intelligenceClient.js";
import { IntelligenceApiError, IntelligenceAuthError } from "./intelligenceClient.js";
import type {
	MemoryNode,
	MemoryType,
	GraphData,
	CovenantVersion,
	AgentRecord,
	PlanRecord,
	PlanStatus,
	WorkReceipt,
	CheckpointRecord,
} from "./types.js";
import { SkillsRuntime, type SkillRecord, type SkillInvocationReceipt } from "./skillsRuntime.js";
import {
	renderGraphSvg,
	graphControllerScript,
	graphStyles,
} from "./graphRenderer.js";
import { icon } from "./webviewIcons.js";

// ── Navigation ──────────────────────────────────────────────────────────────

export type IntelligenceTab =
	| "overview"
	| "memory"
	| "graph"
	| "skills"
	| "agents"
	| "plans"
	| "receipts";

const NAV_TABS: Array<{ id: IntelligenceTab; label: string }> = [
	{ id: "overview", label: "Overview" },
	{ id: "memory", label: "Memory" },
	{ id: "graph", label: "Graph" },
	{ id: "skills", label: "Skills" },
	{ id: "agents", label: "Agents" },
	{ id: "plans", label: "Plans" },
	{ id: "receipts", label: "Receipts" },
];

// ── Snapshot ────────────────────────────────────────────────────────────────

interface WorkspaceSnapshot {
	configured: boolean;
	loading: boolean;
	error: string | null;
	memory: MemoryNode[];
	graph: GraphData;
	covenants: CovenantVersion[];
	agents: AgentRecord[];
	plans: PlanRecord[];
	skills: SkillRecord[];
	skillReceipts: SkillInvocationReceipt[];
	receipts: WorkReceipt[];
	checkpoints: CheckpointRecord[];
	activeTab: IntelligenceTab;
	updatedAt: string;
}

function emptySnapshot(tab: IntelligenceTab = "overview"): WorkspaceSnapshot {
	return {
		configured: false,
		loading: false,
		error: null,
		memory: [],
		graph: { nodes: [], edges: [] },
		covenants: [],
		agents: [],
		plans: [],
		skills: [],
		skillReceipts: [],
		receipts: [],
		checkpoints: [],
		activeTab: tab,
		updatedAt: new Date().toISOString(),
	};
}

// ── Provider ────────────────────────────────────────────────────────────────

export class IntelligenceWorkspaceProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private snapshot: WorkspaceSnapshot = emptySnapshot();
	private loading = false;

	constructor(
		private readonly client: IntelligenceClient,
		private readonly skills: SkillsRuntime,
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

			// Soft-fail each endpoint individually (returning typed empties) so a
			// single 503 / not-implemented route never blanks the whole workspace.
			// Auth errors are re-thrown so the outer catch can flip to the sign-in
			// state.
			const soft = <T>(empty: T): ((err: unknown) => T) => (err: unknown) => {
				if (err instanceof IntelligenceAuthError) throw err;
				return empty;
			};
			const emptyGraph: GraphData = { nodes: [], edges: [] };

			const [memory, graph, covenants, agents, plans, receipts, checkpoints, skills, skillReceipts] =
				await Promise.all([
					this.client.listMemory().then((r) => r.memory).catch(soft<MemoryNode[]>([])),
					this.client.queryGraph({}).catch(soft<GraphData>(emptyGraph)),
					this.client.listCovenants().then((r) => r.versions).catch(soft<CovenantVersion[]>([])),
					this.client.listAgents().then((r) => r.agents).catch(soft<AgentRecord[]>([])),
					this.client.listPlans().then((r) => r.plans).catch(soft<PlanRecord[]>([])),
					this.client.listReceipts().then((r) => r.receipts).catch(soft<WorkReceipt[]>([])),
					this.client.listCheckpoints().then((r) => r.checkpoints).catch(soft<CheckpointRecord[]>([])),
					this.skills.listInstalled(),
					Promise.resolve(this.skills.listReceipts(10)),
				]);

			this.snapshot = {
				configured: true,
				loading: false,
				error: null,
				memory,
				graph,
				covenants,
				agents,
				plans,
				skills,
				skillReceipts,
				receipts,
				checkpoints,
				activeTab: this.snapshot.activeTab,
				updatedAt: new Date().toISOString(),
			};
		} catch (err) {
			this.snapshot.error = errorMessage(err);
			if (err instanceof IntelligenceAuthError) {
				this.snapshot.configured = false;
			}
		} finally {
			this.loading = false;
			this.snapshot.loading = false;
			if (this.view) this.view.webview.html = this.getHtml();
		}
	}

	// ── message handling ──────────────────────────────────────────────────

	private handleMessage(msg: unknown): void {
		const m = msg as { type?: string; tab?: string; id?: string; [k: string]: unknown };
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
			case "installSkill":
				void this.installSkill();
				break;
			case "enableSkill":
				void this.toggleSkill(m.id, "enable");
				break;
			case "disableSkill":
				void this.toggleSkill(m.id, "disable");
				break;
			case "pinSkill":
				void this.pinSkill(m.id);
				break;
			case "invokeSkill":
				void this.invokeSkill(m.id);
				break;
			case "createPlan":
				void vscode.commands.executeCommand("capix.intelligence.createPlan");
				break;
			case "spawnAgent":
				void vscode.commands.executeCommand("capix.intelligence.spawnAgent");
				break;
			case "completeAgent":
				void this.completeAgent(m.id);
				break;
			case "writeMemory":
				void vscode.commands.executeCommand("capix.intelligence.writeMemory");
				break;
			case "editMemory":
				void this.editMemory(m.id);
				break;
			case "deleteMemory":
				void this.deleteMemory(m.id);
				break;
			case "anchorMemory":
				void this.anchorMemory(m.id);
				break;
			case "openMemoryGraph":
				void vscode.commands.executeCommand("capix.intelligence.openGraph");
				break;
			case "verifyReceipt":
				void this.verifyReceipt(m.id);
				break;
			case "graph:selectNode":
				this.handleGraphNodeSelect(String(m.nodeId ?? ""), String(m.nodeType ?? ""));
				break;
			case "graph:expand":
				void this.handleGraphExpand(String(m.nodeId ?? ""));
				break;
			case "graph:copyNode":
				void vscode.env.clipboard.writeText(String(m.nodeId ?? ""));
				vscode.window.showInformationMessage("Capix: node id copied to clipboard.");
				break;
			case "graph:render":
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

	private handleGraphNodeSelect(nodeId: string, nodeType: string): void {
		this.post({ type: "graph:status", message: `Selected ${nodeType} ${nodeId.slice(0, 8)}` });
	}

	private async handleGraphExpand(nodeId: string): Promise<void> {
		try {
			const patch = await this.client.queryGraph({ query: nodeId, limit: 100 });
			const merged = mergeGraph(this.snapshot.graph, patch);
			this.snapshot.graph = merged;
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
			const res = await this.client.retrieveMemory({ query, topK: 25 });
			this.snapshot.memory = res.results.map((r) => r.node);
			this.post({ type: "searchResults", count: res.results.length });
			if (this.view) this.view.webview.html = this.getHtml();
		} catch (err) {
			vscode.window.showErrorMessage(`Capix memory search failed: ${errorMessage(err)}`);
		} finally {
			this.post({ type: "loading", value: false });
		}
	}

	private async installSkill(): Promise<void> {
		const source = await vscode.window.showInputBox({
			prompt: "Install skill from URL, registry:name@version, first-party:name, or JSON manifest",
			placeHolder: "https://capix.network/skills/my-skill.json",
		});
		if (!source) return;
		try {
			const rec = await this.skills.install(source, { enable: false });
			await this.refresh();
			vscode.window.showInformationMessage(
				`Capix: skill installed — ${rec.name}@${rec.version} (${rec.provenance.verified ? "verified" : "unverified"})`,
			);
		} catch (err) {
			vscode.window.showErrorMessage(`Capix install skill failed: ${errorMessage(err)}`);
		}
	}

	private async toggleSkill(
		id: string | undefined,
		action: "enable" | "disable",
	): Promise<void> {
		if (!id) return;
		try {
			await (action === "enable" ? this.skills.enable(id) : this.skills.disable(id));
			await this.refresh();
		} catch (err) {
			vscode.window.showErrorMessage(`Capix ${action} skill failed: ${errorMessage(err)}`);
		}
	}

	private async pinSkill(id: string | undefined): Promise<void> {
		if (!id) return;
		const rec = (await this.skills.listInstalled()).find((s) => s.id === id);
		if (!rec) return;
		try {
			await this.skills.pin(id, rec.version);
			await this.refresh();
			vscode.window.showInformationMessage(`Capix: pinned ${rec.name}@${rec.version}`);
		} catch (err) {
			vscode.window.showErrorMessage(`Capix pin skill failed: ${errorMessage(err)}`);
		}
	}

	private async invokeSkill(id: string | undefined): Promise<void> {
		if (!id) return;
		const rec = (await this.skills.listInstalled()).find((s) => s.id === id);
		if (!rec) return;
		const task = await vscode.window.showInputBox({
			prompt: `Invoke ${rec.name}`,
			placeHolder: "Describe the task for the skill…",
		});
		if (task === undefined) return;
		try {
			const result = await this.skills.invoke(id, { task });
			if (result.ok) {
				vscode.window.showInformationMessage(
					`Capix: ${rec.name} completed in ${result.receipt.durationMs}ms (${fmtCost(result.receipt.costMinor, result.receipt.currency)}).`,
				);
			} else {
				vscode.window.showWarningMessage(`Capix: ${rec.name} failed — ${result.error}`);
			}
			await this.refresh();
		} catch (err) {
			vscode.window.showErrorMessage(`Capix invoke skill failed: ${errorMessage(err)}`);
		}
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
			await this.client.writeMemory({
				type: node.type,
				content,
				source: node.source ? `${node.source} (edit)` : "user-edit",
				metadata: { ...(node.metadata ?? {}), supersedes: node.id },
			});
			await this.refresh();
			vscode.window.showInformationMessage("Capix: memory updated (superseding node written).");
		} catch (err) {
			vscode.window.showErrorMessage(`Capix edit memory failed: ${errorMessage(err)}`);
		}
	}

	private async deleteMemory(id: string | undefined): Promise<void> {
		if (!id) return;
		const node = this.snapshot.memory.find((n) => n.id === id);
		if (!node) return;
		const anchored = Boolean(node.anchorTx);
		const choice = await vscode.window.showWarningMessage(
			anchored
				? `Memory ${node.id.slice(0, 8)} is anchored on-chain and immutable. Supersede it with corrected content instead?`
				: `Memory ${node.id.slice(0, 8)} will be superseded (memory is append-only). Continue?`,
			{ modal: true },
			"Supersede",
		);
		if (choice !== "Supersede") return;
		await this.editMemory(id);
	}

	private async anchorMemory(id: string | undefined): Promise<void> {
		if (!id) return;
		try {
			const res = await this.client.anchorMemory({ memoryId: id });
			vscode.window.showInformationMessage(
				`Capix: memory anchored (tx ${res.txSignature.slice(0, 12)}… slot ${res.slot}).`,
			);
			await this.refresh();
		} catch (err) {
			vscode.window.showErrorMessage(`Capix anchor memory failed: ${errorMessage(err)}`);
		}
	}

	private async completeAgent(id: string | undefined): Promise<void> {
		if (!id) return;
		try {
			await vscode.commands.executeCommand("capix.intelligence.completeAgent");
		} catch (err) {
			vscode.window.showErrorMessage(`Capix complete agent failed: ${errorMessage(err)}`);
		}
	}

	private async verifyReceipt(id: string | undefined): Promise<void> {
		if (!id) return;
		const r = this.snapshot.receipts.find((x) => x.id === id);
		if (!r) return;
		const anchored = r.status === "confirmed" || r.status === "distributed";
		const devTokens = r.devTokens ?? 0;
		const v: string[] = [
			`receipt ${r.id.slice(0, 8)}`,
			`status=${r.status}`,
			`cost=${fmtCost(Number(r.costMinor ?? 0), r.currency ?? "usd")}`,
			`devTokens=${devTokens}`,
			`merkle=${anchored ? "root-anchored" : "pending"}`,
			`on-chain=${anchored ? "settled" : "not-settled"}`,
		];
		vscode.window.showInformationMessage(`Capix local verification: ${v.join(" · ")}`);
		this.post({ type: "receipt:verified", id, anchored });
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
<style>${WORKSPACE_STYLES}\n${graphStyles()}</style>
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
  <script nonce="${nonce}">${graphControllerScript()}\n${WORKSPACE_SCRIPT}</script>
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
		if (this.snapshot.loading && this.snapshot.configured === false && !this.snapshot.error) {
			return `<div class="state loading">Loading intelligence…</div>`;
		}
		if (!this.snapshot.configured) {
			return `<div class="state connect">
        <p>The Capix Intelligence workspace surfaces memory, knowledge graph, covenants, agents, plans, and work receipts.</p>
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
      <section class="tab-panel${this.snapshot.activeTab === "plans" ? " active" : ""}" data-panel="plans">${this.plansHtml()}</section>
      <section class="tab-panel${this.snapshot.activeTab === "receipts" ? " active" : ""}" data-panel="receipts">${this.receiptsHtml()}</section>`;
	}

	private overviewHtml(): string {
		const recentMemory = this.snapshot.memory.slice(0, 10);
		const activePlans = this.snapshot.plans.filter((p) => p.status === "in_progress" || p.status === "approved");
		const recentDecisions = this.snapshot.memory.filter((n) => n.type === "decision").slice(0, 5);
		const covenant = this.snapshot.covenants[0];
		const skillCalls = this.snapshot.skillReceipts.slice(0, 8);

		const memoryRows = recentMemory.length
			? recentMemory.map((n) => `
        <div class="ov-row" data-action="openMemory" data-id="${esc(n.id)}">
          <span class="ov-type type-${esc(n.type)}">${esc(n.type)}</span>
          <span class="ov-content">${esc(truncate(n.content, 72))}</span>
          <span class="ov-recency">${esc(recency(n.createdAt))}</span>
        </div>`).join("")
			: `<div class="state subtle">No memory written yet.</div>`;

		const planRows = activePlans.length
			? activePlans.map((p) => `
        <div class="ov-row" data-action="openPlan" data-id="${esc(p.id)}">
          <span class="ov-badge badge-${esc(p.status)}">${esc(p.status)}</span>
          <span class="ov-content">${esc(p.title)}</span>
          <span class="ov-recency">${p.steps.filter((s) => s.status === "done").length}/${p.steps.length}</span>
        </div>`).join("")
			: `<div class="state subtle">No active plans.</div>`;

		const decisionRows = recentDecisions.length
			? recentDecisions.map((n) => `
        <div class="ov-row">
          <span class="ov-type type-decision">decision</span>
          <span class="ov-content">${esc(truncate(n.content, 64))}</span>
        </div>`).join("")
			: `<div class="state subtle">No recent decisions.</div>`;

		const skillRows = skillCalls.length
			? skillCalls.map((r) => `
        <div class="ov-row">
          <span class="ov-badge ${r.success ? "badge-done" : "badge-failed"}">${r.success ? "ok" : "fail"}</span>
          <span class="ov-content">${esc(r.skillName)}</span>
          <span class="ov-recency">${esc(recency(r.timestamp))}</span>
          <span class="ov-rate">${fmtCost(r.costMinor, r.currency)}</span>
        </div>`).join("")
			: `<div class="state subtle">No skill invocations yet.</div>`;

		const covenantCard = covenant
			? `<div class="ov-covenant">
            <span class="legend-dot" style="background:var(--capix-cyan)"></span>
            <span>Covenant v${esc(covenant.version)} · ${covenant.rules.length} rules · ${esc(covenant.status)}</span>
          </div>`
			: `<div class="state subtle">No covenant ratified.</div>`;

		const counts = {
			memory: this.snapshot.memory.length,
			agents: this.snapshot.agents.filter((a) => a.status === "running" || a.status === "pending").length,
			skills: this.snapshot.skills.filter((s) => s.enabled).length,
			plans: activePlans.length,
			receipts: this.snapshot.receipts.length,
			graphNodes: this.snapshot.graph.nodes.length,
		};

		return `
      <section class="card stat-row">
        <div class="stat"><div class="stat-value">${counts.memory}</div><div class="stat-label">Memory</div></div>
        <div class="stat"><div class="stat-value">${counts.agents}</div><div class="stat-label">Active Agents</div></div>
        <div class="stat"><div class="stat-value">${counts.skills}</div><div class="stat-label">Skills On</div></div>
        <div class="stat"><div class="stat-value">${counts.plans}</div><div class="stat-label">Active Plans</div></div>
        <div class="stat"><div class="stat-value">${counts.receipts}</div><div class="stat-label">Receipts</div></div>
        <div class="stat"><div class="stat-value">${counts.graphNodes}</div><div class="stat-label">Graph Nodes</div></div>
      </section>
      <section class="card">
        <div class="section-head"><h2>Recent Memory</h2><button class="btn btn-mini" data-action="openMemoryGraph">Graph →</button></div>
        ${memoryRows}
      </section>
      <div class="grid-2">
        <section class="card">
          <div class="section-head"><h2>Active Plans</h2><button class="btn btn-mini" data-action="createPlan">+ New</button></div>
          ${planRows}
        </section>
        <section class="card">
          <div class="section-head"><h2>Recent Decisions</h2></div>
          ${decisionRows}
        </section>
      </div>
      <div class="grid-2">
        <section class="card">
          <div class="section-head"><h2>Covenant</h2></div>
          ${covenantCard}
        </section>
        <section class="card">
          <div class="section-head"><h2>Skill Invocations</h2></div>
          ${skillRows}
        </section>
      </div>`;
	}

	private memoryHtml(): string {
		const rows = this.snapshot.memory.length
			? this.snapshot.memory.map((n) => this.memoryRowHtml(n)).join("")
			: `<div class="state subtle">No memory nodes. Use Write Memory to add one.</div>`;

		const types: MemoryType[] = ["decision", "pattern", "feedback", "context", "relationship", "anchor"];
		const typeFilter = types
			.map((t) => `<option value="${t}">${t}</option>`)
			.join("");

		return `
      <div class="toolbar">
        <input type="text" id="memory-search" placeholder="Search memory (hybrid retrieval)…" value="" />
        <select id="memory-type-filter"><option value="">All types</option>${typeFilter}</select>
        <button class="btn btn-primary" data-action="searchMemory">Search</button>
        <button class="btn btn-secondary" data-action="writeMemory">+ Write</button>
      </div>
      <div class="memory-list" id="memory-list">${rows}</div>`;
	}

	private memoryRowHtml(n: MemoryNode): string {
		const confidence = memoryConfidence(n);
		const provChain = memoryProvenance(n);
		const related = relatedLinks(n);
		return `<div class="mem-card" data-mem-id="${esc(n.id)}">
        <div class="mem-head">
          <span class="ov-type type-${esc(n.type)}">${esc(n.type)}</span>
          <div class="conf-bar"><div class="conf-fill" style="width:${Math.round(confidence * 100}%"></div></div>
          <span class="conf-val">${Math.round(confidence * 100)}%</span>
          <span class="ov-recency">${esc(recency(n.createdAt))}</span>
        </div>
        <div class="mem-content" data-truncated="true">${esc(truncate(n.content, 180))}</div>
        <div class="mem-foot">
          <div class="mem-meta">
            <span title="source">src: ${esc(n.source ?? "agent")}</span>
            <span title="provenance chain">${provChain}</span>
          </div>
          <div class="mem-related">${related}</div>
          <div class="mem-actions">
            <button class="icon-btn" data-action="expandMemory" data-id="${esc(n.id)}" title="Expand">${icon("chevron-down")}</button>
            <button class="icon-btn" data-action="editMemory" data-id="${esc(n.id)}" title="Edit">${icon("edit")}</button>
            <button class="icon-btn danger" data-action="deleteMemory" data-id="${esc(n.id)}" title="Supersede">${icon("discard")}</button>
            ${n.anchorTx ? `<span class="anchor-pill" title="${esc(n.anchorTx)}">on-chain</span>` : `<button class="icon-btn" data-action="anchorMemory" data-id="${esc(n.id)}" title="Anchor on-chain">${icon("link")}</button>`}
          </div>
        </div>
      </div>`;
	}

	private graphHtml(): string {
		const svg = renderGraphSvg(this.snapshot.graph, { width: 800, height: 560 });
		const toolbar = `<div class="toolbar">
        <input type="text" id="graph-search" placeholder="Filter graph by label or type…" />
        <button class="btn btn-secondary" data-action="openMemoryGraph">Open full graph</button>
      </div>`;
		return `${toolbar}${svg}`;
	}

	private skillsHtml(): string {
		const installed = this.snapshot.skills;
		const firstParty = installed.filter((s) => s.firstParty);
		const thirdParty = installed.filter((s) => !s.firstParty);

		const render = (s: SkillRecord): string => {
			const color = s.provenance.verified ? "var(--capix-green)" : "var(--capix-amber)";
			const statusBadge = s.status;
			return `<div class="skill-card${s.enabled ? " enabled" : ""}" data-skill-id="${esc(s.id)}">
            <div class="skill-head">
              <span class="legend-dot" style="background:${color}" title="${s.provenance.verified ? "verified" : "unverified"}"></span>
              <span class="skill-name">${esc(s.name)}</span>
              <span class="skill-ver">v${esc(s.version)}</span>
              <span class="ov-badge badge-${esc(s.status)}">${esc(statusBadge)}</span>
              ${s.firstParty ? `<span class="fp-pill">${esc(s.family ?? "first-party")}</span>` : ""}
            </div>
            <div class="skill-desc">${esc(s.description)}</div>
            <div class="skill-meta">
              <span>risk: ${esc(s.riskClass)}</span>
              <span>perms: ${s.permissions.length}</span>
              <span>tools: ${s.requiredTools.length}</span>
              <span>hosts: ${s.networkPolicy.allowedHosts.length}</span>
              <span>${s.enabled ? "on" : "off"}</span>
              ${s.lastUsed ? `<span>used ${esc(recency(s.lastUsed))}</span>` : ""}
            </div>
            <div class="skill-hash" title="integrity hash">${esc(s.integrityHash.slice(0, 16))}…</div>
            <div class="skill-actions">
              <button class="btn btn-mini" data-action="invokeSkill" data-id="${esc(s.id)}" ${s.enabled ? "" : "disabled"}>Invoke</button>
              ${s.enabled
												? `<button class="btn btn-mini" data-action="disableSkill" data-id="${esc(s.id)}">Disable</button>`
												: `<button class="btn btn-mini" data-action="enableSkill" data-id="${esc(s.id)}">Enable</button>`}
              <button class="btn btn-mini" data-action="pinSkill" data-id="${esc(s.id)}">Pin</button>
            </div>
          </div>`;
		};

		const firstPartySection = firstParty.length
			? `<div class="section-head"><h2>First-Party Skills</h2><span class="muted">${firstParty.length} installed</span></div>${firstParty.map(render).join("")}`
			: `<div class="state subtle">No first-party skills.</div>`;

		const thirdPartySection = thirdParty.length
			? `<div class="section-head"><h2>Installed</h2><span class="muted">${thirdParty.length}</span></div>${thirdParty.map(render).join("")}`
			: `<div class="state subtle">No third-party skills installed.</div>`;

		return `
      <div class="toolbar">
        <button class="btn btn-primary" data-action="installSkill">+ Install Skill</button>
        <span class="muted">From URL · registry:name@version · first-party:name · JSON manifest</span>
      </div>
      <div class="grid-2">
        <section class="card">${firstPartySection}</section>
        <section class="card">${thirdPartySection}</section>
      </div>`;
	}

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

	private plansHtml(): string {
		const active = this.snapshot.plans.filter((p) => p.status === "in_progress" || p.status === "approved" || p.status === "draft");
		const historical = this.snapshot.plans.filter((p) => p.status === "completed" || p.status === "cancelled");

		const steps = (p: PlanRecord): string => p.steps.length
			? `<ol class="plan-steps">${p.steps.map((s) => `<li class="step step-${esc(s.status)}">
              <span class="step-check">${s.status === "done" ? "✓" : s.status === "in_progress" ? "…" : "◦"}</span>
              <span class="step-desc">${esc(s.description)}</span>
            </li>`).join("")}</ol>`
			: `<div class="state subtle">No steps.</div>`;

		const planCard = (p: PlanRecord): string => {
			const cp = this.snapshot.checkpoints.find((c) => c.agentId === p.id);
			const receipt = this.snapshot.receipts.find((r) => r.agentId === p.id);
			const done = p.steps.filter((s) => s.status === "done").length;
			return `<div class="plan-card">
            <div class="plan-head">
              <span class="ov-badge badge-${esc(p.status)}">${esc(p.status)}</span>
              <span class="plan-title">${esc(p.title)}</span>
              <span class="ov-progress">${done}/${p.steps.length}</span>
            </div>
            <div class="plan-desc">${esc(truncate(p.description, 140))}</div>
            ${steps(p)}
            <div class="plan-foot">
              <span>${esc(planStatusLabel(p.status))}</span>
              ${p.projectId ? `<span class="muted">proj ${esc(p.projectId.slice(0, 8))}</span>` : ""}
              ${cp ? `<span class="muted">checkpoint ${esc(cp.id.slice(0, 8))}</span>` : ""}
              ${receipt ? `<button class="link-pill" data-action="viewReceipt" data-id="${esc(receipt.id)}">receipt ${esc(receipt.id.slice(0, 8))}</button>` : ""}
            </div>
          </div>`;
		};

		return `
      <div class="toolbar">
        <button class="btn btn-primary" data-action="createPlan">+ Create Plan</button>
        <span class="muted">${active.length} active · ${historical.length} historical</span>
      </div>
      <section class="card">
        <div class="section-head"><h2>Active Plans</h2></div>
        ${active.length ? active.map(planCard).join("") : `<div class="state subtle">No active plans.</div>`}
      </section>
      ${historical.length ? `<section class="card"><div class="section-head"><h2>History</h2></div>${historical.slice(0, 10).map(planCard).join("")}</section>` : ""}`;
	}

	private receiptsHtml(): string {
		const rows = this.snapshot.receipts.length
			? this.snapshot.receipts.map((r) => {
					const settled = r.status === "confirmed" || r.status === "distributed";
					return `<div class="rcpt-row">
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

	private post(msg: unknown): void {
		void this.view?.webview.postMessage(msg);
	}
}

// ── Styles + script ─────────────────────────────────────────────────────────
// @capix/ui-tokens dark foundation: #0a0e14 canvas, #3DCED6 cyan, #14F195 green.

const WORKSPACE_STYLES = `
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
  .ws-header {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 10px;
  }
  .ws-title { display: flex; align-items: baseline; gap: 8px; }
  .ws-mark { color: var(--capix-cyan); font-size: 14px; }
  .ws-name { font-weight: 700; font-size: 14px; letter-spacing: 0.01em; }
  .ws-sub { font-size: 10px; color: var(--capix-muted); font-family: var(--vscode-editor-font-family, 'JetBrains Mono', monospace); }
  .ws-actions { display: flex; gap: 6px; }
  .btn {
    border: none; border-radius: 6px; cursor: pointer;
    font-weight: 600; font-size: 11px; padding: 7px 14px;
    font-family: inherit;
  }
  .btn[disabled] { opacity: 0.4; cursor: not-allowed; }
  .btn-primary { background: var(--capix-green); color: #042b18; }
  .btn-secondary { background: rgba(255,255,255,0.07); color: var(--capix-fg); }
  .btn-mini { background: transparent; color: var(--capix-muted); padding: 4px 9px; font-size: 11px; border: 1px solid var(--capix-border); }
  .btn-mini:hover { background: rgba(61,206,214,0.10); color: var(--capix-cyan); border-color: var(--capix-border-accent); }
  .btn:hover { opacity: 0.9; }
  .nav-bar {
    display: flex; flex-wrap: wrap; gap: 2px;
    border-bottom: 1px solid var(--capix-border);
    margin-bottom: 14px; padding-bottom: 4px;
  }
  .nav-tab {
    background: transparent; border: none; cursor: pointer;
    color: var(--capix-muted); font-family: inherit; font-size: 11px;
    padding: 6px 12px; border-radius: 6px 6px 0 0; letter-spacing: 0.04em;
    border-bottom: 2px solid transparent;
  }
  .nav-tab:hover { color: var(--capix-cyan); }
  .nav-tab.active { color: var(--capix-cyan); border-bottom-color: var(--capix-cyan); }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }
  .card {
    background: var(--capix-panel);
    border: 1px solid var(--capix-border);
    border-radius: 10px; padding: 14px; margin-bottom: 12px;
  }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 720px) { .grid-2 { grid-template-columns: 1fr; } }
  .stat-row { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; }
  @media (max-width: 720px) { .stat-row { grid-template-columns: repeat(3, 1fr); } }
  .stat { text-align: center; }
  .stat-value { font-size: 16px; font-weight: 700; color: var(--capix-cyan); font-family: var(--vscode-editor-font-family, 'JetBrains Mono', monospace); }
  .stat-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.10em; color: var(--capix-muted); margin-top: 2px; }
  .section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; gap: 8px; }
  .section-head h2 { font-size: 10px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--capix-muted); margin: 0; font-weight: 600; }
  .muted { color: var(--capix-muted); font-size: 10px; }
  .toolbar { display: flex; gap: 6px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  .toolbar input[type="text"], .toolbar select {
    flex: 1; min-width: 120px;
    background: var(--capix-input); color: var(--capix-fg);
    border: 1px solid var(--capix-border); padding: 6px 9px; font-size: 12px;
    border-radius: 6px; font-family: inherit;
  }
  .toolbar input:focus, .toolbar select:focus { outline: none; border-color: var(--capix-border-accent); }
  .state { padding: 18px 8px; text-align: center; color: var(--capix-muted); }
  .state.connect p { margin: 0 0 4px; }
  .state.connect .muted { margin-bottom: 12px; display: block; }
  .state.subtle { padding: 12px; text-align: center; opacity: 0.55; }
  .state.loading { color: var(--capix-cyan); }
  .state.error { color: var(--capix-red); }
  .ov-row {
    display: grid; grid-template-columns: auto 1fr auto auto; gap: 8px;
    align-items: center; padding: 7px 0;
    border-bottom: 1px solid rgba(255,255,255,0.045); cursor: pointer;
  }
  .ov-row:hover { background: rgba(61,206,214,0.04); }
  .ov-content { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ov-recency, .ov-rate { font-size: 10px; color: var(--capix-dim); font-family: var(--vscode-editor-font-family, 'JetBrains Mono', monospace); }
  .ov-rate { color: var(--capix-green); }
  .ov-type {
    font-size: 8px; text-transform: uppercase; padding: 2px 7px; border-radius: 999px;
    letter-spacing: 0.06em; background: rgba(255,255,255,0.05); color: var(--capix-muted);
  }
  .type-decision { background: rgba(61,206,214,0.12); color: var(--capix-cyan); }
  .type-pattern, .type-fact { background: rgba(20,241,149,0.12); color: var(--capix-green); }
  .type-feedback, .type-preference { background: rgba(255,174,0,0.12); color: var(--capix-amber); }
  .type-context, .type-observation { background: rgba(91,141,239,0.12); color: #5B8DEF; }
  .type-anchor, .type-relationship { background: rgba(244,114,182,0.12); color: #f472b6; }
  .type-instruction { background: rgba(167,139,250,0.12); color: #a78bfa; }
  .ov-badge { font-size: 8px; text-transform: uppercase; padding: 2px 7px; border-radius: 999px; letter-spacing: 0.04em; }
  .badge-running, .badge-pending, .badge-active, .badge-in_progress, .badge-installed, .badge-enabled, .badge-submitted { background: rgba(61,206,214,0.12); color: var(--capix-cyan); }
  .badge-done, .badge-completed, .badge-confirmed, .badge-distributed, .badge-approved { background: rgba(20,241,149,0.12); color: var(--capix-green); }
  .badge-draft, .badge-deprecated { background: rgba(255,174,0,0.12); color: var(--capix-amber); }
  .badge-failed, .badge-cancelled { background: rgba(255,82,82,0.12); color: var(--capix-red); }
  .badge-disabled, .badge-pinned { background: rgba(255,255,255,0.06); color: var(--capix-muted); }
  .ov-covenant { display: flex; align-items: center; gap: 8px; padding: 6px 0; }
  .legend-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
  /* memory */
  .memory-list { display: flex; flex-direction: column; gap: 8px; }
  .mem-card { background: var(--capix-panel); border: 1px solid var(--capix-border); border-radius: 8px; padding: 10px 12px; }
  .mem-head { display: grid; grid-template-columns: auto 1fr auto auto; gap: 8px; align-items: center; margin-bottom: 6px; }
  .conf-bar { background: rgba(255,255,255,0.06); height: 4px; border-radius: 2px; overflow: hidden; }
  .conf-fill { height: 100%; background: var(--capix-cyan); }
  .conf-val { font-size: 9px; color: var(--capix-muted); font-family: var(--vscode-editor-font-family, 'JetBrains Mono', monospace); }
  .mem-content { color: var(--capix-fg); font-size: 12px; line-height: 1.5; cursor: pointer; }
  .mem-content[data-truncated="false"] { }
  .mem-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
  .mem-meta { display: flex; gap: 12px; font-size: 10px; color: var(--capix-dim); }
  .mem-related { font-size: 10px; color: var(--capix-cyan); }
  .mem-related a { color: var(--capix-cyan); text-decoration: none; cursor: pointer; }
  .mem-actions { display: flex; align-items: center; gap: 4px; }
  .anchor-pill { font-size: 8px; text-transform: uppercase; padding: 2px 6px; border-radius: 999px; background: rgba(20,241,149,0.12); color: var(--capix-green); }
  /* skills */
  .skill-card { background: var(--capix-panel); border: 1px solid var(--capix-border); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; opacity: 0.7; }
  .skill-card.enabled { opacity: 1; border-color: rgba(61,206,214,0.18); }
  .skill-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .skill-name { font-weight: 600; }
  .skill-ver { font-size: 10px; color: var(--capix-dim); font-family: var(--vscode-editor-font-family, 'JetBrains Mono', monospace); }
  .skill-desc { font-size: 11px; color: var(--capix-muted); margin: 4px 0 6px; }
  .skill-meta { display: flex; gap: 10px; font-size: 10px; color: var(--capix-dim); flex-wrap: wrap; }
  .skill-hash { font-size: 9px; color: var(--capix-dim); font-family: var(--vscode-editor-font-family, 'JetBrains Mono', monospace); margin: 4px 0 6px; }
  .skill-actions { display: flex; gap: 4px; }
  .fp-pill { font-size: 8px; text-transform: uppercase; padding: 1px 6px; border-radius: 999px; background: rgba(167,139,250,0.12); color: #a78bfa; }
  /* plans */
  .plan-card { background: var(--capix-panel); border: 1px solid var(--capix-border); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; }
  .plan-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .plan-title { font-weight: 600; }
  .plan-desc { font-size: 11px; color: var(--capix-muted); margin-bottom: 8px; }
  .plan-steps { list-style: none; padding: 0; margin: 0 0 8px; }
  .step { display: flex; gap: 8px; padding: 3px 0; font-size: 11px; }
  .step-check { width: 14px; color: var(--capix-cyan); font-family: var(--vscode-editor-font-family, 'JetBrains Mono', monospace); }
  .step-done .step-desc { color: var(--capix-muted); text-decoration: line-through; }
  .step-in_progress .step-check { color: var(--capix-amber); }
  .plan-foot { display: flex; gap: 10px; font-size: 10px; color: var(--capix-dim); align-items: center; flex-wrap: wrap; }
  .link-pill { background: rgba(20,241,149,0.10); color: var(--capix-green); border: none; cursor: pointer; padding: 2px 8px; border-radius: 999px; font-size: 10px; font-family: inherit; }
  /* agents */
  .agent-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.045); flex-wrap: wrap; }
  .agent-name { font-weight: 500; }
  .agent-role { font-size: 10px; color: var(--capix-dim); }
  .agent-trust { font-size: 9px; text-transform: uppercase; color: var(--capix-amber); padding: 1px 5px; border-radius: 4px; background: rgba(255,174,0,0.10); }
  .gen-pill { font-size: 9px; color: var(--capix-muted); font-family: var(--vscode-editor-font-family, 'JetBrains Mono', monospace); }
  .agent-actions { margin-left: auto; }
  /* receipts */
  .rcpt-head, .rcpt-row { display: grid; grid-template-columns: 1.2fr 1fr 3fr 0.9fr 0.9fr 0.9fr 0.7fr; gap: 8px; align-items: center; padding: 7px 0; border-bottom: 1px solid rgba(255,255,255,0.045); }
  .rcpt-head { font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--capix-dim); border-bottom: 1px solid var(--capix-border); }
  .rcpt-id { font-family: var(--vscode-editor-font-family, 'JetBrains Mono', monospace); font-size: 10px; color: var(--capix-cyan); }
  .rcpt-task { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rcpt-cost { color: var(--capix-green); font-family: var(--vscode-editor-font-family, 'JetBrains Mono', monospace); font-size: 11px; }
  .rcpt-merkle { font-size: 10px; color: var(--capix-muted); }
  .rcpt-chain { font-size: 10px; color: var(--capix-green); }
  .icon-btn { background: transparent; border: none; cursor: pointer; color: var(--capix-muted); font-family: inherit; font-size: 12px; padding: 2px 4px; border-radius: 4px; }
  .icon-btn:hover { background: rgba(255,255,255,0.08); color: var(--capix-fg); }
  .icon-btn.danger:hover { color: var(--capix-red); }
`;

const WORKSPACE_SCRIPT = `
(function(){
  const vscode = acquireVsCodeApi();
  function esc(s){ if(s===null||s===undefined) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

  function activate(tab){
    document.querySelectorAll('.tab-panel').forEach(function(p){ p.classList.toggle('active', p.dataset.panel === tab); });
    document.querySelectorAll('.nav-tab').forEach(function(t){ t.classList.toggle('active', t.dataset.tab === tab); });
    if (tab === 'graph') {
      window.dispatchEvent(new CustomEvent('graph:visible'));
      setTimeout(function(){ const st = document.getElementById('graph-status'); if (st) st.textContent = st.textContent || 'Ready'; }, 50);
    }
    if (tab === 'memory') { const s = document.getElementById('memory-search'); if (s) setTimeout(function(){ s.focus(); }, 50); }
  }

  document.addEventListener('click', function(e){
    const t = e.target instanceof Element ? e.target.closest('[data-action],[data-tab],[data-mem-id]') : null;
    if (!t) return;
    if (t.dataset.tab) { vscode.postMessage({ type: 'activate-tab', tab: t.dataset.tab }); activate(t.dataset.tab); return; }
    const a = t.dataset.action;
    if (!a) return;
    if (a === 'expandMemory') {
      const card = t.closest('.mem-card');
      const c = card ? card.querySelector('.mem-content') : null;
      if (c) {
        const tr = c.dataset.truncated === 'true';
        c.dataset.truncated = tr ? 'false' : 'true';
        if (tr && c.dataset.full) { c.textContent = c.dataset.full; }
        else if (!tr && c.dataset.short) { c.textContent = c.dataset.short; }
      }
      return;
    }
    vscode.postMessage({ type: a, id: t.dataset.id || t.closest('[data-skill-id]')?.dataset.skillId || t.closest('[data-mem-id]')?.dataset.memId || undefined });
  });

  function bindSearch(){
    const s = document.getElementById('memory-search');
    const f = document.getElementById('memory-type-filter');
    if (!s) return;
    const send = function(){ vscode.postMessage({ type: 'searchMemory', query: s.value }); };
    s.addEventListener('keydown', function(e){ if (e.key === 'Enter') send(); });
    if (window.__capixGraphFilter) {
      const g = document.getElementById('graph-search');
      if (g) g.addEventListener('input', function(){ window.__capixGraphFilter(g.value); });
    }
  }
  bindSearch();

  window.addEventListener('message', function(e){
    const m = e.data; if (!m || !m.type) return;
    switch (m.type) {
      case 'loading':
        document.body.classList.toggle('loading', !!m.value);
        break;
      case 'activate-tab':
        activate(m.tab);
        break;
      case 'focus-search':
        const s = document.getElementById('memory-search'); if (s) s.focus();
        break;
      case 'searchResults':
        vscode.postMessage({ type: 'activate-tab', tab: 'memory' }); activate('memory');
        break;
      case 'graph:patch':
        // host re-rendered the whole workspace; the merge is server-side.
        break;
      case 'graph:status':
        const st = document.getElementById('graph-status'); if (st) st.textContent = m.message;
        break;
      case 'graph:rendered':
        window.dispatchEvent(new CustomEvent('graph:visible'));
        break;
      case 'receipt:verified':
        const row = document.querySelector('.rcpt-row[data-id="' + m.id + '"]');
        if (row) { row.classList.add('verified'); }
        break;
    }
  });
  activate(document.querySelector('.tab-panel.active')?.dataset.panel || 'overview');
})();`;

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
	return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function recency(iso: string): string {
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
		return `chain: ${authoredBy} → anchor(${n.anchorTx.slice(0, 10)}…)`;
	}
	return `local: ${authoredBy}`;
}

function relatedLinks(n: MemoryNode): string {
	const meta = n.metadata as Record<string, unknown> | undefined;
	const parts: string[] = [];
	const files = meta?.relatedFiles;
	if (Array.isArray(files)) {
		for (const f of files) {
			if (typeof f === "string") parts.push(`<a title="${esc(f)}">${esc(f.split("/").pop() ?? f)}</a>`);
		}
	}
	const session = meta?.sessionId;
	if (typeof session === "string") parts.push(`<a title="session">session ${esc(session.slice(0, 8))}</a>`);
	return parts.length ? parts.join(" · ") : "";
}

function planStatusLabel(s: PlanStatus): string {
	switch (s) {
		case "draft":
			return "awaiting approval";
		case "approved":
			return "approved · ready to execute";
		case "in_progress":
			return "executing";
		case "completed":
			return "completed";
		case "cancelled":
			return "cancelled";
		default:
			return s;
	}
}

function errorMessage(err: unknown): string {
	if (err instanceof IntelligenceApiError) return err.message;
	if (err instanceof Error) return err.message;
	return String(err);
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
