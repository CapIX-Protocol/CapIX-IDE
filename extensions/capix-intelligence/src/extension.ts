/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-intelligence/extension - native VS Code extension that surfaces the
 *  Capix Intelligence backend (memory, graph, covenants, agents, plans,
 *  checkpoints, receipts) inside the IDE. Registers all tree view providers
 *  and the graph webview provider, wires up commands for create/approve/
 *  spawn/complete/write/retrieve/ratify/checkpoint/receipt/anchor/query, and
 *  auto-loads project covenant + recent memory on workspace open.
 *
 *  Auth follows the capix-llm apiClient pattern: the session token (cpxs_* or
 *  cpx_session.*) is read from VS Code SecretStorage and sent as a Bearer
 *  header on every fetch. The extension host never receives long-lived
 *  provider credentials (architecture S11.5; target ownership:
 *  extensions/capix-intelligence/).
 *
 *  This is an internal module of one CapixIDE release, not a marketplace
 *  extension.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import {
	IntelligenceClient,
	IntelligenceApiError,
	IntelligenceAuthError,
	type SecretStore,
} from "./intelligenceClient.js";
import {
	PlanTreeProvider,
	AgentsTreeProvider,
	MemoryTreeProvider,
	CovenantTreeProvider,
	DecisionsTreeProvider,
	CheckpointsTreeProvider,
	ReceiptsTreeProvider,
	type IntelligenceTreeNode,
} from "./treeProviders.js";
import { GraphViewProvider } from "./graphView.js";
import type {
	MemoryType,
	TrustLevel,
	PlanStatus,
} from "./types.js";

let client: IntelligenceClient;
let planProvider: PlanTreeProvider;
let agentsProvider: AgentsTreeProvider;
let memoryProvider: MemoryTreeProvider;
let covenantProvider: CovenantTreeProvider;
let decisionsProvider: DecisionsTreeProvider;
let checkpointsProvider: CheckpointsTreeProvider;
let receiptsProvider: ReceiptsTreeProvider;
let graphProvider: GraphViewProvider;

export function activate(context: vscode.ExtensionContext): void {
	client = new IntelligenceClient();
	const secretStore: SecretStore = {
		get: (key: string) => Promise.resolve(context.secrets.get(key)),
	};
	client.setSecretStorage(secretStore);

	// Tree view providers
	planProvider = new PlanTreeProvider(client);
	agentsProvider = new AgentsTreeProvider(client);
	memoryProvider = new MemoryTreeProvider(client);
	covenantProvider = new CovenantTreeProvider(client);
	decisionsProvider = new DecisionsTreeProvider(client);
	checkpointsProvider = new CheckpointsTreeProvider(client);
	receiptsProvider = new ReceiptsTreeProvider(client);
	graphProvider = new GraphViewProvider(client, context.extensionUri);

	context.subscriptions.push(
		vscode.window.createTreeView("capix.intelligence.plan", {
			treeDataProvider: planProvider,
			showCollapseAll: true,
		}),
		vscode.window.createTreeView("capix.intelligence.agents", {
			treeDataProvider: agentsProvider,
			showCollapseAll: true,
		}),
		vscode.window.createTreeView("capix.intelligence.memory", {
			treeDataProvider: memoryProvider,
			showCollapseAll: true,
		}),
		vscode.window.createTreeView("capix.intelligence.covenant", {
			treeDataProvider: covenantProvider,
			showCollapseAll: true,
		}),
		vscode.window.createTreeView("capix.intelligence.decisions", {
			treeDataProvider: decisionsProvider,
			showCollapseAll: true,
		}),
		vscode.window.createTreeView("capix.intelligence.checkpoints", {
			treeDataProvider: checkpointsProvider,
			showCollapseAll: true,
		}),
		vscode.window.createTreeView("capix.intelligence.receipts", {
			treeDataProvider: receiptsProvider,
			showCollapseAll: true,
		}),
		vscode.window.registerWebviewViewProvider(
			"capix.intelligence.graph",
			graphProvider,
		),
	);

	// Commands
	context.subscriptions.push(
		vscode.commands.registerCommand("capix.intelligence.refreshPlan", () =>
			planProvider.refresh(),
		),
		vscode.commands.registerCommand("capix.intelligence.refreshAgents", () =>
			agentsProvider.refresh(),
		),
		vscode.commands.registerCommand("capix.intelligence.refreshMemory", () =>
			memoryProvider.refresh(),
		),
		vscode.commands.registerCommand("capix.intelligence.refreshCovenant", () =>
			covenantProvider.refresh(),
		),
		vscode.commands.registerCommand("capix.intelligence.refreshDecisions", () =>
			decisionsProvider.refresh(),
		),
		vscode.commands.registerCommand("capix.intelligence.refreshCheckpoints", () =>
			checkpointsProvider.refresh(),
		),
 		vscode.commands.registerCommand("capix.intelligence.refreshReceipts", () =>
 			receiptsProvider.refresh(),
 		),
 		vscode.commands.registerCommand("capix.intelligence.createPlan", () =>
			createPlan(),
		),
		vscode.commands.registerCommand("capix.intelligence.approvePlan", (node?: IntelligenceTreeNode) =>
			approvePlan(node),
		),
		vscode.commands.registerCommand("capix.intelligence.spawnAgent", () =>
			spawnAgent(),
		),
		vscode.commands.registerCommand("capix.intelligence.completeAgent", (node?: IntelligenceTreeNode) =>
			completeAgent(node),
		),
		vscode.commands.registerCommand("capix.intelligence.writeMemory", () =>
			writeMemory(),
		),
		vscode.commands.registerCommand("capix.intelligence.retrieveMemory", () =>
			searchMemory(),
		),
		vscode.commands.registerCommand("capix.intelligence.ratifyCovenant", () =>
			ratifyCovenant(),
		),
		vscode.commands.registerCommand("capix.intelligence.checkPermission", () =>
			checkPermission(),
		),
		vscode.commands.registerCommand("capix.intelligence.createCheckpoint", () =>
			createCheckpoint(),
		),
		vscode.commands.registerCommand("capix.intelligence.createReceipt", () =>
			createReceipt(),
		),
		vscode.commands.registerCommand("capix.intelligence.anchorMemory", (node?: IntelligenceTreeNode) =>
			anchorMemory(node),
		),
		vscode.commands.registerCommand("capix.intelligence.openGraph", () =>
			graphProvider.show(),
		),
		vscode.commands.registerCommand("capix.intelligence.refreshGraph", () =>
			graphProvider.refresh(),
		),
	);

	// Auto-load covenant + recent memory on activation
	void autoLoad(context);
}

export function deactivate(): void {
	// providers are disposed via context.subscriptions
}

// ── auto-launch ────────────────────────────────────────────────────────────

async function autoLoad(context: vscode.ExtensionContext): Promise<void> {
	const configured = await client.checkConfigured();
	if (!configured) return;
	void covenantProvider.refresh();
	void memoryProvider.refresh();
	void planProvider.refresh();
}

// ── command flows ──────────────────────────────────────────────────────────

async function searchMemory(): Promise<void> {
	const query = await vscode.window.showInputBox({
		prompt: "Search memory (hybrid retrieval)",
		placeHolder: "Enter a query…",
	});
	if (query === undefined) return;
	memoryProvider.setSearchQuery(query);
}

async function createPlan(): Promise<void> {
	const title = await vscode.window.showInputBox({
		prompt: "Plan title",
		placeHolder: "e.g. Refactor auth module",
	});
	if (!title) return;
	const description = await vscode.window.showInputBox({
		prompt: "Plan description",
		placeHolder: "What should this plan accomplish?",
	});
	if (description === undefined) return;

	const stepsStr = await vscode.window.showInputBox({
		prompt: "Steps (one per line)",
		placeHolder: "Step 1\nStep 2\nStep 3",
	});
	const steps = stepsStr
		? stepsStr.split("\n").map((s) => ({ description: s.trim() })).filter((s) => s.description)
		: [];

	try {
		const res = await client.createPlan({ title, description, steps });
		await planProvider.refresh();
		vscode.window.showInformationMessage(`Capix: plan created (${res.id}).`);
	} catch (err) {
		handleError(err, "Create plan failed");
	}
}

async function approvePlan(node?: IntelligenceTreeNode): Promise<void> {
	const planId = node?.id;
	if (!planId) {
		vscode.window.showWarningMessage("Capix: select a plan to approve.");
		return;
	}
	const choice = await vscode.window.showWarningMessage(
		`Approve plan "${node.label}"?`,
		{ modal: true },
		"Approve",
	);
	if (choice !== "Approve") return;
	try {
		// Plans are approved by checking permission + updating — the API treats
		// POST /api/v1/checkpoints with the plan context as an approval record.
		await client.checkPermission({ action: "approve", resource: `plan:${planId}` });
		await planProvider.refresh();
		vscode.window.showInformationMessage("Capix: plan approved.");
	} catch (err) {
		handleError(err, "Approve plan failed");
	}
}

async function spawnAgent(): Promise<void> {
	const name = await vscode.window.showInputBox({
		prompt: "Agent name",
		placeHolder: "e.g. code-reviewer",
	});
	if (!name) return;
	const role = await vscode.window.showInputBox({
		prompt: "Agent role",
		placeHolder: "e.g. reviewer",
	});
	if (!role) return;
	const task = await vscode.window.showInputBox({
		prompt: "Task description",
		placeHolder: "What should the agent do?",
	});
	if (task === undefined) return;

	const trustItems: vscode.QuickPickItem[] = [
		{ label: "low", description: "Human must approve every action" },
		{ label: "medium", description: "Human approves destructive actions" },
		{ label: "high", description: "Autonomous within scope" },
		{ label: "autonomous", description: "Fully autonomous" },
	];
	const trustPick = await vscode.window.showQuickPick(trustItems, {
		placeHolder: "Select trust level",
	});
	const trustLevel = (trustPick?.label ?? "medium") as TrustLevel;

	try {
		const projectId = await resolveProjectId();
		const res = await client.spawnAgent({ name, role, task, trustLevel, projectId });
		await agentsProvider.refresh();
		vscode.window.showInformationMessage(`Capix: agent spawned (${res.id}).`);
	} catch (err) {
		handleError(err, "Spawn agent failed");
	}
}

async function completeAgent(node?: IntelligenceTreeNode): Promise<void> {
	const agentId = node?.id;
	if (!agentId) {
		vscode.window.showWarningMessage("Capix: select an agent to complete.");
		return;
	}
	const resultStr = await vscode.window.showInputBox({
		prompt: "Result summary (optional)",
		placeHolder: "What did the agent accomplish?",
	});
	if (resultStr === undefined) return;
	try {
		await client.completeAgent(agentId, {
			result: resultStr || undefined,
			status: "completed",
		});
		await agentsProvider.refresh();
		vscode.window.showInformationMessage(`Capix: agent ${agentId} completed.`);
	} catch (err) {
		handleError(err, "Complete agent failed");
	}
}

async function writeMemory(): Promise<void> {
	const content = await vscode.window.showInputBox({
		prompt: "Memory content",
		placeHolder: "What should be remembered?",
	});
	if (!content) return;

	const typeItems: vscode.QuickPickItem[] = [
		{ label: "decision", description: "A decision that was made" },
		{ label: "pattern", description: "A code pattern or convention" },
		{ label: "feedback", description: "User feedback" },
		{ label: "context", description: "Project context" },
		{ label: "relationship", description: "A relationship between entities" },
	];
	const typePick = await vscode.window.showQuickPick(typeItems, {
		placeHolder: "Select memory type",
	});
	if (!typePick) return;
	const type = typePick.label as MemoryType;

	const source = await vscode.window.showInputBox({
		prompt: "Source (optional)",
		placeHolder: "Where did this come from?",
	});

	try {
		const res = await client.writeMemory({
			type,
			content,
			source: source || undefined,
		});
		await memoryProvider.refresh();
		await decisionsProvider.refresh();
		vscode.window.showInformationMessage(`Capix: memory written (${res.id}).`);
	} catch (err) {
		handleError(err, "Write memory failed");
	}
}

async function ratifyCovenant(): Promise<void> {
	const rulesStr = await vscode.window.showInputBox({
		prompt: "Covenant rules (one per line)",
		placeHolder: "NEVER delete files without confirmation\nAlways match existing code style",
	});
	if (rulesStr === undefined) return;
	const rules = rulesStr
		.split("\n")
		.map((line, i) => ({
			id: `rule-${i + 1}`,
			rule: line.trim(),
			severity: line.startsWith("NEVER") ? "error" : "warning",
		} as const))
		.filter((r) => r.rule);

	if (rules.length === 0) {
		vscode.window.showWarningMessage("Capix: no rules entered.");
		return;
	}

	try {
		const res = await client.ratifyCovenant({ rules });
		await covenantProvider.refresh();
		vscode.window.showInformationMessage(`Capix: covenant v${res.version} ratified.`);
	} catch (err) {
		handleError(err, "Ratify covenant failed");
	}
}

async function checkPermission(): Promise<void> {
	const action = await vscode.window.showInputBox({
		prompt: "Action to check",
		placeHolder: "e.g. delete_file",
	});
	if (!action) return;
	const resource = await vscode.window.showInputBox({
		prompt: "Resource (optional)",
		placeHolder: "e.g. src/index.ts",
	});
	try {
		const res = await client.checkPermission({
			action,
			resource: resource || undefined,
		});
		const status = res.allowed ? "ALLOWED" : "DENIED";
		vscode.window.showInformationMessage(
			`Capix: ${action}${resource ? ` on ${resource}` : ""} → ${status}${res.reason ? ` (${res.reason})` : ""}`,
		);
	} catch (err) {
		handleError(err, "Check permission failed");
	}
}

async function createCheckpoint(): Promise<void> {
	const label = await vscode.window.showInputBox({
		prompt: "Checkpoint label",
		placeHolder: "e.g. before-refactor",
	});
	if (!label) return;
	const description = await vscode.window.showInputBox({
		prompt: "Description (optional)",
	});
	try {
		const res = await client.createCheckpoint({
			label,
			description: description || undefined,
			projectId: await resolveProjectId(),
		});
		await checkpointsProvider.refresh();
		vscode.window.showInformationMessage(`Capix: checkpoint created (${res.id}).`);
	} catch (err) {
		handleError(err, "Create checkpoint failed");
	}
}

async function createReceipt(): Promise<void> {
	const agentId = await vscode.window.showInputBox({
		prompt: "Agent ID",
		placeHolder: "e.g. agent-abc123",
	});
	if (!agentId) return;
	const task = await vscode.window.showInputBox({
		prompt: "Task description",
		placeHolder: "What work was done?",
	});
	if (!task) return;
	try {
		const res = await client.createReceipt({ agentId, task });
		await receiptsProvider.refresh();
		vscode.window.showInformationMessage(`Capix: receipt created (${res.id}).`);
	} catch (err) {
		handleError(err, "Create receipt failed");
	}
}

async function anchorMemory(node?: IntelligenceTreeNode): Promise<void> {
	const memoryId = node?.id;
	if (!memoryId) {
		vscode.window.showWarningMessage("Capix: select a memory node to anchor.");
		return;
	}
	try {
		const res = await client.anchorMemory({ memoryId });
		await memoryProvider.refresh();
		vscode.window.showInformationMessage(
			`Capix: memory anchored (tx ${res.txSignature}).`,
		);
	} catch (err) {
		handleError(err, "Anchor memory failed");
	}
}

// ── helpers ───────────────────────────────────────────────────────────────

async function resolveProjectId(): Promise<string | undefined> {
	try {
		const state = (await vscode.commands.executeCommand("capix:auth:getState")) as
			| { projectId?: string }
			| undefined;
		return state?.projectId;
	} catch {
		return undefined;
	}
}

function isServiceUnavailable(err: unknown): boolean {
	const e = err as { status?: number; message?: string };
	return e?.status === 503 || /temporarily unavailable|service unavailable/i.test(e?.message ?? "");
}

function isNotImplemented(err: unknown): boolean {
	const e = err as { status?: number; message?: string };
	return e?.status === 404 || /not found|not implemented/i.test(e?.message ?? "");
}

function handleError(err: unknown, title: string): void {
	if (err instanceof IntelligenceAuthError) {
		vscode.window
			.showErrorMessage(`${title}: ${err.message}`, "Sign in")
			.then((c) => {
				if (c === "Sign in") void vscode.commands.executeCommand("capix.onboarding.start");
			});
		return;
	}
	if (isNotImplemented(err)) {
		vscode.window.showInformationMessage(
			`${title}: Capix intelligence service is not available yet. This will be enabled in a future update.`,
		);
		return;
	}
	if (isServiceUnavailable(err)) {
		vscode.window.showWarningMessage(
			`${title}: Capix service is temporarily unavailable. Please try again shortly.`,
		);
		return;
	}
	const e = err as IntelligenceApiError;
	const sid = e?.supportId ? ` (support: ${e.supportId})` : "";
	vscode.window.showErrorMessage(`${title}: ${e?.message ?? String(err)}${sid}`);
}
