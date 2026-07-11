/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-agent-ui/broker - typed broker client for the capix-agent-ui extension.
 *
 *  Wraps `vscode.commands.executeCommand` against the registered Capix bridge
 *  channels (mirrors the core `capix-ai` chat bridge). The extension host is
 *  unprivileged: the broker owns the generated-SDK inference call, the route
 *  receipt correlation, the usage/cost attribution and the AbortSignal lifecycle.
 *  The runtime never receives long-lived credentials (architecture S11.5).
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import { CapixAgentChannels } from "./ipc.js";
import type {
	CapixAgentIpcContract,
	AgentStreamEvent,
	ToolApprovalRequest,
} from "./ipc.js";

type Request<C extends keyof CapixAgentIpcContract> = CapixAgentIpcContract[C]["request"];
type Response<C extends keyof CapixAgentIpcContract> = CapixAgentIpcContract[C]["response"];

/** A typed Capix error; never a raw fetch rejection or a leaked provider credential. */
export class CapixAgentError extends Error {
	constructor(
		public readonly capixCode: string,
		message: string,
		public readonly supportId?: string,
	) {
		super(message);
		this.name = "CapixAgentError";
	}
}

export class CapixAgentAuthError extends CapixAgentError {
	constructor(supportId?: string) {
		super("401", "Not signed in to Capix.", supportId);
		this.name = "CapixAgentAuthError";
	}
}

/** A live stream subscription; dispose to stop receiving events (cancel is separate). */
export interface AgentStreamSubscription {
	dispose(): void;
}

export class CapixAgentBroker {
	/** Invoke one typed broker operation through the IDE IPC bridge. */
	async call<C extends keyof CapixAgentIpcContract>(
		channel: C,
		request: Request<C>,
	): Promise<Response<C>> {
		try {
			return (await vscode.commands.executeCommand(channel as string, request)) as Response<C>;
		} catch (err) {
			throw this.mapError(err);
		}
	}

	startSession(modelId: string, projectId: string): Promise<
		CapixAgentIpcContract[typeof CapixAgentChannels.startSession]["response"]
	> {
		return this.call(CapixAgentChannels.startSession, { modelId, projectId });
	}

	/** Begin streaming a user message; returns an opaque stream handle. */
	streamMessage(sessionId: string, message: string): Promise<{ streamHandle: string }> {
		return this.call(CapixAgentChannels.streamMessage, { sessionId, message });
	}

	/** Subscribe to streamed chunks for a handle. Cancel finalizes the partial-delivery rule. */
	onStreamEvent(
		streamHandle: string,
		handler: (event: AgentStreamEvent) => void,
	): AgentStreamSubscription {
		const disposable = vscode.commands.registerCommand(
			CapixAgentChannels.onStreamEvent as string,
			(req: { streamHandle: string; event: AgentStreamEvent }) => {
				if (req?.streamHandle !== streamHandle) return;
				try {
					handler(req.event);
				} catch {
					// best-effort: never let a renderer handler error the bridge
				}
			},
		);
		return { dispose: () => disposable.dispose() };
	}

	cancel(sessionId: string): Promise<void> {
		return this.call(CapixAgentChannels.cancel, { sessionId });
	}

	listModels(): Promise<{
		models: CapixAgentIpcContract[typeof CapixAgentChannels.listModels]["response"]["models"];
	}> {
		return this.call(CapixAgentChannels.listModels, undefined as never);
	}

	listSessions(projectId?: string): Promise<{
		sessions: CapixAgentIpcContract[typeof CapixAgentChannels.listSessions]["response"]["sessions"];
	}> {
		return this.call(CapixAgentChannels.listSessions, { projectId });
	}

	resumeSession(sessionId: string): Promise<
		CapixAgentIpcContract[typeof CapixAgentChannels.resumeSession]["response"]
	> {
		return this.call(CapixAgentChannels.resumeSession, { sessionId });
	}

	/** Subscribe to deferred tool approval requests from the runtime. */
	onToolApproval(handler: (req: ToolApprovalRequest) => void): vscode.Disposable {
		return vscode.commands.registerCommand(
			CapixAgentChannels.onToolApproval as string,
			(req: ToolApprovalRequest) => {
				try {
					handler(req);
				} catch {
					// best-effort
				}
			},
		);
	}

	approveTool(approvalId: string): Promise<void> {
		return this.call(CapixAgentChannels.approveTool, { approvalId });
	}

	/** Deny a deferred tool call. Disconnect fails pending permissions closed (denied). */
	denyTool(approvalId: string): Promise<void> {
		return this.call(CapixAgentChannels.denyTool, { approvalId });
	}

	// --- helpers -------------------------------------------------------------

	private mapError(err: unknown): Error {
		if (err instanceof CapixAgentError) return err;
		const e = err as { code?: string; capixCode?: string; message?: string; supportId?: string };
		const code = e?.capixCode ?? e?.code ?? "unknown";
		const message = e?.message ?? "Capix broker operation failed.";
		if (code === "401") return new CapixAgentAuthError(e?.supportId);
		return new CapixAgentError(String(code), message, e?.supportId);
	}
}
