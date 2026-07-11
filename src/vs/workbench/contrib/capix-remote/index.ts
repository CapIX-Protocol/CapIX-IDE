/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-remote — barrel export + IPC registration contract for main↔renderer remote
 *  connection communication.
 *
 *  The renderer drives connection lifecycle through typed IPC. It never receives the
 *  session ticket, the mTLS workload identity, the provider management key or a raw
 *  tunnel master secret; those live only in the main-process broker
 *  (architecture §10.3, §11.2; master prompt I6).
 *--------------------------------------------------------------------------------------------*/

export type {
	CapixRemoteAuthority,
	RemoteConnectionState,
} from "./remoteAuthority.js";
export { CapixRemoteService } from "./remoteAuthority.js";

/**
 * Channel names for the main↔renderer remote bridge. UI extensions remain local while
 * workspace/language extensions run in the remote extension host; only state and channel
 * handles cross the boundary.
 */
export const CapixRemoteChannels = {
	/** Renderer → main: open a workspace session and resolve the remote authority. */
	connect: "capix:remote:connect",
	/** Renderer → main: reconnect after sleep/network restart. */
	reconnect: "capix:remote:reconnect",
	/** Renderer → main: disconnect and revoke the session ticket. */
	disconnect: "capix:remote:disconnect",
	/** Renderer → main: acquire a multiplexed channel handle. */
	getChannel: "capix:remote:getChannel",
	/** Main → renderer: connection state changed. */
	onStateChanged: "capix:remote:onStateChanged",
} as const;

export type CapixRemoteChannelName =
	| (typeof CapixRemoteChannels)[keyof typeof CapixRemoteChannels];

/**
 * Typed IPC registration contract. Channel handles (`unknown`) are opaque so an
 * untrusted host cannot cast them into a privileged transport.
 */
export interface CapixRemoteIpcContract {
	[CapixRemoteChannels.connect]: {
		request: { workspaceId: string; projectId: string };
		response: import("./remoteAuthority.js").RemoteConnectionState;
	};
	[CapixRemoteChannels.reconnect]: {
		request: void;
		response: import("./remoteAuthority.js").RemoteConnectionState;
	};
	[CapixRemoteChannels.disconnect]: {
		request: void;
		response: void;
	};
	[CapixRemoteChannels.getChannel]: {
		request: { channel: "filesystem" | "terminal" | "portForwarder" };
		response: unknown;
	};
	[CapixRemoteChannels.onStateChanged]: {
		request: import("./remoteAuthority.js").RemoteConnectionState;
		response: void;
	};
}
