/**
 * Capix Auth Broker Service — the IDE's authentication boundary, backed by
 * the SHARED auth broker (`@capix/auth-broker`, vendored under `src/shared/`).
 *
 * One OAuth 2.1 native-app flow for every Capix client (CLI, IDE, MCP):
 * Authorization Code + PKCE over an ephemeral loopback listener, short-lived
 * access tokens held in memory only, single-flight proactive refresh, and
 * rotating refresh tokens with reuse detection. Persisted credentials live in
 * VS Code SecretStorage (OS keychain), never in plaintext settings.
 *
 * `CapixClient` delegates every token read/refresh to this service via
 * `setTokenProvider`, so ALL IDE API calls authenticate through the shared
 * broker — one identity shared with the other Capix apps.
 */

import * as vscode from "vscode";
import {
  AuthBroker,
  type AccountInfo,
  type AuthEvent,
  type AuthState,
  type CredentialStore,
} from "./shared/auth-broker/index";
import { logger } from "./logger";

const CLIENT_ID = "capix-ide";
const SCOPE = "openid account catalog offline_access";

// Slot names mirror @capix/auth-broker's internal credential-store slots
// (refresh-token:active / refresh-token:previous / account-info). They are
// restated here only for the one-time legacy migration.
const SLOT_REFRESH_ACTIVE = "refresh-token:active";

/** CredentialStore adapter over VS Code SecretStorage (OS keychain). */
class SecretStorageCredentialStore implements CredentialStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  private key(service: string, account: string): string {
    return `capix.broker.${service}.${account}`;
  }

  async get(service: string, account: string): Promise<string | null> {
    return (await this.secrets.get(this.key(service, account))) ?? null;
  }

  async set(service: string, account: string, secret: string): Promise<void> {
    await this.secrets.store(this.key(service, account), secret);
  }

  async delete(service: string, account: string): Promise<void> {
    await this.secrets.delete(this.key(service, account));
  }
}

export class CapixAuthBrokerService {
  private readonly broker: AuthBroker;
  private readonly store: SecretStorageCredentialStore;

  constructor(context: vscode.ExtensionContext, baseUrl: string) {
    this.store = new SecretStorageCredentialStore(context.secrets);
    this.broker = new AuthBroker(
      { baseUrl, clientId: CLIENT_ID, scope: SCOPE },
      this.store,
    );
  }

  /** Broker events (login / refresh / logout / refresh_failed / token_reuse_detected). */
  onEvent(handler: (event: AuthEvent) => void): void {
    this.broker.onEvent(handler);
  }

  getState(): AuthState {
    return this.broker.getState();
  }

  /** Safe account view — never contains token material. */
  getAccount(): AccountInfo | null {
    return this.broker.getAccount();
  }

  /**
   * A valid access token, refreshing proactively inside the broker's expiry
   * skew. Throws NotAuthenticatedError when signed out.
   */
  async getAccessToken(): Promise<string> {
    return this.broker.getAccessToken();
  }

  /**
   * Browser PKCE sign-in. The broker binds its own ephemeral loopback
   * listener, validates state at this privileged boundary and captures the
   * redirect; we drive the system browser and poll for the capture.
   */
  async signIn(timeoutMs = 120_000): Promise<AccountInfo> {
    const { authorizeUrl } = await this.broker.startLogin();
    await vscode.env.openExternal(vscode.Uri.parse(authorizeUrl));
    const captured = await this.waitForCapturedCode(timeoutMs);
    return this.broker.completeLogin(captured.code, captured.state);
  }

  private async waitForCapturedCode(
    timeoutMs: number,
  ): Promise<{ code: string; state: string }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.broker.capturedCode) return this.broker.capturedCode;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("Capix sign-in timed out waiting for the browser callback.");
  }

  /** Revoke the refresh token server-side (best-effort) and clear local state. */
  async signOut(): Promise<void> {
    await this.broker.logout();
  }

  /**
   * One-time migration: seed the broker's credential store from the legacy
   * SecretStorage slots written by the pre-broker sign-in flow. No-op once
   * the broker holds an active refresh token.
   */
  async migrateLegacySession(legacy: {
    get(key: string): Promise<string | undefined>;
  }): Promise<void> {
    try {
      const existing = await this.store.get(CLIENT_ID, SLOT_REFRESH_ACTIVE);
      if (existing) return;
      const legacyRefresh = await legacy.get("capix.refreshToken");
      if (legacyRefresh) {
        await this.store.set(CLIENT_ID, SLOT_REFRESH_ACTIVE, legacyRefresh);
        logger.info("Capix auth: migrated legacy session into the shared auth broker");
      }
    } catch (err) {
      logger.warn("Capix auth: legacy session migration failed", { error: String(err) });
    }
  }
}
