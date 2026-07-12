/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-cloud/extension - resource, quote and billing UI for the standalone IDE.
 *
 *  Registers two sidebar tree views (Deployments, Billing) and the related commands:
 *  create (quote -> cost confirm -> create), delete (durable teardown), cancel
 *  operation, view receipt, refresh, open web console. Every action is dispatched
 *  through the typed main-process broker and never via a raw authenticated fetch
 *  (architecture S11.2, S11.4, S11.6; target ownership: extensions/capix-cloud/).
 *
 *  This is an internal module of one CapixIDE release, not a marketplace extension.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import { CapixCloudBroker, CapixCloudAuthError, CapixCloudError } from "./broker.js";
import type {
	DeploymentView,
	InvoiceView,
	ReceiptView,
	DeploymentState,
} from "./ipc.js";

// --- context value keys (declared in package.json menus) ---------------------
const CTX_DEPLOY_ACTIVE = "capix-deploy-active";
const CTX_DEPLOY_READY = "capix-deploy-ready";

let broker: CapixCloudBroker;
let deploymentsProvider: DeploymentsTreeProvider;
let billingProvider: BillingTreeProvider;
let operationPoll: NodeJS.Timeout | null = null;

export function activate(context: vscode.ExtensionContext): void {
	// The launch UI is provided by capix-llm's authenticated Profile, Deploys,
	// Instances and Catalog surfaces. Keep this broker module packaged for the
	// later control-plane rollout, but do not register orphan view IDs. Billing
	// and deployments are canonically exposed as capix.llm.profile and
	// capix.llm.deploys by capix-llm.
	broker = new CapixCloudBroker();
	deploymentsProvider = new DeploymentsTreeProvider(broker);
	billingProvider = new BillingTreeProvider(broker);
	context.subscriptions.push(
		vscode.commands.registerCommand("capix.cloud.openWebConsole", () =>
			vscode.env.openExternal(
				vscode.Uri.parse("https://www.capix.network/cloud"),
			),
		),
	);
}

export function deactivate(): void {
	if (operationPoll) {
		clearInterval(operationPoll);
		operationPoll = null;
	}
}

// --- create / delete flows --------------------------------------------------

async function createDeployment(
	broker: CapixCloudBroker,
	provider: DeploymentsTreeProvider,
): Promise<void> {
	try {
		const resourceKind = await pickResourceKind();
		if (!resourceKind) return;

		const name = await vscode.window.showInputBox({
			prompt: "Deployment name",
			placeHolder: "my-capix-resource",
			validateInput: (v) => (v.trim() ? undefined : "Name required"),
		});
		if (!name) return;

		const result = await broker.quoteAndCreate({ resourceKind, name });
		vscode.window.showInformationMessage(
			`Capix: creating ${resourceKind} (${result.deploymentId}).`,
		);
		await provider.refresh();
	} catch (err) {
		handleError(err, "Create deployment failed");
	}
}

async function deleteDeployment(
	broker: CapixCloudBroker,
	provider: DeploymentsTreeProvider,
	node?: DeploymentNode,
): Promise<void> {
	const deployment = node?.deployment ?? (await pickDeployment(provider));
	if (!deployment) return;

	const confirm = await vscode.window.showWarningMessage(
		`Capix: destroy ${deployment.name} (${deployment.id})?`,
		{ modal: true, detail: "Revoke sessions, tear down the provider asset and finalize the invoice." },
		"Destroy",
		"Cancel",
	);
	if (confirm !== "Destroy") return;

	try {
		const result = await broker.deleteDeployment(deployment.id);
		vscode.window.showInformationMessage(
			`Capix: teardown in progress (${result.operationId}).`,
		);
		await provider.refresh();
	} catch (err) {
		handleError(err, "Destroy deployment failed");
	}
}

async function showOperation(
	broker: CapixCloudBroker,
	node?: DeploymentNode,
): Promise<void> {
	const deployment = node?.deployment ?? (await pickDeployment(deploymentsProvider));
	if (!deployment?.lastOperationId) {
		vscode.window.showInformationMessage("Capix: no active operation for this deployment.");
		return;
	}
	try {
		const res = await broker.subscribeOperation(deployment.lastOperationId);
		const timeline = res.events
			.map((e) => `[${new Date(e.occurredAt).toLocaleTimeString()}] ${e.phase}: ${e.message}`)
			.join("\n");
		const doc = await vscode.workspace.openTextDocument({ content: timeline || "(no events)", language: "log" });
		await vscode.window.showTextDocument(doc, { preview: true });
	} catch (err) {
		handleError(err, "Operation subscribe failed");
	}
}

async function cancelOperation(
	broker: CapixCloudBroker,
	node?: DeploymentNode,
): Promise<void> {
	const opId = node?.deployment?.lastOperationId;
	if (!opId) return;
	try {
		await broker.cancelOperation(opId);
		await deploymentsProvider.refresh();
	} catch (err) {
		handleError(err, "Cancel operation failed");
	}
}

async function viewReceipt(
	broker: CapixCloudBroker,
	node: InvoiceNode | ReceiptNode,
): Promise<void> {
	const id = node instanceof InvoiceNode ? node.invoice.id : node.receipt.id;
	try {
		const receipt: ReceiptView = await broker.getReceipt(id);
		const panel = vscode.window.createWebviewPanel(
			"capixReceipt",
			`Receipt ${receipt.id}`,
			vscode.ViewColumn.Active,
			{ enableScripts: false, retainContextWhenHidden: false },
		);
		panel.webview.html = renderReceipt(receipt);
	} catch (err) {
		handleError(err, "Load receipt failed");
	}
}

// --- pickers ----------------------------------------------------------------

async function pickResourceKind(): Promise<"dedicated-gpu" | "private-llm" | "cpu-vps" | undefined> {
	const items: vscode.QuickPickItem[] = [
		{ label: "Dedicated GPU", description: "dedicated-gpu", detail: "Bare-metal GPU instance." },
		{ label: "Private LLM", description: "private-llm", detail: "Dedicated private model endpoint." },
		{ label: "CPU VPS", description: "cpu-vps", detail: "CPU virtual private server." },
	];
	const choice = await vscode.window.showQuickPick(items, { placeHolder: "Resource kind" });
	const desc = choice?.description;
	if (desc === "dedicated-gpu") return "dedicated-gpu";
	if (desc === "private-llm") return "private-llm";
	if (desc === "cpu-vps") return "cpu-vps";
	return undefined;
}

async function pickDeployment(provider: DeploymentsTreeProvider): Promise<DeploymentView | undefined> {
	await provider.refresh();
	const items = provider.all.map((d) => ({
		label: d.name,
		description: d.resourceKind,
		detail: `${d.state} - ${d.provider ?? "?"}/${d.region ?? "?"}`,
		deployment: d,
	}));
	const choice = await vscode.window.showQuickPick(items, { placeHolder: "Select deployment" });
	return choice?.deployment;
}

// --- error handling ---------------------------------------------------------

function isServiceUnavailable(err: unknown): boolean {
	const e = err as { capixCode?: string; message?: string };
	return e?.capixCode === "503" || /temporarily unavailable|service unavailable/i.test(e?.message ?? "");
}

function isNotImplemented(err: unknown): boolean {
	const e = err as { capixCode?: string; message?: string };
	return e?.capixCode === "not-implemented" || /not found|not implemented/i.test(e?.message ?? "");
}

function handleError(err: unknown, title: string): void {
	if (err instanceof CapixCloudAuthError) {
		vscode.window
			.showErrorMessage(`${title}: ${err.message}`, "Sign in")
			.then((choice) => {
				if (choice === "Sign in") {
					void vscode.commands.executeCommand("capix.onboarding.start");
				}
			});
		return;
	}
	if (isNotImplemented(err)) {
		vscode.window.showInformationMessage(
			`${title}: Cloud service is not available yet. Deployments and billing will be enabled in a future update.`,
		);
		return;
	}
	if (isServiceUnavailable(err)) {
		vscode.window.showWarningMessage(
			`${title}: Capix service is temporarily unavailable. Please try again shortly.`,
		);
		return;
	}
	const e = err as CapixCloudError;
	const supportId = e?.supportId ? ` (support: ${e.supportId})` : "";
	vscode.window.showErrorMessage(`${title}: ${e?.message ?? String(err)}${supportId}`);
}

function renderReceipt(r: ReceiptView): string {
	const fmt = (minor: string, ccy: string) => {
		const n = Number(minor);
		return Number.isFinite(n) ? `${(n / 100).toFixed(2)} ${ccy}` : `${minor} ${ccy}`;
	};
	return `<!DOCTYPE html><html><body style="font-family:sans-serif">
<h2>Capix Receipt</h2>
<table>
<tr><th>ID</th><td>${r.id}</td></tr>
<tr><th>Operation</th><td>${r.operationId}</td></tr>
<tr><th>Final cost</th><td>${fmt(r.costMinor, r.currency)}</td></tr>
<tr><th>Model</th><td>${r.model ?? "-"}</td></tr>
<tr><th>Region</th><td>${r.region ?? "-"}</td></tr>
<tr><th>Privacy</th><td>${r.privacy ?? "-"}</td></tr>
<tr><th>Provider</th><td>${r.provider ?? "-"}</td></tr>
<tr><th>Created</th><td>${new Date(r.createdAt).toISOString()}</td></tr>
</table></body></html>`;
}

// --- tree providers ---------------------------------------------------------

type CloudNode = DeploymentNode | InvoiceNode | BalanceNode | ReceiptNode | PlaceholderNode;

class DeploymentsTreeProvider implements vscode.TreeDataProvider<CloudNode> {
	private readonly emitter = new vscode.EventEmitter<CloudNode | undefined>();
	readonly onDidChangeTreeData = this.emitter.event;
	all: DeploymentView[] = [];
	private placeholderLabel = "No deployments. Use 'Capix: Create Deployment'.";

	constructor(private readonly broker: CapixCloudBroker) {}

	async refresh(): Promise<void> {
		try {
			const res = await this.broker.listDeployments();
			this.all = res.deployments;
			this.placeholderLabel = "No deployments. Use 'Capix: Create Deployment'.";
			await this.setContextKeys();
		} catch (err) {
			this.all = [];
			if (err instanceof CapixCloudAuthError) {
				this.placeholderLabel = "Sign in to Capix to view deployments.";
			} else if (isServiceUnavailable(err)) {
				this.placeholderLabel = "Service temporarily unavailable.";
			} else if (isNotImplemented(err)) {
				this.placeholderLabel = "Cloud deployments unavailable.";
			} else {
				this.placeholderLabel = "Failed to load deployments.";
				void vscode.window.showErrorMessage(
					`Capix: failed to list deployments (${(err as CapixCloudError).message ?? err})`,
				);
			}
		}
		this.emitter.fire(undefined);
	}

	private async setContextKeys(): Promise<void> {
		const anyActive = this.all.some((d) => isActive(d.state));
		const anyReady = this.all.some((d) => d.state === "READY");
		await vscode.commands.executeCommand("setContext", CTX_DEPLOY_ACTIVE, anyActive);
		await vscode.commands.executeCommand("setContext", CTX_DEPLOY_READY, anyReady);
	}

	getTreeItem(element: CloudNode): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: CloudNode): Promise<CloudNode[]> {
		if (element) return [];
		if (this.all.length === 0) {
			return [new PlaceholderNode(this.placeholderLabel)];
		}
		return this.all.map((d) => new DeploymentNode(d));
	}
}

class BillingTreeProvider implements vscode.TreeDataProvider<CloudNode> {
	private readonly emitter = new vscode.EventEmitter<CloudNode | undefined>();
	readonly onDidChangeTreeData = this.emitter.event;
	private root: (BalanceNode | InvoiceNode)[] = [];
	private placeholderLabel = "No billing data. Sign in to Capix.";

	constructor(private readonly broker: CapixCloudBroker) {}

	async refresh(): Promise<void> {
		try {
			const [balance, invoices] = await Promise.all([
				this.broker.getBalance(),
				this.broker.listInvoices(),
			]);
			this.root = [
				new BalanceNode(balance),
				...invoices.invoices.map((i) => new InvoiceNode(i)),
			];
			this.placeholderLabel = "No billing data available.";
		} catch (err) {
			this.root = [];
			if (err instanceof CapixCloudAuthError) {
				this.placeholderLabel = "Sign in to Capix to view billing.";
			} else if (isServiceUnavailable(err)) {
				this.placeholderLabel = "Service temporarily unavailable.";
			} else if (isNotImplemented(err)) {
				this.placeholderLabel = "Cloud billing unavailable.";
			} else {
				this.placeholderLabel = "Failed to load billing.";
				void vscode.window.showErrorMessage(
					`Capix: failed to load billing (${(err as CapixCloudError).message ?? err})`,
				);
			}
		}
		this.emitter.fire(undefined);
	}

	getTreeItem(element: CloudNode): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: CloudNode): Promise<CloudNode[]> {
		if (element) return [];
		if (this.root.length === 0) {
			return [new PlaceholderNode(this.placeholderLabel)];
		}
		return this.root;
	}
}

// --- node types -------------------------------------------------------------

function isActive(state: DeploymentState): boolean {
	switch (state) {
		case "READY":
		case "PROVISIONING":
		case "BOOTSTRAPPING":
		case "VERIFYING":
		case "STOPPED":
			return true;
		default:
			return false;
	}
}

function stateIcon(state: DeploymentState): string {
	switch (state) {
		case "READY":
			return "$(pass-filled)";
		case "FAILED":
		case "TERMINATED":
			return "$(error)";
		case "STOPPED":
		case "STOPPING":
			return "$(debug-stop)";
		case "DELETING":
			return "$(trash)";
		case "PROVISIONING":
		case "BOOTSTRAPPING":
		case "VERIFYING":
		case "HOLD":
		case "PENDING":
			return "$(loading~spin)";
		default:
			return "$(circle)";
	}
}

class DeploymentNode extends vscode.TreeItem {
	readonly deployment: DeploymentView;
	constructor(d: DeploymentView) {
		super(d.name, vscode.TreeItemCollapsibleState.None);
		this.deployment = d;
		this.id = d.id;
		this.description = `${d.state} - ${d.provider ?? "?"}/${d.region ?? "?"}`;
		this.tooltip = `${d.resourceKind} ${d.name}\nstate: ${d.state}\ncost: ${d.costMinorPerHour ?? "?"}/hr`;
		this.iconPath = new vscode.ThemeIcon(stateIcon(d.state));
		this.contextValue = d.state === "READY" ? "capix-deploy-ready" : "capix-deploy-active";
		this.command = {
			command: "capix.cloud.showOperation",
			title: "Show Operation Timeline",
			arguments: [this],
		};
	}
}

class InvoiceNode extends vscode.TreeItem {
	readonly invoice: InvoiceView;
	constructor(inv: InvoiceView) {
		const total = Number(inv.totalMinor);
		const amt = Number.isFinite(total) ? `${(total / 100).toFixed(2)} ${inv.currency}` : inv.totalMinor;
		super(`Invoice ${inv.number}`, vscode.TreeItemCollapsibleState.None);
		this.invoice = inv;
		this.id = inv.id;
		this.description = `${amt} - ${inv.status}`;
		this.iconPath = new vscode.ThemeIcon("receipt");
		this.contextValue = "capix-invoice";
		this.command = {
			command: "capix.cloud.viewReceipt",
			title: "View Receipt",
			arguments: [this],
		};
	}
}

class ReceiptNode extends vscode.TreeItem {
	readonly receipt: ReceiptView;
	constructor(r: ReceiptView) {
		super(`Receipt ${r.id}`, vscode.TreeItemCollapsibleState.None);
		this.receipt = r;
		this.id = r.id;
		this.description = `${r.costMinor} ${r.currency}`;
		this.iconPath = new vscode.ThemeIcon("file-text");
		this.contextValue = "capix-receipt";
		this.command = {
			command: "capix.cloud.viewReceipt",
			title: "View Receipt",
			arguments: [this],
		};
	}
}

class BalanceNode extends vscode.TreeItem {
	constructor(b: { availableMinor: string; heldMinor: string; currency: string }) {
		const avail = Number(b.availableMinor);
		const held = Number(b.heldMinor);
		const availS = Number.isFinite(avail) ? `${(avail / 100).toFixed(2)} ${b.currency}` : b.availableMinor;
		const heldS = Number.isFinite(held) ? `${(held / 100).toFixed(2)} ${b.currency}` : b.heldMinor;
		super(`Balance: ${availS}`, vscode.TreeItemCollapsibleState.None);
		this.description = `held: ${heldS}`;
		this.iconPath = new vscode.ThemeIcon("credit-card");
		this.contextValue = "capix-balance";
	}
}

class PlaceholderNode extends vscode.TreeItem {
	constructor(label: string) {
		super(label, vscode.TreeItemCollapsibleState.None);
		this.iconPath = new vscode.ThemeIcon("info");
	}
}
