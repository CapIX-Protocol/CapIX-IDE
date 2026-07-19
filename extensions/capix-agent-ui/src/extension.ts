/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-agent-ui/extension - chat view, agent sessions and tool approval for the
 *  standalone IDE.
 *
 *  Registers the Sessions tree view (capix.agent.sessions), the chat webview
 *  (capix.agent.chat) and the commands: open chat, start/resume session, select
 *  model, send message, cancel stream, approve/deny tool. Every action goes through
 *  the typed main-process broker (capix:chat:* and capix:agent:* channels) backed by
 *  the bundled Capix Agent Runtime; the extension never issues raw model HTTP and
 *  never receives the hosted vLLM key (architecture S11.5; target ownership:
 *  extensions/capix-agent-ui/).
 *
 *  Approval prompts are NOT a sandbox: every deferred tool call shows the exact
 *  executable/args/cwd/env-delta/network/timeout/side-effect before confirmation;
 *  tool policy itself is enforced by the broker. Disconnect fails pending
 *  permissions closed (any in-flight prompt is treated as denied).
 *
 *  This is an internal module of one CapixIDE release, not a marketplace extension.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import {
	CapixAgentBroker,
	CapixAgentAuthError,
	CapixAgentError,
	type AgentStreamSubscription,
} from "./broker.js";
import type {
	AgentSession,
	AgentStreamEvent,
	AgentCatalogEntry,
	ToolApprovalRequest,
} from "./ipc.js";

let broker: CapixAgentBroker;
let sessionsProvider: SessionsTreeProvider;
let chatProvider: ChatViewProvider;
let toolApprovalHandler: vscode.Disposable | null = null;

export function activate(context: vscode.ExtensionContext): void {
	broker = new CapixAgentBroker();
	const launchUiEnabled = true;
	if (!launchUiEnabled) return;
	sessionsProvider = new SessionsTreeProvider(broker);
	chatProvider = new ChatViewProvider(broker, context.extensionUri);

	const sessionsView = vscode.window.createTreeView("capix.agent.sessions", {
		treeDataProvider: sessionsProvider,
		showCollapseAll: false,
	});

	context.subscriptions.push(
		sessionsView,
		vscode.window.registerWebviewViewProvider("capix.agent.chat", chatProvider),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("capix.agent.refreshSessions", () =>
			sessionsProvider.refresh(),
		),
		vscode.commands.registerCommand("capix.agent.openChat", () => chatProvider.show()),
		vscode.commands.registerCommand("capix.agent.startSession", () => startSession()),
		vscode.commands.registerCommand("capix.agent.resumeSession", (node?: SessionNode) =>
			resumeSession(node),
		),
		vscode.commands.registerCommand("capix.agent.selectModel", () => selectModel()),
		vscode.commands.registerCommand("capix.agent.cancel", () => chatProvider.cancel()),
		vscode.commands.registerCommand("capix.agent.listSessions", () => sessionsProvider.refresh()),
		vscode.commands.registerCommand("capix.agent.refreshAuth", async () => {
			await sessionsProvider.refresh();
			await chatProvider.init(true);
		}),
	);

	// Deferred tool approvals fan out from the broker; approve/deny is human-confirmed.
	toolApprovalHandler = broker.onToolApproval((req) => {
		void promptToolApproval(broker, chatProvider, req);
	});
	context.subscriptions.push(toolApprovalHandler);

	void sessionsProvider.refresh();
	void chatProvider.init();
}

export function deactivate(): void {
	toolApprovalHandler?.dispose();
	toolApprovalHandler = null;
}

// --- flows ------------------------------------------------------------------

async function startSession(): Promise<void> {
	try {
		const model = await pickModel();
		if (!model) return;
		const projectId = await resolveProjectId();
		if (!projectId) return;
		const session = await broker.startSession(model.id, projectId);
		chatProvider.setSession(session);
		chatProvider.show();
		await sessionsProvider.refresh();
		vscode.window.showInformationMessage(`Capix: started agent session (${session.id}).`);
	} catch (err) {
		handleError(err, "Start session failed");
	}
}

async function resumeSession(node?: SessionNode): Promise<void> {
	const sessionId = node?.session?.id ?? (await pickSessionId());
	if (!sessionId) return;
	try {
		const session = await broker.resumeSession(sessionId);
		chatProvider.setSession(session);
		chatProvider.show();
	} catch (err) {
		handleError(err, "Resume session failed");
	}
}

async function selectModel(): Promise<void> {
	const model = await pickModel();
	if (!model) return;
	chatProvider.setSelectedModel(model.id);
	vscode.window.showInformationMessage(`Capix: model set to ${model.name}.`);
}

async function promptToolApproval(
	broker: CapixAgentBroker,
	chat: ChatViewProvider,
	req: ToolApprovalRequest,
): Promise<void> {
	const lines: string[] = [`Tool: ${req.tool}`];
	if (req.executable) lines.push(`Executable: ${req.executable}`);
	if (req.args?.length) lines.push(`Args: ${req.args.join(" ")}`);
	if (req.cwd) lines.push(`Cwd: ${req.cwd}`);
	if (req.network) lines.push("Network: ALLOWED");
	if (req.timeoutMs) lines.push(`Timeout: ${req.timeoutMs}ms`);
	if (req.sideEffect) lines.push(`Side effect: ${req.sideEffect}`);
	if (req.envDelta) {
		const delta = Object.entries(req.envDelta).map(([k, v]) => `${k}=${v}`);
		lines.push(`Env delta:\n  ${delta.join("\n  ")}`);
	}
	if (req.billable) {
		const n = Number(req.billable.costMinor);
		const cost = Number.isFinite(n) ? `${(n / 100).toFixed(2)} ${req.billable.currency}` : req.billable.costMinor;
		lines.push(`Billable: ${req.billable.description} - ${cost}`);
	}

	chat.appendSystem(`Tool approval requested: ${req.tool} (${req.approvalId})\n${lines.join("\n")}`);

	const choice = await vscode.window.showWarningMessage(
		`Capix: approve tool "${req.tool}"?`,
		{ modal: true, detail: lines.join("\n") },
		"Approve",
		"Deny",
	);
	try {
		if (choice === "Approve") {
			await broker.approveTool(req.approvalId);
			chat.appendSystem(`Tool approved: ${req.tool}`);
		} else {
			await broker.denyTool(req.approvalId);
			chat.appendSystem(`Tool denied: ${req.tool}`);
		}
	} catch (err) {
		handleError(err, "Tool approval failed");
	}
}

// --- pickers ----------------------------------------------------------------

async function pickModel(): Promise<AgentCatalogEntry | undefined> {
	let models: AgentCatalogEntry[] = [];
	try {
		models = (await broker.listModels()).models;
	} catch (err) {
		handleError(err, "Load model catalog failed");
		return undefined;
	}
	if (models.length === 0) {
		vscode.window.showInformationMessage("Capix: no models available.");
		return undefined;
	}
	const items = models.map((m) => ({
		label: m.name,
		description: m.privacy ?? "",
		detail: `${m.region ?? "?"} - ${m.available ? "available" : "unavailable"}`,
		model: m,
		picked: m.id === chatProvider.selectedModel,
	}));
	const choice = await vscode.window.showQuickPick(items, {
		placeHolder: "Select model",
		canPickMany: false,
	});
	return choice?.model;
}

async function pickSessionId(): Promise<string | undefined> {
	await sessionsProvider.refresh();
	const items = sessionsProvider.all.map((s) => ({
		label: s.modelId,
		description: `${s.messages.length} msgs`,
		detail: s.id,
		sessionId: s.id,
	}));
	const choice = await vscode.window.showQuickPick(items, { placeHolder: "Select session to resume" });
	return choice?.sessionId;
}

/** Resolve the active project id from the auth broker state (no secret). */
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
	if (err instanceof CapixAgentAuthError) {
		vscode.window
			.showErrorMessage(`${title}: ${err.message}`, "Sign in")
			.then((c) => {
				if (c === "Sign in") void vscode.commands.executeCommand("capix.onboarding.start");
			});
		return;
	}
	if (isNotImplemented(err)) {
		vscode.window.showInformationMessage(
			`${title}: Capix agent runtime is not available yet. Sessions and chat will be enabled in a future update.`,
		);
		return;
	}
	if (isServiceUnavailable(err)) {
		vscode.window.showWarningMessage(
			`${title}: Capix service is temporarily unavailable. Please try again shortly.`,
		);
		return;
	}
	const e = err as CapixAgentError;
	const sid = e?.supportId ? ` (support: ${e.supportId})` : "";
	vscode.window.showErrorMessage(`${title}: ${e?.message ?? String(err)}${sid}`);
}

// --- sessions tree ----------------------------------------------------------

type AgentNode = SessionNode | PlaceholderNode;

class SessionsTreeProvider implements vscode.TreeDataProvider<AgentNode> {
	private readonly emitter = new vscode.EventEmitter<AgentNode | undefined>();
	readonly onDidChangeTreeData = this.emitter.event;
	all: AgentSession[] = [];
	private placeholderLabel = "No agent sessions. Start one from the chat view.";

	constructor(private readonly broker: CapixAgentBroker) {}

	async refresh(): Promise<void> {
		try {
			const res = await this.broker.listSessions();
			this.all = res.sessions;
			this.placeholderLabel = "No agent sessions. Start one from the chat view.";
		} catch (err) {
			this.all = [];
			if (err instanceof CapixAgentAuthError) {
				this.placeholderLabel = "Sign in to Capix to view agent sessions.";
			} else if (isServiceUnavailable(err)) {
				this.placeholderLabel = "Service temporarily unavailable.";
			} else if (isNotImplemented(err)) {
				this.placeholderLabel = "Agent sessions unavailable.";
			} else {
				this.placeholderLabel = "Failed to load agent sessions.";
				void vscode.window.showErrorMessage(
					`Capix: failed to list agent sessions (${(err as CapixAgentError).message ?? err})`,
				);
			}
		}
		this.emitter.fire(undefined);
	}

	getTreeItem(element: AgentNode): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: AgentNode): Promise<AgentNode[]> {
		if (element) return [];
		if (this.all.length === 0) {
			return [new PlaceholderNode(this.placeholderLabel)];
		}
		return this.all.map((s) => new SessionNode(s));
	}
}

class SessionNode extends vscode.TreeItem {
	readonly session: AgentSession;
	constructor(s: AgentSession) {
		super(s.modelId, vscode.TreeItemCollapsibleState.None);
		this.session = s;
		this.id = s.id;
		this.description = `${s.messages.length} msgs`;
		this.tooltip = `session ${s.id}\nmodel ${s.modelId}\n${s.costMinor ?? "?"} ${s.currency ?? ""}`;
		this.iconPath = new vscode.ThemeIcon("comment-discussion");
		this.contextValue = "capix-agent-session";
		this.command = {
			command: "capix.agent.resumeSession",
			title: "Resume Session",
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

// --- chat webview -----------------------------------------------------------

class ChatViewProvider implements vscode.WebviewViewProvider {
	public view?: vscode.WebviewView;
	private session?: AgentSession;
	private streamSub: AgentStreamSubscription | null = null;
	private _selectedModel?: string;

	constructor(
		private readonly broker: CapixAgentBroker,
		private readonly extensionUri: vscode.Uri,
	) {}

	get selectedModel(): string | undefined {
		return this._selectedModel;
	}

	setSelectedModel(modelId: string): void {
		this._selectedModel = modelId;
		this.notify({ type: "model", modelId });
	}

	setSession(session: AgentSession): void {
		this.session = session;
		this._selectedModel = session.modelId;
		this.notify({ type: "session", session });
	}

	show(): void {
		if (this.view) {
			this.view.show?.(true);
		} else {
			// The canonical Capix Code chat lives in the capix-llm panel.
			void vscode.commands.executeCommand("capix.code.chat.focus");
		}
	}

	async init(force = false): Promise<void> {
		if (this.session && !force) return;
		try {
			const models = (await this.broker.listModels()).models.filter((model) => model.available);
			const routed = models.find((model) => model.id === "auto" || model.id === "capix/auto" || model.id === "capix-routed") ?? models[0];
			if (!routed) return;
			this.setSelectedModel(routed.id);
			const projectId = await resolveProjectId();
			if (!projectId) return;
			const session = await this.broker.startSession(routed.id, projectId);
			this.setSession(session);
			await sessionsProvider.refresh();
		} catch (err) {
			if (force) handleError(err, "Initialize Capix chat failed");
			else if (isNotImplemented(err)) this.appendSystem("Capix agent runtime is not available yet. Start session will be enabled in a future update.");
			else if (isServiceUnavailable(err)) this.appendSystem("Capix service is temporarily unavailable.");
		}
	}

	async cancel(): Promise<void> {
		if (this.session) {
			try {
				await this.broker.cancel(this.session.id);
				this.appendSystem("Stream cancelled (partial-delivery rule applied).");
			} catch (err) {
				handleError(err, "Cancel stream failed");
			}
		}
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri],
		};
		view.webview.html = this.html(view.webview);
		view.webview.onDidReceiveMessage((msg) => void this.onMessage(msg));
		if (this.session) this.notify({ type: "session", session: this.session });
		if (this._selectedModel) this.notify({ type: "model", modelId: this._selectedModel });
		void this.init();
	}

	/** Append a system-level message to the chat log (also used by approval prompts). */
	appendSystem(text: string): void {
		this.notify({ type: "system", text });
	}

	private async onMessage(msg: unknown): Promise<void> {
		const m = msg as { kind?: string; text?: string };
		if (m?.kind !== "send" || !m.text) return;
		const userText = m.text;
		this.notify({ type: "user", text: userText });
		if (!this.session) {
			this.appendSystem("No active session. Start one first (Capix: Start Session).");
			return;
		}
		try {
			const { streamHandle } = await this.broker.streamMessage(this.session.id, userText);
			this.streamSub?.dispose();
			this.streamSub = this.broker.onStreamEvent(streamHandle, (event) => this.onStreamEvent(event));
		} catch (err) {
			handleError(err, "Send message failed");
		}
	}

	private onStreamEvent(event: AgentStreamEvent): void {
		switch (event.type) {
			case "delta":
				if (event.content) this.notify({ type: "delta", content: event.content });
				if (event.toolCalls) this.notify({ type: "toolCalls", toolCalls: event.toolCalls });
				break;
			case "route":
				this.notify({
					type: "route",
					receiptId: event.receiptId,
					model: event.model,
					region: event.region,
					privacy: event.privacy,
				});
				break;
			case "usage":
				this.notify({
					type: "usage",
					inputTokens: event.inputTokens,
					outputTokens: event.outputTokens,
					costMinor: event.costMinor,
					currency: event.currency,
				});
				break;
			case "final":
				this.notify({ type: "final", finishReason: event.finishReason, receiptId: event.receiptId });
				this.streamSub?.dispose();
				this.streamSub = null;
				void sessionsProvider.refresh();
				break;
			case "error":
				this.notify({ type: "error", message: event.message, capixCode: event.capixCode });
				this.streamSub?.dispose();
				this.streamSub = null;
				break;
		}
	}

	private notify(msg: unknown): void {
		void this.view?.webview.postMessage(msg);
	}

	private html(webview: vscode.Webview): string {
		const nonce = getNonce();
		const csp = `default-src 'none'; script-src 'nonce-${nonce}' 'unsafe-inline'; style-src 'unsafe-inline'`;
		return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { font-family: var(--vscode-font-family, sans-serif); margin: 0; padding: 8px; color: var(--vscode-foreground); }
  header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 2px 10px; border-bottom: 1px solid var(--vscode-widget-border); }
  header strong { font-size: 13px; letter-spacing: .02em; }
  #model { color: var(--vscode-descriptionForeground); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #log { white-space: pre-wrap; word-break: break-word; font-size: 13px; }
  .role-user { color: var(--vscode-textLink-foreground); }
  .role-assistant { color: var(--vscode-foreground); }
  .role-system, .role-tool { color: var(--vscode-descriptionForeground); font-style: italic; }
  .route, .usage { color: var(--vscode-charts-purple); font-size: 11px; }
  .error { color: var(--vscode-errorForeground); }
  .row { display: flex; gap: 6px; margin-top: 8px; }
  input { flex: 1; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; cursor: pointer; }
</style></head>
<body>
<header><strong>Capix Code</strong><span id="model">Smart Router · connecting</span></header>
<div id="log"></div>
<div class="row">
  <input id="text" placeholder="Ask Capix Code to build, debug, or explain…" />
  <button id="send">Run</button>
</div>
<script nonce="${nonce}">
const log = document.getElementById('log');
const input = document.getElementById('text');
const modelEl = document.getElementById('model');
let currentAssistant = null;
document.getElementById('send').onclick = send;
input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
function send() {
  const text = input.value.trim(); if (!text) return;
  input.value = '';
  const vscode = acquireVsCodeApi();
  vscode.postMessage({ kind: 'send', text });
}
window.addEventListener('message', e => {
  const m = e.data; if (!m || !m.type) return;
  switch (m.type) {
    case 'model': modelEl.textContent = 'model: ' + m.modelId; break;
    case 'session': modelEl.textContent = 'session: ' + m.session.id + ' / ' + m.session.modelId; break;
    case 'user': append('user', m.text); currentAssistant = null; break;
    case 'system': append('system', m.text); break;
    case 'delta':
      if (!currentAssistant) currentAssistant = append('assistant', m.content || '');
      else currentAssistant.textContent += m.content || '';
      break;
    case 'route': append('route', 'route: ' + m.model + ' (' + (m.region||'?') + (m.privacy ? ', ' + m.privacy : '') + ') receipt=' + m.receiptId); break;
    case 'usage': append('usage', 'usage: in=' + m.inputTokens + ' out=' + m.outputTokens + ' cost=' + m.costMinor + ' ' + (m.currency||'')); break;
    case 'final': append('route', 'final: ' + m.finishReason + ' receipt=' + m.receiptId); break;
    case 'error': append('error', 'error: ' + m.message + (m.capixCode ? ' [' + m.capixCode + ']' : '')); currentAssistant = null; break;
    case 'toolCalls': append('tool', 'tool calls: ' + JSON.stringify(m.toolCalls)); break;
  }
});
function append(role, text) {
  const d = document.createElement('div');
  d.className = 'role-' + role;
  d.textContent = '<' + role + '> ' + text;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  return d;
}
</script>
</body></html>`;
	}
}

function getNonce(): string {
	let text = "";
	const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	for (let i = 0; i < 16; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
	return text;
}
