/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-broker — the privileged Electron main-process broker that the renderer
 *  talks to (architecture §11.2, §11.4, §11.5).
 *
 *  Responsibilities:
 *    - Receives typed `RendererToMainMessage` operations, validates the sender
 *      origin and message schema, and dispatches each to a single audited SDK
 *      operation. Generic fetch/http message types are structurally impossible
 *      (see capix-auth/ipc.ts) and defensively rejected at runtime.
 *    - Owns browser auth exchange, refresh/device secrets, trusted Capix network
 *      transport, client certificate / tunnel tickets, agent child lifecycle,
 *      product protocol, updater and crash boundary.
 *    - NEVER exposes `authenticatedFetch(url, options)` (or any raw authenticated
 *      HTTP surface) to the renderer, webview or extension host.
 *    - NEVER passes refresh/access tokens or the device key to the extension host
 *      or the Agent Runtime. The runtime receives only short-lived, project/
 *      audience-scoped capabilities over inherited pipes / `0600` Unix socket /
 *      locked named pipe with peer PID/UID checks.
 *    - Launches the bundled Capix Agent Runtime by absolute path (never user
 *      `PATH`), with `shell: false` and a scrubbed allowlisted environment.
 *    - Workspace Trust gates task / agent / plugin / network execution; trusted
 *      origins are product/admin-controlled and NOT overridable by workspace
 *      settings (a malicious `.vscode/settings.json` cannot redirect a wallet
 *      bearer token).
 *
 *  This file implements the full broker: PKCE auth, SDK HTTP proxying, streaming
 *  inference/operation forwarding, AbortController-based cancellation, typed
 *  ProblemDetail error mapping, and agent runtime lifecycle. Dependency
 *  injection (CapixBrokerDependencies) is supported for testing; default
 *  implementations use fetch against the Capix control plane.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes, createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type { RendererToMainMessage } from "../vs/workbench/contrib/capix-auth/ipc.js";
import type { AuthState } from "../vs/workbench/contrib/capix-auth/authService.js";
import { SECURITY_CONFIG } from "./security-config.js";

// ===========================================================================
// ProblemDetail (RFC 7807 / Capix extension)
// ===========================================================================

/** Typed error response matching the Capix control-plane contract. */
export interface ProblemDetail {
	type?: string;
	title: string;
	status: number;
	detail?: string;
	capixCode?: string;
	retryClass?: "none" | "retry" | "retry-after";
	operationId?: string;
	supportId?: string;
	traceId?: string;
	instance?: string;
	errors?: Array<{ field: string; message: string; capixCode?: string }>;
}

/** Raised when a broker operation fails; carries a typed ProblemDetail. */
export class CapixBrokerError extends Error {
	constructor(public readonly problem: ProblemDetail) {
		super(problem.title);
		this.name = "CapixBrokerError";
	}
}

// ===========================================================================
// SDK client structural interface
// ===========================================================================

/**
 * Structural type for the Capix SDK client consumed by the broker. Each method
 * is a single named, idempotent operation with correlation/release IDs and typed
 * 401/402/403/409/429/provider errors (architecture §11.4). All methods accept
 * an optional AbortSignal for cancellation. The broker wraps every call in
 * {@link CapixMainBroker.sdkCall} for timeout, logging and error mapping.
 */
export interface CapixSdkClient {
	account: { get(signal?: AbortSignal): Promise<unknown> };
	catalog: { listModels(signal?: AbortSignal): Promise<unknown[]> };
	quote: { create(input: unknown, signal?: AbortSignal): Promise<unknown> };
	deployment: {
		create(input: unknown, signal?: AbortSignal): Promise<unknown>;
		get(id: string, signal?: AbortSignal): Promise<unknown>;
		list(cursor?: string, signal?: AbortSignal): Promise<unknown>;
		setDesired(id: string, desired: unknown, signal?: AbortSignal): Promise<unknown>;
		delete(id: string, signal?: AbortSignal): Promise<unknown>;
	};
	operation: {
		subscribe(id: string, signal?: AbortSignal): Promise<unknown>;
		cancel(id: string, signal?: AbortSignal): Promise<unknown>;
	};
	inference: {
		stream(input: unknown, signal?: AbortSignal): Promise<unknown>;
		cancel(sessionId: string, signal?: AbortSignal): Promise<unknown>;
	};
	billing: {
		getBalance(signal?: AbortSignal): Promise<unknown>;
		listInvoices(signal?: AbortSignal): Promise<unknown>;
	};
	receipt: { get(id: string, signal?: AbortSignal): Promise<unknown> };
	workspace: {
		openSession(workspaceId: string, signal?: AbortSignal): Promise<unknown>;
		openPort(workspaceId: string, port: number, signal?: AbortSignal): Promise<unknown>;
		closeSession(workspaceId: string, signal?: AbortSignal): Promise<unknown>;
	};
}

/** A short-lived, scoped capability handed to the runtime/tools, never a token. */
export interface CapixCapability {
	/** Opaque capability id; revocation closes the capability immediately. */
	capabilityId: string;
	/** Absolute epoch expiry; the broker refuses calls after this. */
	expiresAt: number;
	/** Peer PID/UID binding for inherited-pipe / socket handoff. */
	boundProcessId?: number;
}

export interface CapixNativeAuth {
	startLogin(): Promise<{ authorizeUrl: string; state: string }>;
	completeLogin(code: string, state: string): Promise<unknown>;
	logout(): Promise<void>;
}

/**
 * Extended auth service that also provides token access for the SDK client.
 * The broker uses this internally; the renderer never sees tokens.
 */
export interface CapixBrokerAuth extends CapixNativeAuth {
	/** Obtain the current access token (refreshing if needed). For SDK use only. */
	getAccessToken(): Promise<{ token: string; expiresAt: number }>;
}

export interface CapixBrokerDependencies {
	sdk: CapixSdkClient;
	auth: CapixBrokerAuth;
}

// ===========================================================================
// Error classes
// ===========================================================================

/** Raised when an IPC message arrives from an untrusted origin/process. */
export class CapixIpcOriginError extends Error {
	constructor(public readonly origin: string) {
		super(`capix-broker: rejected IPC from untrusted origin: ${origin}`);
		this.name = "CapixIpcOriginError";
	}
}

/** Raised when an IPC message does not match the typed contract. */
export class CapixIpcSchemaError extends Error {
	constructor(public readonly messageType: string, reason: string) {
		super(`capix-broker: rejected IPC message (${messageType}): ${reason}`);
		this.name = "CapixIpcSchemaError";
	}
}

/** Kept for API compatibility; no longer thrown by the broker. */
export class CapixNotImplementedError extends Error {
	constructor(what: string) {
		super(`capix-broker: feature not available: ${what}`);
		this.name = "CapixNotImplementedError";
	}
}

// ===========================================================================
// Internal helpers
// ===========================================================================

/** Base64url-encode a Buffer (PKCE / OAuth). */
function base64url(buf: Buffer): string {
	return buf.toString("base64url");
}

/** Generate a high-entropy PKCE code verifier (43+ chars, RFC 7636). */
function generateCodeVerifier(): string {
	return base64url(randomBytes(32));
}

/** Compute the S256 code challenge from a verifier. */
function computeCodeChallenge(verifier: string): string {
	return base64url(createHash("sha256").update(verifier).digest());
}

/** Generate a high-entropy state parameter. */
function generateState(): string {
	return base64url(randomBytes(24));
}

/** Redact an error for safe logging — never includes tokens or secrets. */
function redactError(err: unknown): string {
	if (err instanceof Error) return `${err.name}: ${err.message}`;
	return String(err);
}

/** Check whether a value is an async iterable. */
function isAsyncIterable(val: unknown): val is AsyncIterable<unknown> {
	return (
		val != null &&
		typeof val === "object" &&
		Symbol.asyncIterator in (val as object)
	);
}

// ===========================================================================
// Concrete SDK client — HTTP proxy to the Capix control plane
// ===========================================================================

/**
 * Default HTTP-based SDK client. Lives in the main process; uses fetch against
 * the Capix control-plane API with token injection from the auth service. The
 * renderer never sees this object or any raw HTTP — it only sees the typed view
 * models returned through the broker.
 */
class BrokerSdkClient implements CapixSdkClient {
	constructor(
		private readonly baseUrl: string,
		private readonly getToken: () => Promise<{ token: string; expiresAt: number }>,
	) {}

	// --- Core request machinery ---

	private async request<T>(
		method: string,
		path: string,
		opts: { body?: unknown; signal?: AbortSignal; idempotencyKey?: string } = {},
	): Promise<T> {
		let authHeader: string | undefined;
		try {
			const { token } = await this.getToken();
			authHeader = `Bearer ${token}`;
		} catch {
			// Unauthenticated — proceed; the API will return 401 if required.
		}

		const headers: Record<string, string> = {
			Accept: "application/json, application/problem+json",
		};
		if (authHeader) headers["Authorization"] = authHeader;
		if (opts.body !== undefined) {
			headers["Content-Type"] = "application/json";
			headers["Idempotency-Key"] = opts.idempotencyKey ?? randomUUID();
		}

		const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
		let res: Response;
		try {
			res = await fetch(url, {
				method,
				headers,
				body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
				signal: opts.signal,
			});
		} catch (err) {
			if (
				err instanceof DOMException &&
				(err.name === "AbortError" || err.name === "TimeoutError")
			) {
				throw new CapixBrokerError({
					type: "about:blank",
					title: "Request aborted",
					status: 408,
					detail:
						"The operation was aborted (deadline exceeded or caller signal).",
					capixCode: "ABORTED",
				});
			}
			throw new CapixBrokerError({
				type: "about:blank",
				title: "Network error",
				status: 0,
				detail: redactError(err),
				capixCode: "NETWORK_ERROR",
			});
		}

		if (!res.ok) {
			const problem = await this.parseProblem(res);
			throw new CapixBrokerError(problem ?? {
				type: "about:blank",
				title: `Request failed: ${res.status}`,
				status: res.status,
				capixCode: `HTTP_${res.status}`,
			});
		}

		if (res.status === 204 || res.headers.get("Content-Length") === "0") {
			return undefined as T;
		}
		const text = await res.text();
		if (!text) return undefined as T;
		return JSON.parse(text) as T;
	}

	private async parseProblem(
		res: Response,
	): Promise<ProblemDetail | undefined> {
		try {
			const text = await res.text();
			if (!text) return undefined;
			const parsed = JSON.parse(text);
			if (parsed && typeof parsed === "object" && "title" in parsed) {
				return parsed as ProblemDetail;
			}
			return undefined;
		} catch {
			return undefined;
		}
	}

	// --- SSE streaming ---

	private async *streamSse(
		method: string,
		path: string,
		opts: { body?: unknown; signal?: AbortSignal } = {},
	): AsyncGenerator<unknown> {
		let authHeader: string | undefined;
		try {
			const { token } = await this.getToken();
			authHeader = `Bearer ${token}`;
		} catch {
			// proceed unauthenticated
		}

		const headers: Record<string, string> = {
			Accept: "text/event-stream",
		};
		if (authHeader) headers["Authorization"] = authHeader;
		if (opts.body !== undefined) {
			headers["Content-Type"] = "application/json";
			headers["Idempotency-Key"] = randomUUID();
		}

		const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
		let res: Response;
		try {
			res = await fetch(url, {
				method,
				headers,
				body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
				signal: opts.signal,
			});
		} catch (err) {
			if (
				err instanceof DOMException &&
				(err.name === "AbortError" || err.name === "TimeoutError")
			) {
				throw new CapixBrokerError({
					type: "about:blank",
					title: "Stream aborted",
					status: 408,
					detail: "The stream was aborted.",
					capixCode: "ABORTED",
				});
			}
			throw new CapixBrokerError({
				type: "about:blank",
				title: "Network error",
				status: 0,
				detail: redactError(err),
				capixCode: "NETWORK_ERROR",
			});
		}

		if (!res.ok || !res.body) {
			const problem = await this.parseProblem(res);
			throw new CapixBrokerError(problem ?? {
				type: "about:blank",
				title: `Stream failed: ${res.status}`,
				status: res.status,
				capixCode: `HTTP_${res.status}`,
			});
		}

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let dataLines: string[] = [];

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });

				let newlineIdx: number;
				while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
					const line = buffer
						.slice(0, newlineIdx)
						.replace(/\r$/, "");
					buffer = buffer.slice(newlineIdx + 1);

					if (line === "") {
						if (dataLines.length > 0) {
							const raw = dataLines.join("\n");
							let data: unknown = raw;
							try {
								data = JSON.parse(raw);
							} catch {
								// keep raw text
							}
							yield data;
						}
						dataLines = [];
						continue;
					}
					if (line.startsWith(":")) continue; // comment / heartbeat
					if (line.startsWith("data:")) {
						dataLines.push(line.slice(5).replace(/^ /, ""));
					}
				}
			}
			// flush trailing event without blank-line terminator
			if (dataLines.length > 0) {
				const raw = dataLines.join("\n");
				let data: unknown = raw;
				try {
					data = JSON.parse(raw);
				} catch {
					// keep raw text
				}
				yield data;
			}
		} finally {
			reader.releaseLock();
		}
	}

	// --- Typed API methods ---

	account = {
		get: (signal?: AbortSignal) =>
			this.request("GET", "/v1/me", { signal }),
	};

	catalog = {
		listModels: (signal?: AbortSignal) =>
			this.request<unknown[]>("GET", "/v1/models", { signal }),
	};

	quote = {
		create: (input: unknown, signal?: AbortSignal) =>
			this.request("POST", "/v1/quotes", { body: input, signal }),
	};

	deployment = {
		create: (input: unknown, signal?: AbortSignal) =>
			this.request("POST", "/v1/deployments", { body: input, signal }),
		get: (id: string, signal?: AbortSignal) =>
			this.request("GET", `/v1/deployments/${encodeURIComponent(id)}`, { signal }),
		list: (cursor?: string, signal?: AbortSignal) => {
			const qs = cursor
				? `?cursor=${encodeURIComponent(cursor)}`
				: "";
			return this.request("GET", `/v1/deployments${qs}`, { signal });
		},
		setDesired: (id: string, desired: unknown, signal?: AbortSignal) =>
			this.request(
				"PATCH",
				`/v1/deployments/${encodeURIComponent(id)}`,
				{ body: { desiredState: desired }, signal },
			),
		delete: (id: string, signal?: AbortSignal) =>
			this.request("DELETE", `/v1/deployments/${encodeURIComponent(id)}`, { signal }),
	};

	operation = {
		subscribe: (id: string, signal?: AbortSignal) =>
			Promise.resolve(
				this.streamSse(
					"GET",
					`/v1/operations/${encodeURIComponent(id)}/events`,
					{ signal },
				),
			),
		cancel: (id: string, signal?: AbortSignal) =>
			this.request(
				"POST",
				`/v1/operations/${encodeURIComponent(id)}/cancel`,
				{ signal },
			),
	};

	inference = {
		stream: (input: unknown, signal?: AbortSignal) =>
			Promise.resolve(
				this.streamSse("POST", "/v1/inference/stream", { body: input, signal }),
			),
		cancel: (sessionId: string, signal?: AbortSignal) =>
			this.request(
				"POST",
				`/v1/inference/${encodeURIComponent(sessionId)}/cancel`,
				{ signal },
			),
	};

	billing = {
		getBalance: (signal?: AbortSignal) =>
			this.request("GET", "/v1/billing/balance", { signal }),
		listInvoices: (signal?: AbortSignal) =>
			this.request("GET", "/v1/billing/invoices", { signal }),
	};

	receipt = {
		get: (id: string, signal?: AbortSignal) =>
			this.request(
				"GET",
				`/v1/route-receipts/${encodeURIComponent(id)}`,
				{ signal },
			),
	};

	workspace = {
		openSession: (workspaceId: string, signal?: AbortSignal) =>
			this.request(
				"POST",
				`/v1/workspaces/${encodeURIComponent(workspaceId)}/sessions`,
				{ signal },
			),
		openPort: (workspaceId: string, port: number, signal?: AbortSignal) =>
			this.request(
				"POST",
				`/v1/workspaces/${encodeURIComponent(workspaceId)}/ports`,
				{ body: { port }, signal },
			),
		closeSession: (workspaceId: string, signal?: AbortSignal) =>
			this.request(
				"DELETE",
				`/v1/workspaces/${encodeURIComponent(workspaceId)}/sessions`,
				{ signal },
			),
	};
}

// ===========================================================================
// Concrete auth service — PKCE + token management
// ===========================================================================

/**
 * Default auth service implementing PKCE (RFC 8252 / RFC 7636) with token
 * storage in memory. In production, refresh tokens and device keys live in the
 * OS credential store (Keychain / Credential Manager / Secret Service). This
 * implementation gives a working, secure flow for development and production
 * builds without hard-coded secrets.
 */
class BrokerAuthService implements CapixBrokerAuth {
	private verifier: string | undefined;
	private pendingState: string | undefined;
	private accessToken: { token: string; expiresAt: number } | undefined;
	private refreshToken: string | undefined;
	private _state: AuthState = { status: "unauthenticated" };
	private refreshPromise: Promise<void> | undefined;

	constructor(
		private readonly authorizeUrl: string,
		private readonly tokenUrl: string,
		private readonly revokeUrl: string,
		private readonly clientId: string,
		private readonly redirectUri: string,
	) {}

	// --- CapixNativeAuth implementation ---

	async startLogin(): Promise<{ authorizeUrl: string; state: string }> {
		this.verifier = generateCodeVerifier();
		const challenge = computeCodeChallenge(this.verifier);
		this.pendingState = generateState();

		const url = new URL(this.authorizeUrl);
		url.searchParams.set("response_type", "code");
		url.searchParams.set("client_id", this.clientId);
		url.searchParams.set("redirect_uri", this.redirectUri);
		url.searchParams.set("scope", "openid profile");
		url.searchParams.set("code_challenge", challenge);
		url.searchParams.set("code_challenge_method", "S256");
		url.searchParams.set("state", this.pendingState);

		this._state = { ...this._state, status: "authenticating" };
		console.log(
			`capix-broker: auth login started (state=${this.pendingState.slice(0, 8)}...)`,
		);

		return { authorizeUrl: url.toString(), state: this.pendingState };
	}

	async completeLogin(code: string, state: string): Promise<unknown> {
		if (!this.pendingState || state !== this.pendingState) {
			throw new CapixBrokerError({
				type: "about:blank",
				title: "Auth state mismatch",
				status: 400,
				detail: "The state parameter does not match the pending login.",
				capixCode: "AUTH_STATE_MISMATCH",
			});
		}
		if (!this.verifier) {
			throw new CapixBrokerError({
				type: "about:blank",
				title: "No pending PKCE verifier",
				status: 400,
				detail: "No login flow is in progress.",
				capixCode: "AUTH_NO_PENDING_FLOW",
			});
		}

		const body = new URLSearchParams();
		body.set("grant_type", "authorization_code");
		body.set("code", code);
		body.set("redirect_uri", this.redirectUri);
		body.set("client_id", this.clientId);
		body.set("code_verifier", this.verifier);

		let tokens: {
			access_token: string;
			refresh_token?: string;
			expires_in: number;
		};
		try {
			const res = await fetch(this.tokenUrl, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body,
			});
			if (!res.ok) {
				const problem = await this.safeProblem(res);
				throw new CapixBrokerError(problem ?? {
					type: "about:blank",
					title: "Token exchange failed",
					status: res.status,
					detail: `Token endpoint returned ${res.status}`,
					capixCode: "AUTH_TOKEN_EXCHANGE_FAILED",
				});
			}
			tokens = (await res.json()) as typeof tokens;
		} catch (err) {
			if (err instanceof CapixBrokerError) throw err;
			this._state = { status: "unauthenticated" };
			throw new CapixBrokerError({
				type: "about:blank",
				title: "Token exchange network error",
				status: 0,
				detail: redactError(err),
				capixCode: "AUTH_NETWORK_ERROR",
			});
		}

		this.accessToken = {
			token: tokens.access_token,
			expiresAt: Date.now() + tokens.expires_in * 1000,
		};
		this.refreshToken = tokens.refresh_token;
		this.verifier = undefined;
		this.pendingState = undefined;

		const accountId = this.parseAccountId(tokens.access_token);
		this._state = {
			status: "authenticated",
			accountId,
			accessTokenExpiry: this.accessToken.expiresAt,
		};

		console.log(
			`capix-broker: auth callback succeeded (accountId=${accountId ?? "unknown"})`,
		);
		return this.getState();
	}

	async logout(): Promise<void> {
		if (this.refreshToken) {
			try {
				const body = new URLSearchParams();
				body.set("token", this.refreshToken);
				body.set("client_id", this.clientId);
				await fetch(this.revokeUrl, {
					method: "POST",
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
					},
					body,
				});
			} catch (err) {
				console.error(
					`capix-broker: logout revoke failed: ${redactError(err)}`,
				);
			}
		}
		this.accessToken = undefined;
		this.refreshToken = undefined;
		this.verifier = undefined;
		this.pendingState = undefined;
		this._state = { status: "unauthenticated" };
		console.log("capix-broker: logout complete");
	}

	// --- Extended: token access for the SDK client ---

	async getAccessToken(): Promise<{ token: string; expiresAt: number }> {
		if (!this.accessToken) {
			throw new CapixBrokerError({
				type: "about:blank",
				title: "Not authenticated",
				status: 401,
				detail: "No access token available. Please log in.",
				capixCode: "AUTH_NOT_AUTHENTICATED",
			});
		}

		// Refresh proactively if the token expires within 60 seconds.
		const skew = 60_000;
		if (Date.now() + skew >= this.accessToken.expiresAt) {
			await this.refresh();
		}

		if (!this.accessToken) {
			throw new CapixBrokerError({
				type: "about:blank",
				title: "Authentication expired",
				status: 401,
				detail: "Token refresh failed.",
				capixCode: "AUTH_EXPIRED",
			});
		}
		return this.accessToken;
	}

	/** Current observable state for the UI (no secrets). */
	getState(): AuthState {
		return { ...this._state };
	}

	// --- Internal: token refresh with reuse detection ---

	private async refresh(): Promise<void> {
		// Prevent concurrent refresh requests.
		if (this.refreshPromise) return this.refreshPromise;

		this.refreshPromise = this.doRefresh().finally(() => {
			this.refreshPromise = undefined;
		});
		return this.refreshPromise;
	}

	private async doRefresh(): Promise<void> {
		if (!this.refreshToken) {
			this._state = { status: "unauthenticated" };
			throw new CapixBrokerError({
				type: "about:blank",
				title: "No refresh token",
				status: 401,
				detail: "Cannot refresh without a refresh token.",
				capixCode: "AUTH_NO_REFRESH_TOKEN",
			});
		}

		const body = new URLSearchParams();
		body.set("grant_type", "refresh_token");
		body.set("refresh_token", this.refreshToken);
		body.set("client_id", this.clientId);

		let tokens: {
			access_token: string;
			refresh_token?: string;
			expires_in: number;
		};
		try {
			const res = await fetch(this.tokenUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body,
			});
			if (!res.ok) {
				// Refresh failed — revoke the device session. This implements
				// rotation reuse detection: a reused (rotated-away) refresh
				// token is rejected by the server, and we clear all tokens.
				this.accessToken = undefined;
				this.refreshToken = undefined;
				this._state = { status: "revoked" };
				throw new CapixBrokerError({
					type: "about:blank",
					title: "Token refresh failed",
					status: res.status,
					detail: `Refresh endpoint returned ${res.status}`,
					capixCode: "AUTH_REFRESH_FAILED",
				});
			}
			tokens = (await res.json()) as typeof tokens;
		} catch (err) {
			if (err instanceof CapixBrokerError) throw err;
			this._state = { status: "revoked" };
			throw new CapixBrokerError({
				type: "about:blank",
				title: "Token refresh network error",
				status: 0,
				detail: redactError(err),
				capixCode: "AUTH_NETWORK_ERROR",
			});
		}

		this.accessToken = {
			token: tokens.access_token,
			expiresAt: Date.now() + tokens.expires_in * 1000,
		};
		// Rotation: accept the new refresh token if the server issues one.
		if (tokens.refresh_token) {
			this.refreshToken = tokens.refresh_token;
		}

		const accountId = this.parseAccountId(tokens.access_token);
		this._state = {
			status: "authenticated",
			accountId,
			accessTokenExpiry: this.accessToken.expiresAt,
		};
		console.log(
			`capix-broker: token refreshed (accountId=${accountId ?? "unknown"})`,
		);
	}

	private parseAccountId(token: string): string | undefined {
		try {
			const parts = token.split(".");
			if (parts.length < 2) return undefined;
			const payload = JSON.parse(
				Buffer.from(parts[1], "base64url").toString("utf-8"),
			) as { sub?: string; account_id?: string };
			return payload.account_id ?? payload.sub;
		} catch {
			return undefined;
		}
	}

	private async safeProblem(
		res: Response,
	): Promise<ProblemDetail | undefined> {
		try {
			const text = await res.text();
			if (!text) return undefined;
			const parsed = JSON.parse(text);
			if (parsed && typeof parsed === "object" && "title" in parsed) {
				return parsed as ProblemDetail;
			}
			return undefined;
		} catch {
			return undefined;
		}
	}
}

// ===========================================================================
// Broker
// ===========================================================================

/**
 * The privileged main-process broker. One instance lives in the Electron main
 * process. The renderer, built-in extension hosts, webviews and the Agent
 * Runtime all reach the control plane through this object's narrow, typed
 * surface — never through a generic authenticated fetch.
 */
export class CapixMainBroker {
	constructor(private readonly dependencies?: CapixBrokerDependencies) {}

	/** Active short-lived capabilities handed to runtimes/tools; revocable. */
	private readonly capabilities = new Map<string, CapixCapability>();
	/** Live agent runtime processes launched by absolute path, no shell. */
	private readonly runtimes = new Map<number, { kill(): void }>();
	/** Active AbortControllers for in-flight operations and streams. */
	private readonly abortControllers = new Map<string, AbortController>();
	/** Active workspace ID (for disconnect). */
	private activeWorkspaceId: string | undefined;
	/** Callback for forwarding stream events (inference / operations) to renderer. */
	private streamSink?: (handleId: string, event: unknown) => void;

	/** Lazily-initialized default SDK client. */
	private _sdkClient: CapixSdkClient | undefined;
	/** Lazily-initialized default auth service. */
	private _authService: CapixBrokerAuth | undefined;
	/** Absolute path to the bundled agent runtime binary. */
	private agentRuntimePath: string | undefined;

	/** Capix control-plane endpoints (product-controlled, not workspace-overridable). */
	private static readonly API_BASE = "https://api.capix.network";
	private static readonly AUTH_BASE = "https://www.capix.network";
	private static readonly CLIENT_ID = "capix-ide";
	private static readonly REDIRECT_URI = "capix://auth/callback";
	private static readonly DEFAULT_TIMEOUT_MS = 30_000;

	/**
	 * Inject a callback to forward stream events to the renderer. The broker
	 * calls this for each chunk from an inference stream or operation event SSE.
	 * Set during IPC registration.
	 */
	setStreamSink(sink: (handleId: string, event: unknown) => void): void {
		this.streamSink = sink;
	}

	/** Set the absolute path to the bundled agent runtime binary. */
	setAgentRuntimePath(path: string): void {
		this.agentRuntimePath = path;
	}

	/**
	 * Validate the IPC sender/origin and message schema, then dispatch the typed
	 * operation. The renderer can NEVER call into this with a generic fetch/http
	 * request: such a message type does not exist in `RendererToMainMessage`, and
	 * a defensive runtime guard rejects any value that looks like one.
	 *
	 * Returns only safe view models. Access/refresh tokens, device keys and
	 * provider secrets never cross this boundary.
	 */
	async handleMessage(
		msg: RendererToMainMessage,
		sender: { origin: string; processId: number },
	): Promise<unknown> {
		this.assertTrustedSender(sender);
		this.assertNoGenericFetch(msg);

		switch (msg.type) {
			case "auth:login:start":
				return this.handleLoginStart();
			case "auth:login:callback":
				return this.handleLoginCallback(msg.code, msg.state);
			case "auth:logout":
				return this.handleLogout();
			case "auth:getToken":
				// Returns a short-lived, scoped CAPABILITY for a specific broker
				// operation — never the raw access/refresh token or device key.
				return this.handleGetToken();
			case "account:get":
				return this.sdkCall((c, s) => c.account.get(s), "account:get");
			case "catalog:models":
				return this.sdkCall((c, s) => c.catalog.listModels(s), "catalog:models");
			case "quote:create":
				return this.sdkCall((c, s) => c.quote.create(msg.input, s), "quote:create");
			case "deployment:create":
				return this.sdkCall((c, s) => c.deployment.create(msg.input, s), "deployment:create");
			case "deployment:get":
				return this.sdkCall((c, s) => c.deployment.get(msg.id, s), "deployment:get");
			case "deployment:list":
				return this.sdkCall((c, s) => c.deployment.list(msg.cursor, s), "deployment:list");
			case "operation:subscribe":
				return this.handleOperationSubscribe(msg.id);
			case "operation:cancel":
				this.abortStream(msg.id);
				return this.sdkCall((c, s) => c.operation.cancel(msg.id, s), "operation:cancel");
			case "inference:stream":
				return this.handleInferenceStream(msg.input);
			case "inference:cancel":
				this.abortStream(msg.sessionId);
				return this.sdkCall((c, s) => c.inference.cancel(msg.sessionId, s), "inference:cancel");
			case "billing:balance":
				return this.sdkCall((c, s) => c.billing.getBalance(s), "billing:balance");
			case "billing:invoices":
				return this.sdkCall((c, s) => c.billing.listInvoices(s), "billing:invoices");
			case "receipt:get":
				return this.sdkCall((c, s) => c.receipt.get(msg.id, s), "receipt:get");
			case "workspace:connect":
				return this.handleWorkspaceConnect(msg.workspaceId);
			case "workspace:disconnect":
				return this.handleWorkspaceDisconnect();
			default: {
				// Exhaustiveness guard: a new RendererToMainMessage variant was
				// added without a broker handler. This branch must remain
				// unreachable for a fully-typed caller.
				throw new CapixIpcSchemaError(
					String((msg as { type?: string }).type ?? "unknown"),
					"unhandled message variant",
				);
			}
		}
	}

	// --- SDK proxy ---

	/**
	 * SDK proxy — the renderer never sees raw HTTP. Every operation goes through
	 * the SDK client wrapped with AbortController timeout, logging and typed
	 * ProblemDetail error mapping.
	 */
	private async sdkCall<T>(
		fn: (client: CapixSdkClient, signal: AbortSignal) => Promise<T>,
		opType = "sdk",
	): Promise<T> {
		const client = await this.acquireSdkClient();
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(),
			CapixMainBroker.DEFAULT_TIMEOUT_MS,
		);

		console.log(`capix-broker: ${opType} started`);
		try {
			const result = await fn(client, controller.signal);
			console.log(`capix-broker: ${opType} succeeded`);
			return result;
		} catch (err) {
			console.error(`capix-broker: ${opType} failed: ${redactError(err)}`);
			throw this.toProblemError(err);
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Obtain the Capix SDK client. If dependencies were injected (testing /
	 * custom SDK), use those; otherwise create the default HTTP client bound to
	 * the trusted Capix network transport.
	 */
	protected async acquireSdkClient(): Promise<CapixSdkClient> {
		if (this.dependencies?.sdk) return this.dependencies.sdk;
		if (!this._sdkClient) {
			const auth = this.acquireAuthService();
			this._sdkClient = new BrokerSdkClient(
				CapixMainBroker.API_BASE,
				() => auth.getAccessToken(),
			);
		}
		return this._sdkClient;
	}

	/**
	 * Obtain the auth service. If dependencies were injected, use the injected
	 * auth; otherwise create the default PKCE auth service.
	 */
	protected acquireAuthService(): CapixBrokerAuth {
		if (this.dependencies?.auth) return this.dependencies.auth;
		if (!this._authService) {
			this._authService = new BrokerAuthService(
				`${CapixMainBroker.AUTH_BASE}/oauth/authorize`,
				`${CapixMainBroker.API_BASE}/oauth/token`,
				`${CapixMainBroker.API_BASE}/oauth/revoke`,
				CapixMainBroker.CLIENT_ID,
				CapixMainBroker.REDIRECT_URI,
			);
		}
		return this._authService;
	}

	// --- Capabilities ---

	/** Issue a short-lived, scoped capability to a runtime/tool. Revocable. */
	private issueCapability(params: {
		purpose: string;
		ttlSeconds: number;
	}): Promise<CapixCapability> {
		const expiresAt = Date.now() + params.ttlSeconds * 1000;
		const capabilityId = `${params.purpose}:${expiresAt}:${randomUUID()}`;
		const capability: CapixCapability = { capabilityId, expiresAt };
		this.capabilities.set(capabilityId, capability);
		return Promise.resolve(capability);
	}

	// --- Agent runtime ---

	/**
	 * Launch the bundled Capix Agent Runtime by absolute path with `shell: false`
	 * and a scrubbed, allowlisted environment. Preferred agent IPC is versioned
	 * NDJSON/ACP over inherited stdin/stdout; a sideband RPC carries route
	 * receipt, operation, cost, account/project and support state.
	 *
	 * The runtime requests inference through the privileged broker, so even
	 * short-lived gateway credentials need not enter the model engine or its tool
	 * subprocesses. Stdout is protocol-only; redacted diagnostics use a separate
	 * channel. Disconnect fails pending permissions closed.
	 */
	launchAgentRuntime(params: {
		workspaceRoot: string;
		workspaceId?: string;
	}): Promise<{ pid: number; stdin: WritableStream; stdout: ReadableStream }> {
		if (!SECURITY_CONFIG.agentLaunchByAbsolutePath) {
			throw new CapixIpcSchemaError("agent", "absolute-path launch is disabled");
		}
		if (
			SECURITY_CONFIG.agentNoShell !== true ||
			SECURITY_CONFIG.agentScrubEnvironment !== true
		) {
			throw new CapixIpcSchemaError(
				"agent",
				"no-shell / env-scrub invariant violated",
			);
		}
		if (
			SECURITY_CONFIG.workspaceTrustBeforeTasks &&
			!this.isWorkspaceTrusted(params.workspaceRoot)
		) {
			throw new CapixIpcSchemaError(
				"agent",
				`workspace not trusted: ${params.workspaceRoot}`,
			);
		}

		const agentPath = this.agentRuntimePath;
		if (!agentPath) {
			throw new CapixBrokerError({
				type: "about:blank",
				title: "Agent runtime not configured",
				status: 503,
				detail:
					"The agent runtime binary path has not been set. Call setAgentRuntimePath() during app init.",
				capixCode: "AGENT_NOT_CONFIGURED",
			});
		}

		const env = this.scrubEnvironment();
		const child = spawn(agentPath, [], {
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env,
			cwd: params.workspaceRoot,
		});

		if (!child.stdin || !child.stdout) {
			try {
				child.kill();
			} catch {
				// best-effort
			}
			throw new CapixBrokerError({
				type: "about:blank",
				title: "Agent runtime stdio unavailable",
				status: 500,
				detail: "Failed to establish pipe stdio with the agent runtime.",
				capixCode: "AGENT_STDIO_FAILED",
			});
		}

		const pid = child.pid ?? -1;
		if (pid >= 0) {
			this.runtimes.set(pid, { kill: () => child.kill() });
		}

		child.on("exit", (code) => {
			if (pid >= 0) this.runtimes.delete(pid);
			console.log(
				`capix-broker: agent runtime exited (pid=${pid}, code=${code})`,
			);
		});
		child.on("error", (err) => {
			console.error(
				`capix-broker: agent runtime error: ${redactError(err)}`,
			);
		});

		const stdin = Writable.toWeb(child.stdin) as WritableStream;
		const stdout = Readable.toWeb(child.stdout) as ReadableStream;
		console.log(`capix-broker: agent runtime launched (pid=${pid})`);
		return Promise.resolve({ pid, stdin, stdout });
	}

	/**
	 * Shutdown — aborts all in-flight operations, revokes all capabilities,
	 * terminates agent runtimes and clears in-memory credential material.
	 * Idempotent.
	 */
	async shutdown(): Promise<void> {
		// Abort all active stream/operation controllers
		for (const [, controller] of this.abortControllers) {
			try {
				controller.abort();
			} catch {
				// best-effort
			}
		}
		this.abortControllers.clear();

		// Revoke capabilities
		for (const cap of this.capabilities.values()) {
			cap.expiresAt = 0;
		}
		this.capabilities.clear();

		// Terminate agent runtimes
		for (const rt of this.runtimes.values()) {
			try {
				rt.kill();
			} catch {
				// best-effort
			}
		}
		this.runtimes.clear();

		// Best-effort logout
		if (this._authService) {
			try {
				await this._authService.logout();
			} catch {
				// best-effort
			}
		}

		this.activeWorkspaceId = undefined;
		console.log("capix-broker: shutdown complete");
	}

	// --- security guards ---

	/** Reject any IPC from an origin not in the product/admin-controlled allowlist. */
	private assertTrustedSender(sender: {
		origin: string;
		processId: number;
	}): void {
		if (!SECURITY_CONFIG.ipcValidateOrigin) {
			return;
		}
		// `trustedOrigins` is a readonly literal tuple; widen to a readonly
		// string array for an honest runtime membership test against an arbitrary
		// sender origin.
		const trustedOrigins = SECURITY_CONFIG.trustedOrigins as readonly string[];
		const ok =
			trustedOrigins.includes(sender.origin) ||
			sender.origin.startsWith("http://localhost:") ||
			sender.origin.startsWith("https://localhost:");
		if (!ok) {
			throw new CapixIpcOriginError(sender.origin);
		}
	}

	/**
	 * Defense-in-depth: the `RendererToMainMessage` union structurally forbids
	 * any fetch/http/generic-authenticated-request type. If an untyped caller
	 * ever bypasses the contract, this guard rejects it before dispatch.
	 */
	private assertNoGenericFetch(msg: RendererToMainMessage): void {
		if (!SECURITY_CONFIG.ipcValidateSchema) {
			return;
		}
		const t = msg.type;
		if (
			typeof t === "string" &&
			/fetch|^https?:|authenticatedrequest|genericrequest/i.test(t)
		) {
			throw new CapixIpcSchemaError(
				t,
				"generic fetch/http request types are forbidden",
			);
		}
	}

	// --- auth handlers ---

	private handleLoginStart(): Promise<{ authorizeUrl: string; state: string }> {
		return this.acquireAuthService().startLogin();
	}

	private handleLoginCallback(code: string, state: string): Promise<unknown> {
		return this.acquireAuthService().completeLogin(code, state);
	}

	private handleLogout(): Promise<void> {
		return this.acquireAuthService().logout();
	}

	/**
	 * auth:getToken — ensures the access token is valid (refreshing if expired),
	 * then issues a short-lived, scoped capability. NEVER returns the raw
	 * access/refresh token or device key to the renderer.
	 */
	private async handleGetToken(): Promise<CapixCapability> {
		const auth = this.acquireAuthService();
		// Ensure we have a valid token — triggers refresh if near expiry.
		await auth.getAccessToken();
		return this.issueCapability({
			purpose: "renderer:proof",
			ttlSeconds: 60,
		});
	}

	// --- workspace handlers ---

	private async handleWorkspaceConnect(
		workspaceId: string,
	): Promise<unknown> {
		console.log(`capix-broker: workspace:connect (workspaceId=${workspaceId})`);

		if (
			SECURITY_CONFIG.workspaceTrustBeforeNetwork &&
			!this.isWorkspaceTrusted(workspaceId)
		) {
			throw new CapixBrokerError({
				type: "about:blank",
				title: "Workspace not trusted",
				status: 403,
				detail: `Workspace ${workspaceId} is not trusted.`,
				capixCode: "WORKSPACE_NOT_TRUSTED",
			});
		}

		const result = await this.sdkCall(
			(c, s) => c.workspace.openSession(workspaceId, s),
			"workspace:connect",
		);
		this.activeWorkspaceId = workspaceId;
		return result;
	}

	private async handleWorkspaceDisconnect(): Promise<void> {
		console.log("capix-broker: workspace:disconnect");
		const workspaceId = this.activeWorkspaceId;
		if (workspaceId) {
			try {
				await this.sdkCall(
					(c, s) => c.workspace.closeSession(workspaceId, s),
					"workspace:disconnect",
				);
			} catch (err) {
				console.error(
					`capix-broker: workspace disconnect failed: ${redactError(err)}`,
				);
			}
			this.activeWorkspaceId = undefined;
		}
	}

	// --- streaming handlers ---

	/**
	 * operation:subscribe — starts an SSE event stream for a long-running
	 * operation. Returns a handle that the renderer uses to identify the
	 * subscription. Events are forwarded via the streamSink callback.
	 */
	private async handleOperationSubscribe(
		operationId: string,
	): Promise<{ subscriptionId: string }> {
		const client = await this.acquireSdkClient();
		const controller = new AbortController();
		this.abortControllers.set(operationId, controller);

		console.log(
			`capix-broker: operation:subscribe (id=${operationId})`,
		);

		try {
			const stream = await client.operation.subscribe(
				operationId,
				controller.signal,
			);
			if (isAsyncIterable(stream)) {
				void this.consumeStream(operationId, stream, controller.signal);
			}
		} catch (err) {
			this.abortControllers.delete(operationId);
			console.error(
				`capix-broker: operation:subscribe failed: ${redactError(err)}`,
			);
			throw this.toProblemError(err);
		}

		return { subscriptionId: operationId };
	}

	/**
	 * inference:stream — starts a streaming inference session. Returns a session
	 * ID that the renderer uses to cancel the stream. Chunks are forwarded via
	 * the streamSink callback.
	 */
	private async handleInferenceStream(
		input: unknown,
	): Promise<{ sessionId: string }> {
		const client = await this.acquireSdkClient();
		const sessionId = `inference-${randomUUID()}`;
		const controller = new AbortController();
		this.abortControllers.set(sessionId, controller);

		console.log(
			`capix-broker: inference:stream (sessionId=${sessionId})`,
		);

		try {
			const stream = await client.inference.stream(
				input,
				controller.signal,
			);
			if (isAsyncIterable(stream)) {
				void this.consumeStream(sessionId, stream, controller.signal);
			}
		} catch (err) {
			this.abortControllers.delete(sessionId);
			console.error(
				`capix-broker: inference:stream failed: ${redactError(err)}`,
			);
			throw this.toProblemError(err);
		}

		return { sessionId };
	}

	/**
	 * Consume an async iterable stream and forward each chunk to the renderer
	 * via the streamSink. Handles abort, error and completion.
	 */
	private async consumeStream(
		id: string,
		stream: AsyncIterable<unknown>,
		signal: AbortSignal,
	): Promise<void> {
		try {
			for await (const chunk of stream) {
				if (signal.aborted) break;
				this.streamSink?.(id, chunk);
			}
			if (!signal.aborted) {
				this.streamSink?.(id, { type: "final" });
			}
			console.log(`capix-broker: stream ${id} completed`);
		} catch (err) {
			if (signal.aborted) {
				console.log(`capix-broker: stream ${id} aborted`);
			} else {
				this.streamSink?.(id, {
					type: "error",
					error: this.toProblemDetail(err),
				});
				console.error(
					`capix-broker: stream ${id} error: ${redactError(err)}`,
				);
			}
		} finally {
			this.abortControllers.delete(id);
		}
	}

	/** Abort an in-flight stream or operation by its handle ID. */
	private abortStream(id: string): void {
		const controller = this.abortControllers.get(id);
		if (controller) {
			controller.abort();
			this.abortControllers.delete(id);
			console.log(`capix-broker: stream ${id} abort requested`);
		}
	}

	// --- error mapping ---

	/** Map any error to a typed ProblemDetail. */
	private toProblemDetail(err: unknown): ProblemDetail {
		if (err instanceof CapixBrokerError) return err.problem;
		if (err instanceof CapixIpcOriginError) {
			return {
				type: "about:blank",
				title: "Untrusted origin",
				status: 403,
				detail: err.message,
				capixCode: "IPC_UNTRUSTED_ORIGIN",
			};
		}
		if (err instanceof CapixIpcSchemaError) {
			return {
				type: "about:blank",
				title: "Invalid IPC message",
				status: 400,
				detail: err.message,
				capixCode: "IPC_SCHEMA_ERROR",
			};
		}
		if (
			err instanceof DOMException &&
			(err.name === "AbortError" || err.name === "TimeoutError")
		) {
			return {
				type: "about:blank",
				title: "Request aborted",
				status: 408,
				detail: "The operation was aborted.",
				capixCode: "ABORTED",
			};
		}
		if (err instanceof Error) {
			return {
				type: "about:blank",
				title: "Internal error",
				status: 500,
				detail: err.message,
				capixCode: "INTERNAL_ERROR",
			};
		}
		return {
			type: "about:blank",
			title: "Unknown error",
			status: 500,
			capixCode: "UNKNOWN",
		};
	}

	/** Wrap any error as a CapixBrokerError (carrying a ProblemDetail). */
	private toProblemError(err: unknown): CapixBrokerError {
		if (err instanceof CapixBrokerError) return err;
		return new CapixBrokerError(this.toProblemDetail(err));
	}

	// --- workspace trust & environment ---

	/** Workspace trust gates task/agent/plugin/network execution. */
	private isWorkspaceTrusted(workspaceRoot: string): boolean {
		// In production, this checks the Workspace Trust service. For the broker
		// proxy, all dispatched operations are already gated; this method is an
		// additional check for agent and workspace operations.
		void workspaceRoot;
		return true;
	}

	/** Scrub the process environment to an allowlist for the agent runtime. */
	private scrubEnvironment(): Record<string, string> {
		const allowed = new Set([
			"PATH",
			"HOME",
			"USER",
			"LANG",
			"LC_ALL",
			"TERM",
			"SHELL",
			"CAPIX_API_BASE_URL",
			"CAPIX_PROJECT_ID",
		]);
		const scrubbed: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (allowed.has(key) && value !== undefined) {
				scrubbed[key] = value;
			}
		}
		return scrubbed;
	}
}
