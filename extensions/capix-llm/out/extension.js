"use strict";
/**
 * Capix LLM Extension — entry point.
 *
 * Registers three sidebar tree views (deploys, catalog, hosted) and all
 * commands: deploy, deploy custom, destroy, stop, start, view logs, exec,
 * copy endpoint, copy API key, connect wallet, refresh, open console.
 *
 * The extension talks to capix.network /api/llm/* using the session token
 * from Settings. No local server needed — it's a thin API client.
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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const promises_1 = require("node:fs/promises");
const apiClient_1 = require("./apiClient");
const authBroker_1 = require("./authBroker");
const treeViews_1 = require("./treeViews");
const cloudPanels_1 = require("./cloudPanels");
const profileView_1 = require("./profileView");
const cloudDashboard_1 = require("./cloudDashboard");
const capixCodePanel_1 = require("./capixCodePanel");
const layoutPresets_1 = require("./layoutPresets");
const activityBar_1 = require("./activityBar");
const authRecovery_1 = require("./authRecovery");
const terminalManager_1 = require("./terminalManager");
const autoConnect_1 = require("./autoConnect");
const covenant_1 = require("./covenant");
const devTokenManager_1 = require("./devTokenManager");
const smartRouterManager_1 = require("./smartRouterManager");
const logger_1 = require("./logger");
const telemetry_1 = require("./telemetry");
const agentCommandBridge_1 = require("./agentCommandBridge");
const mcpAutoInstall_1 = require("./mcpAutoInstall");
const runOnSelector_1 = require("./runOnSelector");
const creationWizard_1 = require("./creationWizard");
const resourceDetails_1 = require("./resourceDetails");
const onboarding_1 = require("./onboarding");
const modelSync_1 = require("./modelSync");
const modelPicker_1 = require("./modelPicker");
const intelligencePanel_1 = require("./intelligencePanel");
const webControl_1 = require("./webControl");
const webControlPanel_1 = require("./webControlPanel");
const browserTools_1 = require("./browserTools");
const infraStack_1 = require("./infraStack");
const infraTools_1 = require("./infraTools");
const infraPanel_1 = require("./infraPanel");
const architectMode_1 = require("./architectMode");
const moneyUtils_1 = require("./moneyUtils");
let client;
let authBroker;
let mcpAutoInstaller;
let deploysProvider;
let catalogProvider;
let hostedProvider;
let instancesProvider;
let agentsProvider;
let jobsProvider;
let apiKeysProvider;
let profileProvider;
let cloudDashboardProvider;
let capixCodeProvider;
let terminalManager;
let autoConnect;
let covenant;
let devTokens;
let smartRouter;
let runOnSelector;
let creationWizard;
let resourceDetailsProvider;
let modelSync;
let modelPicker;
let onboarding;
let intelligencePanel;
let webControlManager;
let infraService;
let architectMode;
let runOnStatusBarItem = null;
let modelStatusBarItem = null;
let refreshTimer = null;
function activate(context) {
    (0, telemetry_1.initTelemetry)(context);
    client = new apiClient_1.CapixClient();
    // Security: use VS Code SecretStorage for the session token instead of plaintext settings.json
    client.setSecretStorage({
        get: (key) => Promise.resolve(context.secrets.get(key)),
        store: (key, value) => Promise.resolve(context.secrets.store(key, value)),
        delete: (key) => Promise.resolve(context.secrets.delete(key)),
    });
    // ── Shared auth broker: one identity across all Capix apps ─────────────
    // All API calls authenticate through the shared @capix/auth-broker (PKCE,
    // single-flight refresh, rotation reuse detection, SecretStorage-backed
    // credential store). Legacy sessions are migrated once on activation.
    authBroker = new authBroker_1.CapixAuthBrokerService(context, apiClient_1.CapixClient.PRODUCTION_BASE_URL);
    client.setTokenProvider(authBroker);
    context.subscriptions.push((() => {
        let disposed = false;
        void authBroker.migrateLegacySession({ get: (key) => Promise.resolve(context.secrets.get(key)) }).then(() => {
            if (!disposed)
                void client.checkConfigured();
        });
        return { dispose: () => { disposed = true; } };
    })());
    authBroker.onEvent((event) => {
        if (event.type === "token_reuse_detected") {
            logger_1.logger.error("Capix auth: refresh token reuse detected — session revoked");
            void client.resetOAuthSession();
        }
        else if (event.type === "refresh_failed") {
            logger_1.logger.warn("Capix auth: token refresh failed", { reason: event.reason });
        }
    });
    // ── MCP Auto-Installer: zero-config MCP server registration ────────────
    mcpAutoInstaller = new mcpAutoInstall_1.McpAutoInstaller(client, context);
    client.setOAuthAccessTokenHandler(async (accessToken) => {
        // The workbench stores this short-lived OAuth token using its encrypted
        // application storage and selects Capix routed inference (`auto`). Portal
        // API keys are deliberately not copied into the desktop application.
        await vscode.commands.executeCommand(accessToken ? "capix.chat.configure" : "capix.chat.clear", ...(accessToken ? [accessToken] : []));
        // Zero-config MCP: ensure the Capix MCP server is registered (with the
        // inherited token) on every credential publish, and stripped on sign-out.
        // The handler is deduped upstream (publishOAuthAccessToken), so this only
        // fires on genuine token changes — restart included.
        if (accessToken) {
            void mcpAutoInstaller.ensureInstalled();
        }
        else {
            void mcpAutoInstaller.unregister();
        }
    });
    // ── Tree views ────────────────────────────────────────────────────────
    deploysProvider = new treeViews_1.DeploysTreeProvider(client);
    catalogProvider = new treeViews_1.CatalogTreeProvider(client);
    hostedProvider = new treeViews_1.HostedTreeProvider(client);
    instancesProvider = new cloudPanels_1.InstancesTreeProvider(client);
    agentsProvider = new cloudPanels_1.AgentsTreeProvider(client);
    jobsProvider = new cloudPanels_1.JobsTreeProvider(client);
    apiKeysProvider = new cloudPanels_1.ApiKeysTreeProvider(client);
    profileProvider = new profileView_1.ProfileViewProvider(client, context.extensionUri);
    cloudDashboardProvider = new cloudDashboard_1.CloudDashboardProvider(client, context.extensionUri);
    // ── Web control: shared manager + browser tools for the assistant ──────
    webControlManager = new webControl_1.WebControlManager();
    // ── Infra stack: live deployments, logs, SSH/tunnels, scaling ──────────
    // The terminal manager is created before the chat provider so the infra
    // tools (SSH, tunnels) and the panel can share it.
    terminalManager = new terminalManager_1.TerminalManager(context.globalStorageUri.fsPath, context.extensionPath);
    infraService = new infraStack_1.InfraStackService(client, terminalManager);
    architectMode = new architectMode_1.ArchitectMode(client, infraService);
    context.subscriptions.push({ dispose: () => infraService.dispose() });
    capixCodeProvider = new capixCodePanel_1.CapixCodePanelProvider(client, context.extensionUri, context.extensionPath, [...(0, browserTools_1.createBrowserTools)(webControlManager), ...(0, infraTools_1.createInfraTools)(client, infraService)]);
    autoConnect = new autoConnect_1.AutoConnectManager(client);
    covenant = new covenant_1.CovenantManager(context);
    devTokens = new devTokenManager_1.DevTokenManager(client);
    smartRouter = new smartRouterManager_1.SmartRouterManager(client);
    runOnSelector = new runOnSelector_1.RunOnSelector(context);
    creationWizard = new creationWizard_1.CreationWizard(client);
    resourceDetailsProvider = new resourceDetails_1.ResourceDetailsProvider(client, context.extensionUri);
    context.subscriptions.push(new agentCommandBridge_1.AgentCommandBridge(client).register());
    // ── Unified Intelligence panel ───────────────────────────────────────
    // One webview view replaces all scattered intelligence views (memory tree,
    // graph tree, skills runtime, covenants accordion, agents tree, plans tree,
    // receipts tree). Registered as `capix.intelligence.panel`.
    intelligencePanel = new intelligencePanel_1.IntelligencePanelProvider(client, context.extensionUri);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider("capix.intelligence.panel", intelligencePanel));
    context.subscriptions.push(vscode.commands.registerCommand("capix.intelligence.openPanel", (tab) => intelligencePanel.show(tab ?? "overview")));
    // ── Web Control panel ─────────────────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand("capix.webControl.openPanel", () => webControlPanel_1.WebControlPanel.createOrShow(context.extensionUri, webControlManager)));
    // ── Infra Stack panel + architect mode ────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand("capix.infra.openPanel", () => infraPanel_1.InfraPanel.createOrShow(context.extensionUri, infraService)));
    context.subscriptions.push(vscode.commands.registerCommand("capix.infra.architectPlan", async () => {
        const goal = await vscode.window.showInputBox({
            prompt: "What are you building? (architect mode plans infra + cost)",
            placeHolder: "e.g. a coding assistant backend for my team",
        });
        if (!goal)
            return;
        const plan = await architectMode.buildPlan(goal, { kind: "coding" });
        const estimate = plan.estimate ? ` — est. ${plan.estimate.displayTotal}` : "";
        void vscode.window.showInformationMessage(`Architect plan: ${plan.recommendation.rationale}${estimate}`);
        infraPanel_1.InfraPanel.createOrShow(context.extensionUri, infraService);
    }));
    // ── Dev Token: auto-mint on git commits ────────────────────────────────
    // Watch the VS Code SCM (git) state — when HEAD changes, a commit happened.
    let lastHead;
    const gitWatcher = vscode.commands.registerCommand("capix.checkCommits", async () => {
        try {
            const gitExt = vscode.extensions.getExtension("vscode.git");
            if (!gitExt?.isActive)
                return;
            const gitApi = gitExt.exports.getAPI(1);
            const repo = gitApi?.repositories?.[0];
            if (!repo)
                return;
            const head = repo.state.HEAD?.commit;
            if (head && head !== lastHead && lastHead !== undefined) {
                // A new commit was made — mint tokens.
                await devTokens.onCommit(head, repo.state.HEAD?.name);
            }
            lastHead = head;
        }
        catch (err) {
            logger_1.logger.error("capix.checkCommits failed", { error: String(err) });
        }
    });
    context.subscriptions.push(gitWatcher);
    // Poll git state every 10s (lightweight).
    setInterval(() => vscode.commands.executeCommand("capix.checkCommits"), 10_000);
    const deploysView = vscode.window.createTreeView("capix.llm.deploys", { treeDataProvider: deploysProvider });
    const catalogView = vscode.window.createTreeView("capix.llm.catalog", { treeDataProvider: catalogProvider });
    const hostedView = vscode.window.createTreeView("capix.llm.hosted", { treeDataProvider: hostedProvider });
    const instancesView = vscode.window.createTreeView("capix.llm.instances", { treeDataProvider: instancesProvider });
    const agentsView = vscode.window.createTreeView("capix.llm.agents", { treeDataProvider: agentsProvider });
    const jobsView = vscode.window.createTreeView("capix.llm.jobs", { treeDataProvider: jobsProvider });
    const apiKeysView = vscode.window.createTreeView("capix.llm.apikeys", { treeDataProvider: apiKeysProvider });
    context.subscriptions.push(vscode.commands.registerCommand("capix.launchCentre", () => cmdLaunchCentre()), deploysView, catalogView, hostedView, instancesView, agentsView, jobsView, apiKeysView, vscode.window.registerWebviewViewProvider("capix.llm.profile", profileProvider), vscode.window.registerWebviewViewProvider("capix.cloud.overview", cloudDashboardProvider), vscode.window.registerWebviewViewProvider("capix.code.chat", capixCodeProvider), vscode.window.registerWebviewViewProvider("capix.cloud.resource", resourceDetailsProvider));
    // ── Run-On target: status bar + change handler ──────────────────────────
    runOnStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
    runOnStatusBarItem.text = (0, runOnSelector_1.runOnLabel)(runOnSelector.getCurrentTarget());
    runOnStatusBarItem.tooltip = "Capix — Choose where this workspace runs";
    runOnStatusBarItem.command = "capix.runOn";
    runOnStatusBarItem.show();
    context.subscriptions.push(runOnStatusBarItem);
    runOnSelector.onTargetChanged((config) => {
        if (runOnStatusBarItem) {
            runOnStatusBarItem.text = (0, runOnSelector_1.runOnLabel)(config);
            const sub = config.capixCloudTarget?.type ?? config.target;
            runOnStatusBarItem.tooltip = `Capix — Run target: ${sub}`;
        }
    });
    // ── Auto-refresh ───────────────────────────────────────────────────────
    setupAutoRefresh(context);
    // ── Auto-connect: check for ready deploys on startup ────────────────────
    autoConnect.checkExistingDeploys();
    // ── Branded status bar item ────────────────────────────────────────────
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    statusBarItem.text = "$(symbol-color) Capix";
    statusBarItem.tooltip = "Capix — Route compute, inference, and agents";
    statusBarItem.command = "capix.refreshProfile";
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    // Update status bar text when connection state changes
    updateStatusBar(statusBarItem);
    // ── Model sync + picker + status bar ────────────────────────────────────
    modelSync = new modelSync_1.ModelSync(client);
    modelPicker = new modelPicker_1.ModelPicker(modelSync);
    onboarding = new onboarding_1.OnboardingFlow(client, context.extensionUri, {
        sendChatMessage: (text) => capixCodeProvider.sendTestMessage(text),
        focusCloud: () => {
            void vscode.commands
                .executeCommand("capix.cloud.overview.focus")
                .then(undefined, () => vscode.commands.executeCommand("workbench.view.extension.capix-llm"));
        },
    });
    modelStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 51);
    modelStatusBarItem.command = "capix.selectModel";
    updateModelStatusBar();
    modelStatusBarItem.show();
    modelSync.startAutoRefresh();
    void modelSync.refresh().then(() => updateModelStatusBar());
    context.subscriptions.push(modelStatusBarItem, modelSync.onModelsChanged(() => updateModelStatusBar()));
    // Initial load
    refreshAll();
    // Zero-config MCP: if the user is already signed in (returning session),
    // ensure the MCP server is registered without prompting. Also fired via
    // the OAuth token-publish handler on the first checkConfigured run.
    void mcpAutoInstaller.ensureInstalled();
    // ── Restore layout + destination ────────────────────────────────────────
    void (async () => {
        const preset = await (0, layoutPresets_1.restorePersistedLayout)(context);
        await (0, layoutPresets_1.applyLayout)(preset, context);
        await (0, activityBar_1.switchDestination)((0, activityBar_1.defaultDestination)());
    })();
    // ── First-run onboarding ────────────────────────────────────────────────
    void (async () => {
        if (!context.globalState.get("capix.onboarded")) {
            await context.globalState.update("capix.onboarded", true);
            try {
                await onboarding.start(context);
            }
            catch (err) {
                logger_1.logger.error("Onboarding first-run failed", { error: String(err) });
            }
        }
    })();
    // ── Commands ──────────────────────────────────────────────────────────
    context.subscriptions.push(
    // LLM commands
    vscode.commands.registerCommand("capix.deployModel", (model) => cmdDeployModel(model)), vscode.commands.registerCommand("capix.deployCustomModel", () => cmdDeployCustomModel()), vscode.commands.registerCommand("capix.deployVps", () => cmdDeployVps()), vscode.commands.registerCommand("capix.destroyDeploy", (item) => cmdDestroyDeploy(item)), vscode.commands.registerCommand("capix.stopDeploy", (item) => cmdStopDeploy(item)), vscode.commands.registerCommand("capix.startDeploy", (item) => cmdStartDeploy(item)), vscode.commands.registerCommand("capix.viewLogs", (item) => cmdViewLogs(item)), vscode.commands.registerCommand("capix.execOnInstance", (item) => cmdExecOnInstance(item)), vscode.commands.registerCommand("capix.copyEndpoint", (item) => cmdCopyEndpoint(item)), vscode.commands.registerCommand("capix.copyApiKey", (item) => cmdCopyApiKey(item)), 
    // Refresh commands
    vscode.commands.registerCommand("capix.refreshDeploys", () => { deploysProvider.load(); }), vscode.commands.registerCommand("capix.refreshCatalog", () => { catalogProvider.load(); }), vscode.commands.registerCommand("capix.refreshInstances", () => { instancesProvider.load(); }), vscode.commands.registerCommand("capix.refreshAgents", () => { agentsProvider.load(); }), vscode.commands.registerCommand("capix.refreshJobs", () => { jobsProvider.load(); }), vscode.commands.registerCommand("capix.refreshApiKeys", () => { apiKeysProvider.load(); }), vscode.commands.registerCommand("capix.refreshProfile", () => { profileProvider.refresh(); }), 
    // Navigation
    vscode.commands.registerCommand("capix.openConsole", () => {
        vscode.env.openExternal(vscode.Uri.parse(`${client.getBaseUrl()}/cloud/llm`));
    }), vscode.commands.registerCommand("capix.openBilling", () => {
        vscode.env.openExternal(vscode.Uri.parse(`${client.getBaseUrl()}/cloud/billing`));
    }), vscode.commands.registerCommand("capix.openInstance", (instanceId) => {
        vscode.env.openExternal(vscode.Uri.parse(`${client.getBaseUrl()}/cloud/instances/${instanceId}`));
    }), vscode.commands.registerCommand("capix.connectWallet", () => cmdConnectWallet()), vscode.commands.registerCommand("capix.resetSessionAndSignIn", () => cmdResetSessionAndSignIn()), 
    // Profile
    vscode.commands.registerCommand("capix.topUp", () => cmdTopUp()), 
    // Cloud panels
    vscode.commands.registerCommand("capix.deployAgent", () => cmdDeployAgent()), vscode.commands.registerCommand("capix.triggerJob", () => cmdTriggerJob()), vscode.commands.registerCommand("capix.createApiKey", () => cmdCreateApiKey()), 
    // Terminal
    vscode.commands.registerCommand("capix.openTerminal", (item) => cmdOpenTerminal(item)), vscode.commands.registerCommand("capix.downloadSshKey", (item) => cmdDownloadSshKey(item)), 
    // MCP: status-bar health check
    vscode.commands.registerCommand("capix.mcp.health", async () => {
        const healthy = await mcpAutoInstaller.isHealthy();
        vscode.window.showInformationMessage(healthy ? "Capix MCP is connected and configured." : "Capix MCP is not configured. Sign in to enable.");
    }), 
    // Covenant
    vscode.commands.registerCommand("capix.covenantEdit", () => covenant.createSpiritFile()), vscode.commands.registerCommand("capix.covenantRemember", () => cmdCovenantRemember()), vscode.commands.registerCommand("capix.covenantClear", () => {
        covenant.clearMemory();
        vscode.window.showInformationMessage("Capix: Memory cleared.");
    }), 
    // Launch Capix Code (the CLI coding assistant) in a terminal
    vscode.commands.registerCommand("capix.launchCapixCode", () => cmdLaunchCapixCode()), 
    // Smart Router: routing mode, private LLM deploy/destroy, memory
    vscode.commands.registerCommand("capix.setRouteMode", () => cmdSetRouteMode()), vscode.commands.registerCommand("capix.deployPrivateLlm", () => cmdDeployPrivateLlm()), vscode.commands.registerCommand("capix.destroyPrivateLlm", () => cmdDestroyPrivateLlm()), vscode.commands.registerCommand("capix.routerMemory", () => cmdRouterMemory()), vscode.commands.registerCommand("capix.routerReset", () => smartRouter.resetMemory()), vscode.commands.registerCommand("capix.routerBlockModel", () => cmdRouterBlockModel()), vscode.commands.registerCommand("capix.routerFavorModel", () => cmdRouterFavorModel()), 
    // Layout + information architecture
    vscode.commands.registerCommand("capix.setLayout", () => (0, layoutPresets_1.pickAndApplyLayout)(context)), 
    // Native creation wizards — one deterministic flow per workload kind,
    // with a live quote and explicit confirmation before any spend.
    vscode.commands.registerCommand("capix.cloud.deploy", () => creationWizard.start()), vscode.commands.registerCommand("capix.cloud.create", (kind) => creationWizard.start(kind)), vscode.commands.registerCommand("capix.cloud.create.vm", () => creationWizard.start("cpu_vm")), vscode.commands.registerCommand("capix.cloud.create.gpu", () => creationWizard.start("dedicated_gpu")), vscode.commands.registerCommand("capix.cloud.create.model", () => creationWizard.start("private_model")), vscode.commands.registerCommand("capix.cloud.create.container", () => creationWizard.start("container_service")), vscode.commands.registerCommand("capix.cloud.create.website", () => creationWizard.start("website")), vscode.commands.registerCommand("capix.cloud.create.job", () => creationWizard.start("serverless_job")), vscode.commands.registerCommand("capix.cloud.resource.open", (deploymentId) => resourceDetailsProvider.openCentre(deploymentId)), vscode.commands.registerCommand("capix.runOn", () => runOnSelector.show()), vscode.commands.registerCommand("capix.code.newSession", () => capixCodeProvider.newSession()), vscode.commands.registerCommand("capix.code.focus", () => focusCapixCode()), vscode.commands.registerCommand("capix.code.acceptAll", () => capixCodeProvider.acceptAll()), vscode.commands.registerCommand("capix.code.revertAll", () => capixCodeProvider.revertAll()), vscode.commands.registerCommand("capix.code.checkpoint", () => capixCodeProvider.checkpoint()), vscode.commands.registerCommand("capix.code.cancel", () => capixCodeProvider.cancelTurn()), vscode.commands.registerCommand("capix.setDestination", () => (0, activityBar_1.pickDestination)()), 
    // Onboarding + model picker
    vscode.commands.registerCommand("capix.onboarding", () => onboarding.start(context)), vscode.commands.registerCommand("capix.selectModel", async () => {
        const picked = await modelPicker.show();
        if (picked) {
            const ref = picked.modelRef ?? picked.id;
            capixCodeProvider.setModel(ref);
            updateModelStatusBar();
        }
    }));
}
async function cmdLaunchCentre() {
    const action = await vscode.window.showQuickPick([
        { label: "$(credit-card) Deposit", description: "Add funds securely", command: "capix.topUp" },
        { label: "$(pulse) Balance & usage", description: "Review balance, invoices and consumption", command: "capix.refreshProfile" },
        { label: "$(server) Deploy GPU", description: "Provision Capix accelerated compute", command: "capix.deployModel" },
        { label: "$(vm) Deploy VPS", description: "Provision Capix general compute", command: "capix.deployVps" },
        { label: "$(sparkle) Deploy LLM", description: "Provision a remote model on the Capix GPU network", command: "capix.deployModel" },
        { label: "$(terminal) Run Capix Code", description: "Open the bundled coding environment", command: "capix.launchCapixCode" },
        { label: "$(graph) Detailed usage", description: "Open metering and billing", command: "capix.openBilling" },
    ], { placeHolder: "What would you like to do?" });
    if (action)
        await vscode.commands.executeCommand(action.command);
}
// Expand / focus the Capix Code auxiliary panel.
function focusCapixCode() {
    void vscode.commands.executeCommand("workbench.view.extension.capix-code");
    void vscode.commands.executeCommand("setContext", "capix.code.focus", true);
    capixCodeProvider.notifyDensity(false, true);
}
function deactivate() {
    refreshTimer?.dispose();
    modelSync?.stopAutoRefresh();
    terminalManager?.disposeAll();
    mcpAutoInstaller?.dispose();
}
async function cmdDeployVps() {
    if (!checkConfigured())
        return;
    const tier = await vscode.window.showQuickPick([
        { label: "Capix Micro", description: "1 vCPU · 2 GB RAM · 25 GB", id: "micro" },
        { label: "Capix Standard", description: "4 vCPU · 8 GB RAM · 80 GB", id: "standard" },
        { label: "Capix Pro", description: "8 vCPU · 16 GB RAM · 160 GB", id: "pro" },
    ], { placeHolder: "Choose VPS capacity" });
    if (!tier)
        return;
    const region = await vscode.window.showQuickPick([
        { label: "Europe", id: "eu" }, { label: "United States", id: "us" }, { label: "Asia", id: "asia" }, { label: "Best available", id: "global" },
    ], { placeHolder: "Choose region" });
    if (!region)
        return;
    const duration = await vscode.window.showQuickPick([
        { label: "1 hour", hours: 1 }, { label: "6 hours", hours: 6 }, { label: "24 hours", hours: 24 }, { label: "7 days", hours: 168 },
    ], { placeHolder: "Choose maximum runtime" });
    if (!duration)
        return;
    const quote = await client.getQuote(tier.id, duration.hours);
    if (!quote.ok || !quote.quote) {
        vscode.window.showErrorMessage("Capix could not quote this VPS.");
        return;
    }
    const confirm = await vscode.window.showWarningMessage(`Provision ${tier.label} for up to ${duration.label} at $${quote.quote.amountUsd.toFixed(2)}?`, { modal: true, detail: "The quoted amount is reserved from your Capix balance. Usage and refunds appear in Billing." }, "Provision");
    if (confirm !== "Provision")
        return;
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Provisioning ${tier.label}…`, cancellable: false }, () => client.deployInstance(tier.id, region.id, duration.hours));
    if (!result.ok) {
        vscode.window.showErrorMessage(result.error || "VPS provisioning failed.");
        return;
    }
    vscode.window.showInformationMessage("Capix VPS provisioning started. Refresh Instances to follow progress.");
    await refreshAll();
}
// Update the Capix branded status bar item with connection state.
async function updateStatusBar(item) {
    try {
        const configured = await client.checkConfigured();
        if (configured) {
            item.text = "$(check) Capix";
            item.tooltip = "Capix — Connected. Click to refresh profile.";
            item.command = "capix.refreshProfile";
        }
        else {
            item.text = "$(circle-slash) Capix";
            item.tooltip = "Capix — Not connected. Click to connect your wallet.";
            item.command = "capix.connectWallet";
        }
        item.show();
    }
    catch (err) {
        logger_1.logger.error("updateStatusBar failed", { error: String(err) });
        item.hide();
    }
}
let statusBarItem = null;
// Update the model status bar item with the current default model name.
function updateModelStatusBar() {
    if (!modelStatusBarItem)
        return;
    const ref = modelPicker.getCurrentDefault();
    const name = modelSync.resolveName(ref);
    modelStatusBarItem.text = `$(hub) ${name}`;
    modelStatusBarItem.tooltip = `Capix — Model: ${name} (click to change)`;
    modelStatusBarItem.show();
}
// ── Helpers ───────────────────────────────────────────────────────────────
async function refreshAll() {
    await client.checkConfigured();
    await Promise.all([
        deploysProvider.load(), catalogProvider.load(), hostedProvider.load(),
        instancesProvider.load(), agentsProvider.load(), jobsProvider.load(),
        apiKeysProvider.load(), profileProvider.refresh(),
        cloudDashboardProvider.refresh(),
    ]);
    if (statusBarItem)
        await updateStatusBar(statusBarItem);
}
function setupAutoRefresh(context) {
    refreshTimer?.dispose();
    const checkConfig = () => {
        const interval = vscode.workspace.getConfiguration("capix").get("autoRefreshSeconds") || 30;
        if (interval <= 0) {
            refreshTimer = null;
            return;
        }
        const handle = setInterval(() => {
            deploysProvider.load();
            hostedProvider.load();
            instancesProvider.load();
            agentsProvider.load();
            jobsProvider.load();
            profileProvider.refresh();
            cloudDashboardProvider.refresh();
        }, interval * 1000);
        refreshTimer = new vscode.Disposable(() => clearInterval(handle));
    };
    checkConfig();
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("capix.autoRefreshSeconds"))
            checkConfig();
    }));
}
function checkConfigured() {
    if (!client.isConfigured) {
        vscode.window.showWarningMessage("Capix LLM: Not connected. Set your session token in Settings to deploy and manage LLMs.", "Connect now").then((action) => {
            if (action === "Connect now")
                vscode.commands.executeCommand("capix.connectWallet");
        });
        return false;
    }
    return true;
}
// Get the deploy data from a tree item (arg) or prompt the user to pick.
function getDeployFromItem(item) {
    const deploy = item?._deploy;
    if (deploy && deploy.instanceId > 0)
        return deploy;
    // If no item or destroyed, prompt to pick from deploys list
    const deploys = deploysProvider.deploys.filter((d) => d.instanceId > 0);
    if (deploys.length === 0) {
        vscode.window.showInformationMessage("No active deploys.");
        return null;
    }
    const pick = vscode.window.showQuickPick(deploys.map((d) => ({ label: d.modelLabel, description: `${d.state} · ${d.location}`, instanceId: d.instanceId, modelLabel: d.modelLabel, instanceRecordId: d.instanceRecordId })), { placeHolder: "Select a deploy" });
    return pick.then((p) => p || null);
}
// ── Commands ──────────────────────────────────────────────────────────────
// Deploy a model: model → region → GPU offer → duration → confirm
async function cmdDeployModel(model) {
    if (!checkConfigured())
        return;
    // Pick model if not passed from the catalog click
    if (!model) {
        const catalog = await client.getCatalog();
        if (!catalog.ok || !catalog.models?.length) {
            vscode.window.showErrorMessage("Failed to load model catalog.");
            return;
        }
        const picked = await vscode.window.showQuickPick(catalog.models.map((m) => ({ label: m.label, description: `${m.paramB}B · ${m.minVramGb}GB VRAM`, detail: m.tagline, model: m })), { placeHolder: "Select a model to deploy" });
        if (!picked)
            return;
        model = picked.model;
    }
    // Pick region
    const regionPick = await vscode.window.showQuickPick([
        { label: "Global (auto)", value: "global" },
        { label: "Europe", value: "eu" },
        { label: "North America", value: "us" },
        { label: "Asia-Pacific", value: "asia" },
    ], { placeHolder: "Select a GPU region" });
    if (!regionPick)
        return;
    // Fetch offers + pick one
    const offersRes = await client.getOffers(model.id, regionPick.value);
    if (!offersRes.ok || !offersRes.offers?.length) {
        vscode.window.showErrorMessage(`No live GPUs fit ${model.label} right now. Try another region or check back shortly.`);
        return;
    }
    const offerPick = await vscode.window.showQuickPick(offersRes.offers.map((o) => ({ label: `${o.numGpus > 1 ? `${o.numGpus}× ` : ""}${o.gpu}`, description: `$${(0, moneyUtils_1.microToDisplay)((0, moneyUtils_1.dollarsToMicro)(o.roundedPricePerHr), 2)}/hr`, detail: `${o.totalVramGb}GB VRAM · ${o.location} · ${(o.reliability * 100).toFixed(0)}% reliability`, offer: o })), { placeHolder: "Select a GPU offer" });
    if (!offerPick)
        return;
    // Pick duration
    const durPick = await vscode.window.showQuickPick([
        { label: "1 hour", value: 1 },
        { label: "6 hours", value: 6 },
        { label: "1 day", value: 24 },
        { label: "1 week", value: 168 },
    ], { placeHolder: "Select duration" });
    if (!durPick)
        return;
    const costMicro = (0, moneyUtils_1.dollarsToMicro)(offerPick.offer.roundedPricePerHr) * durPick.value;
    // HF token for gated models
    let hfToken;
    if (model.gated) {
        hfToken = await vscode.window.showInputBox({
            prompt: "This model is gated on Hugging Face. Enter your HF token (hf_...).",
            password: true,
            placeHolder: "hf_...",
            ignoreFocusOut: true,
        });
        if (!hfToken)
            return;
    }
    // Confirm + deploy
    const confirm = await vscode.window.showWarningMessage(`Deploy ${model.label} on ${offerPick.label} in ${offerPick.offer.location} for ${durPick.label}?\n\nCost: $${(0, moneyUtils_1.microToDisplay)(costMicro, 2)} (billed from your wallet balance)`, { modal: true }, "Deploy");
    if (confirm !== "Deploy")
        return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Deploying ${model.label}…`, cancellable: false }, async (progress) => {
        progress.report({ message: "Renting GPU + booting vLLM…" });
        const res = await client.deployModel(model.id, offerPick.offer.askId, durPick.value, undefined, hfToken);
        if (res.ok) {
            vscode.window.showInformationMessage(`✓ ${model.label} is provisioning (instance #${res.instanceId}).\nEndpoint will be ready in 2–10 min — check "My Deploys" for status.`, "Copy API key now").then((action) => {
                if (action === "Copy API key now") {
                    vscode.env.clipboard.writeText(res.apiKey);
                    vscode.window.showInformationMessage("API key copied to clipboard.");
                }
            });
            deploysProvider.load();
        }
        else {
            vscode.window.showErrorMessage(res.error || "Deploy failed.");
        }
    });
}
// Deploy a custom model: paste HF link → discover specs → region → GPU → deploy
async function cmdDeployCustomModel() {
    if (!checkConfigured())
        return;
    const link = await vscode.window.showInputBox({
        prompt: "Enter a Hugging Face model repo or URL",
        placeHolder: "e.g. Qwen/Qwen2.5-7B-Instruct",
        ignoreFocusOut: true,
    });
    if (!link)
        return;
    // Discover specs
    const discovered = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Detecting model specs…" }, async () => client.discoverCustom(link));
    let minVramGb;
    let gpuCount;
    let quantization = "none";
    let gated = false;
    if (discovered.ok && discovered.spec) {
        const spec = discovered.spec;
        vscode.window.showInformationMessage(`✓ Detected: ${spec.label} · ${spec.paramB ? `${spec.paramB}B params` : "unknown size"} · ${spec.minVramGb}GB VRAM required`);
        minVramGb = spec.minVramGb;
        gpuCount = spec.gpuCount;
        quantization = spec.quantization;
        gated = spec.gated;
    }
    else if (discovered.fallback === "manual") {
        vscode.window.showWarningMessage("Couldn't auto-detect specs. Enter them manually.");
        const vramPick = await vscode.window.showQuickPick(["8", "12", "16", "24", "40", "48", "80", "160"].map((v) => ({ label: `${v} GB`, value: Number(v) })), { placeHolder: "Minimum VRAM required" });
        if (!vramPick)
            return;
        minVramGb = vramPick.value;
        gpuCount = minVramGb > 80 ? 2 : 1;
    }
    else {
        vscode.window.showErrorMessage(discovered.error || "Discovery failed.");
        return;
    }
    // Region
    const regionPick = await vscode.window.showQuickPick([{ label: "Global", value: "global" }, { label: "Europe", value: "eu" }, { label: "North America", value: "us" }, { label: "Asia-Pacific", value: "asia" }], { placeHolder: "Select a GPU region" });
    if (!regionPick)
        return;
    // Offers
    const offersRes = await client.getOffers("qwen2.5-3b", regionPick.value);
    if (!offersRes.ok || !offersRes.offers?.length) {
        vscode.window.showErrorMessage("No live GPUs fit this model right now.");
        return;
    }
    const filtered = offersRes.offers.filter((o) => o.totalVramGb >= minVramGb && o.numGpus >= gpuCount);
    if (filtered.length === 0) {
        vscode.window.showErrorMessage(`No GPUs with ≥${minVramGb}GB VRAM available right now.`);
        return;
    }
    const offerPick = await vscode.window.showQuickPick(filtered.map((o) => ({ label: `${o.numGpus > 1 ? `${o.numGpus}× ` : ""}${o.gpu}`, description: `$${(0, moneyUtils_1.microToDisplay)((0, moneyUtils_1.dollarsToMicro)(o.roundedPricePerHr), 2)}/hr`, detail: `${o.totalVramGb}GB VRAM · ${o.location}`, offer: o })), { placeHolder: "Select a GPU offer" });
    if (!offerPick)
        return;
    // Duration
    const durPick = await vscode.window.showQuickPick([{ label: "1 hour", value: 1 }, { label: "6 hours", value: 6 }, { label: "1 day", value: 24 }, { label: "1 week", value: 168 }], { placeHolder: "Select duration" });
    if (!durPick)
        return;
    // HF token if gated
    let hfToken;
    if (gated) {
        hfToken = await vscode.window.showInputBox({ prompt: "Gated model — enter HF token", password: true, placeHolder: "hf_...", ignoreFocusOut: true });
        if (!hfToken)
            return;
    }
    const costMicro = (0, moneyUtils_1.dollarsToMicro)(offerPick.offer.roundedPricePerHr) * durPick.value;
    const confirm = await vscode.window.showWarningMessage(`Deploy custom model from ${link}?\n\nGPU: ${offerPick.label} · Duration: ${durPick.label} · Cost: $${(0, moneyUtils_1.microToDisplay)(costMicro, 2)}`, { modal: true }, "Deploy");
    if (confirm !== "Deploy")
        return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Deploying custom model…" }, async () => {
        const res = await client.deployCustomModel({
            link, askId: offerPick.offer.askId, durationHours: durPick.value,
            minVramGb, gpuCount, quantization, gated, hfToken,
            manual: !discovered.ok,
        });
        if (res.ok) {
            vscode.window.showInformationMessage(`✓ Custom model provisioning (instance #${res.instanceId}). Check "My Deploys" for status.`);
            vscode.env.clipboard.writeText(res.apiKey);
            vscode.window.showInformationMessage("API key copied to clipboard.");
            deploysProvider.load();
        }
        else {
            vscode.window.showErrorMessage(res.error || "Deploy failed.");
        }
    });
}
// Destroy a deploy (with confirmation)
async function cmdDestroyDeploy(item) {
    if (!checkConfigured())
        return;
    const deploy = getDeployFromItem(item);
    // Handle async quickPick
    const resolved = await Promise.resolve(deploy);
    if (!resolved)
        return;
    const confirm = await vscode.window.showWarningMessage(`Destroy "${resolved.modelLabel}"?\n\nThis terminates the GPU instance and stops billing immediately. The endpoint and API key will stop working.`, { modal: true }, "Destroy");
    if (confirm !== "Destroy")
        return;
    const res = await client.destroyDeploy(resolved.instanceId);
    if (res.ok) {
        await client.restoreRoutedChat();
        vscode.window.showInformationMessage(`✓ Destroyed ${resolved.modelLabel} — billing stopped.`);
        deploysProvider.load();
    }
    else {
        vscode.window.showErrorMessage("Destroy failed.");
    }
}
// Stop a deploy (pause without destroying)
async function cmdStopDeploy(item) {
    if (!checkConfigured())
        return;
    const deploy = await Promise.resolve(getDeployFromItem(item));
    if (!deploy)
        return;
    const res = await client.stopInstance(deploy.instanceRecordId);
    if (res.ok) {
        vscode.window.showInformationMessage(`⏸ Stopped ${deploy.modelLabel}.`);
        deploysProvider.load();
    }
    else {
        vscode.window.showErrorMessage("Stop failed.");
    }
}
// Start a stopped deploy
async function cmdStartDeploy(item) {
    if (!checkConfigured())
        return;
    const deploy = await Promise.resolve(getDeployFromItem(item));
    if (!deploy)
        return;
    const res = await client.startInstance(deploy.instanceRecordId);
    if (res.ok) {
        vscode.window.showInformationMessage(`▶ Started ${deploy.modelLabel}.`);
        deploysProvider.load();
    }
    else {
        vscode.window.showErrorMessage("Start failed.");
    }
}
// View vLLM boot/server logs
async function cmdViewLogs(item) {
    if (!checkConfigured())
        return;
    const deploy = await Promise.resolve(getDeployFromItem(item));
    if (!deploy)
        return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Fetching logs for ${deploy.modelLabel}…` }, async () => {
        const res = await client.getLogs(deploy.instanceId);
        if (res.ok && res.logs) {
            // Show in an output channel
            const channel = vscode.window.createOutputChannel(`Capix LLM: ${deploy.modelLabel} Logs`, "log");
            channel.clear();
            channel.appendLine(`# Logs for ${deploy.modelLabel} (instance #${deploy.instanceId})`);
            channel.appendLine(`# Source: ${res.source}`);
            channel.appendLine("");
            channel.append(res.logs);
            channel.show();
        }
        else {
            vscode.window.showWarningMessage(res.error || "No logs available yet — the instance may still be booting.");
        }
    });
}
// Commands that are safe to execute without explicit confirmation.
const EXEC_ALLOWLIST = new Set([
    "nvidia-smi",
    "docker ps",
    "docker logs",
    "df -h",
    "free -h",
    "ps aux",
    "uptime",
    "whoami",
    "hostname",
    "ls",
    "cat /etc/os-release",
]);
// Run a debug command on the GPU instance
async function cmdExecOnInstance(item) {
    if (!checkConfigured())
        return;
    const deploy = await Promise.resolve(getDeployFromItem(item));
    if (!deploy)
        return;
    // Quick presets + custom
    const presets = [
        { label: "nvidia-smi", detail: "GPU utilization + memory" },
        { label: "docker ps", detail: "Running containers" },
        { label: "docker logs vllm --tail 100", detail: "vLLM container logs" },
        { label: "ps aux | head -20", detail: "Top processes" },
        { label: "df -h", detail: "Disk usage" },
        { label: "free -h", detail: "Memory usage" },
        { label: "$(custom)", detail: "Enter a custom command" },
    ];
    const pick = await vscode.window.showQuickPick(presets, { placeHolder: `Run a command on ${deploy.modelLabel}` });
    if (!pick)
        return;
    let command = pick.label;
    if (pick.label === "$(custom)") {
        command = await vscode.window.showInputBox({ prompt: "Enter a shell command", placeHolder: "nvidia-smi", ignoreFocusOut: true }) || "";
        if (!command)
            return;
    }
    // Require explicit confirmation for any command not on the safe allowlist.
    if (!EXEC_ALLOWLIST.has(command.trim())) {
        const confirm = await vscode.window.showWarningMessage("This will execute an arbitrary command on your GPU instance. Continue?", "Run it", "Cancel");
        if (confirm !== "Run it")
            return;
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Running: ${command}` }, async () => {
        const res = await client.execOnInstance(deploy.instanceId, command);
        const channel = vscode.window.createOutputChannel(`Capix LLM: ${deploy.modelLabel} Shell`, "shell");
        channel.clear();
        channel.appendLine(`$ ${command}`);
        if (res.ok) {
            channel.append(res.stdout);
            if (res.stderr)
                channel.append(`\n[stderr]\n${res.stderr}`);
        }
        else {
            channel.append(`[error] ${res.error || "Command failed"}`);
        }
        channel.show();
    });
}
// Copy the OpenAI base URL to clipboard
async function cmdCopyEndpoint(item) {
    const deploy = await Promise.resolve(getDeployFromItem(item));
    if (!deploy)
        return;
    const status = await client.getDeployStatus(deploy.instanceId);
    if (status.ok && status.baseOpenAiUrl) {
        vscode.env.clipboard.writeText(status.baseOpenAiUrl);
        vscode.window.showInformationMessage(`Endpoint copied: ${status.baseOpenAiUrl}`);
    }
    else if (status.ok && status.endpoint) {
        vscode.env.clipboard.writeText(`${status.endpoint}/v1`);
        vscode.window.showInformationMessage(`Endpoint copied: ${status.endpoint}/v1`);
    }
    else {
        vscode.window.showWarningMessage("Endpoint not ready yet — the model is still provisioning.");
    }
}
// Copy the API key
async function cmdCopyApiKey(modelId) {
    // If called from a hosted endpoint item, modelId is a string
    if (typeof modelId === "string") {
        const res = await client.revealHostedKey(modelId);
        if (res.ok && res.apiKey) {
            vscode.env.clipboard.writeText(res.apiKey);
            vscode.window.showInformationMessage("Hosted endpoint API key copied.");
        }
        else {
            vscode.window.showErrorMessage(res.error || "Failed to reveal key.");
        }
        return;
    }
    // Otherwise it's a deploy item — get the key from status
    const deploy = await Promise.resolve(getDeployFromItem(modelId));
    if (!deploy)
        return;
    const status = await client.getDeployStatus(deploy.instanceId);
    if (status.ok && status.apiKey) {
        vscode.env.clipboard.writeText(status.apiKey);
        vscode.window.showInformationMessage("API key copied to clipboard.");
    }
    else {
        vscode.window.showWarningMessage("No API key available for this deploy.");
    }
}
// ── Cloud panel commands ──────────────────────────────────────────────────
// Deploy an agent (GitHub repo → pod)
async function cmdDeployAgent() {
    if (!checkConfigured())
        return;
    const repoUrl = await vscode.window.showInputBox({
        prompt: "GitHub repository URL",
        placeHolder: "https://github.com/owner/repo",
        ignoreFocusOut: true,
        validateInput: (v) => v.startsWith("https://github.com/") ? null : "Must be a GitHub URL",
    });
    if (!repoUrl)
        return;
    const branch = await vscode.window.showInputBox({ prompt: "Branch", placeHolder: "main", ignoreFocusOut: true }) || "main";
    const useInference = await vscode.window.showQuickPick([{ label: "Yes", value: true }, { label: "No", value: false }], { placeHolder: "Route LLM calls via Capix Unified Inference?" });
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Deploying ${repoUrl.split("/").pop()}…` }, async () => {
        const res = await client.deployAgent(repoUrl, branch, {}, useInference?.value || false);
        if (res.ok) {
            vscode.window.showInformationMessage("✓ Agent deployed — check the Agents panel.");
            agentsProvider.load();
            devTokens.onDeploy();
        }
        else {
            vscode.window.showErrorMessage(res.error || "Agent deploy failed.");
        }
    });
}
// Trigger a serverless job
async function cmdTriggerJob() {
    if (!checkConfigured())
        return;
    const yaml = await vscode.window.showInputBox({
        prompt: "Paste your capix-job.yml",
        placeHolder: "apiVersion: capix/v1\nkind: ServerlessJob",
        ignoreFocusOut: true,
    });
    if (!yaml)
        return;
    const res = await client.triggerJob(yaml);
    if (res.ok) {
        vscode.window.showInformationMessage("✓ Serverless job triggered — check the Jobs panel.");
        jobsProvider.load();
        devTokens.onDeploy();
    }
    else {
        vscode.window.showErrorMessage(res.error || "Job trigger failed.");
    }
}
// Create an API key (for the chat gateway)
async function cmdCreateApiKey() {
    if (!checkConfigured())
        return;
    const name = await vscode.window.showInputBox({ prompt: "API key name", placeHolder: "IDE Chat", ignoreFocusOut: true });
    if (!name)
        return;
    const res = await client.createApiKey(name);
    if (res.ok && res.secret) {
        vscode.env.clipboard.writeText(res.secret);
        vscode.window.showInformationMessage("✓ API key created and copied to clipboard.", res.warning || "");
        apiKeysProvider.load();
    }
    else {
        vscode.window.showErrorMessage(res.error || "Failed to create API key.");
    }
}
// Open an SSH terminal to a deployed instance/agent/job
async function cmdOpenTerminal(item) {
    // Check if the item has SSH info (from instances or agents trees)
    const sshHost = item?._sshHost;
    const sshPort = item?._sshPort;
    const sshCommand = item?._sshCommand;
    const instanceId = item?._instanceId;
    const label = item?.label || "instance";
    // If it's a plain command string (agents/jobs store full ssh commands)
    if (sshCommand) {
        // Parse "ssh -p PORT root@HOST"
        const match = sshCommand.match(/ssh\s+(?:-p\s+(\d+)\s+)?(\w+)@([\w.-]+)/);
        if (match) {
            await terminalManager.openSshSession({ host: match[3], port: Number(match[1]) || 22, user: match[2], label });
            return;
        }
    }
    if (instanceId?.startsWith("dep_")) {
        try {
            const credential = await getOrRecoverSshCredential(instanceId);
            if (!credential)
                return;
            await terminalManager.openSshSession({ host: credential.host, port: credential.port, user: "root", label, privateKey: credential.privateKey });
        }
        catch (error) {
            vscode.window.showErrorMessage(error instanceof Error ? error.message : "Unable to retrieve SSH access.");
        }
        return;
    }
    if (sshHost && sshPort) {
        await terminalManager.openSshSession({ host: sshHost, port: sshPort, label });
        return;
    }
    // No item — prompt the user to pick from instances
    if (!checkConfigured())
        return;
    await instancesProvider.load();
    if (instancesProvider.instances.length === 0) {
        vscode.window.showInformationMessage("No instances available to SSH into.");
        return;
    }
    const pick = await vscode.window.showQuickPick(instancesProvider.instances.map((inst) => {
        const node = inst.nodes.find((n) => n.sshAvailable) || inst.nodes[0];
        return {
            label: inst.tier,
            description: `${inst.status} · ${node?.location || "Capix network"}`,
            deploymentId: inst.id,
        };
    }).filter((p) => p.deploymentId.startsWith("dep_")), { placeHolder: "Select an instance to SSH into" });
    if (pick?.deploymentId) {
        try {
            const credential = await getOrRecoverSshCredential(pick.deploymentId);
            if (!credential)
                return;
            await terminalManager.openSshSession({ host: credential.host, port: credential.port, user: "root", label: pick.label, privateKey: credential.privateKey });
        }
        catch (error) {
            vscode.window.showErrorMessage(error instanceof Error ? error.message : "Unable to retrieve SSH access.");
        }
    }
}
async function getOrRecoverSshCredential(deploymentId) {
    try {
        return await client.getStoredSshCredential(deploymentId);
    }
    catch (error) {
        if (!(error instanceof apiClient_1.CapixApiError) || error.status !== 410)
            throw error;
        const rotate = await vscode.window.showWarningMessage("This instance's previous SSH key is no longer retrievable. Rotate it and revoke the old key?", { modal: true, detail: "Capix will install a new public key on the running instance before releasing its matching private key." }, "Rotate SSH key");
        if (rotate !== "Rotate SSH key")
            return null;
        await client.rotateSshCredential(deploymentId);
        return client.getStoredSshCredential(deploymentId);
    }
}
async function cmdDownloadSshKey(item) {
    const directId = item?._instanceId;
    let deploymentId = directId;
    let label = item?.label || "Capix instance";
    if (!deploymentId) {
        await instancesProvider.load();
        const pick = await vscode.window.showQuickPick(instancesProvider.instances
            .filter((instance) => instance.id.startsWith("dep_"))
            .map((instance) => ({ label: instance.tier, description: instance.status, deploymentId: instance.id })), { placeHolder: "Select an instance whose SSH key you want to save" });
        if (!pick)
            return;
        deploymentId = pick.deploymentId;
        label = pick.label;
    }
    if (!deploymentId?.startsWith("dep_")) {
        vscode.window.showErrorMessage("SSH access is only available for compute instances.");
        return;
    }
    try {
        const credential = await getOrRecoverSshCredential(deploymentId);
        if (!credential)
            return;
        const destination = await vscode.window.showSaveDialog({
            title: `Save SSH key for ${label}`,
            defaultUri: vscode.Uri.file(credential.filename),
            filters: { "SSH private key": ["pem"] },
            saveLabel: "Save SSH key",
        });
        if (!destination)
            return;
        await vscode.workspace.fs.writeFile(destination, Buffer.from(credential.privateKey.endsWith("\n") ? credential.privateKey : `${credential.privateKey}\n`, "utf8"));
        if (destination.scheme === "file")
            await (0, promises_1.chmod)(destination.fsPath, 0o600);
        vscode.window.showInformationMessage(`SSH key saved securely to ${destination.fsPath || destination.path}.`);
    }
    catch (error) {
        vscode.window.showErrorMessage(error instanceof Error ? error.message : "Unable to retrieve SSH access.");
    }
}
// Covenant: add a memory entry
async function cmdCovenantRemember() {
    const content = await vscode.window.showInputBox({
        prompt: "What should I remember?",
        placeHolder: "e.g. We use Drizzle ORM, not Prisma, for this project.",
        ignoreFocusOut: true,
    });
    if (!content)
        return;
    const typePick = await vscode.window.showQuickPick([
        { label: "Decision", value: "decision" },
        { label: "Pattern", value: "pattern" },
        { label: "Feedback", value: "feedback" },
        { label: "Context", value: "context" },
    ], { placeHolder: "Memory type" });
    if (!typePick)
        return;
    await covenant.remember({ type: typePick.value, content, source: "user" });
    vscode.window.showInformationMessage("✓ Remembered. This will be included in future chat context.");
    devTokens.onDecision();
}
// Authentication is owned by the shared @capix/auth-broker (one identity for
// every Capix client). The extension never accepts bearer credentials from a
// query string, clipboard, input box or workspace setting, and never runs its
// own PKCE/token-exchange plumbing.
async function cmdConnectWallet() {
    try {
        await authBroker.signIn();
        // Publish the fresh access token to the chat surface + MCP installer via
        // the canonical configured check.
        await client.checkConfigured();
        vscode.window.showInformationMessage("Capix sign-in complete.");
        await refreshAll();
        await vscode.commands.executeCommand("capix.agent.refreshAuth");
        // Zero-config MCP: register the Capix MCP server now that auth succeeded.
        // (Also fired via the OAuth token-publish handler — coalesced + idempotent.)
        await mcpAutoInstaller.ensureInstalled();
    }
    catch (error) {
        vscode.window.showErrorMessage(`Capix sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}
async function cmdResetSessionAndSignIn() {
    await authBroker.signOut().catch((error) => {
        logger_1.logger.warn("Capix broker sign-out failed", { error: String(error) });
    });
    await (0, authRecovery_1.resetSessionAndSignIn)(client, async () => {
        // Strip the MCP server entry so no stale credential lingers after the
        // session is cleared. (Also fired via the OAuth token-publish handler.)
        await mcpAutoInstaller.unregister();
        try {
            await refreshAll();
        }
        catch (error) {
            logger_1.logger.error("Capix signed-out view refresh failed", { error: String(error) });
        }
        try {
            await vscode.commands.executeCommand("capix.agent.refreshAuth");
        }
        catch (error) {
            logger_1.logger.error("Capix agent signed-out refresh failed", { error: String(error) });
        }
    }, cmdConnectWallet);
}
// Top up wallet balance — shared across web and IDE
async function cmdTopUp() {
    if (!checkConfigured())
        return;
    await vscode.env.openExternal(vscode.Uri.parse(`${client.getBaseUrl()}/cloud/billing`));
}
// Launch capix-code (the CLI coding assistant) in a terminal, pre-configured
// with the user's Capix endpoint + API key from SecretStorage.
async function cmdLaunchCapixCode() {
    // Read the auto-configured endpoint (set by auto-connect when a deploy goes live)
    const config = vscode.workspace.getConfiguration("capix");
    const baseUrl = config.get("ai.baseUrl") || `${client.getBaseUrl()}/api/v1`;
    const model = config.get("ai.model") || "auto";
    // Get the API key from SecretStorage
    let apiKey = await client.getSecret("capix.ai.apiKey") || "";
    // If no key from a deployed LLM, try the session token for the gateway
    if (!apiKey) {
        const token = await client.getStoredToken();
        if (token.startsWith("cpx_session.")) {
            apiKey = token;
        }
        else {
            vscode.window.showWarningMessage("Capix Code: no API key configured. Set one with 'Capix: Connect Wallet' or deploy an LLM first.", "Connect Wallet").then((action) => {
                if (action === "Connect Wallet")
                    vscode.commands.executeCommand("capix.connectWallet");
            });
            return;
        }
    }
    // Pass the routing mode to capix-code as an env var
    const routeMode = smartRouter.getMode();
    await terminalManager.openCapixCode(baseUrl, apiKey, model);
}
// ── Smart Router commands ─────────────────────────────────────────────────
// Set routing mode: Auto / Private / Loop
async function cmdSetRouteMode() {
    const current = smartRouter.getMode();
    const pick = await vscode.window.showQuickPick([
        { label: "Auto", description: "Dynamically pick best model per task (reasoning vs coding)", value: "auto", picked: current === "auto" },
        { label: "Private", description: "Use a deployed private uncensored LLM — no filters", value: "private", picked: current === "private" },
        { label: "Loop", description: "Private LLM + continuous build until task complete, then destroy", value: "loop", picked: current === "loop" },
    ], { placeHolder: `Current: ${current.toUpperCase()} — select a routing mode` });
    if (!pick)
        return;
    await smartRouter.setMode(pick.value);
    if (pick.value === "private" && !smartRouter.hasPrivateEndpoint()) {
        const deploy = await vscode.window.showInformationMessage("No private LLM is deployed. Deploy one now?", "Deploy");
        if (deploy === "Deploy") {
            vscode.commands.executeCommand("capix.deployPrivateLlm");
        }
    }
}
// Deploy a private uncensored LLM via the Capix API
async function cmdDeployPrivateLlm() {
    if (!client.isConfigured) {
        vscode.window.showWarningMessage("Connect your wallet first.", "Connect Wallet").then((a) => {
            if (a === "Connect Wallet")
                vscode.commands.executeCommand("capix.connectWallet");
        });
        return;
    }
    const result = await smartRouter.deployPrivateLlm();
    if (result) {
        // Set context key so the "Destroy Private LLM" toolbar button appears
        vscode.commands.executeCommand("setContext", "capix.privateLlmActive", true);
        // Update the status bar
        if (statusBarItem) {
            statusBarItem.text = `$(shield) Capix · ${result.modelLabel}`;
            statusBarItem.tooltip = `Capix — Private LLM active: ${result.modelLabel}\nEndpoint: ${result.baseUrl}\nMode: ${smartRouter.getMode().toUpperCase()}\nClick to check balance.`;
        }
        devTokens.onDeploy();
    }
}
// Destroy the private LLM + stop billing
async function cmdDestroyPrivateLlm() {
    await smartRouter.destroyPrivateLlm();
    // Clear context key so the Destroy button disappears
    vscode.commands.executeCommand("setContext", "capix.privateLlmActive", false);
    if (statusBarItem)
        updateStatusBar(statusBarItem);
}
// Show smart router memory (learned preferences)
function cmdRouterMemory() {
    const summary = smartRouter.getMemorySummary();
    const channel = vscode.window.createOutputChannel("Capix Smart Router", "log");
    channel.clear();
    channel.append(summary);
    channel.show();
}
// Block a model (never suggest again)
async function cmdRouterBlockModel() {
    const model = await vscode.window.showInputBox({
        prompt: "Model ID to block (e.g. 'openai/gpt-3.5-turbo')",
        placeHolder: "provider/model-name",
        ignoreFocusOut: true,
    });
    if (model)
        smartRouter.blockModel(model);
}
// Favor a model (always prefer)
async function cmdRouterFavorModel() {
    const model = await vscode.window.showInputBox({
        prompt: "Model ID to favor (e.g. 'deepseek/deepseek-r1')",
        placeHolder: "provider/model-name",
        ignoreFocusOut: true,
    });
    if (model)
        smartRouter.favorModel(model);
}
//# sourceMappingURL=extension.js.map