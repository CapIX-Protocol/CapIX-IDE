"use strict";
/**
 * Capix API client — wraps fetch calls to capix.network /api/llm/* routes.
 * The production origin is compiled into the product. Workspace settings must
 * never be able to redirect an authenticated request.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CapixApiError = exports.CapixClient = void 0;
const node_crypto_1 = require("node:crypto");
class CapixClient {
    static PRODUCTION_BASE_URL = "https://www.capix.network";
    /** Cached session token (loaded from SecretStorage on first use) */
    _sessionToken = null;
    _secretStorage;
    _onOAuthAccessToken;
    _lastPublishedOAuthAccessToken = null;
    /** Wire up VS Code SecretStorage for secure (non-plaintext) token storage */
    setSecretStorage(store) {
        this._secretStorage = store;
    }
    /** Keep the native chat surface synchronized whenever OAuth rotates. */
    setOAuthAccessTokenHandler(handler) {
        this._onOAuthAccessToken = handler;
    }
    async publishOAuthAccessToken(accessToken) {
        if (accessToken === this._lastPublishedOAuthAccessToken)
            return;
        await this._onOAuthAccessToken?.(accessToken);
        this._lastPublishedOAuthAccessToken = accessToken;
    }
    /** Read an arbitrary secret from SecretStorage (extension-internal use only) */
    async getSecret(key) {
        return this._secretStorage?.get(key);
    }
    /** Write an arbitrary secret to SecretStorage (extension-internal use only) */
    async storeSecret(key, value) {
        await this._secretStorage?.store(key, value);
    }
    /** Persist tokens obtained only through the native OAuth PKCE flow. */
    async saveOAuthTokens(accessToken, refreshToken) {
        if (!accessToken.startsWith("cpxs_"))
            throw new Error("Invalid Capix OAuth access token");
        this._sessionToken = accessToken;
        if (!this._secretStorage)
            throw new Error("OS SecretStorage is unavailable");
        await this._secretStorage.store("capix.sessionToken", accessToken);
        if (refreshToken)
            await this._secretStorage.store("capix.refreshToken", refreshToken);
        await this.publishOAuthAccessToken(accessToken);
    }
    get baseUrl() {
        return CapixClient.PRODUCTION_BASE_URL;
    }
    getBaseUrl() {
        return this.baseUrl;
    }
    /** Lazily fetch the session token from SecretStorage (avoids plaintext in settings.json) */
    async getStoredToken() {
        if (this._sessionToken)
            return this._sessionToken;
        if (this._secretStorage) {
            const stored = await this._secretStorage.get("capix.sessionToken");
            if (stored) {
                this._sessionToken = stored;
                return stored;
            }
        }
        return "";
    }
    async getAuthHeaders() {
        const token = await this.getStoredToken();
        return token ? { Authorization: `Bearer ${token}` } : {};
    }
    async refreshOAuthToken(recoverCrossWindow = true) {
        const refreshToken = await this._secretStorage?.get("capix.refreshToken");
        if (!refreshToken)
            return false;
        const response = await fetch(`${CapixClient.PRODUCTION_BASE_URL}/oauth/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
            body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: "capix-ide" }),
        });
        const tokens = await response.json();
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
    async authenticatedFetch(url, init = {}, retry = true) {
        const response = await fetch(url, { ...init, headers: { ...(init.headers || {}), ...(await this.getAuthHeaders()) } });
        if (response.status === 401 && retry && await this.refreshOAuthToken())
            return this.authenticatedFetch(url, init, false);
        return response;
    }
    get isConfigured() {
        return Boolean(this._sessionToken && this.isOAuthAccessToken(this._sessionToken));
    }
    /** Async config check (used by tools that can await) */
    async checkConfigured() {
        const token = await this.getStoredToken();
        this._sessionToken = token;
        const configured = this.isOAuthAccessToken(token);
        if (configured)
            await this.publishOAuthAccessToken(token);
        return configured;
    }
    isOAuthAccessToken(token) {
        return token.startsWith("cpxs_") || token.startsWith("cpx_session.");
    }
    async get(path) {
        const res = await this.authenticatedFetch(`${this.baseUrl}${path}`);
        const data = await res.json().catch(() => ({}));
        if (res.ok === false)
            throw new CapixApiError(res.status, data.error || `request_failed_${res.status}`);
        return data;
    }
    async post(path, body) {
        const res = await this.authenticatedFetch(`${this.baseUrl}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Idempotency-Key": (0, node_crypto_1.randomUUID)() },
            body: JSON.stringify(body),
        });
        return res.json();
    }
    async delete(path) {
        const res = await this.authenticatedFetch(`${this.baseUrl}${path}`, {
            method: "DELETE",
            headers: { "Idempotency-Key": (0, node_crypto_1.randomUUID)() },
        });
        return res.json();
    }
    // ── Model catalog ──────────────────────────────────────────────────────
    async getCatalog() {
        return this.get("/api/llm/models");
    }
    // ── GPU offers for a model ─────────────────────────────────────────────
    async getOffers(modelId, region) {
        const params = new URLSearchParams({ modelId });
        if (region && region !== "global")
            params.set("region", region);
        return this.get(`/api/llm/offers?${params}`);
    }
    // ── Deploy a catalog model ─────────────────────────────────────────────
    async deployModel(modelId, askId, durationHours, diskGb, hfToken) {
        return this.post("/api/llm/deploy", { modelId, askId, durationHours, diskGb, hfToken });
    }
    // ── Deploy a custom model (Hugging Face link) ──────────────────────────
    async deployCustomModel(opts) {
        return this.post("/api/llm/custom", { action: "deploy", ...opts });
    }
    // ── Discover specs from a Hugging Face link ────────────────────────────
    async discoverCustom(link) {
        return this.post("/api/llm/custom", { action: "discover", link });
    }
    // ── List + status of user's deploys ────────────────────────────────────
    async listDeploys() {
        return this.get("/api/llm/0?action=list");
    }
    async getDeployStatus(instanceId) {
        return this.get(`/api/llm/${instanceId}?action=status`);
    }
    // ── Destroy / stop / start ──────────────────────────────────────────────
    async destroyDeploy(instanceId) {
        return this.delete(`/api/llm/${instanceId}`);
    }
    async stopInstance(instanceId) {
        return this.post(`/api/cloud/instances/${instanceId}`, { action: "stop" });
    }
    async startInstance(instanceId) {
        return this.post(`/api/cloud/instances/${instanceId}`, { action: "start" });
    }
    // ── Logs + exec ────────────────────────────────────────────────────────
    async getLogs(instanceId) {
        return this.get(`/api/llm/${instanceId}?action=logs`);
    }
    async execOnInstance(instanceId, command) {
        return this.get(`/api/llm/${instanceId}?action=exec&command=${encodeURIComponent(command)}`);
    }
    // ── Hosted endpoints (ready now) ──────────────────────────────────────
    async getHosted() {
        return this.get("/api/llm/hosted");
    }
    async revealHostedKey(modelId) {
        return this.get(`/api/llm/hosted?reveal=true&modelId=${encodeURIComponent(modelId)}`);
    }
    // ── Wallet balance ────────────────────────────────────────────────────
    async getBalance() {
        const result = await this.get("/api/v1/billing");
        if (!result.ok)
            return result;
        const sol = Number(result.balances?.SOL?.available || 0) / 1e9;
        const usdc = Number(result.balances?.USDC?.available || 0) / 1e6;
        return { ok: true, balance: { usd: usdc, sol, usdc }, activeInstances: 0, totalSpent: 0 };
    }
    // ── Billing: base treasury address for USDC on Base ───────────────────
    async getBaseTreasury() {
        return this.get("/api/cloud/billing?action=base-treasury");
    }
    // ── Deposit (SOL or USDC on Solana — returns a tx signature) ──────────
    // The actual signing happens in the web browser with the Solana wallet
    // adapter. The IDE just opens the billing page for the user to complete.
    // For USDC on Base (EVM), the user sends manually and submits the tx hash.
    async submitBaseDeposit(txHash, amountUsd) {
        return this.post("/api/cloud/billing", { action: "deposit", signature: txHash, asset: "USDC_BASE", amountUsd });
    }
    // ── Deploy quote (for showing per-minute costs) ────────────────────────
    async getQuote(tierId, hours) {
        return this.get(`/api/cloud/deploy/quote?tierId=${tierId}&hours=${hours}&asset=SOL`);
    }
    // ── Instance Deploy (VPS — sharded multi-node) ────────────────────────
    async deployInstance(tierId, region, durationHours, image) {
        return this.post("/api/cloud/deploy", { tierId, region, durationHours, image });
    }
    // ── GPU Deploy (dedicated GPU from live offers) ───────────────────────
    async getGpuOffers() {
        return this.get("/api/cloud/gpu-deploy?action=offers");
    }
    async getGpuInstances() {
        return this.get("/api/cloud/gpu-deploy?action=instances");
    }
    async deployGpu(askId, diskGb, durationHours) {
        return this.post("/api/cloud/gpu-deploy", { askId, diskGb, durationHours });
    }
    // ── Agent Deploy (GitHub repo → pod) ──────────────────────────────────
    async getAgents() {
        return this.get("/api/cloud/agent-deploy");
    }
    async deployAgent(repoUrl, branch, envVars, useUnifiedInference, startCommand) {
        return this.post("/api/cloud/agent-deploy", { repoUrl, branch, envVars, useUnifiedInference, startCommand });
    }
    // ── Serverless Jobs ───────────────────────────────────────────────────
    async getJobs() {
        return this.get("/api/cloud/job-trigger");
    }
    async triggerJob(yaml) {
        return this.post("/api/cloud/job-trigger", { yaml });
    }
    // ── Instances: list, detail, control ───────────────────────────────────
    async getInstanceDetail(instanceId) {
        return this.get(`/api/cloud/instances/${instanceId}`);
    }
    async controlInstance(instanceId, action, command, timeoutMs) {
        return this.post(`/api/cloud/instances/${instanceId}`, { action, command, timeoutMs });
    }
    // ── API Keys (for the chat gateway) ───────────────────────────────────
    async getApiKeys() {
        return this.get("/api/cloud/api-keys");
    }
    async createApiKey(name) {
        return this.post("/api/cloud/api-keys", { name, action: "create" });
    }
    async revokeApiKey(keyId) {
        return this.post("/api/cloud/api-keys", { action: "revoke", keyId });
    }
    // ── Chat (OpenAI-compatible gateway — for auto-connect) ────────────────
    async chat(body, apiKey) {
        const headers = { "Content-Type": "application/json" };
        if (apiKey)
            headers.Authorization = `Bearer ${apiKey}`;
        else
            Object.assign(headers, await this.getAuthHeaders());
        const res = await fetch(`${this.baseUrl}/api/v1/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
        });
        return res.json();
    }
    // ── Logs ──────────────────────────────────────────────────────────────
    async getPodLogs(podId) {
        return this.get(`/api/cloud/logs?podId=${encodeURIComponent(podId)}`);
    }
    // ── Pods cluster ───────────────────────────────────────────────────────
    async getPodCluster() {
        return this.get("/api/cloud/pods?action=cluster");
    }
    // ── Dev Tokens (proof-of-development minting) ───────────────────────────
    async getDevTokenBalance() {
        return this.get("/api/devtokens?wallet=me");
    }
    async mintDevTokens(reason, proof) {
        return this.post("/api/devtokens", { reason, proof });
    }
}
exports.CapixClient = CapixClient;
class CapixApiError extends Error {
    status;
    code;
    constructor(status, code) {
        super(code);
        this.status = status;
        this.code = code;
        this.name = "CapixApiError";
    }
}
exports.CapixApiError = CapixApiError;
//# sourceMappingURL=apiClient.js.map