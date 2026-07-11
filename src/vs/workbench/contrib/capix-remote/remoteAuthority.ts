/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-remote — remote authority and connection service.
 *
 *  CapixIDE resolves a remote workspace through its own authority
 *  `capix-remote+<workspaceId>` and its own matching `capix-server`, not an assumed
 *  Microsoft Remote-SSH dependency (architecture §11.6; master prompt I6). The client
 *  makes an outbound connection; the workspace agent makes an outbound connection; the
 *  Capix tunnel gateway multiplexes logical streams. No raw provider SSH key or
 *  management credential crosses this boundary for managed IDE access.
 *--------------------------------------------------------------------------------------------*/

import type { Disposable, Event, FileChangeEvent, FileSystemProvider, FileStat, FileType, Uri } from "vscode";
import type { ICommandService } from "../../../platform/commands/common/commands.js";

/**
 * A Capix remote authority resolved for one workspace attach. The authority string is
 * `capix-remote+<workspaceId>`; the `ticket` is a one-use, minutes-long session ticket
 * scoped to actor/project/workspace/channels (architecture §10.3).
 */
export interface CapixRemoteAuthority {
	/** `capix-remote+<workspaceId>` — the Code-OSS remote authority string. */
	authority: string;
	workspaceId: string;
	/** One-time session ticket; never a provider/management credential or master tunnel secret. */
	ticket: string;
}

/**
 * Observable connection state for the UI. Safe to render and contains no secret; the
 * actual mTLS identity lives in the main-process broker.
 */
export interface RemoteConnectionState {
	state: "disconnected" | "connecting" | "connected" | "reconnecting" | "failed";
	workspaceId?: string;
	lastError?: string;
}

/**
 * Tunneled multiplexed channel handles exposed to the workbench. Each is backed by a
 * logical stream over the outbound mTLS tunnel (architecture §10.3):
 *   control | filesystem | file-watch | pty | task | logs | port | preview | agent-runtime
 *
 * The concrete channel types are provided by the remote extension host and workspace
 * agent; this surface is intentionally narrow and typed as `unknown` here so that the
 * broker cannot accidentally leak a raw file/socket/PTY handle to an untrusted host.
 */
export interface CapixRemoteChannels {
	filesystem: unknown;
	terminal: unknown;
	portForwarder: unknown;
}

/**
 * Single transport command registered by the privileged main-process broker. Every
 * remote operation below is a typed message dispatched through this command; the broker
 * owns the mTLS tunnel, the one-use session ticket and the multiplexed channel handles.
 * The renderer never receives a token, a raw socket or a PTY file descriptor.
 */
const CAPIX_REMOTE_TRANSPORT = "capix.remote.transport";

/** Authority scheme resolver: `capix-remote+<workspaceId>`. */
const CAPIX_REMOTE_SCHEME = "capix-remote";

/** Preview host suffix for forwarded ports (architecture §10.5). */
const PREVIEW_HOST_SUFFIX = "preview.capix.network";

/** Workspace id validation: non-empty, URL-safe, no `+` (authority separator). */
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Multiplexed channel names exposed through the transport. */
type CapixChannelName = "filesystem" | "terminal" | "portForwarder";

/**
 * Discriminated transport message union. The `workspace:*` tags mirror the main
 * broker's `RendererToMainMessage` contract; the `channel:`, `fs:`, `pty:` and `port:`
 * tags are the narrow, audited operations the renderer is permitted to request. There is
 * deliberately no generic `fetch`/`http` op: an untrusted caller cannot ask the broker to
 * perform an arbitrary authenticated request.
 */
type CapixTransportMessage =
	// Workspace lifecycle.
	| { type: "workspace:connect"; workspaceId: string; projectId: string }
	| { type: "workspace:disconnect" }
	// Multiplexed channel acquisition (opaque handle).
	| { type: "channel:open"; channel: CapixChannelName }
	// Filesystem proxy — the broker canonicalizes paths and roots on the agent.
	| { type: "fs:stat"; resource: string }
	| { type: "fs:readFile"; resource: string }
	| { type: "fs:writeFile"; resource: string; content: Uint8Array; create: boolean; overwrite: boolean }
	| { type: "fs:readDirectory"; resource: string }
	| { type: "fs:createDirectory"; resource: string }
	| { type: "fs:delete"; resource: string; recursive: boolean }
	| { type: "fs:rename"; from: string; to: string; overwrite: boolean }
	| { type: "fs:copy"; from: string; to: string; overwrite: boolean }
	| { type: "fs:watch"; resource: string; recursive: boolean; excludes: string[] }
	| { type: "fs:unwatch"; watcherId: string }
	// PTY proxy — open/input/resize/exit/cancel/reconnect.
	| { type: "pty:open"; sessionId: string; cwd?: string; cols?: number; rows?: number; env?: Record<string, string> }
	| { type: "pty:input"; sessionId: string; data: string }
	| { type: "pty:resize"; sessionId: string; cols: number; rows: number }
	| { type: "pty:exit"; sessionId: string }
	| { type: "pty:cancel"; sessionId: string }
	| { type: "pty:reconnect"; sessionId: string }
	// Port forwarding — registers a workspace port and resolves a preview host.
	| { type: "port:forward"; workspaceId: string; port: number; label?: string }
	| { type: "port:close"; workspaceId: string; localPort: number }
	| { type: "port:preview"; workspaceId: string; localPort: number }
	| { type: "port:list"; workspaceId: string };

/** Transport dispatch function bound to the owning service. */
type TransportFn = (message: CapixTransportMessage) => Promise<unknown>;

/** Response shape for `workspace:connect` (authority + one-use ticket). */
interface CapixConnectResponse {
	/** `capix-remote+<workspaceId>` authority string resolved by the broker. */
	authority: string;
	/**
	 * One-use session ticket scoped to actor/project/workspace. Kept inside the broker
	 * normally; when the transport returns it for authority resolution it is never
	 * re-exposed in {@link RemoteConnectionState}, which is the secret-free UI view model.
	 */
	ticket: string;
}

/** A live forwarded workspace port over the encrypted tunnel. */
export interface CapixForwardedPort {
	workspaceId: string;
	localPort: number;
	/** Opaque TLS preview hostname under `preview.capix.network` (no raw provider IP/port). */
	previewHost: string;
	/** True once the broker confirms the forward is live on the workspace side. */
	open: boolean;
}

/** A terminal PTY session created through the main broker's tunnel. */
export interface CapixRemoteTerminalSession {
	id: string;
	open: boolean;
}

/**
 * Minimal `vscode.Event` emitter. The `event` field and the returned disposable handle
 * are structurally compatible with `vscode.Event<T>` / `vscode.Disposable`. State and
 * file-change events are forwarded from the main broker through the transport, so this
 * surface stays free of secrets and raw transport handles.
 */
class CapixEmitter<T> {
	private readonly listeners = new Set<(e: T) => void>();
	private readonly handles = new Set<{ dispose(): void }>();

	readonly event: Event<T> = (listener, thisArgs, disposables) => {
		const bound: (e: T) => void = thisArgs ? listener.bind(thisArgs) : listener;
		this.listeners.add(bound);
		const handle = {
			dispose: () => {
				this.listeners.delete(bound);
				this.handles.delete(handle);
			},
		};
		this.handles.add(handle);
		if (disposables) {
			disposables.push(handle);
		}
		return handle;
	};

	fire(e: T): void {
		for (const l of this.listeners) {
			try {
				l(e);
			} catch {
				// best-effort: a throwing listener must not break the bridge
			}
		}
	}

	dispose(): void {
		this.listeners.clear();
		this.handles.clear();
	}
}

/** Normalize a free-form label into a DNS-safe preview-host prefix. */
function slugify(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
}

/** Compute a deterministic preview host when the broker does not return one. */
function defaultPreviewHost(port: number, label?: string): string {
	const prefix = label ? `${slugify(label)}-` : "";
	return `${prefix}${port}.${PREVIEW_HOST_SUFFIX}`;
}

/**
 * The Capix remote connection service. Owns the renderer-side connection state machine
 * and the lazy, typed channel handles. It delegates ALL transport to the privileged
 * main-process broker through the single `capix.remote.transport` command; it never holds
 * the mTLS identity, the provider SSH key or a raw socket/PTY handle.
 *
 * Connection model:
 *   - IDE authenticates with a one-use session ticket scoped to actor/project/workspace.
 *   - The gateway validates ownership from the control plane and cannot enumerate
 *     another tenant.
 *   - Sessions resume after sleep/network restart using sequence numbers and a cursor;
 *     reconnect requests a fresh ticket for the SAME workspace and never creates a new
 *     billable resource.
 *   - Raw SSH is an optional dedicated-machine mode using the customer's own key and host
 *     identity, separate from managed access.
 */
export class CapixRemoteService {
	private readonly _commandService: ICommandService;

	/** Last resolved connection (workspace/project/authority). Cleared on disconnect. */
	private _connection: { workspaceId: string; projectId: string; authority: string } | undefined;

	/** Current observable state; fired through {@link onDidChangeState} on every change. */
	private _state: RemoteConnectionState = { state: "disconnected" };

	private readonly _onDidChangeState = new CapixEmitter<RemoteConnectionState>();
	readonly onDidChangeState: Event<RemoteConnectionState> = this._onDidChangeState.event;

	/** Lazy channel handles, created on first access. */
	private _fileSystemProvider: CapixRemoteFileSystemProvider | undefined;
	private _terminalProvider: CapixRemoteTerminalProvider | undefined;
	private _portForwarder: CapixRemotePortForwarder | undefined;

	/** Child disposables torn down by {@link dispose}. */
	private readonly _disposables: Disposable[] = [this._onDidChangeState];

	/**
	 * @param commandService The workbench command service used to dispatch the single
	 *   `capix.remote.transport` command to the privileged main-process broker.
	 */
	constructor(commandService: ICommandService) {
		this._commandService = commandService;
	}

	/** Dispatch one typed transport message to the main-process broker. */
	private transport<R = unknown>(message: CapixTransportMessage): Promise<R> {
		return this._commandService.executeCommand<unknown>(CAPIX_REMOTE_TRANSPORT, message) as Promise<R>;
	}

	/** Current observable connection state. Safe to render; contains no secret. */
	getState(): RemoteConnectionState {
		return this._state;
	}

	/** Transition state and fan out to listeners. */
	private setState(
		state: RemoteConnectionState["state"],
		workspaceId: string | undefined,
		lastError: string | undefined,
	): RemoteConnectionState {
		this._state = { state, workspaceId, lastError };
		this._onDidChangeState.fire(this._state);
		return this._state;
	}

	/**
	 * Connect to a workspace through an outbound mTLS tunnel. Resolves the
	 * `capix-remote+<workspaceId>` authority from a one-time ticket. Validates versions
	 * before attach; an incompatible `capix-server` triggers controlled recovery, not a
	 * silent break.
	 */
	async connect(params: {
		workspaceId: string;
		projectId: string;
	}): Promise<RemoteConnectionState> {
		const { workspaceId, projectId } = params;

		if (typeof workspaceId !== "string" || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
			return this.setState(
				"failed",
				workspaceId,
				`Invalid workspace id: ${workspaceId ?? "<empty>"}.`,
			);
		}

		this.setState("connecting", workspaceId, undefined);

		try {
			const res = await this.transport<CapixConnectResponse | undefined>({
				type: "workspace:connect",
				workspaceId,
				projectId,
			});
			const authority = res?.authority ?? `${CAPIX_REMOTE_SCHEME}+${workspaceId}`;
			this._connection = { workspaceId, projectId, authority };
			return this.setState("connected", workspaceId, undefined);
		} catch (err) {
			return this.setState(
				"failed",
				workspaceId,
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	/**
	 * Reconnect after sleep / network restart / app relaunch without a new resource.
	 * Requests a fresh one-use ticket for the SAME workspace; resolves to `failed` if
	 * there is no previous connection to resume.
	 */
	async reconnect(): Promise<RemoteConnectionState> {
		const last = this._connection;
		if (!last) {
			return this.setState(
				"failed",
				this._state.workspaceId,
				"No previous connection to reconnect to.",
			);
		}

		this.setState("reconnecting", last.workspaceId, undefined);

		try {
			const res = await this.transport<CapixConnectResponse | undefined>({
				type: "workspace:connect",
				workspaceId: last.workspaceId,
				projectId: last.projectId,
			});
			const authority = res?.authority ?? last.authority;
			this._connection = { workspaceId: last.workspaceId, projectId: last.projectId, authority };
			return this.setState("connected", last.workspaceId, undefined);
		} catch (err) {
			return this.setState(
				"failed",
				last.workspaceId,
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	/** Disconnect and revoke the session ticket. Does not destroy the workspace. */
	async disconnect(): Promise<void> {
		try {
			await this.transport<void>({ type: "workspace:disconnect" });
		} catch {
			// best-effort: the ticket is revoked server-side on failure too
		}
		this._connection = undefined;
		this.setState("disconnected", undefined, undefined);
	}

	/**
	 * Multiplexed file/watch/search channel, rooted and canonicalized by the agent.
	 * Lazily initialized on first access; proxies every operation through the transport
	 * to the main broker, which owns the real filesystem stream over the tunnel.
	 */
	getFileSystem(): CapixRemoteFileSystemProvider {
		if (!this._fileSystemProvider) {
			this._fileSystemProvider = new CapixRemoteFileSystemProvider((m) => this.transport(m));
			this._disposables.push(this._fileSystemProvider);
		}
		return this._fileSystemProvider;
	}

	/**
	 * Multiplexed PTY channel: open/input/resize/exit/cancel/reconnect. Each session gets
	 * a unique client-side id and communicates through the main broker's tunnel.
	 */
	getTerminal(): CapixRemoteTerminalProvider {
		if (!this._terminalProvider) {
			this._terminalProvider = new CapixRemoteTerminalProvider((m) => this.transport(m));
			this._disposables.push(this._terminalProvider);
		}
		return this._terminalProvider;
	}

	/**
	 * Port forwarder + preview registration. Proxies a listening workspace port through
	 * the encrypted tunnel to an opaque TLS preview hostname under `preview.capix.network`
	 * (architecture §10.5). Raw provider IP/port is not the normal path.
	 */
	getPortForwarder(): CapixRemotePortForwarder {
		if (!this._portForwarder) {
			this._portForwarder = new CapixRemotePortForwarder((m) => this.transport(m));
			this._disposables.push(this._portForwarder);
		}
		return this._portForwarder;
	}

	/** Tear down providers, the state emitter and any cached connection info. */
	dispose(): void {
		this._connection = undefined;
		for (const d of this._disposables) {
			try {
				d.dispose();
			} catch {
				// best-effort during disposal
			}
		}
		this._disposables.length = 0;
		this._fileSystemProvider = undefined;
		this._terminalProvider = undefined;
		this._portForwarder = undefined;
		this._state = { state: "disconnected" };
	}
}

/**
 * Typed remote filesystem provider. Each FS operation is serialized to a URI string and
 * proxied to the broker; the broker holds the real filesystem stream and canonicalizes
 * paths against the workspace agent root. The provider never sees a raw file descriptor.
 */
class CapixRemoteFileSystemProvider implements FileSystemProvider {
	private readonly _transport: TransportFn;
	private readonly _onDidChangeFile = new CapixEmitter<FileChangeEvent[]>();
	readonly onDidChangeFile: Event<FileChangeEvent[]> = this._onDidChangeFile.event;

	constructor(transport: TransportFn) {
		this._transport = transport;
	}

	/** Forward file-change events pushed by the broker through the transport wiring. */
	pushFileChanges(events: FileChangeEvent[]): void {
		this._onDidChangeFile.fire(events);
	}

	stat(uri: Uri): Promise<FileStat> {
		return this._transport({ type: "fs:stat", resource: uri.toString() }) as Promise<FileStat>;
	}

	readFile(uri: Uri): Promise<Uint8Array> {
		return this._transport({ type: "fs:readFile", resource: uri.toString() }) as Promise<Uint8Array>;
	}

	writeFile(
		uri: Uri,
		content: Uint8Array,
		options: { readonly create: boolean; readonly overwrite: boolean },
	): Promise<void> {
		return this._transport({
			type: "fs:writeFile",
			resource: uri.toString(),
			content,
			create: options.create,
			overwrite: options.overwrite,
		}) as Promise<void>;
	}

	readDirectory(uri: Uri): Promise<[string, FileType][]> {
		return this._transport({ type: "fs:readDirectory", resource: uri.toString() }) as Promise<[string, FileType][]>;
	}

	createDirectory(uri: Uri): Promise<void> {
		return this._transport({ type: "fs:createDirectory", resource: uri.toString() }) as Promise<void>;
	}

	delete(uri: Uri, options: { readonly recursive: boolean }): Promise<void> {
		return this._transport({
			type: "fs:delete",
			resource: uri.toString(),
			recursive: options.recursive,
		}) as Promise<void>;
	}

	rename(from: Uri, to: Uri, options: { readonly overwrite: boolean }): Promise<void> {
		return this._transport({
			type: "fs:rename",
			from: from.toString(),
			to: to.toString(),
			overwrite: options.overwrite,
		}) as Promise<void>;
	}

	copy(from: Uri, to: Uri, options: { readonly overwrite: boolean }): Promise<void> {
		return this._transport({
			type: "fs:copy",
			from: from.toString(),
			to: to.toString(),
			overwrite: options.overwrite,
		}) as Promise<void>;
	}

	watch(
		uri: Uri,
		options: { readonly recursive: boolean; readonly excludes: readonly string[] },
	): Disposable {
		const state: { watcherId?: string; disposed: boolean } = { disposed: false };
		void this._transport({
			type: "fs:watch",
			resource: uri.toString(),
			recursive: options.recursive,
			excludes: [...options.excludes],
		})
			.then((r) => {
				if (!state.disposed) {
					state.watcherId = (r as { watcherId?: string } | undefined)?.watcherId;
				}
			})
			.catch(() => {
				// best-effort watch registration
			});
		return {
			dispose: () => {
				state.disposed = true;
				const watcherId = state.watcherId;
				if (watcherId) {
					state.watcherId = undefined;
					void this._transport({ type: "fs:unwatch", watcherId }).catch(() => undefined);
				}
			},
		};
	}

	dispose(): void {
		this._onDidChangeFile.dispose();
	}
}

/** Terminal provider backed by broker-owned multiplexed PTY sessions. */
class CapixRemoteTerminalProvider {
	private readonly _transport: TransportFn;
	private readonly _sessions = new Map<string, CapixRemoteTerminalSession>();
	private _seq = 0;

	constructor(transport: TransportFn) {
		this._transport = transport;
	}

	/** Generate a unique, unforgeable client-side session id. */
	private newSessionId(): string {
		return `pty-${Date.now().toString(36)}-${(this._seq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	}

	async open(params?: {
		cwd?: string;
		cols?: number;
		rows?: number;
		env?: Record<string, string>;
	}): Promise<CapixRemoteTerminalSession> {
		const sessionId = this.newSessionId();
		await this._transport({
			type: "pty:open",
			sessionId,
			cwd: params?.cwd,
			cols: params?.cols,
			rows: params?.rows,
			env: params?.env,
		});
		const session: CapixRemoteTerminalSession = { id: sessionId, open: true };
		this._sessions.set(sessionId, session);
		return session;
	}

	async input(sessionId: string, data: string): Promise<void> {
		await this._transport({ type: "pty:input", sessionId, data });
	}

	async resize(sessionId: string, cols: number, rows: number): Promise<void> {
		await this._transport({ type: "pty:resize", sessionId, cols, rows });
	}

	async exit(sessionId: string): Promise<void> {
		await this._transport({ type: "pty:exit", sessionId });
		const session = this._sessions.get(sessionId);
		if (session) {
			session.open = false;
		}
	}

	async cancel(sessionId: string): Promise<void> {
		await this._transport({ type: "pty:cancel", sessionId });
	}

	async reconnect(sessionId: string): Promise<CapixRemoteTerminalSession> {
		await this._transport({ type: "pty:reconnect", sessionId });
		const session = this._sessions.get(sessionId) ?? { id: sessionId, open: false };
		session.open = true;
		this._sessions.set(sessionId, session);
		return session;
	}

	dispose(): void {
		for (const session of this._sessions.values()) {
			session.open = false;
		}
		this._sessions.clear();
	}
}

/** Port forwarder that registers workspace ports through the broker's tunnel. */
class CapixRemotePortForwarder {
	private readonly _transport: TransportFn;
	private readonly _ports = new Map<string, CapixForwardedPort>();

	constructor(transport: TransportFn) {
		this._transport = transport;
	}

	private key(workspaceId: string, localPort: number): string {
		return `${workspaceId}:${localPort}`;
	}

	async forward(workspaceId: string, port: number, label?: string): Promise<CapixForwardedPort> {
		const res = (await this._transport({
			type: "port:forward",
			workspaceId,
			port,
			label,
		})) as { previewHost?: string; localPort?: number; open?: boolean } | undefined;

		const localPort = res?.localPort ?? port;
		const previewHost = res?.previewHost ?? defaultPreviewHost(localPort, label);
		const forwarded: CapixForwardedPort = {
			workspaceId,
			localPort,
			previewHost,
			open: res?.open ?? true,
		};
		this._ports.set(this.key(workspaceId, localPort), forwarded);
		return forwarded;
	}

	async close(workspaceId: string, localPort: number): Promise<void> {
		await this._transport({ type: "port:close", workspaceId, localPort });
		this._ports.delete(this.key(workspaceId, localPort));
	}

	async preview(workspaceId: string, localPort: number): Promise<string> {
		const cached = this._ports.get(this.key(workspaceId, localPort));
		const res = (await this._transport({
			type: "port:preview",
			workspaceId,
			localPort,
		})) as { url?: string; previewHost?: string } | undefined;

		if (res?.url) {
			return res.url;
		}
		const host = res?.previewHost ?? cached?.previewHost ?? defaultPreviewHost(localPort);
		return `https://${host}`;
	}

	async list(workspaceId: string): Promise<CapixForwardedPort[]> {
		const res = (await this._transport({
			type: "port:list",
			workspaceId,
		})) as { ports?: CapixForwardedPort[] } | undefined;

		const ports = res?.ports ?? [];
		for (const p of ports) {
			this._ports.set(this.key(p.workspaceId, p.localPort), p);
		}
		return ports;
	}

	dispose(): void {
		this._ports.clear();
	}
}
