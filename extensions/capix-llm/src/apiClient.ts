/**
 * Capix API client — wraps fetch calls to capix.network /api/llm/* routes.
 * The production origin is compiled into the product. Workspace settings must
 * never be able to redirect an authenticated request.
 */

import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import type { CatalogModel, GpuOffer, LlmDeploy, HostedEndpoint, DeployResult } from "./types";

export class CapixClient {
  static readonly PRODUCTION_BASE_URL = "https://www.capix.network";
  /** Cached session token (loaded from SecretStorage on first use) */
  private _sessionToken: string | null = null;
  private _secretStorage?: { get: (key: string) => Promise<string | undefined>; store: (key: string, value: string) => Promise<void> };

  /** Wire up VS Code SecretStorage for secure (non-plaintext) token storage */
  setSecretStorage(store: { get: (key: string) => Promise<string | undefined>; store: (key: string, value: string) => Promise<void> }): void {
    this._secretStorage = store;
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

  private async refreshOAuthToken(): Promise<boolean> {
    const refreshToken = await this._secretStorage?.get("capix.refreshToken");
    if (!refreshToken) return false;
    const response = await fetch(`${CapixClient.PRODUCTION_BASE_URL}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: "capix-ide" }),
    });
    const tokens = await response.json() as { access_token?: string; refresh_token?: string };
    if (!response.ok || !tokens.access_token) { this._sessionToken = null; return false; }
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
    return this.isOAuthAccessToken(token);
  }

  private isOAuthAccessToken(token: string): boolean {
    return token.startsWith("cpxs_") || token.startsWith("cpx_session.");
  }

  async get<T = unknown>(path: string): Promise<T> {
    const res = await this.authenticatedFetch(`${this.baseUrl}${path}`);
    return res.json() as Promise<T>;
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
    return this.get("/api/llm/0?action=list");
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
  async getBalance(): Promise<{ ok: boolean; balance?: { usd: number; sol: number; usdc: number }; activeInstances?: number; totalSpent?: number; error?: string }> {
    const result = await this.get<{ ok: boolean; balances?: { SOL?: { available?: string }; USDC?: { available?: string } }; error?: string }>("/api/v1/billing");
    if (!result.ok) return result;
    const sol = Number(result.balances?.SOL?.available || 0) / 1e9;
    const usdc = Number(result.balances?.USDC?.available || 0) / 1e6;
    return { ok: true, balance: { usd: usdc, sol, usdc }, activeInstances: 0, totalSpent: 0 };
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
}
