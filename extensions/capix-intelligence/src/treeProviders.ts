/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-intelligence/treeProviders - TreeDataProvider implementations for
 *  every tree view contributed by the intelligence extension. Each provider
 *  fetches its data from the IntelligenceClient and surfaces a placeholder
 *  node when the list is empty or an error occurs. Nodes carry contextValue
 *  tags so view/item/context menus can match by viewItem.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import type { IntelligenceClient } from "./intelligenceClient.js";
import { IntelligenceApiError, IntelligenceAuthError } from "./intelligenceClient.js";
import type {
	PlanRecord,
	PlanStep,
	PlanStatus,
	AgentRecord,
	MemoryNode,
	MemoryType,
	CovenantVersion,
	CovenantRule,
	CheckpointRecord,
	WorkReceipt,
	IntelligenceTreeNodeKind,
} from "./types.js";

// ── shared helpers ────────────────────────────────────────────────────────

function isAuthError(err: unknown): boolean {
	return err instanceof IntelligenceAuthError;
}

function isServiceUnavailable(err: unknown): boolean {
	const e = err as { status?: number; message?: string };
	return e?.status === 503 || /temporarily unavailable|service unavailable/i.test(e?.message ?? "");
}

function isNotImplemented(err: unknown): boolean {
	const e = err as { status?: number; message?: string };
	return e?.status === 404 || /not found|not implemented/i.test(e?.message ?? "");
}

/** Base class: manages emitter + placeholder pattern shared by all providers. */
abstract class BaseTreeProvider<T> implements vscode.TreeDataProvider<IntelligenceTreeNode> {
	protected readonly emitter = new vscode.EventEmitter<IntelligenceTreeNode | undefined>();
	readonly onDidChangeTreeData = this.emitter.event;
	protected items: T[] = [];
	protected placeholderLabel = "No data yet.";
	protected authPlaceholder = "Sign in to Capix to view data.";
	protected unavailablePlaceholder = "Intelligence service is not available yet.";
	protected errorPlaceholder = "Failed to load data.";

	abstract refresh(): Promise<void>;
	abstract buildNodes(items: T[]): IntelligenceTreeNode[];

	getTreeItem(element: IntelligenceTreeNode): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: IntelligenceTreeNode): Promise<IntelligenceTreeNode[]> {
		if (element) return element.children ?? [];
		if (this.items.length === 0) {
			return [new PlaceholderNode(this.placeholderLabel)];
		}
		return this.buildNodes(this.items);
	}

	protected fire(): void {
		this.emitter.fire(undefined);
	}

	protected handleListError(err: unknown, entity: string): void {
		this.items = [];
		if (isAuthError(err)) {
			this.placeholderLabel = this.authPlaceholder;
		} else if (isServiceUnavailable(err)) {
			this.placeholderLabel = "Service temporarily unavailable.";
		} else if (isNotImplemented(err)) {
			this.placeholderLabel = `${entity} unavailable.`;
		} else {
			this.placeholderLabel = this.errorPlaceholder;
			const e = err as IntelligenceApiError;
			void vscode.window.showErrorMessage(
				`Capix: failed to list ${entity} (${e?.message ?? err})`,
			);
		}
	}
}

/** A generic tree node wrapper. */
export class IntelligenceTreeNode extends vscode.TreeItem {
	children?: IntelligenceTreeNode[];

	constructor(
		label: string,
		collapsibleState: vscode.TreeItemCollapsibleState,
		readonly kind: IntelligenceTreeNodeKind,
	) {
		super(label, collapsibleState);
	}
}

class PlaceholderNode extends IntelligenceTreeNode {
	constructor(label: string) {
		super(label, vscode.TreeItemCollapsibleState.None, "placeholder");
		this.iconPath = new vscode.ThemeIcon("info");
	}
}

// ── Plan provider ─────────────────────────────────────────────────────────

const PLAN_STATUS_ICON: Record<PlanStatus, string> = {
	draft: "edit",
	approved: "pass",
	in_progress: "loading~spin",
	completed: "check-all",
	cancelled: "circle-slash",
};

export class PlanTreeProvider extends BaseTreeProvider<PlanRecord> {
	constructor(private readonly client: IntelligenceClient) {
		super();
		this.placeholderLabel = "No plans yet. Create one to get started.";
		this.authPlaceholder = "Sign in to Capix to view plans.";
		this.errorPlaceholder = "Failed to load plans.";
	}

	async refresh(): Promise<void> {
		try {
			const res = await this.client.listPlans();
			this.items = res.plans;
			this.placeholderLabel = "No plans yet. Create one to get started.";
		} catch (err) {
			this.handleListError(err, "plans");
		}
		this.fire();
	}

	buildNodes(plans: PlanRecord[]): IntelligenceTreeNode[] {
		return plans.map((plan) => {
			const node = new IntelligenceTreeNode(
				plan.title,
				plan.steps.length > 0
					? vscode.TreeItemCollapsibleState.Expanded
					: vscode.TreeItemCollapsibleState.None,
				"plan",
			);
			node.id = plan.id;
			node.description = plan.status;
			node.tooltip = `${plan.title}\nstatus: ${plan.status}\n${plan.steps.length} steps`;
			node.iconPath = new vscode.ThemeIcon(PLAN_STATUS_ICON[plan.status] ?? "list-tree");
			node.contextValue = `capix-intel-plan-${plan.status}`;
			node.children = plan.steps.map((step) => this.buildStepNode(step));
			return node;
		});
	}

	private buildStepNode(step: PlanStep): IntelligenceTreeNode {
		const node = new IntelligenceTreeNode(
			step.description,
			vscode.TreeItemCollapsibleState.None,
			"plan-step",
		);
		node.id = step.id;
		node.description = step.status;
		node.iconPath = new vscode.ThemeIcon(
			step.status === "done" ? "check" : step.status === "in_progress" ? "loading~spin" : "circle-outline",
		);
		node.contextValue = "capix-intel-plan-step";
		return node;
	}
}

// ── Agents provider ───────────────────────────────────────────────────────

const TRUST_ICON: Record<string, string> = {
	low: "shield",
	medium: "shield-check",
	high: "verified",
	autonomous: "robot",
};

const AGENT_STATUS_ICON: Record<string, string> = {
	pending: "clock",
	running: "loading~spin",
	completed: "check-all",
	failed: "error",
	cancelled: "circle-slash",
};

export class AgentsTreeProvider extends BaseTreeProvider<AgentRecord> {
	constructor(private readonly client: IntelligenceClient) {
		super();
		this.placeholderLabel = "No active agents. Spawn one to get started.";
		this.authPlaceholder = "Sign in to Capix to view agents.";
		this.errorPlaceholder = "Failed to load agents.";
	}

	async refresh(): Promise<void> {
		try {
			const res = await this.client.listAgents();
			this.items = res.agents;
			this.placeholderLabel = "No active agents. Spawn one to get started.";
		} catch (err) {
			this.handleListError(err, "agents");
		}
		this.fire();
	}

	buildNodes(agents: AgentRecord[]): IntelligenceTreeNode[] {
		return agents.map((agent) => {
			const node = new IntelligenceTreeNode(
				`${agent.name} (${agent.role})`,
				vscode.TreeItemCollapsibleState.None,
				"agent",
			);
			node.id = agent.id;
			node.description = `gen ${agent.generation} · ${agent.status}`;
			node.tooltip = `agent ${agent.id}\nrole: ${agent.role}\ntrust: ${agent.trustLevel}\ngeneration: ${agent.generation}\nstatus: ${agent.status}`;
			node.iconPath = new vscode.ThemeIcon(
				TRUST_ICON[agent.trustLevel] ?? AGENT_STATUS_ICON[agent.status] ?? "server",
			);
			node.contextValue = `capix-intel-agent-${agent.status}`;
			return node;
		});
	}
}

// ── Memory provider ──────────────────────────────────────────────────────

const MEMORY_TYPE_ICON: Record<string, string> = {
	decision: "lightbulb",
	pattern: "symbol-structure",
	feedback: "feedback",
	context: "bookmark",
	relationship: "references",
	anchor: "link",
};

export class MemoryTreeProvider extends BaseTreeProvider<MemoryNode> {
	private _searchQuery = "";

	constructor(private readonly client: IntelligenceClient) {
		super();
		this.placeholderLabel = "No memory nodes. Write one to get started.";
		this.authPlaceholder = "Sign in to Capix to view memory.";
		this.errorPlaceholder = "Failed to load memory.";
	}

	get searchQuery(): string {
		return this._searchQuery;
	}

	setSearchQuery(q: string): void {
		this._searchQuery = q;
		void this.refresh();
	}

	async refresh(): Promise<void> {
		try {
			if (this._searchQuery.trim()) {
				const res = await this.client.retrieveMemory({
					query: this._searchQuery,
					topK: 50,
				});
				this.items = res.results.map((r) => r.node);
			} else {
				const res = await this.client.listMemory();
				this.items = res.memory;
			}
			this.placeholderLabel = "No memory nodes. Write one to get started.";
		} catch (err) {
			this.handleListError(err, "memory");
		}
		this.fire();
	}

	buildNodes(memory: MemoryNode[]): IntelligenceTreeNode[] {
		const grouped = new Map<MemoryType, MemoryNode[]>();
		for (const node of memory) {
			const list = grouped.get(node.type) ?? [];
			list.push(node);
			grouped.set(node.type, list);
		}
		const result: IntelligenceTreeNode[] = [];
		for (const [type, nodes] of grouped) {
			const group = new IntelligenceTreeNode(
				`${type} (${nodes.length})`,
				vscode.TreeItemCollapsibleState.Expanded,
				"memory-group",
			);
			group.iconPath = new vscode.ThemeIcon("folder");
			group.contextValue = "capix-intel-memory-group";
			group.children = nodes.map((node) => this.buildMemoryNode(node));
			result.push(group);
		}
		return result;
	}

	private buildMemoryNode(node: MemoryNode): IntelligenceTreeNode {
		const tn = new IntelligenceTreeNode(
			node.content.length > 60 ? node.content.slice(0, 57) + "…" : node.content,
			vscode.TreeItemCollapsibleState.None,
			"memory",
		);
		tn.id = node.id;
		tn.description = new Date(node.createdAt).toLocaleDateString();
		tn.tooltip = `${node.type}: ${node.content}\nsource: ${node.source ?? "?"}\nid: ${node.id}${node.anchorTx ? `\nanchor: ${node.anchorTx}` : ""}`;
		tn.iconPath = new vscode.ThemeIcon(MEMORY_TYPE_ICON[node.type] ?? "note");
		tn.contextValue = node.type === "anchor" ? "capix-intel-memory-anchor" : "capix-intel-memory";
		return tn;
	}
}

// ── Covenant provider ─────────────────────────────────────────────────────

export class CovenantTreeProvider extends BaseTreeProvider<CovenantVersion> {
	constructor(private readonly client: IntelligenceClient) {
		super();
		this.placeholderLabel = "No covenant versions. Ratify one to get started.";
		this.authPlaceholder = "Sign in to Capix to view covenants.";
		this.errorPlaceholder = "Failed to load covenants.";
	}

	async refresh(): Promise<void> {
		try {
			const res = await this.client.listCovenants();
			this.items = res.versions;
			this.placeholderLabel = "No covenant versions. Ratify one to get started.";
		} catch (err) {
			this.handleListError(err, "covenants");
		}
		this.fire();
	}

	buildNodes(versions: CovenantVersion[]): IntelligenceTreeNode[] {
		return versions.map((version) => {
			const node = new IntelligenceTreeNode(
				`v${version.version}`,
				version.rules.length > 0
					? vscode.TreeItemCollapsibleState.Expanded
					: vscode.TreeItemCollapsibleState.None,
				"covenant-version",
			);
			node.id = version.version;
			node.description = `${version.status} · ${version.rules.length} rules`;
			node.tooltip = `covenant v${version.version}\nstatus: ${version.status}\ncreated: ${version.createdAt}`;
			node.iconPath = new vscode.ThemeIcon(
				version.status === "ratified" ? "shield-check" : version.status === "draft" ? "shield" : "archive",
			);
			node.contextValue = `capix-intel-covenant-${version.status}`;
			node.children = version.rules.map((rule) => this.buildRuleNode(rule));
			return node;
		});
	}

	private buildRuleNode(rule: CovenantRule): IntelligenceTreeNode {
		const node = new IntelligenceTreeNode(
			rule.rule,
			vscode.TreeItemCollapsibleState.None,
			"covenant-rule",
		);
		node.id = rule.id;
		node.description = rule.severity;
		node.tooltip = `${rule.rule}\nseverity: ${rule.severity}${rule.description ? `\n${rule.description}` : ""}`;
		node.iconPath = new vscode.ThemeIcon(
			rule.severity === "error" ? "error" : rule.severity === "warning" ? "warning" : "info",
		);
		node.contextValue = "capix-intel-covenant-rule";
		return node;
	}
}

// ── Decisions provider ────────────────────────────────────────────────────

export class DecisionsTreeProvider extends BaseTreeProvider<MemoryNode> {
	constructor(private readonly client: IntelligenceClient) {
		super();
		this.placeholderLabel = "No decisions recorded yet.";
		this.authPlaceholder = "Sign in to Capix to view decisions.";
		this.errorPlaceholder = "Failed to load decisions.";
	}

	async refresh(): Promise<void> {
		try {
			const res = await this.client.retrieveMemory({
				query: "decision",
				topK: 50,
				filterType: "decision",
			});
			this.items = res.results.map((r) => r.node);
			this.placeholderLabel = "No decisions recorded yet.";
		} catch (err) {
			this.handleListError(err, "decisions");
		}
		this.fire();
	}

	buildNodes(decisions: MemoryNode[]): IntelligenceTreeNode[] {
		return decisions.map((node) => {
			const tn = new IntelligenceTreeNode(
				node.content.length > 70 ? node.content.slice(0, 67) + "…" : node.content,
				vscode.TreeItemCollapsibleState.None,
				"decision",
			);
			tn.id = node.id;
			tn.description = new Date(node.createdAt).toLocaleDateString();
			tn.tooltip = `${node.content}\nsource: ${node.source ?? "?"}\nid: ${node.id}`;
			tn.iconPath = new vscode.ThemeIcon("lightbulb");
			tn.contextValue = "capix-intel-decision";
			return tn;
		});
	}
}

// ── Checkpoints provider ──────────────────────────────────────────────────

export class CheckpointsTreeProvider extends BaseTreeProvider<CheckpointRecord> {
	constructor(private readonly client: IntelligenceClient) {
		super();
		this.placeholderLabel = "No checkpoints yet. Create one to save state.";
		this.authPlaceholder = "Sign in to Capix to view checkpoints.";
		this.errorPlaceholder = "Failed to load checkpoints.";
	}

	async refresh(): Promise<void> {
		try {
			const res = await this.client.listCheckpoints();
			this.items = res.checkpoints;
			this.placeholderLabel = "No checkpoints yet. Create one to save state.";
		} catch (err) {
			this.handleListError(err, "checkpoints");
		}
		this.fire();
	}

	buildNodes(checkpoints: CheckpointRecord[]): IntelligenceTreeNode[] {
		return checkpoints.map((cp) => {
			const node = new IntelligenceTreeNode(
				cp.label,
				vscode.TreeItemCollapsibleState.None,
				"checkpoint",
			);
			node.id = cp.id;
			node.description = new Date(cp.createdAt).toLocaleString();
			node.tooltip = `${cp.label}\nid: ${cp.id}\ncreated: ${cp.createdAt}${cp.agentId ? `\nagent: ${cp.agentId}` : ""}`;
			node.iconPath = new vscode.ThemeIcon("history");
			node.contextValue = "capix-intel-checkpoint";
			return node;
		});
	}
}

// ── Receipts provider ─────────────────────────────────────────────────────

const RECEIPT_STATUS_ICON: Record<string, string> = {
	pending: "clock",
	submitted: "cloud-upload",
	confirmed: "check",
	distributed: "gift",
};

export class ReceiptsTreeProvider extends BaseTreeProvider<WorkReceipt> {
	constructor(private readonly client: IntelligenceClient) {
		super();
		this.placeholderLabel = "No work receipts yet.";
		this.authPlaceholder = "Sign in to Capix to view receipts.";
		this.errorPlaceholder = "Failed to load receipts.";
	}

	async refresh(): Promise<void> {
		try {
			const res = await this.client.listReceipts();
			this.items = res.receipts;
			this.placeholderLabel = "No work receipts yet.";
		} catch (err) {
			this.handleListError(err, "receipts");
		}
		this.fire();
	}

	buildNodes(receipts: WorkReceipt[]): IntelligenceTreeNode[] {
		return receipts.map((r) => {
			const node = new IntelligenceTreeNode(
				r.task.length > 60 ? r.task.slice(0, 57) + "…" : r.task,
				vscode.TreeItemCollapsibleState.None,
				"receipt",
			);
			node.id = r.id;
			node.description = `${r.status}${r.devTokens != null ? ` · ${r.devTokens} DEV` : ""}`;
			node.tooltip = `task: ${r.task}\nagent: ${r.agentId}\nstatus: ${r.status}${r.costMinor ? `\ncost: ${r.costMinor} ${r.currency ?? ""}` : ""}${r.devTokens != null ? `\nDEV tokens: ${r.devTokens}` : ""}`;
			node.iconPath = new vscode.ThemeIcon(RECEIPT_STATUS_ICON[r.status] ?? "receipt");
			node.contextValue = `capix-intel-receipt-${r.status}`;
			return node;
		});
	}
}
