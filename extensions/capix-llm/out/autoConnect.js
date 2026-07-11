"use strict";
/**
 * Auto-Connect — when an LLM deploy becomes ready (on IDE or web),
 * automatically configure the AI chat provider so the user can start
 * chatting immediately without manual copy-paste.
 *
 * How it works:
 * 1. The auto-refresh loop polls `/api/llm/[id]?action=status` for
 *    provisioning deploys until `ready` flips to true.
 * 2. When ready, we fetch the API key via `?action=reveal-key` (auth-gated).
 * 3. We write the base URL + API key into VS Code Settings under
 *    `capix.ai.baseUrl` and `capix.ai.apiKey` — which the Void/Capix
 *    chat panel reads as its `openAICompatible` provider config.
 * 4. We show a notification: "Your endpoint is ready — chat panel
 *    auto-configured."
 *
 * If the user deployed on the web (capix.network), the same session token
 * is used in the IDE — so the deploy shows up in "My Deploys" and
 * auto-connects here too. Seamless web ↔ IDE sync.
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
exports.AutoConnectManager = void 0;
const vscode = __importStar(require("vscode"));
const logger_1 = require("./logger");
class AutoConnectManager {
    client;
    watched = new Set();
    constructor(client) {
        this.client = client;
    }
    /**
     * Watch a provisioning deploy. Polls until ready, then auto-configures
     * the chat provider settings.
     */
    watchDeploy(instanceId, modelLabel) {
        // Canonical saga deployments use opaque saga IDs and are observed through
        // `/api/v1/gpu`; never poll the retired numeric legacy route.
        if (instanceId <= 0)
            return;
        if (this.watched.has(instanceId))
            return;
        this.watched.add(instanceId);
        vscode.window.showInformationMessage(`Capix: ${modelLabel} is provisioning — we'll auto-configure the chat panel when it's ready.`);
        this.poll(instanceId, modelLabel);
    }
    async poll(instanceId, modelLabel) {
        const pollInterval = 15000; // 15s
        const maxAttempts = 80; // ~20 min
        for (let i = 0; i < maxAttempts; i++) {
            try {
                const status = await this.client.getDeployStatus(instanceId);
                if (status.ok && status.ready && status.baseOpenAiUrl) {
                    // Deploy is live — reveal the API key and auto-configure.
                    await this.autoConfigureChat(instanceId, modelLabel, status.baseOpenAiUrl);
                    this.watched.delete(instanceId);
                    return;
                }
            }
            catch (err) {
                logger_1.logger.error("AutoConnectManager.poll failed", { error: String(err) });
            }
            await new Promise((r) => setTimeout(r, pollInterval));
        }
        // Timed out — stop watching silently.
        this.watched.delete(instanceId);
        vscode.window.showWarningMessage(`Capix: ${modelLabel} took longer than 20 min to become ready. Check the Instances panel manually.`);
    }
    async autoConfigureChat(instanceId, modelLabel, baseUrl) {
        try {
            // Fetch the API key via the reveal-key action (auth-gated, rate-limited).
            const keyRes = await this.client.get(`/api/llm/${instanceId}?action=reveal-key`);
            if (!keyRes.ok || !keyRes.apiKey) {
                // Can't get the key — fall back to manual.
                vscode.window.showInformationMessage(`✓ ${modelLabel} is ready! Endpoint: ${baseUrl}`, "Copy URL").then((action) => {
                    if (action === "Copy URL")
                        vscode.env.clipboard.writeText(baseUrl);
                });
                return;
            }
            // Keep the endpoint available for explicit private-endpoint workflows, but
            // never replace the authenticated Capix routed chat automatically. A
            // private instance can later be stopped, expired, or rate limited; making
            // it the global chat provider causes apparently random 429/connection
            // failures on the next IDE launch. OAuth sign-in owns the default route.
            const config = vscode.workspace.getConfiguration("capix");
            await config.update("ai.baseUrl", baseUrl, vscode.ConfigurationTarget.Global);
            await config.update("ai.model", modelLabel, vscode.ConfigurationTarget.Global);
            await this.client.storeSecret("capix.ai.apiKey", keyRes.apiKey);
            await this.client.restoreRoutedChat();
            vscode.window.showInformationMessage(`✓ ${modelLabel} is ready! Capix routed chat remains active.`, "Start chatting").then((action) => {
                if (action === "Start chatting") {
                    vscode.commands.executeCommand("workbench.panel.chat");
                }
            });
        }
        catch (err) {
            logger_1.logger.error("autoConfigureChat failed", { error: String(err) });
            vscode.window.showInformationMessage(`✓ ${modelLabel} is ready! Endpoint: ${baseUrl} — configure it in Settings → AI.`);
        }
    }
    /**
     * Check all existing deploys on startup. If any are already ready,
     * auto-configure from the most recent one.
     */
    async checkExistingDeploys() {
        if (!await this.client.checkConfigured())
            return;
        try {
            const res = await this.client.listDeploys();
            if (!res.ok)
                return;
            const ready = res.deploys
                .filter((d) => d.live && d.live.ready && d.live.endpoint)
                .sort((a, b) => (b.live.instanceId - a.live.instanceId));
            if (ready.length > 0) {
                const latest = ready[0].live;
                await this.autoConfigureChat(latest.instanceId, latest.modelLabel, `${latest.endpoint}/v1`);
            }
            // Watch any provisioning deploys.
            for (const d of res.deploys) {
                if (d.live && !d.live.ready && d.live.state !== "stopped") {
                    this.watchDeploy(d.live.instanceId, d.live.modelLabel);
                }
            }
        }
        catch (err) {
            const status = err.status;
            if (status === 401)
                logger_1.logger.info("Auto-connect is waiting for a refreshed Capix session");
            else if (status === 503)
                logger_1.logger.info("Auto-connect is waiting for the deployment service");
            else
                logger_1.logger.error("checkExistingDeploys failed", { error: String(err) });
        }
    }
}
exports.AutoConnectManager = AutoConnectManager;
//# sourceMappingURL=autoConnect.js.map