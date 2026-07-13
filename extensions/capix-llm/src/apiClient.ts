/**
 * Capix API client — wraps fetch calls to capix.network /api/llm/* routes.
 * The production origin is compiled into the product. Workspace settings must
 * never be able to redirect an authenticated request.
 */

import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import type { CatalogModel, GpuOffer, LlmDeploy, HostedEndpoint, DeployResult } from "./types";

// ── Settlement & Proof types ────────────────────────────────────────────

/** Canonical leaf field in JSON form. BigInt values are decimal strings. */
export type FieldJSON =
  | { kind: "hash"; value: string }
  | { kind: "u64"; value: string }
  | { kind: "string"; value: string }
  | { kind: "bytes"; value: string }
  | { kind: "null" }
  | { kind: "u8"; value: number }
  | { kind: "bool"; value: boolean };

/** Settlement layer status (all u64/bigint values as decimal strings). */
export interface SettlementStatus {
  currentEpoch: string;
  lastFinalizedEpoch: string;
  lastSettlementRoot: string;
  cluster: string;
  programId: string;
  paused: boolean;
  lastAnchoredTimestamp: string | null;
}

/** A finalized settlement epoch entry. */
export interface SettlementEpoch {
  epoch: string;
  root: string;
  txSignature: string | null;
  anchoredAt: string | null;
  leafCount: string;
}

/** Complete proof package — wraps the Merkle proof with settlement metadata. */
export interface ProofPackage {
  leafCategory: string;
  leafVersion: number;
  leaf: FieldJSON[];
  leafIndex: string;
  leafCount: string;
  path: { sibling: string; siblingIsRight: boolean }[];
  root: string;
  epoch: string;
  txSignature: string | null;
  programId: string;
  cluster: string;
  verifyInstructions: string;
}

/** Balance proof variant (account leaf in the settlement tree). */
export type BalanceProofPackage = ProofPackage;
/** Usage proof variant (route-receipt leaf). */
export type UsageProofPackage = ProofPackage;
/** Dev-token proof variant (proof-of-development leaf). */
export type DevProofPackage = ProofPackage;

/** CPX billing overview — all amounts as string minor units (no float). */
export interface CpxBilling {
  walletBalanceMinor: string;
  depositedBalanceMinor: string;
  decimals: number;
  priceUsd: string;
  priceSource: string;
  priceUpdatedAt: string | null;
  perMinuteRateMinor: string;
  burnedThisEpochMinor: string;
  currentEpoch: string;
}

export class CapixClient {
  static readonly PRODUCTION_BASE_URL = "https://www.capix.network";
  /** Cached session token (loaded from SecretStorage on first use) */
  private _sessionToken: string | null = null;
  private _secretStorage?: { get: (key: string) => Promise<string | undefined>; store: (key: string, value: string) => Promise<void>; delete: (key: string) => Promise<void> };
  private _onOAuthAccessToken?: (accessToken: string | null) => Promise<void>;
  private _lastPublishedOAuthAccessToken: string | null = null;

  /** Wire up VS Code SecretStorage for secure (non-plaintext) token storage */
  setSecretStorage(store: { get: (key: string) => Promise<string | undefined>; store: (key: string, value: string) => Promise<void>; delete: (key: string) => Promise<void> }): void {
    this._secretStorage = store;
  }

  /** Keep the native chat surface synchronized whenever OAuth rotates. */
  setOAuthAccessTokenHandler(handler: (accessToken: string | null) => Promise<void>): void {
    this._onOAuthAccessToken = handler;
  }

  /** Forget only Capix OAuth credentials, including all in-memory copies. */
  async resetOAuthSession(): Promise<void> {
    if (!this._secretStorage) throw new Error("OS SecretStorage is unavailable");
    await Promise.all([
      this._secretStorage.delete("capix.sessionToken"),
      this._secretStorage.delete("capix.refreshToken"),
    ]);
    this._sessionToken = null;
    this._lastPublishedOAuthAccessToken = null;
    await this._onOAuthAccessToken?.(null);
  }

  private async publishOAuthAccessToken(accessToken: string): Promise<void> {
    if (accessToken === this._lastPublishedOAuthAccessToken) return;
    await this._onOAuthAccessToken?.(accessToken);
    this._lastPublishedOAuthAccessToken = accessToken;
  }

  /** Restore the shared Capix router after a private endpoint is removed. */
  async restoreRoutedChat(): Promise<void> {
    const accessToken = await this.getStoredToken();
    if (!this.isOAuthAccessToken(accessToken)) throw new Error("Capix sign-in is required");
    await this._onOAuthAccessToken?.(accessToken);
    this._lastPublishedOAuthAccessToken = accessToken;
  }

  /** Read an arbitrary secret from SecretStorage (extension-internal use only) */
  async getSecret(key: string): Promise<string | undefined> {
    return this._secretStorage?.get(key);
  }

  /** Write an arbitrary secret to SecretStorage (extension-internal use only) */
  async storeSecret(key: string, value: string): Promise<void> {
    await this._secretStorage?.store(key, value);
  }

  /** Persist tokens obtained only through the native OAuth PKCE flow. */
  async saveOAuthTokens(accessToken: string, refreshToken?: string): Promise<void> {
    if (!accessToken.startsWith("cpxs_")) throw new Error("Invalid Capix OAuth access token");
    this._sessionToken = accessToken;
    if (!this._secretStorage) throw new Error("OS SecretStorage is unavailable");
    await this._secretStorage.store("capix.sessionToken", accessToken);
    if (refreshToken) await this._secretStorage.store("capix.refreshToken", refreshToken);
    await this.publishOAuthAccessToken(accessToken);
  }

  get baseUrl(): string {
    return CapixClient.PRODUCTION_BASE_URL;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  /** Lazily fetch the session token from SecretStorage (avoids plaintext in settings.json) */
  async getStoredToken(): Promise<string> {
    if (this._sessionToken) return this._sessionToken;
    if (this._secretStorage) {
      const stored = await this._secretStorage.get("capix.sessionToken");
      if (stored) { this._sessionToken = stored; return stored; }
    }
    return "";
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await this.getStoredToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  private async refreshOAuthToken(recoverCrossWindow = true): Promise<boolean> {
    const refreshToken = await this._secretStorage?.get("capix.refreshToken");
    if (!refreshToken) return false;
    const response = await fetch(`${CapixClient.PRODUCTION_BASE_URL}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: "capix-ide" }),
    });
    const tokens = await response.json() as { access_token?: string; refresh_token?: string };
    if (!response.ok || !tokens.access_token) {
      // SecretStorage is shared by all CapixIDE windows, but each extension host
      // has its own in-memory token cache. A second window can lose the refresh
      // rotation race after the first window has already stored fresh tokens.
      // Adopt those credentials instead of leaving this window permanently 401.
      if (recoverCrossWindow && this._secretStorage) {
        const [storedAccess, storedRefresh] = await Promise.all([
          this._secretStorage.get("capix.sessionToken"),
          this._secretStorage.get("capix.refreshToken"),
        ]);
        if (storedAccess && storedAccess !== this._sessionToken) {
          this._sessionToken = storedAccess;
          return true;
        }
        if (storedRefresh && storedRefresh !== refreshToken) {
          return this.refreshOAuthToken(false);
        }
      }
      this._sessionToken = null;
      return false;
    }
    await this.saveOAuthTokens(tokens.access_token, tokens.refresh_token || refreshToken);
    return true;
  }

  private async authenticatedFetch(url: string, init: RequestInit = {}, retry = true): Promise<Response> {
    const response = await fetch(url, { ...init, headers: { ...(init.headers || {}), ...(await this.getAuthHeaders()) } });
    if (response.status === 401 && retry && await this.refreshOAuthToken()) return this.authenticatedFetch(url, init, false);
    return response;
  }

  get isConfigured(): boolean {
    return Boolean(this._sessionToken && this.isOAuthAccessToken(this._sessionToken));
  }

  /** Async config check (used by tools that can await) */
  async checkConfigured(): Promise<boolean> {
    const token = await this.getStoredToken();
    this._sessionToken = token;
    const configured = this.isOAuthAccessToken(token);
    if (configured) await this.publishOAuthAccessToken(token);
    return configured;
  }

  private isOAuthAccessToken(token: string): boolean {
    return token.startsWith("cpxs_") || token.startsWith("cpx_session.");
  }

  async get<T = unknown>(path: string): Promise<T> {
    const res = await this.authenticatedFetch(`${this.baseUrl}${path}`);
    const data = await res.json().catch(() => ({})) as T & { error?: string };
    if (res.ok === false) throw new CapixApiError(res.status, data.error || `request_failed_${res.status}`);
    return data;
  }

  async post<T = unknown>(path: string, body: unknown): Promise<T> {
    const res = await this.authenticatedFetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify(body),
    });
    return res.json() as Promise<T>;
  }

  async delete<T = unknown>(path: string): Promise<T> {
    const res = await this.authenticatedFetch(`${this.baseUrl}${path}`, {
      method: "DELETE",
      headers: { "Idempotency-Key": randomUUID() },
    });
    return res.json() as Promise<T>;
  }

  // ── Model catalog ──────────────────────────────────────────────────────
  async getCatalog(): Promise<{ ok: boolean; models: CatalogModel[] }> {
    return this.get("/api/llm/models");
  }

  // ── GPU offers for a model ─────────────────────────────────────────────
  async getOffers(modelId: string, region?: string): Promise<{ ok: boolean; offers: GpuOffer[] }> {
    const params = new URLSearchParams({ modelId });
    if (region && region !== "global") params.set("region", region);
    return this.get(`/api/llm/offers?${params}`);
  }

  // ── Deploy a catalog model ─────────────────────────────────────────────
  async deployModel(modelId: string, askId: number, durationHours: number, diskGb?: number, hfToken?: string): Promise<DeployResult & { ok: boolean; error?: string }> {
    return this.post("/api/llm/deploy", { modelId, askId, durationHours, diskGb, hfToken });
  }

  // ── Deploy a custom model (Hugging Face link) ──────────────────────────
  async deployCustomModel(opts: {
    link: string; label?: string; askId: number; durationHours: number;
    minVramGb?: number; gpuCount?: number; contextWindow?: number;
    quantization?: string; gated?: boolean; hfToken?: string; manual?: boolean;
  }): Promise<DeployResult & { ok: boolean; error?: string }> {
    return this.post("/api/llm/custom", { action: "deploy", ...opts });
  }

  // ── Discover specs from a Hugging Face link ────────────────────────────
  async discoverCustom(link: string): Promise<{ ok: boolean; spec?: unknown; error?: string; fallback?: string }> {
    return this.post("/api/llm/custom", { action: "discover", link });
  }

  // ── List + status of user's deploys ────────────────────────────────────
  async listDeploys(): Promise<{ ok: boolean; deploys: Array<{ instance: unknown; live: LlmDeploy | null }> }> {
    const result = await this.get<{ok:boolean;sagas?:Array<{sagaId:string;state:string;assetId:string|null;workload:string;modelId:string|null;expiresAt:string;createdAt:string}>}>("/api/v1/gpu");
    return {
      ok: result.ok,
      deploys: (result.sagas || []).map((saga) => ({
        instance: { id: saga.sagaId, tier: saga.workload === "llm" ? `LLM · ${saga.modelId || "Private model"}` : "Dedicated GPU", status: saga.state.toLowerCase(), expiresAt: saga.expiresAt },
        live: {
          instanceId: 0,
          modelLabel: saga.modelId || (saga.workload === "llm" ? "Private model" : "Dedicated GPU"),
          state: saga.state === "ACTIVE" ? "running" : saga.state === "TERMINATED" || saga.state === "COMPENSATED" ? "stopped" : "loading",
          endpoint: null,
          ready: false,
          apiKey: null,
          gpu: "",
          location: "",
          pricePerHr: 0,
        },
      })),
    };
  }

  async getDeployStatus(instanceId: number): Promise<LlmDeploy & { ok: boolean; baseOpenAiUrl?: string }> {
    return this.get(`/api/llm/${instanceId}?action=status`);
  }

  // ── Destroy / stop / start ──────────────────────────────────────────────
  async destroyDeploy(instanceId: number): Promise<{ ok: boolean }> {
    return this.delete(`/api/llm/${instanceId}`);
  }

  async stopInstance(instanceId: string): Promise<{ ok: boolean }> {
    return this.post(`/api/cloud/instances/${instanceId}`, { action: "stop" });
  }

  async startInstance(instanceId: string): Promise<{ ok: boolean }> {
    return this.post(`/api/cloud/instances/${instanceId}`, { action: "start" });
  }

  // ── Logs + exec ────────────────────────────────────────────────────────
  async getLogs(instanceId: number): Promise<{ ok: boolean; logs: string; source: string; error?: string }> {
    return this.get(`/api/llm/${instanceId}?action=logs`);
  }

  async execOnInstance(instanceId: number, command: string): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
    return this.get(`/api/llm/${instanceId}?action=exec&command=${encodeURIComponent(command)}`);
  }

  // ── Hosted endpoints (ready now) ──────────────────────────────────────
  async getHosted(): Promise<{ ok: boolean; endpoints: HostedEndpoint[] }> {
    return this.get("/api/llm/hosted");
  }

  async revealHostedKey(modelId: string): Promise<{ ok: boolean; apiKey?: string; error?: string }> {
    return this.get(`/api/llm/hosted?reveal=true&modelId=${encodeURIComponent(modelId)}`);
  }

  // ── Wallet balance ────────────────────────────────────────────────────
  async getBalance(): Promise<{ ok: boolean; balance?: { usd: number; sol: number; usdc: number }; transactions?: unknown[]; updatedAt?: string; activeInstances?: number; totalSpent?: number; error?: string }> {
    const result = await this.get<{ ok: boolean; balances?: { SOL?: { available?: string }; USDC?: { available?: string } }; transactions?: unknown[]; error?: string }>("/api/v1/billing");
    if (!result.ok) return result;
    const sol = Number(result.balances?.SOL?.available || 0) / 1e9;
    const usdc = Number(result.balances?.USDC?.available || 0) / 1e6;
    return { ok: true, balance: { usd: usdc, sol, usdc }, transactions: result.transactions || [], updatedAt: new Date().toISOString(), activeInstances: 0, totalSpent: 0 };
  }

  // ── Billing: base treasury address for USDC on Base ───────────────────
  async getBaseTreasury(): Promise<{ ok: boolean; treasury?: string; chain?: string; contract?: string; explorer?: string }> {
    return this.get("/api/cloud/billing?action=base-treasury");
  }

  // ── Deposit (SOL or USDC on Solana — returns a tx signature) ──────────
  // The actual signing happens in the web browser with the Solana wallet
  // adapter. The IDE just opens the billing page for the user to complete.
  // For USDC on Base (EVM), the user sends manually and submits the tx hash.
  async submitBaseDeposit(txHash: string, amountUsd: number): Promise<{ ok: boolean; balanceUsd?: number; error?: string }> {
    return this.post("/api/cloud/billing", { action: "deposit", signature: txHash, asset: "USDC_BASE", amountUsd });
  }

  // ── Deploy quote (for showing per-minute costs) ────────────────────────
  async getQuote(tierId: string, hours: number): Promise<{ ok: boolean; quote?: { amountUsd: number; assetPrice: number } }> {
    return this.get(`/api/cloud/deploy/quote?tierId=${tierId}&hours=${hours}&asset=SOL`);
  }

  // ── Instance Deploy (VPS — sharded multi-node) ────────────────────────
  async deployInstance(tierId: string, region: string, durationHours: number, image?: string): Promise<{ ok: boolean; instance?: unknown; error?: string }> {
    return this.post("/api/cloud/deploy", { tierId, region, durationHours, image });
  }

  // ── GPU Deploy (dedicated GPU from live offers) ───────────────────────
  async getGpuOffers(): Promise<{ ok: boolean; offers?: unknown[] }> {
    return this.get("/api/cloud/gpu-deploy?action=offers");
  }

  async getGpuInstances(): Promise<{ ok: boolean; instances?: unknown[] }> {
    return this.get("/api/cloud/gpu-deploy?action=instances");
  }

  async deployGpu(askId: number, diskGb: number, durationHours: number): Promise<{ ok: boolean; instanceId?: number; label?: string; gpu?: string; pricePerHr?: number; chargedUsd?: number; error?: string }> {
    return this.post("/api/cloud/gpu-deploy", { askId, diskGb, durationHours });
  }

  // ── Agent Deploy (GitHub repo → pod) ──────────────────────────────────
  async getAgents(): Promise<{ ok: boolean; agents?: unknown[] }> {
    return this.get("/api/cloud/agent-deploy");
  }

  async deployAgent(repoUrl: string, branch: string, envVars: Record<string, string>, useUnifiedInference: boolean, startCommand?: string): Promise<{ ok: boolean; deployment?: unknown; error?: string }> {
    return this.post("/api/cloud/agent-deploy", { repoUrl, branch, envVars, useUnifiedInference, startCommand });
  }

  // ── Serverless Jobs ───────────────────────────────────────────────────
  async getJobs(): Promise<{ ok: boolean; jobs?: unknown[] }> {
    return this.get("/api/cloud/job-trigger");
  }

  async triggerJob(yaml: string): Promise<{ ok: boolean; job?: unknown; error?: string }> {
    return this.post("/api/cloud/job-trigger", { yaml });
  }

  // ── Instances: list, detail, control ───────────────────────────────────
  async getInstanceDetail(instanceId: string): Promise<{ ok: boolean; instance?: unknown }> {
    return this.get(`/api/cloud/instances/${instanceId}`);
  }

  async controlInstance(instanceId: string, action: "stop" | "start" | "destroy", command?: string, timeoutMs?: number): Promise<{ ok: boolean; results?: unknown[]; error?: string }> {
    return this.post(`/api/cloud/instances/${instanceId}`, { action, command, timeoutMs });
  }

  // ── API Keys (for the chat gateway) ───────────────────────────────────
  async getApiKeys(): Promise<{ ok: boolean; keys?: unknown[] }> {
    return this.get("/api/cloud/api-keys");
  }

  async createApiKey(name: string): Promise<{ ok: boolean; secret?: string; warning?: string; error?: string }> {
    return this.post("/api/cloud/api-keys", { name, action: "create" });
  }

  async revokeApiKey(keyId: string): Promise<{ ok: boolean }> {
    return this.post("/api/cloud/api-keys", { action: "revoke", keyId });
  }

  // ── Chat (OpenAI-compatible gateway — for auto-connect) ────────────────
  async chat(body: { messages: Array<{ role: string; content: string }>; model?: string; max_tokens?: number }, apiKey?: string): Promise<{ ok: boolean; capix?: { route: string; tokensBilled: number; usdCost: number } }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    else Object.assign(headers, await this.getAuthHeaders());
    const res = await fetch(`${this.baseUrl}/api/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return res.json() as Promise<{ ok: boolean; capix?: { route: string; tokensBilled: number; usdCost: number } }>;
  }

  // ── Logs ──────────────────────────────────────────────────────────────
  async getPodLogs(podId: string): Promise<{ ok: boolean; logs?: unknown[] }> {
    return this.get(`/api/cloud/logs?podId=${encodeURIComponent(podId)}`);
  }

  // ── Pods cluster ───────────────────────────────────────────────────────
  async getPodCluster(): Promise<{ ok: boolean; cluster?: unknown; nodes?: unknown[] }> {
    return this.get("/api/cloud/pods?action=cluster");
  }

  // ── Dev Tokens (proof-of-development minting) ───────────────────────────
  async getDevTokenBalance(): Promise<{ ok: boolean; balance?: number; totalEarned?: number }> {
    return this.get("/api/devtokens?wallet=me");
  }

  async mintDevTokens(reason: string, proof: { sessionId?: string; repoHash?: string; commitSha?: string; toolUsed: "capix-code" | "capix-ide" }): Promise<{ ok: boolean; mint?: unknown; message?: string; error?: string }> {
    return this.post("/api/devtokens", { reason, proof });
  }

  // ── Settlement status & proofs ────────────────────────────────────────

  async getSettlementStatus(): Promise<SettlementStatus & { ok: boolean; error?: string }> {
    return this.get("/api/v1/settlement/status");
  }

  async getSettlementEpochs(): Promise<{ ok: boolean; epochs?: SettlementEpoch[]; error?: string }> {
    return this.get("/api/v1/settlement/epochs");
  }

  async getBalanceProof(): Promise<BalanceProofPackage & { ok: boolean; error?: string }> {
    return this.get("/api/v1/settlement/proof/balance");
  }

  async getUsageProof(receiptId: string): Promise<UsageProofPackage & { ok: boolean; error?: string }> {
    return this.get(`/api/v1/settlement/proof/usage/${encodeURIComponent(receiptId)}`);
  }

  async getDevProof(awardId: string): Promise<DevProofPackage & { ok: boolean; error?: string }> {
    return this.get(`/api/v1/settlement/proof/dev/${encodeURIComponent(awardId)}`);
  }

  async getCpxBilling(): Promise<CpxBilling & { ok: boolean; error?: string }> {
    return this.get("/api/v1/settlement/cpx-billing");
  }
}

export class CapixApiError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
    this.name = "CapixApiError";
  }
}
