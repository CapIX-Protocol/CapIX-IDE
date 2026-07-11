/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-workspace/ipc - typed IPC contract for the capix-workspace built-in
 *  extension: remote workspace attach, port forwarding and private preview
 *  (architecture S10.3, S11.6; target ownership: extensions/capix-workspace/).
 *
 *  Connection model: the IDE makes an outbound connection to the Capix tunnel
 *  gateway; the workspace agent makes an outbound connection; the gateway
 *  multiplexes logical streams (control | filesystem | file-watch | pty | task |
 *  logs | port | preview | agent-runtime). No raw provider SSH key or management
 *  credential crosses this boundary for managed IDE access.
 *
 *  This module consumes the main-process broker through typed IPC. It never issues
 *  a raw fetch, never receives the mTLS workload identity or the one-use session
 *  ticket, and never constructs a shell-built SSH command. The session ticket lives
 *  only in the main-process broker.
 *--------------------------------------------------------------------------------------------*/

/** Observable connection state for a workspace session. Mirrors the core view model. */
export interface WorkspaceConnectionState {
	state: "disconnected" | "connecting" | "connected" | "reconnecting" | "failed";
	workspaceId?: string;
	projectId?: string;
	/** `capix-remote+<workspaceId>` authority string, resolved by the broker. */
	authority?: string;
	lastError?: string;
	/** Broker-side sequence/cursor used for resumable reconnect. */
	lastSequence?: number;
}

/** A forwarded workspace port over the encrypted mTLS tunnel. */
export interface ForwardedPort {
	/** Workspace-local listening port. */
	localPort: number;
	/** Opaque TLS preview hostname under preview.capix.network (no raw provider IP/port). */
	previewHost: string;
	/** True once the broker confirms the forward is live on the workspace side. */
	open: boolean;
	createdAt: number;
}

/** A workspace session surfaced in the Sessions tree. */
export interface WorkspaceSession {
	workspaceId: string;
	name: string;
	projectId: string;
	resourceKind: "dedicated-gpu" | "private-llm" | "cpu-vps";
	provider?: string;
	region?: string;
	connected: boolean;
	forwardedPorts: ForwardedPort[];
}

/**
 * Channel names for the main <-> workspace-extension bridge. These mirror the
 * core `capix-remote` bridge: `connect` opens a workspace session and resolves the
 * `capix-remote+<workspaceId>` authority; `getChannel` acquires an opaque,
 * unforgeable multiplexed channel handle (filesystem / terminal / portForwarder).
 */
export const CapixWorkspaceChannels = {
	/** List workspace sessions owned by the current account/project. */
	listSessions: "capix:workspace:listSessions",
	/** workspace.openSession over the broker; resolves authority + one-use ticket. */
	connect: "capix:remote:connect",
	/** Reconnect after sleep/network restart without creating a new billable resource. */
	reconnect: "capix:remote:reconnect",
	/** Disconnect and revoke the session ticket (does NOT destroy the workspace). */
	disconnect: "capix:remote:disconnect",
	/** Acquire an opaque multiplexed channel (filesystem | terminal | portForwarder). */
	getChannel: "capix:remote:getChannel",
	/** workspace.openPort: forward a workspace port through the tunnel. */
	forwardPort: "capix:workspace:forwardPort",
	/** Close a forwarded port and revoke its preview hostname. */
	closePort: "capix:workspace:closePort",
	/** Open the preview URL for a forwarded port in the system browser. */
	openPreview: "capix:workspace:openPreview",
	/** Main -> renderer: connection state changed (no secrets). */
	onStateChanged: "capix:remote:onStateChanged",
} as const;

export type CapixWorkspaceChannelName =
	| (typeof CapixWorkspaceChannels)[keyof typeof CapixWorkspaceChannels];

/** Typed request/response pairs for every workspace bridge operation. */
export interface CapixWorkspaceIpcContract {
	[CapixWorkspaceChannels.listSessions]: {
		request: { projectId?: string };
		response: { sessions: WorkspaceSession[] };
	};
	[CapixWorkspaceChannels.connect]: {
		request: { workspaceId: string; projectId: string };
		response: WorkspaceConnectionState;
	};
	[CapixWorkspaceChannels.reconnect]: {
		request: void;
		response: WorkspaceConnectionState;
	};
	[CapixWorkspaceChannels.disconnect]: {
		request: void;
		response: void;
	};
	[CapixWorkspaceChannels.getChannel]: {
		request: { channel: "filesystem" | "terminal" | "portForwarder" };
		/** Opaque handle; an untrusted host cannot cast it into a privileged transport. */
		response: unknown;
	};
	[CapixWorkspaceChannels.forwardPort]: {
		request: { workspaceId: string; port: number; /** Optional friendly label. */ label?: string };
		response: ForwardedPort;
	};
	[CapixWorkspaceChannels.closePort]: {
		request: { workspaceId: string; localPort: number };
		response: void;
	};
	[CapixWorkspaceChannels.openPreview]: {
		request: { workspaceId: string; localPort: number };
		response: { url: string };
	};
	[CapixWorkspaceChannels.onStateChanged]: {
		request: WorkspaceConnectionState;
		response: void;
	};
}
