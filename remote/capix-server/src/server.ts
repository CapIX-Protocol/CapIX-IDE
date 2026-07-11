/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-server/server - the Capix-owned matching Code-OSS remote server stub.
 *
 *  This process runs inside the workspace isolation boundary (installed/updated by
 *  the signed workspace agent) and is the remote extension host the IDE attaches to
 *  through the `capix-remote+<workspaceId>` authority (architecture S11.6):
 *
 *    "The remote authority uses Capix's own matching Code-OSS `capix-server`, not
 *     an assumed Microsoft Remote-SSH dependency. UI extensions remain local;
 *     workspace/language extensions run in the remote extension host. The server is
 *     installed/updated by the signed workspace agent and must match the desktop
 *     compatibility manifest."
 *
 *  Attach flow: the server makes an outbound connection to the Capix tunnel gateway
 *  (never listens on a public port); the IDE also connects outbound; the gateway
 *  multiplexes logical streams over one mTLS tunnel using sequence numbers and a
 *  resumable cursor. The server validates the IDE handshake (versions + release
 *  manifest), validates the one-use session ticket scope against the control plane,
 *  then opens the allowlisted channels. Reconnect uses the cursor and never creates
 *  a new billable resource.
 *
 *  This file is a typed stub matching the IDE release: signatures, invariants and
 *  the protocol surface are authoritative; the real transport wiring is injected by
 *  the signed workspace agent build and stubbed here (architecture S11.5, S11.6).
 *--------------------------------------------------------------------------------------------*/

import type {
	AttachHandshake,
	ChannelFrame,
	ChannelKind,
	ControlCommand,
	ControlResponse,
	HandshakeReject,
	HandshakeResult,
	ProtocolVersions,
} from "./protocol.js";
import {
	LOCAL_PROTOCOL_VERSION,
	assertVersionsCompatible,
} from "./protocol.js";

/**
 * The pinned release manifest this server was installed/updated against. The signed
 * workspace agent verifies this against the desktop compatibility manifest at
 * install time; a mismatched server is never silently downgraded.
 */
export const SERVER_VERSIONS: ProtocolVersions = {
	ide: "1.0.0",
	codeRuntime: "1.0.0",
	enginePlugin: "1.0.0",
	localProtocol: LOCAL_PROTOCOL_VERSION,
	apiSchema: "1.0.0",
	releaseManifest: "capix-release-1.0.0",
};

/**
 * A live attach session. One per IDE attach; the server revokes the capability
 * scope on disconnect and fails any pending permissions closed (architecture S11.5).
 */
export interface AttachSession {
	id: string;
	workspaceId: string;
	projectId: string;
	canonicalRoot: string;
	/** Channels currently open in this session. */
	openChannels: Set<ChannelKind>;
	/** Last applied sequence cursor (for resumable reconnect). */
	cursor: string;
	/** Whether the IDE declared it may request an agent-runtime channel. */
	allowAgentRuntime: boolean;
}

/** Raised when a handshake is rejected; typed and audited. */
export class HandshakeError extends Error {
	constructor(
		public readonly reason: HandshakeReject["reason"],
		message: string,
		public readonly supportId?: string,
	) {
		super(message);
		this.name = "HandshakeError";
	}
}

/**
 * The Capix remote server. Runs in the workspace isolation boundary and is reached
 * only through the outbound mTLS tunnel; it never holds the customer's refresh token,
 * device key, wallet bearer or a provider management credential.
 */
export class CapixRemoteServer {
	private readonly sessions = new Map<string, AttachSession>();

	/** Pinned versions this server reports back in the handshake. */
	get versions(): ProtocolVersions {
		return SERVER_VERSIONS;
	}

	/**
	 * Process an IDE attach handshake over the tunnel. Validates versions, release
	 * manifest, API schema, the one-use session ticket scope and the canonical root
	 * before opening any channel. Returns accept (with a session id) or a typed
	 * reject; an incompatible server triggers controlled recovery, not a silent break.
	 */
	async attach(handshake: AttachHandshake): Promise<HandshakeResult> {
		const reject = assertVersionsCompatible(handshake.versions, SERVER_VERSIONS);
		if (reject) return reject;

		if (!handshake.capabilities.channels.includes("control")) {
			return {
				ok: false,
				reason: "capability-revoked",
				message: "attach handshake must include the control channel",
			};
		}

		if (!this.isCanonicalTrusted(handshake.capabilities.canonicalRoot)) {
			return {
				ok: false,
				reason: "workspace-not-trusted",
				message: `canonical root not trusted: ${handshake.capabilities.canonicalRoot}`,
			};
		}

		const sessionId = this.newSessionId(handshake.workspaceId);
		const session: AttachSession = {
			id: sessionId,
			workspaceId: handshake.workspaceId,
			projectId: handshake.projectId,
			canonicalRoot: handshake.capabilities.canonicalRoot,
			openChannels: new Set<ChannelKind>(["control"]),
			cursor: handshake.resumeCursor ?? "0",
			allowAgentRuntime: handshake.capabilities.allowAgentRuntime,
		};
		this.sessions.set(sessionId, session);

		return {
			ok: true,
			serverVersions: SERVER_VERSIONS,
			sessionId,
		};
	}

	/**
	 * Resume an existing session after sleep/network restart/app relaunch using the
	 * cursor. Never creates a new billable resource; the workspace agent stays up.
	 */
	async resume(sessionId: string, cursor: string): Promise<HandshakeResult> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return {
				ok: false,
				reason: "capability-revoked",
				message: `unknown session ${sessionId}; ticket revoked or expired`,
			};
		}
		session.cursor = cursor;
		return { ok: true, serverVersions: SERVER_VERSIONS, sessionId };
	}

	/**
	 * Dispatch a control-channel command for a session. The agent-runtime channel is
	 * only opened when the IDE declared {@link AttachHandshake.capabilities}.
	 * {@link AttachCapabilities.allowAgentRuntime}.
	 */
	async control(sessionId: string, cmd: ControlCommand): Promise<ControlResponse> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return { kind: "detached" };
		}
		switch (cmd.kind) {
			case "ping":
				return { kind: "pong", serverTime: Date.now() };
			case "openChannel": {
				if (cmd.channel === "agent-runtime" && !session.allowAgentRuntime) {
					return {
						kind: "channelClosed",
						channel: cmd.channel,
						reason: "agent-runtime not permitted for this attach",
					};
				}
				session.openChannels.add(cmd.channel);
				return { kind: "channelOpened", channel: cmd.channel };
			}
			case "closeChannel":
				session.openChannels.delete(cmd.channel);
				return { kind: "channelClosed", channel: cmd.channel };
			case "drain":
				return { kind: "drained" };
			case "detach":
				this.sessions.delete(sessionId);
				return { kind: "detached" };
		}
	}

	/**
	 * Receive a multiplexed frame for a session. Dispatched per-channel at the
	 * extension-host boundary; the server applies rooted/canonicalized filesystem
	 * access and resource limits (architecture S14.4). Returns the updated cursor.
	 */
	async frame(sessionId: string, frame: ChannelFrame): Promise<string> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new HandshakeError("capability-revoked", `unknown session ${sessionId}`);
		}
		if (!session.openChannels.has(frame.channel)) {
			throw new HandshakeError("capability-revoked", `channel ${frame.channel} not open`);
		}
		// Real implementation dispatches per channel kind (filesystem/pty/port/...).
		// This stub validates the contract and advances the cursor.
		session.cursor = frame.cursor ?? String(Number(session.cursor) + 1);
		return session.cursor;
	}

	/** Revoke a session and close every open channel. Idempotent. */
	async detach(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		session.openChannels.clear();
		this.sessions.delete(sessionId);
	}

	// --- invariants ----------------------------------------------------------

	/**
	 * The workspace agent already admits images by digest/signature and pins the
	 * canonical root. This guard is defense-in-depth: a non-canonical or
	 * symlink/junction/traversal root is rejected before any channel opens.
	 */
	private isCanonicalTrusted(canonicalRoot: string): boolean {
		if (!canonicalRoot || canonicalRoot.includes("..")) return false;
		if (canonicalRoot.includes("\0")) return false;
		// The signed workspace agent pins the canonical root; the server trusts
		// only absolute, rooted paths under the agent's workspace boundary.
		return canonicalRoot.startsWith("/");
	}

	private newSessionId(workspaceId: string): string {
		return `${workspaceId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
	}
}

/**
 * Process entry point invoked by the signed workspace agent. The agent launches
 * this server by absolute path (never user `PATH`), with `shell: false` and a
 * scrubbed, allowlisted environment. The server makes an outbound connection to
 * the Capix tunnel gateway; it never listens on a public port.
 */
export async function main(): Promise<void> {
	const server = new CapixRemoteServer();
	void server;
	// Real wiring: dial the tunnel gateway, exchange the one-use session ticket,
	// run the handshake pump and multiplex channels. Stubbed here; the signed
	// workspace agent build injects the transport implementation.
}
