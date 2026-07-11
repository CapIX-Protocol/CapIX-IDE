"use strict";
/**
 * Capix IDE — Smart Router + Private LLM + Loop Engineering integration.
 *
 * This is the IDE-side counterpart to capix-code's smartRouter.ts.
 * It mirrors the same Covenant memory system so the IDE and CLI
 * share learned preferences.
 *
 * Three modes:
 * 1. AUTO — dynamically picks the best model from OpenRouter + Surplus
 * 2. PRIVATE — uses the user's deployed private LLM (or deploys one via MCP)
 * 3. LOOP — same as PRIVATE, agent builds until done, then destroys LLM
 *
 * The router is born with memory — loads from
 * ~/.config/capix-code/smart-router-memory.json so it knows what it
 * learned in previous sessions (including from capix-code CLI usage).
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
exports.SmartRouterManager = void 0;
const vscode = __importStar(require("vscode"));
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
function getConfigDir() {
    switch (process.platform) {
        case "darwin": return (0, node_path_1.join)((0, node_os_1.homedir)(), "Library", "Application Support", "capix-code");
        case "win32": return (0, node_path_1.join)((0, node_os_1.homedir)(), "AppData", "Roaming", "capix-code");
        default: return (0, node_path_1.join)((0, node_os_1.homedir)(), ".config", "capix-code");
    }
}
const MEMORY_FILE = (0, node_path_1.join)(getConfigDir(), "smart-router-memory.json");
function loadMemory() {
    try {
        if (!(0, node_fs_1.existsSync)(MEMORY_FILE))
            return blankMemory();
        return JSON.parse((0, node_fs_1.readFileSync)(MEMORY_FILE, "utf-8"));
    }
    catch {
        return blankMemory();
    }
}
function saveMemory(mem) {
    try {
        (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(MEMORY_FILE), { recursive: true });
        mem.updatedAt = new Date().toISOString();
        (0, node_fs_1.writeFileSync)(MEMORY_FILE, JSON.stringify(mem, null, 2), "utf-8");
    }
    catch { /* read-only fs */ }
}
function blankMemory() {
    return { ratings: {}, blockedModels: [], favoredModels: [], updatedAt: new Date().toISOString() };
}
class SmartRouterManager {
    client;
    memory;
    activePrivateEndpoint;
    constructor(client) {
        this.client = client;
        this.memory = loadMemory();
    }
    // ── Mode ────────────────────────────────────────────────────────────────
    getMode() {
        const env = (process.env.CAPIX_ROUTE_MODE || "auto").toLowerCase();
        if (env === "private")
            return "private";
        if (env === "loop")
            return "loop";
        return "auto";
    }
    async setMode(mode) {
        // Set the env var for child processes (capix-code terminals)
        process.env.CAPIX_ROUTE_MODE = mode;
        // Update VS Code terminal env
        const config = vscode.workspace.getConfiguration("capix");
        await config.update("routeMode", mode, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Capix: routing mode set to ${mode.toUpperCase()}.`);
    }
    // ── Private endpoint lifecycle ──────────────────────────────────────────
    hasPrivateEndpoint() {
        return Boolean(this.activePrivateEndpoint);
    }
    getPrivateEndpoint() {
        return this.activePrivateEndpoint;
    }
    setPrivateEndpoint(endpoint) {
        this.activePrivateEndpoint = endpoint;
        this.memory.lastPrivateEndpoint = { baseUrl: endpoint.baseUrl, instanceId: endpoint.instanceId, modelLabel: endpoint.modelLabel };
        saveMemory(this.memory);
    }
    clearPrivateEndpoint() {
        this.activePrivateEndpoint = undefined;
        this.memory.lastPrivateEndpoint = undefined;
        saveMemory(this.memory);
    }
    // ── Deploy a private LLM (via the Capix API) ────────────────────────────
    /**
     * Deploy a private uncensored LLM for the user's coding session.
     * Picks the best Jiunsong model based on available GPU offers.
     * Returns when the endpoint is ready.
     */
    async deployPrivateLlm() {
        const baseUrl = this.client.getBaseUrl();
        // Step 1: find uncensored models in the catalog.
        const catalogRes = await this.client.get("/api/llm/models");
        if (!catalogRes.ok || !catalogRes.models)
            return null;
        const uncensored = catalogRes.models.filter((m) => m.uncensored);
        if (uncensored.length === 0) {
            vscode.window.showErrorMessage("No uncensored models available in the catalog.");
            return null;
        }
        // Step 2: let the user pick (or auto-pick the first).
        const pick = await vscode.window.showQuickPick(uncensored.map((m) => ({ label: m.label, description: `${m.minVramGb}GB VRAM`, modelId: m.id })), { placeHolder: "Select a private uncensored model to deploy" });
        if (!pick)
            return null;
        // Step 3: find GPU offers for the selected model.
        const offersRes = await this.client.get(`/api/llm/offers?modelId=${pick.modelId}`);
        if (!offersRes.ok || !offersRes.offers?.length) {
            vscode.window.showErrorMessage("No live GPU offers for that model right now.");
            return null;
        }
        // Step 4: pick the cheapest offer.
        const cheapest = offersRes.offers.sort((a, b) => a.pricePerHr - b.pricePerHr)[0];
        const confirm = await vscode.window.showWarningMessage(`Deploy ${pick.label} on ${cheapest.gpu} in ${cheapest.location}?\n$${cheapest.pricePerHr.toFixed(2)}/hr`, { modal: true }, "Deploy");
        if (confirm !== "Deploy")
            return null;
        // Step 5: deploy + wait for ready.
        const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Deploying ${pick.label}...`, cancellable: false }, async (progress) => {
            progress.report({ message: "Renting GPU + booting vLLM..." });
            const deployRes = await this.client.post("/api/llm/deploy", {
                modelId: pick.modelId,
                askId: cheapest.askId,
                durationHours: 1,
            });
            if (!deployRes.ok || !deployRes.instanceId) {
                throw new Error(deployRes.error || "Deploy failed");
            }
            // Poll until ready.
            progress.report({ message: "Model downloading + booting (2-10 min)..." });
            for (let i = 0; i < 80; i++) {
                const status = await this.client.get(`/api/llm/${deployRes.instanceId}?action=status`);
                if (status.ok && status.ready && status.baseOpenAiUrl) {
                    return {
                        baseUrl: status.baseOpenAiUrl,
                        apiKey: deployRes.apiKey,
                        instanceId: deployRes.instanceId,
                        modelLabel: status.modelLabel || pick.label,
                    };
                }
                await new Promise((r) => setTimeout(r, 15000));
                progress.report({ message: `Waiting for model... (${i * 15}s elapsed)` });
            }
            throw new Error("Timed out waiting for model to boot.");
        });
        if (result) {
            this.setPrivateEndpoint(result);
            vscode.window.showInformationMessage(`✓ ${result.modelLabel} is ready! Private endpoint: ${result.baseUrl}`);
            // Mint dev tokens for the deploy.
            this.client.storeSecret("capix.ai.apiKey", result.apiKey);
            const config = vscode.workspace.getConfiguration("capix");
            await config.update("ai.baseUrl", result.baseUrl, vscode.ConfigurationTarget.Global);
            await config.update("ai.model", result.modelLabel, vscode.ConfigurationTarget.Global);
        }
        return result;
    }
    /**
     * Destroy the active private LLM endpoint and stop billing.
     */
    async destroyPrivateLlm() {
        if (!this.activePrivateEndpoint) {
            vscode.window.showInformationMessage("No private LLM endpoint active.");
            return;
        }
        const confirm = await vscode.window.showWarningMessage(`Destroy ${this.activePrivateEndpoint.modelLabel}?\nBilling stops immediately.`, { modal: true }, "Destroy");
        if (confirm !== "Destroy")
            return;
        const res = await this.client.get(`/api/llm/${this.activePrivateEndpoint.instanceId}`);
        // Note: DELETE would be ideal but our client only has GET/POST. Use the IDE's own delete.
        // Actually we can use fetch directly:
        try {
            const baseUrl = this.client.getBaseUrl();
            await fetch(`${baseUrl}/api/llm/${this.activePrivateEndpoint.instanceId}`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${process.env.CAPIX_API_KEY}` },
            });
        }
        catch { /* ignore */ }
        const modelLabel = this.activePrivateEndpoint.modelLabel;
        this.clearPrivateEndpoint();
        vscode.window.showInformationMessage(`✓ Destroyed ${modelLabel}. Billing stopped.`);
    }
    // ── Learning ────────────────────────────────────────────────────────────
    recordOverride(rejectedModel, chosenModel, taskType) {
        if (!this.memory.ratings[rejectedModel])
            this.memory.ratings[rejectedModel] = { reasoning: { score: 0, selections: 0, overrides: 0 }, coding: { score: 0, selections: 0, overrides: 0 } };
        this.memory.ratings[rejectedModel][taskType].overrides++;
        if (!this.memory.ratings[chosenModel])
            this.memory.ratings[chosenModel] = { reasoning: { score: 0, selections: 0, overrides: 0 }, coding: { score: 0, selections: 0, overrides: 0 } };
        this.memory.ratings[chosenModel][taskType].selections++;
        saveMemory(this.memory);
    }
    blockModel(model) {
        if (!this.memory.blockedModels.includes(model)) {
            this.memory.blockedModels.push(model);
            saveMemory(this.memory);
            vscode.window.showInformationMessage(`Capix: blocked model '${model}'. Won't be suggested again.`);
        }
    }
    favorModel(model) {
        if (!this.memory.favoredModels.includes(model)) {
            this.memory.favoredModels.push(model);
            saveMemory(this.memory);
            vscode.window.showInformationMessage(`Capix: favored model '${model}'. Will be preferred.`);
        }
    }
    // ── Memory inspection ──────────────────────────────────────────────────
    getMemorySummary() {
        const m = this.memory;
        const topModels = Object.entries(m.ratings)
            .sort(([, a], [, b]) => {
            const aScore = (a.coding.selections - a.coding.overrides * 2) + (a.reasoning.selections - a.reasoning.overrides * 2);
            const bScore = (b.coding.selections - b.coding.overrides * 2) + (b.reasoning.selections - b.reasoning.overrides * 2);
            return bScore - aScore;
        })
            .slice(0, 5)
            .map(([model, r]) => `  ${model}: coding ${r.coding.selections}× (${r.coding.overrides} overrides), reasoning ${r.reasoning.selections}× (${r.reasoning.overrides} overrides)`);
        return [
            `Routing mode: ${this.getMode().toUpperCase()}`,
            `Private endpoint: ${this.activePrivateEndpoint ? this.activePrivateEndpoint.modelLabel : "none"}`,
            `Blocked: ${m.blockedModels.length > 0 ? m.blockedModels.join(", ") : "none"}`,
            `Favored: ${m.favoredModels.length > 0 ? m.favoredModels.join(", ") : "none"}`,
            `Top models:`,
            ...topModels,
        ].join("\n");
    }
    resetMemory() {
        this.memory = blankMemory();
        this.activePrivateEndpoint = undefined;
        saveMemory(this.memory);
        vscode.window.showInformationMessage("Capix: Smart Router memory cleared.");
    }
}
exports.SmartRouterManager = SmartRouterManager;
//# sourceMappingURL=smartRouterManager.js.map