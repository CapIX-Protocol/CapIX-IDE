"use strict";
/**
 * Capix API client — wraps fetch calls to capix.network /api/llm/* routes.
 * The production origin is compiled into the product. Workspace settings must
 * never be able to redirect an authenticated request.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CapixApiError = exports.CapixClient = void 0;
const node_crypto_1 = require("node:crypto");
const moneyUtils_1 = require("./moneyUtils");
class CapixClient {
    static PRODUCTION_BASE_URL = "https://www.capix.network";
    /** Cached session token (loaded from SecretStorage on first use) */
    _sessionToken = null;
    _tokenProvider;
    _secretStorage;
    _onOAuthAccessToken;
    _lastPublishedOAuthAccessToken = null;
    _refreshPromise = null;
    _inFlightGets = new Map();
    /** Wire up VS Code SecretStorage for secure (non-plaintext) token storage */
    setSecretStorage(store) {
        this._secretStorage = store;
    }
    /** Keep the native chat surface synchronized whenever OAuth rotates. */
    setOAuthAccessTokenHandler(handler) {
        this._onOAuthAccessToken = handler;
    }
    /** Forget only Capix OAuth credentials, including all in-memory copies. */
    async resetOAuthSession() {
        if (!this._secretStorage)
            throw new Error("OS SecretStorage is unavailable");
        await Promise.all([
            this._secretStorage.delete("capix.sessionToken"),
            this._secretStorage.delete("capix.refreshToken"),
        ]);
        this._sessionToken = null;
        this._lastPublishedOAuthAccessToken = null;
        await this._onOAuthAccessToken?.(null);
    }
    async publishOAuthAccessToken(accessToken) {
        if (accessToken === this._lastPublishedOAuthAccessToken)
            return;
        await this._onOAuthAccessToken?.(accessToken);
        this._lastPublishedOAuthAccessToken = accessToken;
    }
    /** Restore the shared Capix router after a private endpoint is removed. */
    async restoreRoutedChat() {
        const accessToken = await this.getStoredToken();
        if (!this.isOAuthAccessToken(accessToken))
            throw new Error("Capix sign-in is required");
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
    /** Delegate all token reads/refreshes to the shared auth broker. */
    setTokenProvider(provider) {
        this._tokenProvider = provider;
    }
    async getAuthHeaders() {
        if (this._tokenProvider) {
            try {
                const token = await this._tokenProvider.getAccessToken();
                if (token) {
                    this._sessionToken = token;
                    return { Authorization: `Bearer ${token}` };
                }
            }
            catch {
                // Broker has no valid grant — fall through to the legacy store so the
                // 401 retry path can surface a definitive signed-out state.
            }
        }
        const token = await this.getStoredToken();
        return token ? { Authorization: `Bearer ${token}` } : {};
    }
    async refreshOAuthToken() {
        if (this._refreshPromise)
            return this._refreshPromise;
        this._refreshPromise = this.performOAuthRefresh(true).finally(() => {
            this._refreshPromise = null;
        });
        return this._refreshPromise;
    }
    async performOAuthRefresh(recoverCrossWindow) {
        if (this._tokenProvider) {
            try {
                const token = await this._tokenProvider.getAccessToken();
                this._sessionToken = token;
                await this.publishOAuthAccessToken(token);
                return true;
            }
            catch {
                await this.clearExpiredOAuthSession();
                return false;
            }
        }
        const refreshToken = await this._secretStorage?.get("capix.refreshToken");
        if (!refreshToken) {
            await this.clearExpiredOAuthSession();
            return false;
        }
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
                    await this.publishOAuthAccessToken(storedAccess);
                    return true;
                }
                if (storedRefresh && storedRefresh !== refreshToken) {
                    return this.performOAuthRefresh(false);
                }
            }
            await this.clearExpiredOAuthSession();
            return false;
        }
        await this.saveOAuthTokens(tokens.access_token, tokens.refresh_token || refreshToken);
        return true;
    }
    async clearExpiredOAuthSession() {
        this._sessionToken = null;
        this._lastPublishedOAuthAccessToken = null;
        await this._secretStorage?.delete("capix.sessionToken");
        await this._onOAuthAccessToken?.(null);
    }
    async authenticatedFetch(url, init = {}, retry = true, networkAttempt = 0) {
        const method = String(init.method || "GET").toUpperCase();
        const safeRead = method === "GET" || method === "HEAD";
        const requestInit = {
            ...init,
            signal: init.signal ?? (safeRead ? AbortSignal.timeout(6_000) : undefined),
            headers: { ...(init.headers || {}), ...(await this.getAuthHeaders()) },
        };
        let response;
        try {
            response = await fetch(url, requestInit);
        }
        catch (error) {
            if (safeRead && networkAttempt < 2) {
                const backoff = 250 * 2 ** networkAttempt + Math.random() * 250;
                console.warn("Capix could not reach the network. Retrying…", { url: new URL(url).pathname, attempt: networkAttempt + 1, cause: String(error), retryInMs: Math.round(backoff) });
                await new Promise((resolve) => setTimeout(resolve, backoff));
                return this.authenticatedFetch(url, init, retry, networkAttempt + 1);
            }
            throw Object.assign(new Error("Capix could not reach the network. Retrying…"), { code: "network_unreachable", cause: String(error), transient: true });
        }
        if (response.status === 401 && retry && await this.refreshOAuthToken())
            return this.authenticatedFetch(url, init, false);
        if (safeRead && [429, 502, 503, 504].includes(response.status) && networkAttempt < 2) {
            const backoff = 250 * 2 ** networkAttempt + Math.random() * 250;
            console.warn("Capix could not reach the network. Retrying…", { url: new URL(url).pathname, attempt: networkAttempt + 1, status: response.status, retryInMs: Math.round(backoff) });
            await new Promise((resolve) => setTimeout(resolve, backoff));
            return this.authenticatedFetch(url, init, retry, networkAttempt + 1);
        }
        return response;
    }
    get isConfigured() {
        return Boolean(this._sessionToken && this.isOAuthAccessToken(this._sessionToken));
    }
    /** Async config check (used by tools that can await) */
    async checkConfigured() {
        if (this._tokenProvider) {
            try {
                const token = await this._tokenProvider.getAccessToken();
                if (this.isOAuthAccessToken(token)) {
                    this._sessionToken = token;
                    await this.publishOAuthAccessToken(token);
                    return true;
                }
            }
            catch {
                // No valid broker grant — fall through to the legacy probe.
            }
        }
        const stored = await this._secretStorage?.get("capix.sessionToken");
        const token = stored || await this.getStoredToken();
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
        const existing = this._inFlightGets.get(path);
        if (existing)
            return existing;
        const request = (async () => {
            const res = await this.authenticatedFetch(`${this.baseUrl}${path}`);
            const data = await res.json().catch(() => ({}));
            if (res.ok === false)
                throw new CapixApiError(res.status, data.error || `request_failed_${res.status}`);
            return data;
        })();
        this._inFlightGets.set(path, request);
        return request.finally(() => {
            if (this._inFlightGets.get(path) === request)
                this._inFlightGets.delete(path);
        });
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
    async streamAgentChat(input, signal, onEvent) {
        // Canonical streaming inference route — /api/v1/chat/completions is the
        // non-streaming JSON compatibility surface and silently yields zero SSE
        // events, so the chat panel must stream from the canonical route.
        const res = await this.authenticatedFetch(`${this.baseUrl}/api/v1/inference/chat/completions`, { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify(input), signal });
        if (!res.ok || !res.body)
            throw new CapixApiError(res.status, `inference_failed_${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let data = [];
        const emit = async (raw) => {
            if (raw === "[DONE]")
                return;
            let parsed;
            try {
                parsed = JSON.parse(raw);
            }
            catch {
                return;
            }
            // Canonical Capix stream contract (@capix/contracts inference-stream).
            if (parsed.type === "capix.route") {
                await onEvent({ type: "route", receiptId: String(parsed.receiptId ?? ""), model: String(parsed.modelCapability ?? (input && input.model) ?? ""), region: String(parsed.region ?? "global"), privacy: parsed.privacyClass });
                return;
            }
            if (parsed.type === "content.delta") {
                await onEvent({ type: "delta", content: typeof parsed.content === "string" ? parsed.content : "", toolCalls: undefined });
                return;
            }
            if (parsed.type === "tool.delta") {
                await onEvent({ type: "delta", content: undefined, toolCalls: [{ id: parsed.toolCallId, function: parsed.function, index: parsed.index }] });
                return;
            }
            if (parsed.type === "capix.usage") {
                await onEvent({ type: "usage", inputTokens: Number(parsed.inputUnits ?? 0), outputTokens: Number(parsed.outputUnits ?? 0), costMinor: (0, moneyUtils_1.usageCostToMicroUsd)(parsed.provisionalCost), currency: "USD" });
                return;
            }
            if (parsed.type === "capix.final") {
                await onEvent({ type: "final", finishReason: String(parsed.finishReason ?? "stop"), receiptId: String(parsed.receiptId ?? "") });
                return;
            }
            if (parsed.type === "capix.error")
                throw new CapixApiError(Number(parsed.status ?? 500), String(parsed.capixCode ?? "inference_error"));
            // OpenAI-compatible chunks (compatibility surface / older gateways).
            const choice = parsed.choices?.[0];
            if (choice?.delta?.content !== undefined || choice?.delta?.tool_calls !== undefined)
                await onEvent({ type: "delta", content: choice.delta.content, toolCalls: choice.delta.tool_calls });
            if (parsed.capix?.receiptId || parsed.receiptId)
                await onEvent({ type: "route", receiptId: parsed.capix?.receiptId ?? parsed.receiptId, model: parsed.model ?? (input && input.model), region: parsed.capix?.region ?? "global", privacy: parsed.capix?.privacy });
            if (parsed.usage)
                await onEvent({ type: "usage", inputTokens: Number(parsed.usage.prompt_tokens ?? 0), outputTokens: Number(parsed.usage.completion_tokens ?? 0), costMinor: String(parsed.usage.cost_minor ?? parsed.capix?.costMinor ?? "0"), currency: String(parsed.usage.currency ?? parsed.capix?.currency ?? "USD") });
        };
        try {
            while (true) {
                const chunk = await reader.read();
                if (chunk.done)
                    break;
                buffer += decoder.decode(chunk.value, { stream: true });
                let i;
                while ((i = buffer.indexOf("\n")) >= 0) {
                    const line = buffer.slice(0, i).replace(/\r$/, "");
                    buffer = buffer.slice(i + 1);
                    if (!line) {
                        if (data.length)
                            await emit(data.join("\n"));
                        data = [];
                    }
                    else if (line.startsWith("data:"))
                        data.push(line.slice(5).trimStart());
                }
            }
            if (data.length)
                await emit(data.join("\n"));
        }
        finally {
            reader.releaseLock();
        }
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
        const result = await this.get("/api/v1/gpu");
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
        const [result, inventory] = await Promise.all([
            this.get("/api/v1/billing"),
            this.listInstances(),
        ]);
        if (!result.ok)
            return result;
        const sol = (0, moneyUtils_1.minorToDisplay)(result.balances?.SOL?.available || "0", 9, 4);
        const usdc = (0, moneyUtils_1.minorToDisplay)(result.balances?.USDC?.available || "0", 6, 2);
        const transactions = result.transactions || [];
        const debitEntries = transactions.reduce((acc, entry) => {
            if (!entry || typeof entry !== "object")
                return acc;
            const row = entry;
            if ((row.postingType ?? row.posting_type) !== "debit" || row.asset !== "USDC")
                return acc;
            acc.push({ amount: String(row.amount || "0"), scale: Number(row.scale ?? 6) });
            return acc;
        }, []);
        const spentSum = (0, moneyUtils_1.sumMinor)(debitEntries);
        const totalSpent = (0, moneyUtils_1.minorToDisplay)(spentSum.amount.toString(), spentSum.scale, 2);
        const activeInstances = inventory.instances.filter((instance) => !["terminated", "deleted", "destroyed"].includes(instance.status)).length;
        return {
            ok: true,
            balance: { usd: Number.isFinite(Number(result.valuation?.usdTotal)) ? Number(result.valuation?.usdTotal).toFixed(2) : usdc, sol, usdc },
            transactions,
            updatedAt: new Date().toISOString(),
            activeInstances,
            totalSpent,
            instances: inventory.instances.map((instance) => ({
                id: instance.id, tier: instance.tier, status: instance.status,
                startedAt: instance.startedAt, costUsdPerHour: instance.costUsdPerHour,
                paymentAsset: "USDC",
            })),
        };
    }
    // ── Instances: canonical owner-scoped deployments ─────────────────────
    async listInstances() {
        const result = await this.get("/api/v1/deployments?limit=100");
        return {
            ok: true,
            instances: (result.data || []).map((deployment) => {
                const workload = deployment.workloadSpec || {};
                const allocations = deployment.allocations || [];
                return {
                    id: deployment.id,
                    tier: String(workload.name || workload.modelId || workload.kind || "Capix compute"),
                    status: String(deployment.phase || "pending").toLowerCase(),
                    startedAt: deployment.createdAt || new Date(0).toISOString(),
                    costUsdPerHour: 0,
                    nodes: allocations.map((allocation, index) => ({
                        nodeId: String(allocation.nodeId || allocation.id || `${deployment.id}-${index}`),
                        location: String(allocation.region || allocation.location || "Capix network"),
                        sshHost: typeof allocation.sshHost === "string" ? allocation.sshHost : null,
                        sshPort: typeof allocation.sshPort === "number" ? allocation.sshPort : null,
                        gpu: typeof allocation.gpu === "string" ? allocation.gpu : null,
                        agentOnline: allocation.agentOnline === true,
                        sshAvailable: allocation.sshAvailable === true,
                    })),
                };
            }),
        };
    }
    async retrieveSshCredential(deploymentId) {
        const res = await this.authenticatedFetch(`${this.baseUrl}/api/v1/deployments/${encodeURIComponent(deploymentId)}/ssh`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Idempotency-Key": (0, node_crypto_1.randomUUID)() },
        });
        const contentType = res.headers.get("content-type") || "";
        if (!res.ok) {
            const error = contentType.includes("json")
                ? await res.json().catch(() => ({}))
                : { detail: await res.text().catch(() => "") };
            throw new CapixApiError(res.status, error.detail || error.error || "SSH credential is unavailable or was already retrieved.");
        }
        let privateKey;
        let host;
        let port;
        let filename;
        if (contentType.includes("json")) {
            const data = await res.json().catch(() => ({}));
            privateKey = data.privateKey || "";
            host = data.host || "";
            port = Number(data.port || 0);
            filename = data.filename || `${deploymentId}.pem`;
        }
        else {
            privateKey = await res.text();
            host = res.headers.get("x-capix-ssh-host") || "";
            port = Number(res.headers.get("x-capix-ssh-port") || 0);
            filename = res.headers.get("x-capix-ssh-filename") || `${deploymentId}.pem`;
        }
        if (!host || !Number.isInteger(port) || port <= 0 || !privateKey.includes("PRIVATE KEY")) {
            throw new CapixApiError(502, "The SSH credential response was incomplete. The key was not written to disk.");
        }
        return { host, port, privateKey, filename };
    }
    /**
     * Return the deployment credential from the OS credential store, retrieving
     * it from the control plane only on first use. This makes SSH reliably
     * reusable without repeatedly exposing the private key over the network.
     */
    async getStoredSshCredential(deploymentId) {
        if (!this._secretStorage)
            throw new Error("OS SecretStorage is unavailable");
        const storageKey = `capix.ssh.${deploymentId}`;
        const stored = await this._secretStorage.get(storageKey);
        if (stored) {
            try {
                const credential = JSON.parse(stored);
                if (credential.host && Number.isInteger(credential.port) && credential.privateKey?.includes("PRIVATE KEY")) {
                    return {
                        host: credential.host,
                        port: Number(credential.port),
                        privateKey: credential.privateKey,
                        filename: credential.filename || `${deploymentId}.pem`,
                    };
                }
            }
            catch {
                // Corrupt local material is removed and recovered from the server.
            }
            await this._secretStorage.delete(storageKey);
        }
        const credential = await this.retrieveSshCredential(deploymentId);
        await this._secretStorage.store(storageKey, JSON.stringify(credential));
        return credential;
    }
    /**
     * Explicitly rotate an unavailable deployment key. Rotation is never an
     * automatic retry: the caller must obtain customer confirmation because it
     * revokes the previous key on the instance.
     */
    async rotateSshCredential(deploymentId) {
        const res = await this.authenticatedFetch(`${this.baseUrl}/api/v1/deployments/${encodeURIComponent(deploymentId)}/ssh/rotate`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Idempotency-Key": (0, node_crypto_1.randomUUID)() },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok)
            throw new CapixApiError(res.status, data.detail || data.error || "SSH key rotation failed.");
        if (!data.rotated || !data.oldKeyRevokedOnInstance) {
            throw new CapixApiError(409, "The new SSH key could not be installed on the instance. The existing key was not replaced.");
        }
        await this._secretStorage?.delete(`capix.ssh.${deploymentId}`);
        return { rotated: true, oldKeyRevokedOnInstance: true };
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