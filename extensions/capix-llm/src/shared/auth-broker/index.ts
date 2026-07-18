// GENERATED FILE — vendored from @capix/auth-broker (shared Capix package).
// Do not edit. Refresh with: node scripts/sync-shared-packages.mjs
/**
 * @capix/auth-broker — the shared Capix credential broker.
 *
 * One implementation of the OAuth 2.1 native-app flow for every Capix client
 * (CLI engine, IDE, MCP server):
 *
 *   - Authorization Code + PKCE (S256, RFC 8252/7636) with a loopback redirect
 *     captured by an ephemeral `127.0.0.1` listener; the captured code is
 *     exposed as {@link AuthBroker.capturedCode} for hosts that drive the
 *     browser themselves.
 *   - Device Authorization Grant (RFC 8628) for headless / SSH sessions.
 *   - Short-lived access tokens held in memory only; refresh happens
 *     proactively inside a 60-second expiry skew.
 *   - Rotating refresh tokens persisted in the OS credential store with
 *     crash-safe dual-slot writes (`refresh-token:active` /
 *     `refresh-token:previous`) and reuse detection: presenting a rotated-out
 *     token revokes the local session and emits `token_reuse_detected`.
 *   - Single-flight refresh — concurrent callers share one in-flight grant.
 *   - Explicit audience/scope: `AuthConfig.scope`/`audience` are sent on every
 *     grant; `getAccessToken({ audience, scopes })` requests down-scoped
 *     tokens per call.
 *
 * The broker NEVER writes secrets to logs, and never falls back to plaintext
 * storage — see stores.ts for the backend selection order.
 *
 * Wire endpoints (relative to `AuthConfig.baseUrl`):
 *   `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`, `/oauth/device/code`.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { CredentialStore, SyncReadableCredentialStore } from "./stores.js";

export {
  FileCredentialStore,
  KeytarCredentialStore,
  PlatformCredentialStore,
  createDefaultCredentialStore,
} from "./stores.js";
export type {
  CredentialStore,
  PlatformBackend,
  SyncReadableCredentialStore,
} from "./stores.js";

// ===========================================================================
// Public types
// ===========================================================================

export type AuthState =
  | "authenticated"
  | "unauthenticated"
  | "refreshing"
  | "error";

export interface AccountInfo {
  accountId: string;
  walletAddress?: string;
  projectId?: string;
  /** Epoch milliseconds when the current access token expires. */
  expiresAt: number;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string;
}

export interface AuthConfig {
  /** Control-plane origin, e.g. `https://capix.network`. HTTPS required (loopback HTTP allowed for tests). */
  baseUrl: string;
  /** OAuth client id; also namespaces the credential-store slots. */
  clientId: string;
  /** Explicit scope requested on every grant (e.g. `capix:deploy ... offline_access`). */
  scope?: string;
  /** RFC 8707 audience/resource indicator sent on every token request. */
  audience?: string;
  /** Loopback callback timeout for the PKCE flow (default 120s). */
  callbackTimeoutMs?: number;
  /** Fetch override (tests). */
  fetchImpl?: typeof fetch;
}

export type AuthEvent =
  | { type: "login"; account: AccountInfo }
  | { type: "refresh"; account: AccountInfo }
  | { type: "logout" }
  | { type: "refresh_failed"; reason: string }
  | { type: "token_reuse_detected" };

export interface DeviceCodeChallenge {
  /** Verification URL the user opens (verification_uri_complete when available). */
  url: string;
  userCode: string;
  deviceCode: string;
  /** Polling interval in seconds. */
  interval: number;
  /** Challenge lifetime in seconds. */
  expiresIn: number;
}

/** Per-call token request overrides (down-scoping only). */
export interface AccessTokenOptions {
  /** RFC 8707 audience override for this token. */
  audience?: string;
  /** Narrower scope set for this token. */
  scopes?: string[];
}

// ===========================================================================
// Errors
// ===========================================================================

/** Raised when a broker operation fails; `capixCode` is safe to log/display. */
export class AuthBrokerError extends Error {
  constructor(
    message: string,
    public readonly capixCode: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "AuthBrokerError";
  }
}

/** Raised when no usable credential exists; the caller must re-login. */
export class NotAuthenticatedError extends AuthBrokerError {
  constructor(message = "@capix/auth-broker: not authenticated") {
    super(message, "not_authenticated", 401);
    this.name = "NotAuthenticatedError";
  }
}

/** Raised when a rotated-out refresh token is presented again. */
export class TokenReuseError extends AuthBrokerError {
  constructor(message = "@capix/auth-broker: refresh token reuse detected") {
    super(message, "token_reuse_detected", 401);
    this.name = "TokenReuseError";
  }
}

// ===========================================================================
// Internal helpers
// ===========================================================================

/** Refresh this many ms before the access token actually expires. */
const REFRESH_SKEW_MS = 60_000;
/** Network timeout for OAuth endpoint calls. */
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

/** Credential-store slots (service = client id). */
const SLOT_REFRESH_ACTIVE = "refresh-token:active";
const SLOT_REFRESH_PREVIOUS = "refresh-token:previous";
const SLOT_ACCOUNT_INFO = "account-info";

function randomUrlSafe(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function isLoopbackHttp(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "[::1]")
  );
}

interface TokenEndpointResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  account_id?: string;
  project_id?: string;
  wallet_address?: string;
  error?: string;
  error_description?: string;
}

interface PendingLogin {
  verifier: string;
  state: string;
  redirectUri: string;
  server: Server;
  timeout: ReturnType<typeof setTimeout>;
}

/** Decode the payload of a JWT without verifying it (display claims only). */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    return JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ===========================================================================
// AuthBroker
// ===========================================================================

/**
 * The shared auth broker. One instance per process per client id.
 *
 * Secrets discipline: the access token lives only in `this.accessToken`; the
 * refresh token lives in the {@link CredentialStore} (plus one in-memory copy
 * for the single-flight refresh). Neither is ever logged or exposed through
 * {@link AuthBroker.getState}/{@link AuthBroker.getAccount}.
 */
export class AuthBroker {
  /**
   * Loopback-captured authorization code, set by the built-in callback
   * listener. Hosts that drive the system browser poll this field and then
   * call {@link completeLogin}.
   */
  capturedCode: { code: string; state: string } | null = null;

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly store: CredentialStore;

  private state: AuthState = "unauthenticated";
  private accessToken: { token: string; expiresAt: number } | null = null;
  private refreshToken: string | null = null;
  private account: AccountInfo | null = null;
  private pending: PendingLogin | null = null;
  /** Single-flight refresh: one in-flight grant shared by all callers. */
  private refreshFlight: Promise<string> | null = null;
  private readonly handlers = new Set<(event: AuthEvent) => void>();
  private readonly ready: Promise<void>;

  constructor(
    private readonly config: AuthConfig,
    credentialStore: CredentialStore,
  ) {
    const base = new URL(config.baseUrl);
    if (base.protocol !== "https:" && !isLoopbackHttp(base)) {
      throw new AuthBrokerError(
        "@capix/auth-broker: baseUrl must be an HTTPS origin (loopback HTTP allowed for local development)",
        "insecure_base_url",
      );
    }
    if (!config.clientId) {
      throw new AuthBrokerError(
        "@capix/auth-broker: clientId is required",
        "invalid_config",
      );
    }
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.store = credentialStore;

    // Prime synchronously when the store supports it, so getState() is
    // accurate before the first await (CLI startup probes depend on this).
    const syncStore = credentialStore as SyncReadableCredentialStore;
    if (typeof syncStore.getSync === "function") {
      try {
        const active = syncStore.getSync(config.clientId, SLOT_REFRESH_ACTIVE);
        if (active) {
          this.refreshToken = active;
          this.state = "authenticated";
        }
        const accountJson = syncStore.getSync(config.clientId, SLOT_ACCOUNT_INFO);
        if (accountJson) this.account = JSON.parse(accountJson) as AccountInfo;
      } catch {
        // Unreadable store — stay unauthenticated; async load may still succeed.
      }
    }
    this.ready = this.loadStoredCredentials();
  }

  // ── Authorization Code + PKCE ───────────────────────────────────────────

  /**
   * Start the PKCE flow. Binds an ephemeral loopback listener that captures
   * the redirect into {@link capturedCode}, then returns the authorize URL
   * for the host to open in the system browser.
   */
  async startLogin(): Promise<{ authorizeUrl: string; state: string }> {
    this.cancelPendingLogin();
    this.capturedCode = null;

    const verifier = randomUrlSafe(48);
    const state = randomUrlSafe(32);
    const nonce = randomUrlSafe(24);

    const server = createServer((req, res) => {
      void this.acceptLoopbackCallback(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new AuthBrokerError(
        "@capix/auth-broker: failed to bind PKCE loopback callback",
        "loopback_bind_failed",
      );
    }
    const redirectUri = `http://127.0.0.1:${address.port}/callback`;
    const timeout = setTimeout(
      () => this.cancelPendingLogin(),
      this.config.callbackTimeoutMs ?? 120_000,
    );
    this.pending = { verifier, state, redirectUri, server, timeout };

    const url = new URL("/oauth/authorize", this.baseUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("code_challenge", pkceChallenge(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    if (this.config.scope) url.searchParams.set("scope", this.config.scope);
    if (this.config.audience) url.searchParams.set("audience", this.config.audience);

    return { authorizeUrl: url.toString(), state };
  }

  /**
   * Exchange the captured authorization code for tokens. Validates the state
   * against the pending login at this privileged boundary before accepting
   * the code.
   */
  async completeLogin(code: string, state: string): Promise<AccountInfo> {
    const pending = this.pending;
    if (!pending || state !== pending.state) {
      throw new AuthBrokerError(
        "@capix/auth-broker: OAuth state mismatch or expired login",
        "state_mismatch",
        400,
      );
    }
    if (!code) {
      throw new AuthBrokerError(
        "@capix/auth-broker: authorization code missing",
        "code_missing",
        400,
      );
    }

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: pending.verifier,
      redirect_uri: pending.redirectUri,
      client_id: this.config.clientId,
    });
    if (this.config.audience) body.set("audience", this.config.audience);

    const tokens = await this.tokenRequest(body, "token_exchange_failed");
    this.cancelPendingLogin();
    return this.acceptTokens(tokens, "login");
  }

  // ── Device Authorization Grant (RFC 8628) ───────────────────────────────

  /** Begin a device-code login for headless sessions. */
  async startDeviceCodeLogin(): Promise<DeviceCodeChallenge> {
    const body = new URLSearchParams({ client_id: this.config.clientId });
    if (this.config.scope) body.set("scope", this.config.scope);
    if (this.config.audience) body.set("audience", this.config.audience);

    const res = await this.fetchImpl(`${this.baseUrl}/oauth/device/code`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
    const payload = (await res.json().catch(() => ({}))) as {
      device_code?: string;
      user_code?: string;
      verification_uri?: string;
      verification_uri_complete?: string;
      interval?: number;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !payload.device_code || !payload.user_code) {
      throw new AuthBrokerError(
        payload.error_description ??
          `@capix/auth-broker: device code request failed (${res.status})`,
        payload.error ?? "device_code_failed",
        res.status,
      );
    }
    return {
      url: payload.verification_uri_complete ?? payload.verification_uri ?? "",
      userCode: payload.user_code,
      deviceCode: payload.device_code,
      interval: Math.max(1, payload.interval ?? 5),
      expiresIn: payload.expires_in ?? 600,
    };
  }

  /**
   * Poll the token endpoint until the user authorizes the device, the
   * challenge expires, or authorization is denied. Honors `slow_down`.
   */
  async completeDeviceCodeLogin(
    challenge: DeviceCodeChallenge,
  ): Promise<AccountInfo> {
    const deadline = Date.now() + challenge.expiresIn * 1000;
    let intervalMs = challenge.interval * 1000;

    for (;;) {
      if (Date.now() >= deadline) {
        throw new AuthBrokerError(
          "@capix/auth-broker: device code expired before authorization",
          "device_code_expired",
          400,
        );
      }
      const body = new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: challenge.deviceCode,
        client_id: this.config.clientId,
      });
      const res = await this.fetchImpl(`${this.baseUrl}/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body,
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      });
      const payload = (await res.json().catch(() => ({}))) as TokenEndpointResponse;

      if (res.ok && payload.access_token) {
        return this.acceptTokens(payload, "login");
      }
      switch (payload.error) {
        case "authorization_pending":
          break; // poll again after the interval
        case "slow_down":
          intervalMs += 5000;
          break;
        case "expired_token":
          throw new AuthBrokerError(
            "@capix/auth-broker: device code expired",
            "device_code_expired",
            400,
          );
        case "access_denied":
          throw new AuthBrokerError(
            "@capix/auth-broker: device authorization denied",
            "device_authorization_denied",
            403,
          );
        default:
          throw new AuthBrokerError(
            payload.error_description ??
              `@capix/auth-broker: device token poll failed (${res.status})`,
            payload.error ?? "device_token_poll_failed",
            res.status,
          );
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  // ── Access tokens (single-flight refresh) ───────────────────────────────

  /**
   * Return a valid access token, refreshing proactively inside the expiry
   * skew. Concurrent callers share one in-flight refresh grant. With
   * `audience`/`scopes` overrides a fresh down-scoped token is always minted.
   */
  async getAccessToken(opts?: AccessTokenOptions): Promise<string> {
    await this.ready;
    if (
      !opts?.audience &&
      !opts?.scopes &&
      this.accessToken &&
      this.accessToken.expiresAt - REFRESH_SKEW_MS > Date.now()
    ) {
      return this.accessToken.token;
    }
    return this.refresh(opts);
  }

  /** Single-flight: all concurrent refresh callers share one grant. */
  private refresh(opts?: AccessTokenOptions): Promise<string> {
    if (this.refreshFlight) return this.refreshFlight;
    this.refreshFlight = this.doRefresh(opts).finally(() => {
      this.refreshFlight = null;
    });
    return this.refreshFlight;
  }

  private async doRefresh(opts?: AccessTokenOptions): Promise<string> {
    const storedActive = await this.store
      .get(this.config.clientId, SLOT_REFRESH_ACTIVE)
      .catch(() => null);
    const presented = this.refreshToken ?? storedActive;
    if (!presented) {
      this.state = "unauthenticated";
      throw new NotAuthenticatedError();
    }

    // Reuse detection: presenting a token we already rotated away from (and
    // which is no longer the active slot) is a replay — revoke the session.
    const storedPrevious = await this.store
      .get(this.config.clientId, SLOT_REFRESH_PREVIOUS)
      .catch(() => null);
    if (
      storedPrevious &&
      presented === storedPrevious &&
      presented !== storedActive
    ) {
      await this.clearCredentials();
      this.state = "unauthenticated";
      this.emit({ type: "token_reuse_detected" });
      throw new TokenReuseError();
    }

    this.state = "refreshing";
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: presented,
      client_id: this.config.clientId,
    });
    // Explicit audience/scope: per-call overrides narrow the token; the
    // configured audience always applies.
    const audience = opts?.audience ?? this.config.audience;
    if (audience) body.set("audience", audience);
    if (opts?.scopes?.length) body.set("scope", opts.scopes.join(" "));

    let tokens: TokenEndpointResponse;
    try {
      tokens = await this.tokenRequest(body, "refresh_failed");
    } catch (err) {
      if (err instanceof AuthBrokerError && err.status !== undefined && err.status < 500) {
        // The grant was rejected — the refresh token is dead. Clear it so the
        // next caller goes straight to re-login instead of retrying a corpse.
        await this.clearCredentials();
        this.state = "unauthenticated";
      } else {
        this.state = "error";
      }
      this.emit({ type: "refresh_failed", reason: (err as Error).message });
      throw err;
    }

    // Rotation with crash-safe dual-slot write: mark the consumed token as
    // previous BEFORE promoting its replacement to active. A crash between
    // the writes leaves active == previous, which the reuse check above
    // treats as legitimate (the grant is simply retried).
    if (tokens.refresh_token && tokens.refresh_token !== presented) {
      await this.store
        .set(this.config.clientId, SLOT_REFRESH_PREVIOUS, presented)
        .catch(() => {});
      await this.store
        .set(this.config.clientId, SLOT_REFRESH_ACTIVE, tokens.refresh_token)
        .catch(() => {});
      this.refreshToken = tokens.refresh_token;
    } else {
      this.refreshToken = presented;
    }

    await this.acceptTokens(tokens, "refresh");
    if (!this.accessToken) {
      throw new AuthBrokerError(
        "@capix/auth-broker: no access token after refresh",
        "malformed_token_response",
      );
    }
    return this.accessToken.token;
  }

  // ── State / account / events ────────────────────────────────────────────

  getState(): AuthState {
    return this.state;
  }

  /** Safe account view — never contains token material. */
  getAccount(): AccountInfo | null {
    return this.account ? { ...this.account } : null;
  }

  onEvent(handler: (event: AuthEvent) => void): void {
    this.handlers.add(handler);
  }

  // ── Logout / revoke ─────────────────────────────────────────────────────

  /** Revoke the refresh token server-side (best-effort) and clear local state. */
  async logout(): Promise<void> {
    await this.ready;
    const token =
      this.refreshToken ??
      (await this.store
        .get(this.config.clientId, SLOT_REFRESH_ACTIVE)
        .catch(() => null));
    try {
      if (token) {
        await this.fetchImpl(`${this.baseUrl}/oauth/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token,
            client_id: this.config.clientId,
          }),
          signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
        });
      }
    } catch {
      // Revocation is best-effort; local credentials are cleared regardless.
    } finally {
      this.cancelPendingLogin();
      await this.clearCredentials();
      this.state = "unauthenticated";
      this.emit({ type: "logout" });
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private async loadStoredCredentials(): Promise<void> {
    try {
      const [active, accountJson] = await Promise.all([
        this.store.get(this.config.clientId, SLOT_REFRESH_ACTIVE),
        this.store.get(this.config.clientId, SLOT_ACCOUNT_INFO),
      ]);
      if (active) {
        this.refreshToken = active;
        if (this.state === "unauthenticated") this.state = "authenticated";
      }
      if (accountJson && !this.account) {
        try {
          this.account = JSON.parse(accountJson) as AccountInfo;
        } catch {
          // Corrupt account cache — rebuilt on next token response.
        }
      }
    } catch {
      // Store unreadable — remain unauthenticated.
    }
  }

  /**
   * Accept a successful token-endpoint response: cache the short-lived access
   * token in memory, persist the refresh token (for login flows; refresh
   * rotation is handled by the caller), rebuild the account view and emit the
   * event.
   */
  private async acceptTokens(
    tokens: TokenEndpointResponse,
    event: "login" | "refresh",
  ): Promise<AccountInfo> {
    if (!tokens.access_token) {
      throw new AuthBrokerError(
        "@capix/auth-broker: token endpoint response missing access_token",
        "malformed_token_response",
      );
    }
    const expiresAt = Date.now() + Math.max(0, tokens.expires_in ?? 300) * 1000;
    this.accessToken = { token: tokens.access_token, expiresAt };

    if (event === "login" && tokens.refresh_token) {
      // Fresh grant: any previous rotated-out slot is superseded.
      await this.store
        .set(this.config.clientId, SLOT_REFRESH_ACTIVE, tokens.refresh_token)
        .catch(() => {});
      await this.store
        .delete(this.config.clientId, SLOT_REFRESH_PREVIOUS)
        .catch(() => {});
      this.refreshToken = tokens.refresh_token;
    }

    const claims = decodeJwtPayload(tokens.access_token);
    const accountId =
      tokens.account_id ??
      (claims?.account_id as string | undefined) ??
      (claims?.sub as string | undefined) ??
      this.account?.accountId ??
      "unknown";
    this.account = {
      accountId,
      expiresAt,
      ...(tokens.project_id || this.account?.projectId
        ? { projectId: tokens.project_id ?? this.account?.projectId }
        : {}),
      ...(tokens.wallet_address || this.account?.walletAddress
        ? { walletAddress: tokens.wallet_address ?? this.account?.walletAddress }
        : {}),
    };
    await this.store
      .set(this.config.clientId, SLOT_ACCOUNT_INFO, JSON.stringify(this.account))
      .catch(() => {});

    this.state = "authenticated";
    this.emit({ type: event, account: this.account });
    return this.account;
  }

  /** POST to the token endpoint and decode the response, mapping errors. */
  private async tokenRequest(
    body: URLSearchParams,
    fallbackCode: string,
  ): Promise<TokenEndpointResponse> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body,
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new AuthBrokerError(
        `@capix/auth-broker: token endpoint unreachable: ${(err as Error).message}`,
        "network_error",
      );
    }
    const payload = (await res.json().catch(() => ({}))) as TokenEndpointResponse;
    if (!res.ok) {
      throw new AuthBrokerError(
        payload.error_description ??
          `@capix/auth-broker: token request failed (${res.status})`,
        payload.error ?? fallbackCode,
        res.status,
      );
    }
    return payload;
  }

  /** Handle a loopback redirect hit on the PKCE listener. */
  private acceptLoopbackCallback(
    req: IncomingMessage,
    res: ServerResponse,
  ): void {
    const pending = this.pending;
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
      return;
    }
    const finish = (status: number, message: string): void => {
      res.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(
        `<!doctype html><title>Capix sign-in</title><p>${message}</p>`,
      );
    };
    const errorParam = url.searchParams.get("error");
    if (errorParam) {
      finish(400, `Capix sign-in failed (${errorParam}). Return to the app.`);
      return;
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!pending || !state || state !== pending.state || !code) {
      finish(400, "Capix sign-in failed: state mismatch. Return to the app.");
      return;
    }
    this.capturedCode = { code, state };
    finish(200, "Capix sign-in complete — you can close this window.");
    // The code is captured; the listener is no longer needed. Keep `pending`
    // (verifier/state) alive for completeLogin().
    setTimeout(() => pending.server.close(), 250).unref();
  }

  private cancelPendingLogin(): void {
    if (this.pending) {
      clearTimeout(this.pending.timeout);
      try {
        this.pending.server.close();
      } catch {
        // best-effort
      }
      this.pending = null;
    }
  }

  private async clearCredentials(): Promise<void> {
    this.accessToken = null;
    this.refreshToken = null;
    this.account = null;
    await Promise.all([
      this.store.delete(this.config.clientId, SLOT_REFRESH_ACTIVE).catch(() => {}),
      this.store.delete(this.config.clientId, SLOT_REFRESH_PREVIOUS).catch(() => {}),
      this.store.delete(this.config.clientId, SLOT_ACCOUNT_INFO).catch(() => {}),
    ]);
  }

  private emit(event: AuthEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // A broken listener must not break the broker.
      }
    }
  }
}
