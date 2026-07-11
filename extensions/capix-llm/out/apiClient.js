"use strict";
/**
 * Capix API client — wraps fetch calls to capix.network /api/llm/* routes.
 * Uses the session token from VS Code settings as a Bearer header.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.CapixClient = void 0;
const vscode = __importStar(require("vscode"));
class CapixClient {
    /** Cached session token (loaded from SecretStorage on first use) */
    _sessionToken = null;
    _secretStorage;
    /** Wire up VS Code SecretStorage for secure (non-plaintext) token storage */
    setSecretStorage(store) {
        this._secretStorage = store;
    }
    /** Read an arbitrary secret from SecretStorage (extension-internal use only) */
    async getSecret(key) {
        return this._secretStorage?.get(key);
    }
    /** Write an arbitrary secret to SecretStorage (extension-internal use only) */
    async storeSecret(key, value) {
        await this._secretStorage?.store(key, value);
    }
    get baseUrl() {
        return vscode.workspace.getConfiguration("capix").get("baseUrl") || "https://capix.network";
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
    /** Save the session token to SecretStorage + clear plaintext settings */
    async saveSessionToken(token) {
        this._sessionToken = token;
        if (this._secretStorage) {
            await this._secretStorage.store("capix.sessionToken", token);
        }
        await vscode.workspace.getConfiguration("capix").update("sessionToken", undefined, vscode.ConfigurationTarget.Global);
    }
    async getAuthHeaders() {
        const token = await this.getStoredToken();
        return token ? { Authorization: `Bearer ${token}` } : {};
    }
    get isConfigured() {
        return Boolean(this._sessionToken && this._sessionToken.startsWith("cpx_session."));
    }
    /** Async config check (used by tools that can await) */
    async checkConfigured() {
        const token = await this.getStoredToken();
        this._sessionToken = token;
        return token.startsWith("cpx_session.");
    }
    async get(path) {
        const res = await fetch(`${this.baseUrl}${path}`, {
            headers: { ...(await this.getAuthHeaders()) },
        });
        return res.json();
    }
    async post(path, body) {
        const res = await fetch(`${this.baseUrl}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(await this.getAuthHeaders()) },
            body: JSON.stringify(body),
        });
        return res.json();
    }
    async delete(path) {
        const res = await fetch(`${this.baseUrl}${path}`, {
            method: "DELETE",
            headers: { ...(await this.getAuthHeaders()) },
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
        return this.get("/api/cloud/billing");
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
//# sourceMappingURL=apiClient.js.map