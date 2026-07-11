/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-server/protocol - Capix remote server handshake and attach protocol types.
 *
 *  This is the Capix-owned matching Code-OSS remote server (architecture S11.6):
 *
 *    "The remote authority uses Capix's own matching Code-OSS `capix-server`, not
 *     an assumed Microsoft Remote-SSH dependency. UI extensions remain local;
 *     workspace/language extensions run in the remote extension host. The server is
 *     installed/updated by the signed workspace agent and must match the desktop
 *     compatibility manifest."
 *
 *  Attach model: the IDE makes an outbound connection to the Capix tunnel gateway;
 *  the workspace agent (running this `capix-server`) also makes an outbound connection;
 *  the gateway multiplexes logical streams over one mTLS tunnel using sequence numbers
 *  and a resumable cursor. The server never holds the customer's refresh token,
 *  device key, wallet bearer or a provider management credential - those live only
 *  in the IDE main-process broker and the OS credential store.
 *
 *  The handshake is versioned: IDE, Code/runtime, engine/plugin, local protocol, API
 *  schema and release manifest versions are exchanged and validated before any
 *  channel multiplexing begins. An incompatible server triggers controlled recovery,
 *  not a silent break (architecture S11.5, S11.6).
 *--------------------------------------------------------------------------------------------*/

/**
 * The Capix remote protocol scheme. `capix-remote+<workspaceId>` is the Code-OSS
 * remote authority string resolved by the IDE main-process broker.
 */
export const CAPIX_REMOTE_SCHEME = "capix-remote";

/**
 * Protocol versions exchanged in the handshake. The server validates every field
 * against its pinned release manifest and rejects (with {@link HandshakeRejectReason})
 * on any mismatch; an old or tampered server is never silently downgraded.
 */
export interface ProtocolVersions {
	/** Standalone CapixIDE release (product.json / release-manifest id). */
	ide: string;
	/** Bundled Capix Code launcher + runtime version. */
	codeRuntime: string;
	/** Bundled OpenCode engine + Capix plugin ABI version. */
	enginePlugin: string;
	/** This local attach protocol version. */
	localProtocol: string;
	/** Control API schema id (OpenAPI/event hash range). */
	apiSchema: string;
	/** Immutable release manifest id the server was installed/updated against. */
	releaseManifest: string;
}

/** Current local-attach protocol version this server speaks. */
export const LOCAL_PROTOCOL_VERSION = "1.0.0";

/** Multiplexed logical channels over the single mTLS tunnel. */
export type ChannelKind =
	| "control"
	| "filesystem"
	| "file-watch"
	| "pty"
	| "task"
	| "logs"
	| "port"
	| "preview"
	| "agent-runtime";

/**
 * The handshake frame sent by the IDE (over the tunnel gateway) to attach. Carries
 * only version metadata and the one-use session ticket scope - never a long-lived
 * credential. The server validates the ticket against the control plane before
 * opening any channel.
 */
export interface AttachHandshake {
	versions: ProtocolVersions;
	/** `capix-remote+<workspaceId>` authority the IDE resolved. */
	authority: string;
	workspaceId: string;
	projectId: string;
	/**
	 * Capability tokens scoped to actor/project/workspace/channels, issued by the
	 * IDE broker. The server never persists these and revokes them on disconnect.
	 */
	capabilities: AttachCapabilities;
	/** Cursor for resumable reconnect (sequence-based, never a new resource). */
	resumeCursor?: string;
}

/** Channel-scoped capabilities the IDE hands the server for this attach session. */
export interface AttachCapabilities {
	/** Channels the IDE may open on this server. */
	channels: readonly ChannelKind[];
	/** Filesystem root the server may expose (canonicalized, rooted). */
	canonicalRoot: string;
	/** Whether the IDE may request an agent-runtime channel. */
	allowAgentRuntime: boolean;
}

/** Reason the server rejected the handshake (typed, audited; never a silent drop). */
export type HandshakeRejectReason =
	| "version-mismatch"
	| "release-manifest-mismatch"
	| "capability-revoked"
	| "workspace-not-trusted"
	| "api-schema-incompatible"
	| "incompatible-server";

/** Handshake accept; the server is ready to multiplex channels. */
export interface HandshakeAccept {
	ok: true;
	serverVersions: ProtocolVersions;
	/** Server-assigned attach session id (correlates logs/audit/support). */
	sessionId: string;
}

/** Handshake reject; the IDE shows controlled recovery, never a silent break. */
export interface HandshakeReject {
	ok: false;
	reason: HandshakeRejectReason;
	message: string;
	/** Support id the IDE surfaces alongside the operation/support record. */
	supportId?: string;
}

export type HandshakeResult = HandshakeAccept | HandshakeReject;

/**
 * A framed message on one multiplexed channel. Channel handles the IDE receives are
 * opaque `unknown`; the server side dispatches by {@link channel} + {@link seq}.
 */
export interface ChannelFrame {
	/** Logical stream this frame belongs to. */
	channel: ChannelKind;
	/** Monotonic sequence number; used for resumable reconnect after drop. */
	seq: number;
	/** Optional resume cursor piggy-backed for control frames. */
	cursor?: string;
	/** Opaque payload; typed per-channel at the extension-host boundary. */
	payload: unknown;
}

/** Control-channel commands the IDE sends to manage the attach session. */
export type ControlCommand =
	| { kind: "ping" }
	| { kind: "openChannel"; channel: ChannelKind }
	| { kind: "closeChannel"; channel: ChannelKind }
	| { kind: "drain" }
	| { kind: "detach" };

/** Control-channel responses the server sends back. */
export type ControlResponse =
	| { kind: "pong"; serverTime: number }
	| { kind: "channelOpened"; channel: ChannelKind }
	| { kind: "channelClosed"; channel: ChannelKind; reason?: string }
	| { kind: "drained" }
	| { kind: "detached" };

/**
 * Validate that two {@link ProtocolVersions} sets are compatible under the release
 * manifest. This is a precise check: a mismatch is an explicit failed outcome,
 * never a silent downgrade (architecture S11.6, S11.7).
 */
export function assertVersionsCompatible(
	client: ProtocolVersions,
	server: ProtocolVersions,
): HandshakeReject | null {
	if (client.localProtocol !== server.localProtocol) {
		return {
			ok: false,
			reason: "version-mismatch",
			message: `local protocol ${client.localProtocol} != server ${server.localProtocol}`,
		};
	}
	if (client.releaseManifest !== server.releaseManifest) {
		return {
			ok: false,
			reason: "release-manifest-mismatch",
			message: `release manifest ${client.releaseManifest} != server ${server.releaseManifest}`,
		};
	}
	if (client.apiSchema !== server.apiSchema) {
		return {
			ok: false,
			reason: "api-schema-incompatible",
			message: `api schema ${client.apiSchema} != server ${server.apiSchema}`,
		};
	}
	return null;
}
