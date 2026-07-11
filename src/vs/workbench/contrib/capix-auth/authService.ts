/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-auth — main-process auth broker (TypeScript types only).
 *
 *  This module declares the public surface of the privileged Capix auth broker that
 *  lives in the Electron main process. The renderer, built-in extension hosts and the
 *  bundled Capix Agent Runtime never receive long-lived credentials; they ask the broker
 *  for short-lived, project-scoped capabilities (architecture §11.2–11.4, master prompt I3).
 *
 *  Conformance:
 *    - RFC 8252 (Native Apps): system browser, authorization-code + PKCE, loopback callback
 *      with signed `capix://auth/callback` fallback.
 *    - Access token is short-lived and held in broker memory only.
 *    - Rotating refresh token + device key live in the OS credential store
 *      (Keychain / Credential Manager / Secret Service). If no secure store exists,
 *      only session login is allowed.
 *    - `capix.baseUrl`, auth origin and update origin are product/admin settings that
 *      workspace settings cannot override.
 *--------------------------------------------------------------------------------------------*/

/**
 * Observable auth state for the UI. Contains only safe, non-secret values that may be
 * rendered to the workbench. No access token, refresh token or device key is ever
 * present here.
 */
export interface AuthState {
	status: "unauthenticated" | "authenticating" | "authenticated" | "expired" | "revoked";
	accountId?: string;
	projectId?: string;
	accessTokenExpiry?: number;
	deviceKeyFingerprint?: string;
}

/**
 * Result of initiating a PKCE login. The renderer receives only the authorize URL and
 * the high-entropy state; the verifier, nonce and device key stay in the broker.
 */
export interface InitiateLoginResult {
	authorizeUrl: string;
	state: string;
}

/**
 * The privileged Capix auth service, implemented in the Electron main process and
 * exposed to the renderer/extension hosts as narrow, typed IPC operations
 * (see `capix-auth/index.ts` for the IPC registration contract).
 *
 * Implementations MUST:
 *   - create verifier/challenge, state, nonce and a per-install device key;
 *   - open the Capix system-browser authorize route with exact client/release/callback
 *     metadata;
 *   - validate state and exchange the single-use code over TLS;
 *   - keep refresh rotation with reuse detection and device revocation;
 *   - support logout/revoke, expiry, account/project switch and offline state.
 */
export interface CapixAuthService {
	/**
	 * Start the PKCE flow. Generates verifier/challenge, high-entropy state, nonce and
	 * a per-install device key, then returns the authorize URL to open in the system
	 * browser. The broker holds the verifier, nonce and device key in memory; only the
	 * URL and state are returned to the caller.
	 */
	initiateLogin(): Promise<InitiateLoginResult>;

	/**
	 * Handle the authorization-code callback. `code`/`state` arrive only via the
	 * loopback listener (preferred) or signed `capix://auth/callback` fallback — never
	 * a session/access/refresh token. Validates state, exchanges the code over TLS and
	 * stores the rotating refresh token / device key in the OS credential store.
	 */
	handleCallback(code: string, state: string): Promise<AuthState>;

	/**
	 * Refresh the access token using the rotating refresh token. Implements reuse
	 * detection: a reused (rotated-away) refresh token revokes the device session.
	 * Returns the refreshed auth state.
	 */
	refresh(): Promise<AuthState>;

	/**
	 * Log out and revoke the device session. Clears refresh token, device key and any
	 * in-memory access token. Local UI state is reset to `unauthenticated`.
	 */
	logout(): Promise<void>;

	/**
	 * Obtain a short-lived, project/audience-scoped access token for a privileged API
	 * call. The token never crosses into the renderer, webview, extension host or agent
	 * runtime; callers receive it only to pass down an inherited capability.
	 */
	getAccessToken(): Promise<{ token: string; expiresAt: number }>;

	/**
	 * Current observable state for the UI. Safe to render; contains no secret material.
	 */
	getState(): AuthState;
}
