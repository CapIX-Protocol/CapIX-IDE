/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-workspace/broker - typed broker client for the capix-workspace extension.
 *
 *  Wraps `vscode.commands.executeCommand` against the registered Capix bridge
 *  channels (mirroring the core `capix-remote` bridge). The extension host is
 *  unprivileged: it receives only observable state and opaque channel handles, never
 *  the one-use session ticket, the mTLS workload identity or a raw SSH command.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import { CapixWorkspaceChannels } from "./ipc.js";
import type { CapixWorkspaceIpcContract, WorkspaceConnectionState } from "./ipc.js";

type Request<C extends keyof CapixWorkspaceIpcContract> = CapixWorkspaceIpcContract[C]["request"];
type Response<C extends keyof CapixWorkspaceIpcContract> = CapixWorkspaceIpcContract[C]["response"];

/** A typed Capix error; never a raw fetch or transport rejection. */
export class CapixWorkspaceError extends Error {
	constructor(
		public readonly capixCode: string,
		message: string,
		public readonly supportId?: string,
	) {
		super(message);
		this.name = "CapixWorkspaceError";
	}
}

export class CapixWorkspaceAuthError extends CapixWorkspaceError {
	constructor(supportId?: string) {
		super("401", "Not signed in to Capix.", supportId);
		this.name = "CapixWorkspaceAuthError";
	}
}

/**
 * State-change subscription handle. `onStateChanged` events fan out from the broker;
 * the extension registers the listener once and re-renders on every state event.
 */
export interface ConnectionStateSubscription {
	readonly state: WorkspaceConnectionState;
	dispose(): void;
}

export class CapixWorkspaceBroker {
	/** Invoke one typed broker operation through the IDE IPC bridge. */
	async call<C extends keyof CapixWorkspaceIpcContract>(
		channel: C,
		request: Request<C>,
	): Promise<Response<C>> {
		try {
			return (await vscode.commands.executeCommand(channel as string, request)) as Response<C>;
		} catch (err) {
			throw this.mapError(err);
		}
	}

	listSessions(projectId?: string): Promise<{
		sessions: CapixWorkspaceIpcContract[typeof CapixWorkspaceChannels.listSessions]["response"]["sessions"];
	}> {
		return this.call(CapixWorkspaceChannels.listSessions, { projectId });
	}

	/** Open a workspace session and resolve the `capix-remote+<workspaceId>` authority. */
	connect(workspaceId: string, projectId: string): Promise<WorkspaceConnectionState> {
		return this.call(CapixWorkspaceChannels.connect, { workspaceId, projectId });
	}

	reconnect(): Promise<WorkspaceConnectionState> {
		return this.call(CapixWorkspaceChannels.reconnect, undefined as never);
	}

	disconnect(): Promise<void> {
		return this.call(CapixWorkspaceChannels.disconnect, undefined as never);
	}

	/**
	 * Acquire an opaque multiplexed channel handle. Always typed `unknown` so an
	 * untrusted host cannot cast it into a privileged transport surface.
	 */
	getChannel(channel: "filesystem" | "terminal" | "portForwarder"): Promise<unknown> {
		return this.call(CapixWorkspaceChannels.getChannel, { channel });
	}

	forwardPort(workspaceId: string, port: number, label?: string): Promise<
		CapixWorkspaceIpcContract[typeof CapixWorkspaceChannels.forwardPort]["response"]
	> {
		return this.call(CapixWorkspaceChannels.forwardPort, { workspaceId, port, label });
	}

	closePort(workspaceId: string, localPort: number): Promise<void> {
		return this.call(CapixWorkspaceChannels.closePort, { workspaceId, localPort });
	}

	/** Resolve the opaque TLS preview URL for a forwarded port. */
	openPreview(workspaceId: string, localPort: number): Promise<{ url: string }> {
		return this.call(CapixWorkspaceChannels.openPreview, { workspaceId, localPort });
	}

	/**
	 * Subscribe to connection state changes. The broker fans out safe (secret-free)
	 * state; reconnect after sleep/network restart uses sequence numbers + a cursor
	 * and never creates a new billable resource.
	 */
	onStateChanged(handler: (state: WorkspaceConnectionState) => void): ConnectionStateSubscription {
		const disposable = vscode.commands.registerCommand(
			CapixWorkspaceChannels.onStateChanged as string,
			(state: WorkspaceConnectionState) => {
				try {
					handler(state);
				} catch {
					// best-effort: never let a renderer handler error the bridge
				}
			},
		);
		let last: WorkspaceConnectionState = { state: "disconnected" };
		return {
			get state() {
				return last;
			},
			dispose: () => disposable.dispose(),
		};
	}

	// --- helpers -------------------------------------------------------------

	private mapError(err: unknown): Error {
		if (err instanceof CapixWorkspaceError) return err;
		const e = err as { code?: string; capixCode?: string; message?: string; supportId?: string };
		const code = e?.capixCode ?? e?.code ?? "unknown";
		const message = e?.message ?? "Capix broker operation failed.";
		if (code === "401") return new CapixWorkspaceAuthError(e?.supportId);
		return new CapixWorkspaceError(String(code), message, e?.supportId);
	}
}
