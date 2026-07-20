/**
 * capix-workspace/extension - remote workspace attach, port forwarding and private
 * preview UI for the standalone IDE.
 *
 * Registers the Sessions tree view (capix.workspace.sessions) and the Ports tree
 * view (capix.workspace.ports), plus commands: connect, reconnect, disconnect,
 * forward port, close port, open preview, open terminal and open file. Every
 * action goes through the typed main-process broker (`capix:remote:*` and
 * `capix:workspace:*` channels); the extension never receives the one-use session
 * ticket, the mTLS workload identity or a raw provider SSH command
 * (architecture S11.6; target ownership: extensions/capix-workspace/).
 *
 * This is an internal module of one CapixIDE release, not a marketplace extension.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import {
	CapixWorkspaceBroker,
	CapixWorkspaceAuthError,
	CapixWorkspaceError,
	type ConnectionStateSubscription,
} from "./broker.js";
import type { WorkspaceSession, ForwardedPort, WorkspaceConnectionState } from "./ipc.js";

let broker: CapixWorkspaceBroker;
let sessionsProvider: SessionsTreeProvider;
let portsProvider: PortsTreeProvider;
let stateSub: ConnectionStateSubscription | null = null;
let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext): void {
	// Remote workspace attach is outside the initial launch surface. Hiding it
	// avoids presenting a separate broker-auth state alongside the primary Capix
	// session until the unified native credential bridge ships.
	const launchUiEnabled = false;
	if (!launchUiEnabled) return;
	broker = new CapixWorkspaceBroker();
	sessionsProvider = new SessionsTreeProvider(broker);
	portsProvider = new PortsTreeProvider(broker);

	const sessionsView = vscode.window.createTreeView("capix.workspace.sessions", {
		treeDataProvider: sessionsProvider,
		showCollapseAll: true,
	});
	const portsView = vscode.window.createTreeView("capix.workspace.ports", {
		treeDataProvider: portsProvider,
		showCollapseAll: false,
	});

	context.subscriptions.push(sessionsView, portsView);

	context.subscriptions.push(
		vscode.commands.registerCommand("capix.workspace.refreshSessions", () =>
			sessionsProvider.refresh(),
		),
		vscode.commands.registerCommand("capix.workspace.refreshPorts", () =>
			portsProvider.refresh(),
		),
		vscode.commands.registerCommand("capix.workspace.connect", (node?: SessionNode) =>
			connect(broker, sessionsProvider, portsProvider, node),
		),
		vscode.commands.registerCommand("capix.workspace.reconnect", () =>
			reconnect(broker, sessionsProvider, portsProvider),
		),
		vscode.commands.registerCommand("capix.workspace.disconnect", () =>
			disconnect(broker, sessionsProvider, portsProvider),
		),
		vscode.commands.registerCommand("capix.workspace.forwardPort", (node?: SessionNode) =>
			forwardPort(broker, portsProvider, node),
		),
		vscode.commands.registerCommand("capix.workspace.closePort", (node?: PortNode) =>
			closePort(broker, portsProvider, node),
		),
		vscode.commands.registerCommand("capix.workspace.openPreview", (node?: PortNode) =>
			openPreview(broker, node),
		),
		vscode.commands.registerCommand("capix.workspace.openTerminal", (node?: SessionNode) =>
			openTerminal(broker, node),
		),
		vscode.commands.registerCommand("capix.workspace.openFile", (node?: SessionNode) =>
			openFile(broker, node),
		),
	);

	// Connection-state fan-out from the broker (no secrets cross the boundary).
	stateSub = broker.onStateChanged((state) => {
		updateStatusBar(state);
		if (state.state === "connected" || state.state === "disconnected" || state.state === "failed") {
			void sessionsProvider.refresh();
		}
	});

	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
	statusBarItem.command = "capix.workspace.reconnect";
	statusBarItem.text = "$(remote) Capix: disconnected";
	statusBarItem.tooltip = "Capix remote workspace — click to reconnect";
	statusBarItem.show();
	context.subscriptions.push(statusBarItem);

	void sessionsProvider.refresh();
}

export function deactivate(): void {
	stateSub?.dispose();
	stateSub = null;
}

// --- flows ------------------------------------------------------------------

async function connect(
	broker: CapixWorkspaceBroker,
	sessions: SessionsTreeProvider,
	ports: PortsTreeProvider,
	node?: SessionNode,
): Promise<void> {
	const session = node?.session ?? (await pickSession(sessions));
	if (!session) return;
	try {
		const state = await broker.connect(session.workspaceId, session.projectId);
		vscode.window.showInformationMessage(
			`Capix: attached to ${session.name} (${state.authority ?? session.workspaceId}).`,
		);
		await sessions.refresh();
		await ports.refresh();
	} catch (err) {
		handleError(err, "Attach workspace failed");
	}
}

async function reconnect(
	broker: CapixWorkspaceBroker,
	sessions: SessionsTreeProvider,
	ports: PortsTreeProvider,
): Promise<void> {
	try {
		const state = await broker.reconnect();
		if (state.state === "connected") {
			await sessions.refresh();
			await ports.refresh();
		}
	} catch (err) {
		handleError(err, "Reconnect failed");
	}
}

async function disconnect(
	broker: CapixWorkspaceBroker,
	sessions: SessionsTreeProvider,
	ports: PortsTreeProvider,
): Promise<void> {
	const confirm = await vscode.window.showWarningMessage(
		"Capix: disconnect the active workspace session?",
		{ modal: true, detail: "The session ticket is revoked. The workspace itself is NOT destroyed." },
		"Disconnect",
		"Cancel",
	);
	if (confirm !== "Disconnect") return;
	try {
		await broker.disconnect();
		await sessions.refresh();
		await ports.refresh();
	} catch (err) {
		handleError(err, "Disconnect failed");
	}
}

async function forwardPort(
	broker: CapixWorkspaceBroker,
	ports: PortsTreeProvider,
	node?: SessionNode,
): Promise<void> {
	const session = node?.session;
	if (!session) {
		vscode.window.showErrorMessage("Capix: connect to a workspace before forwarding a port.");
		return;
	}
	const portStr = await vscode.window.showInputBox({
		prompt: "Workspace port to forward",
		placeHolder: "8080",
		validateInput: (v) => (/^\d+$/.test(v) && +v > 0 && +v < 65536 ? undefined : "Enter a valid port"),
	});
	if (!portStr) return;
	const label = await vscode.window.showInputBox({ prompt: "Label (optional)", placeHolder: "web preview" });
	try {
		const forwarded = await broker.forwardPort(session.workspaceId, Number(portStr), label);
		vscode.window.showInformationMessage(
			`Capix: forwarded port ${forwarded.localPort} -> ${forwarded.previewHost}`,
		);
		await ports.refresh();
	} catch (err) {
		handleError(err, "Forward port failed");
	}
}

async function closePort(
	broker: CapixWorkspaceBroker,
	ports: PortsTreeProvider,
	node?: PortNode,
): Promise<void> {
	const port = node?.port;
	if (!port) return;
	try {
		await broker.closePort(node!.session.workspaceId, port.localPort);
		await ports.refresh();
	} catch (err) {
		handleError(err, "Close port failed");
	}
}

async function openPreview(broker: CapixWorkspaceBroker, node?: PortNode): Promise<void> {
	const port = node?.port;
	if (!port) return;
	try {
		const res = await broker.openPreview(node!.session.workspaceId, port.localPort);
		await vscode.env.openExternal(vscode.Uri.parse(res.url));
	} catch (err) {
		handleError(err, "Open preview failed");
	}
}

async function openTerminal(broker: CapixWorkspaceBroker, node?: SessionNode): Promise<void> {
	const session = node?.session;
	if (!session) return;
	try {
		// Opaque handle: the broker owns the multiplexed PTY; the extension never
		// receives a raw socket or the mTLS identity.
		await broker.getChannel("terminal");
		vscode.window.showInformationMessage(`Capix: opened terminal on ${session.name}.`);
	} catch (err) {
		handleError(err, "Open terminal failed");
	}
}

async function openFile(broker: CapixWorkspaceBroker, node?: SessionNode): Promise<void> {
	const session = node?.session;
	if (!session) return;
	try {
		await broker.getChannel("filesystem");
		vscode.window.showInformationMessage(`Capix: opened remote files on ${session.name}.`);
	} catch (err) {
		handleError(err, "Open files failed");
	}
}

// --- pickers ----------------------------------------------------------------

async function pickSession(provider: SessionsTreeProvider): Promise<WorkspaceSession | undefined> {
	await provider.refresh();
	const items = provider.all.map((s) => ({
		label: s.name,
		description: s.resourceKind,
		detail: `${s.provider ?? "?"}/${s.region ?? "?"}${s.connected ? " - connected" : ""}`,
		session: s,
	}));
	const choice = await vscode.window.showQuickPick(items, { placeHolder: "Select workspace session" });
	return choice?.session;
}

// --- error handling / status ------------------------------------------------

function handleError(err: unknown, title: string): void {
	if (err instanceof CapixWorkspaceAuthError) {
		vscode.window
			.showErrorMessage(`${title}: ${err.message}`, "Sign in")
			.then((c) => {
				if (c === "Sign in") void vscode.commands.executeCommand("capix.onboarding.start");
			});
		return;
	}
	const e = err as CapixWorkspaceError;
	const sid = e?.supportId ? ` (support: ${e.supportId})` : "";
	vscode.window.showErrorMessage(`${title}: ${e?.message ?? String(err)}${sid}`);
}

function updateStatusBar(state: WorkspaceConnectionState): void {
	const icon =
		state.state === "connected"
			? "$(vm-active)"
			: state.state === "connecting" || state.state === "reconnecting"
				? "$(loading~spin)"
				: state.state === "failed"
					? "$(error)"
					: "$(remote)";
	statusBarItem.text = `${icon} Capix: ${state.state}`;
	statusBarItem.tooltip = state.lastError
		? `Capix remote: ${state.state}\n${state.lastError}`
		: `Capix remote: ${state.state}${state.authority ? ` (${state.authority})` : ""}`;
}

// --- tree providers ---------------------------------------------------------

type WsNode = SessionNode | PortNode | PlaceholderNode;

class SessionsTreeProvider implements vscode.TreeDataProvider<WsNode> {
	private readonly emitter = new vscode.EventEmitter<WsNode | undefined>();
	readonly onDidChangeTreeData = this.emitter.event;
	all: WorkspaceSession[] = [];

	constructor(private readonly broker: CapixWorkspaceBroker) {}

	async refresh(): Promise<void> {
		try {
			const res = await this.broker.listSessions();
			this.all = res.sessions;
		} catch (err) {
			this.all = [];
			if (!(err instanceof CapixWorkspaceAuthError)) {
				void vscode.window.showErrorMessage(
					`Capix: failed to list sessions (${(err as CapixWorkspaceError).message ?? err})`,
				);
			}
		}
		this.emitter.fire(undefined);
	}

	getTreeItem(element: WsNode): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: WsNode): Promise<WsNode[]> {
		if (element instanceof SessionNode) {
			return element.session.forwardedPorts.map(
				(p) => new PortNode(p, element!.session),
			);
		}
		if (element) return [];
		if (this.all.length === 0) {
			return [new PlaceholderNode("No workspace sessions.")];
		}
		return this.all.map((s) => new SessionNode(s, s.forwardedPorts.length > 0));
	}
}

class PortsTreeProvider implements vscode.TreeDataProvider<WsNode> {
	private readonly emitter = new vscode.EventEmitter<WsNode | undefined>();
	readonly onDidChangeTreeData = this.emitter.event;

	constructor(private readonly broker: CapixWorkspaceBroker) {}

	async refresh(): Promise<void> {
		// Ports are children of sessions; refresh the sessions tree to repopulate.
		this.emitter.fire(undefined);
		try {
			await this.broker.listSessions();
		} catch {
			// best-effort: state subscription drives the real redraw
		}
	}

	getTreeItem(element: WsNode): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: WsNode): Promise<WsNode[]> {
		if (element) return [];
		let sessions: WorkspaceSession[] = [];
		try {
			sessions = (await this.broker.listSessions()).sessions;
		} catch {
			return [new PlaceholderNode("No forwarded ports.")];
		}
		const ports: PortNode[] = [];
		for (const s of sessions) {
			for (const p of s.forwardedPorts) ports.push(new PortNode(p, s));
		}
		return ports.length > 0 ? ports : [new PlaceholderNode("No forwarded ports.")];
	}
}

// --- node types -------------------------------------------------------------

class SessionNode extends vscode.TreeItem {
	readonly session: WorkspaceSession;
	constructor(s: WorkspaceSession, hasPorts: boolean) {
		super(s.name, hasPorts ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
		this.session = s;
		this.id = s.workspaceId;
		this.description = `${s.resourceKind} - ${s.provider ?? "?"}/${s.region ?? "?"}`;
		this.tooltip = `workspace ${s.workspaceId}\nproject ${s.projectId}\n${s.connected ? "connected" : "disconnected"}`;
		this.iconPath = new vscode.ThemeIcon(s.connected ? "vm-active" : "vm-outline");
		this.contextValue = s.connected ? "capix-session-connected" : "capix-session";
		this.command = {
			command: "capix.workspace.connect",
			title: "Attach",
			arguments: [this],
		};
	}
}

class PortNode extends vscode.TreeItem {
	readonly port: ForwardedPort;
	readonly session: WorkspaceSession;
	constructor(p: ForwardedPort, session: WorkspaceSession) {
		super(`:${p.localPort}`, vscode.TreeItemCollapsibleState.None);
		this.port = p;
		this.session = session;
		this.id = `${session.workspaceId}:${p.localPort}`;
		this.description = p.previewHost;
		this.tooltip = `port ${p.localPort} -> ${p.previewHost}\n${p.open ? "open" : "opening…"}\ncreated ${new Date(p.createdAt).toLocaleTimeString()}`;
		this.iconPath = new vscode.ThemeIcon(p.open ? "globe" : "loading");
		this.contextValue = "capix-port";
		this.command = {
			command: "capix.workspace.openPreview",
			title: "Open Preview",
			arguments: [this],
		};
	}
}

class PlaceholderNode extends vscode.TreeItem {
	constructor(label: string) {
		super(label, vscode.TreeItemCollapsibleState.None);
		this.iconPath = new vscode.ThemeIcon("info");
	}
}
