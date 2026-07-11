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

import * as vscode from "vscode";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { CapixClient } from "./apiClient";
import { DeploysTreeProvider, CatalogTreeProvider, HostedTreeProvider } from "./treeViews";
import { InstancesTreeProvider, AgentsTreeProvider, JobsTreeProvider, ApiKeysTreeProvider } from "./cloudPanels";
import { ProfileViewProvider } from "./profileView";
import { TerminalManager } from "./terminalManager";
import { AutoConnectManager } from "./autoConnect";
import { CovenantManager } from "./covenant";
import { DevTokenManager } from "./devTokenManager";
import { SmartRouterManager } from "./smartRouterManager";
import { logger } from "./logger";
import { initTelemetry } from "./telemetry";
import type { CatalogModel } from "./types";

let client: CapixClient;
let deploysProvider: DeploysTreeProvider;
let catalogProvider: CatalogTreeProvider;
let hostedProvider: HostedTreeProvider;
let instancesProvider: InstancesTreeProvider;
let agentsProvider: AgentsTreeProvider;
let jobsProvider: JobsTreeProvider;
let apiKeysProvider: ApiKeysTreeProvider;
let profileProvider: ProfileViewProvider;
let terminalManager: TerminalManager;
let autoConnect: AutoConnectManager;
let covenant: CovenantManager;
let devTokens: DevTokenManager;
let smartRouter: SmartRouterManager;
let refreshTimer: vscode.Disposable | null = null;

export function activate(context: vscode.ExtensionContext) {
  initTelemetry(context);

  client = new CapixClient();
  // Security: use VS Code SecretStorage for the session token instead of plaintext settings.json
  client.setSecretStorage({
    get: (key) => Promise.resolve(context.secrets.get(key)),
    store: (key, value) => Promise.resolve(context.secrets.store(key, value)),
  });

  // ── Tree views ────────────────────────────────────────────────────────
  deploysProvider = new DeploysTreeProvider(client);
  catalogProvider = new CatalogTreeProvider(client);
  hostedProvider = new HostedTreeProvider(client);
  instancesProvider = new InstancesTreeProvider(client);
  agentsProvider = new AgentsTreeProvider(client);
  jobsProvider = new JobsTreeProvider(client);
  apiKeysProvider = new ApiKeysTreeProvider(client);
  profileProvider = new ProfileViewProvider(client, context.extensionUri);
  terminalManager = new TerminalManager(context.globalStorageUri.fsPath, context.extensionPath);
  autoConnect = new AutoConnectManager(client);
  covenant = new CovenantManager(context);
  devTokens = new DevTokenManager(client);
  smartRouter = new SmartRouterManager(client);

  // ── Dev Token: auto-mint on git commits ────────────────────────────────
  // Watch the VS Code SCM (git) state — when HEAD changes, a commit happened.
  let lastHead: string | undefined;
  const gitWatcher = vscode.commands.registerCommand("capix.checkCommits", async () => {
    try {
      const gitExt = vscode.extensions.getExtension("vscode.git");
      if (!gitExt?.isActive) return;
      const gitApi = gitExt.exports.getAPI(1);
      const repo = gitApi?.repositories?.[0];
      if (!repo) return;
      const head = repo.state.HEAD?.commit;
      if (head && head !== lastHead && lastHead !== undefined) {
        // A new commit was made — mint tokens.
        await devTokens.onCommit(head, repo.state.HEAD?.name);
      }
      lastHead = head;
    } catch (err) { logger.error("capix.checkCommits failed", { error: String(err) }); }
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

  context.subscriptions.push(
    vscode.commands.registerCommand("capix.launchCentre", () => cmdLaunchCentre()),
    deploysView, catalogView, hostedView, instancesView, agentsView, jobsView, apiKeysView,
    vscode.window.registerWebviewViewProvider("capix.llm.profile", profileProvider),
  );

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

  // Initial load
  refreshAll();

  // ── Commands ──────────────────────────────────────────────────────────
  context.subscriptions.push(
    // LLM commands
    vscode.commands.registerCommand("capix.deployModel", (model?: CatalogModel) => cmdDeployModel(model)),
    vscode.commands.registerCommand("capix.deployCustomModel", () => cmdDeployCustomModel()),
    vscode.commands.registerCommand("capix.destroyDeploy", (item?: unknown) => cmdDestroyDeploy(item)),
    vscode.commands.registerCommand("capix.stopDeploy", (item?: unknown) => cmdStopDeploy(item)),
    vscode.commands.registerCommand("capix.startDeploy", (item?: unknown) => cmdStartDeploy(item)),
    vscode.commands.registerCommand("capix.viewLogs", (item?: unknown) => cmdViewLogs(item)),
    vscode.commands.registerCommand("capix.execOnInstance", (item?: unknown) => cmdExecOnInstance(item)),
    vscode.commands.registerCommand("capix.copyEndpoint", (item?: unknown) => cmdCopyEndpoint(item)),
    vscode.commands.registerCommand("capix.copyApiKey", (item?: unknown) => cmdCopyApiKey(item)),

    // Refresh commands
    vscode.commands.registerCommand("capix.refreshDeploys", () => { deploysProvider.load(); }),
    vscode.commands.registerCommand("capix.refreshCatalog", () => { catalogProvider.load(); }),
    vscode.commands.registerCommand("capix.refreshInstances", () => { instancesProvider.load(); }),
    vscode.commands.registerCommand("capix.refreshAgents", () => { agentsProvider.load(); }),
    vscode.commands.registerCommand("capix.refreshJobs", () => { jobsProvider.load(); }),
    vscode.commands.registerCommand("capix.refreshApiKeys", () => { apiKeysProvider.load(); }),
    vscode.commands.registerCommand("capix.refreshProfile", () => { profileProvider.refresh(); }),

    // Navigation
    vscode.commands.registerCommand("capix.openConsole", () => {
      vscode.env.openExternal(vscode.Uri.parse(`${client.getBaseUrl()}/cloud/llm`));
    }),
    vscode.commands.registerCommand("capix.openBilling", () => {
      vscode.env.openExternal(vscode.Uri.parse(`${client.getBaseUrl()}/cloud/billing`));
    }),
    vscode.commands.registerCommand("capix.openInstance", (instanceId: string) => {
      vscode.env.openExternal(vscode.Uri.parse(`${client.getBaseUrl()}/cloud/instances/${instanceId}`));
    }),
    vscode.commands.registerCommand("capix.connectWallet", () => cmdConnectWallet()),

    // Profile
    vscode.commands.registerCommand("capix.topUp", () => cmdTopUp()),

    // Cloud panels
    vscode.commands.registerCommand("capix.deployAgent", () => cmdDeployAgent()),
    vscode.commands.registerCommand("capix.triggerJob", () => cmdTriggerJob()),
    vscode.commands.registerCommand("capix.createApiKey", () => cmdCreateApiKey()),

    // Terminal
    vscode.commands.registerCommand("capix.openTerminal", (item?: unknown) => cmdOpenTerminal(item)),

    // Covenant
    vscode.commands.registerCommand("capix.covenantEdit", () => covenant.createSpiritFile()),
    vscode.commands.registerCommand("capix.covenantRemember", () => cmdCovenantRemember()),
    vscode.commands.registerCommand("capix.covenantClear", () => {
      covenant.clearMemory();
      vscode.window.showInformationMessage("Capix: Memory cleared.");
    }),

    // Launch Capix Code (the CLI coding assistant) in a terminal
    vscode.commands.registerCommand("capix.launchCapixCode", () => cmdLaunchCapixCode()),

    // Smart Router: routing mode, private LLM deploy/destroy, memory
    vscode.commands.registerCommand("capix.setRouteMode", () => cmdSetRouteMode()),
    vscode.commands.registerCommand("capix.deployPrivateLlm", () => cmdDeployPrivateLlm()),
    vscode.commands.registerCommand("capix.destroyPrivateLlm", () => cmdDestroyPrivateLlm()),
    vscode.commands.registerCommand("capix.routerMemory", () => cmdRouterMemory()),
    vscode.commands.registerCommand("capix.routerReset", () => smartRouter.resetMemory()),
    vscode.commands.registerCommand("capix.routerBlockModel", () => cmdRouterBlockModel()),
    vscode.commands.registerCommand("capix.routerFavorModel", () => cmdRouterFavorModel()),
  );

}

async function cmdLaunchCentre(): Promise<void> {
  const action = await vscode.window.showQuickPick([
    { label: "$(credit-card) Deposit", description: "Add funds securely", command: "capix.topUp" },
    { label: "$(pulse) Balance & usage", description: "Review balance, invoices and consumption", command: "capix.refreshProfile" },
    { label: "$(server) Deploy GPU", description: "Provision Capix accelerated compute", command: "capix.deployModel" },
    { label: "$(vm) Deploy VPS", description: "Provision Capix general compute", command: "capix.cloud.createDeployment" },
    { label: "$(sparkle) Deploy LLM", description: "Provision a remote model on the Capix GPU network", command: "capix.deployModel" },
    { label: "$(terminal) Run Capix Code", description: "Open the bundled coding environment", command: "capix.launchCapixCode" },
    { label: "$(graph) Detailed usage", description: "Open metering and billing", command: "capix.openBilling" },
  ], { placeHolder: "What would you like to do?" });
  if (action) await vscode.commands.executeCommand(action.command);
}

export function deactivate() {
  refreshTimer?.dispose();
  terminalManager?.disposeAll();
}

// Update the Capix branded status bar item with connection state.
async function updateStatusBar(item: vscode.StatusBarItem): Promise<void> {
  try {
    const configured = await client.checkConfigured();
    if (configured) {
      item.text = "$(check) Capix";
      item.tooltip = "Capix — Connected. Click to refresh profile.";
      item.command = "capix.refreshProfile";
    } else {
      item.text = "$(circle-slash) Capix";
      item.tooltip = "Capix — Not connected. Click to connect your wallet.";
      item.command = "capix.connectWallet";
    }
    item.show();
  } catch (err) {
    logger.error("updateStatusBar failed", { error: String(err) });
    item.hide();
  }
}

let statusBarItem: vscode.StatusBarItem | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────
async function refreshAll() {
  await client.checkConfigured();
  await Promise.all([
    deploysProvider.load(), catalogProvider.load(), hostedProvider.load(),
    instancesProvider.load(), agentsProvider.load(), jobsProvider.load(),
    apiKeysProvider.load(), profileProvider.refresh(),
  ]);
  if (statusBarItem) await updateStatusBar(statusBarItem);
}

function setupAutoRefresh(context: vscode.ExtensionContext) {
  refreshTimer?.dispose();

  const checkConfig = () => {
    const interval = vscode.workspace.getConfiguration("capix").get<number>("autoRefreshSeconds") || 30;
    if (interval <= 0) { refreshTimer = null; return; }

    const handle = setInterval(() => {
      deploysProvider.load();
      hostedProvider.load();
      instancesProvider.load();
      agentsProvider.load();
      jobsProvider.load();
      profileProvider.refresh();
    }, interval * 1000);
    refreshTimer = new vscode.Disposable(() => clearInterval(handle));
  };

  checkConfig();
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("capix.autoRefreshSeconds")) checkConfig();
  }));
}

function checkConfigured(): boolean {
  if (!client.isConfigured) {
    vscode.window.showWarningMessage(
      "Capix LLM: Not connected. Set your session token in Settings to deploy and manage LLMs.",
      "Connect now",
    ).then((action) => {
      if (action === "Connect now") vscode.commands.executeCommand("capix.connectWallet");
    });
    return false;
  }
  return true;
}

// Get the deploy data from a tree item (arg) or prompt the user to pick.
function getDeployFromItem(item: unknown): { instanceId: number; modelLabel: string; instanceRecordId: string } | null {
  const deploy = (item as { _deploy?: { instanceId: number; modelLabel: string; instanceRecordId: string } })?._deploy;
  if (deploy && deploy.instanceId > 0) return deploy;
  // If no item or destroyed, prompt to pick from deploys list
  const deploys = deploysProvider.deploys.filter((d) => d.instanceId > 0);
  if (deploys.length === 0) {
    vscode.window.showInformationMessage("No active deploys.");
    return null;
  }
  const pick = vscode.window.showQuickPick(
    deploys.map((d) => ({ label: d.modelLabel, description: `${d.state} · ${d.location}`, instanceId: d.instanceId, modelLabel: d.modelLabel, instanceRecordId: d.instanceRecordId })),
    { placeHolder: "Select a deploy" },
  );
  return pick.then((p) => p || null) as unknown as { instanceId: number; modelLabel: string; instanceRecordId: string } | null;
}

// ── Commands ──────────────────────────────────────────────────────────────

// Deploy a model: model → region → GPU offer → duration → confirm
async function cmdDeployModel(model?: CatalogModel) {
  if (!checkConfigured()) return;

  // Pick model if not passed from the catalog click
  if (!model) {
    const catalog = await client.getCatalog();
    if (!catalog.ok || !catalog.models?.length) {
      vscode.window.showErrorMessage("Failed to load model catalog.");
      return;
    }
    const picked = await vscode.window.showQuickPick(
      catalog.models.map((m) => ({ label: m.label, description: `${m.paramB}B · ${m.minVramGb}GB VRAM`, detail: m.tagline, model: m })),
      { placeHolder: "Select a model to deploy" },
    );
    if (!picked) return;
    model = picked.model;
  }

  // Pick region
  const regionPick = await vscode.window.showQuickPick(
    [
      { label: "Global (auto)", value: "global" },
      { label: "Europe", value: "eu" },
      { label: "North America", value: "us" },
      { label: "Asia-Pacific", value: "asia" },
    ],
    { placeHolder: "Select a GPU region" },
  );
  if (!regionPick) return;

  // Fetch offers + pick one
  const offersRes = await client.getOffers(model.id, regionPick.value);
  if (!offersRes.ok || !offersRes.offers?.length) {
    vscode.window.showErrorMessage(`No live GPUs fit ${model.label} right now. Try another region or check back shortly.`);
    return;
  }
  const offerPick = await vscode.window.showQuickPick(
    offersRes.offers.map((o) => ({ label: `${o.numGpus > 1 ? `${o.numGpus}× ` : ""}${o.gpu}`, description: `$${o.roundedPricePerHr.toFixed(2)}/hr`, detail: `${o.totalVramGb}GB VRAM · ${o.location} · ${(o.reliability * 100).toFixed(0)}% reliability`, offer: o })),
    { placeHolder: "Select a GPU offer" },
  );
  if (!offerPick) return;

  // Pick duration
  const durPick = await vscode.window.showQuickPick(
    [
      { label: "1 hour", value: 1 },
      { label: "6 hours", value: 6 },
      { label: "1 day", value: 24 },
      { label: "1 week", value: 168 },
    ],
    { placeHolder: "Select duration" },
  );
  if (!durPick) return;

  const cost = offerPick.offer.roundedPricePerHr * durPick.value;

  // HF token for gated models
  let hfToken: string | undefined;
  if (model.gated) {
    hfToken = await vscode.window.showInputBox({
      prompt: "This model is gated on Hugging Face. Enter your HF token (hf_...).",
      password: true,
      placeHolder: "hf_...",
      ignoreFocusOut: true,
    });
    if (!hfToken) return;
  }

  // Confirm + deploy
  const confirm = await vscode.window.showWarningMessage(
    `Deploy ${model.label} on ${offerPick.label} in ${offerPick.offer.location} for ${durPick.label}?\n\nCost: $${cost.toFixed(2)} (billed from your wallet balance)`,
    { modal: true },
    "Deploy",
  );
  if (confirm !== "Deploy") return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Deploying ${model.label}…`, cancellable: false },
    async (progress) => {
      progress.report({ message: "Renting GPU + booting vLLM…" });
      const res = await client.deployModel(model!.id, offerPick.offer.askId, durPick.value, undefined, hfToken);
      if (res.ok) {
        vscode.window.showInformationMessage(
          `✓ ${model!.label} is provisioning (instance #${res.instanceId}).\nEndpoint will be ready in 2–10 min — check "My Deploys" for status.`,
          "Copy API key now",
        ).then((action) => {
          if (action === "Copy API key now") {
            vscode.env.clipboard.writeText(res.apiKey);
            vscode.window.showInformationMessage("API key copied to clipboard.");
          }
        });
        deploysProvider.load();
      } else {
        vscode.window.showErrorMessage(res.error || "Deploy failed.");
      }
    },
  );
}

// Deploy a custom model: paste HF link → discover specs → region → GPU → deploy
async function cmdDeployCustomModel() {
  if (!checkConfigured()) return;

  const link = await vscode.window.showInputBox({
    prompt: "Enter a Hugging Face model repo or URL",
    placeHolder: "e.g. Qwen/Qwen2.5-7B-Instruct",
    ignoreFocusOut: true,
  });
  if (!link) return;

  // Discover specs
  const discovered = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Detecting model specs…" },
    async () => client.discoverCustom(link),
  );

  let minVramGb: number;
  let gpuCount: number;
  let quantization = "none";
  let gated = false;

  if (discovered.ok && discovered.spec) {
    const spec = discovered.spec as { label: string; minVramGb: number; gpuCount: number; quantization: string; gated: boolean; paramB: number | null; autoDiscovered: boolean };
    vscode.window.showInformationMessage(`✓ Detected: ${spec.label} · ${spec.paramB ? `${spec.paramB}B params` : "unknown size"} · ${spec.minVramGb}GB VRAM required`);
    minVramGb = spec.minVramGb;
    gpuCount = spec.gpuCount;
    quantization = spec.quantization;
    gated = spec.gated;
  } else if (discovered.fallback === "manual") {
    vscode.window.showWarningMessage("Couldn't auto-detect specs. Enter them manually.");
    const vramPick = await vscode.window.showQuickPick(
      ["8", "12", "16", "24", "40", "48", "80", "160"].map((v) => ({ label: `${v} GB`, value: Number(v) })),
      { placeHolder: "Minimum VRAM required" },
    );
    if (!vramPick) return;
    minVramGb = vramPick.value;
    gpuCount = minVramGb > 80 ? 2 : 1;
  } else {
    vscode.window.showErrorMessage(discovered.error || "Discovery failed.");
    return;
  }

  // Region
  const regionPick = await vscode.window.showQuickPick(
    [{ label: "Global", value: "global" }, { label: "Europe", value: "eu" }, { label: "North America", value: "us" }, { label: "Asia-Pacific", value: "asia" }],
    { placeHolder: "Select a GPU region" },
  );
  if (!regionPick) return;

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
  const offerPick = await vscode.window.showQuickPick(
    filtered.map((o) => ({ label: `${o.numGpus > 1 ? `${o.numGpus}× ` : ""}${o.gpu}`, description: `$${o.roundedPricePerHr.toFixed(2)}/hr`, detail: `${o.totalVramGb}GB VRAM · ${o.location}`, offer: o })),
    { placeHolder: "Select a GPU offer" },
  );
  if (!offerPick) return;

  // Duration
  const durPick = await vscode.window.showQuickPick(
    [{ label: "1 hour", value: 1 }, { label: "6 hours", value: 6 }, { label: "1 day", value: 24 }, { label: "1 week", value: 168 }],
    { placeHolder: "Select duration" },
  );
  if (!durPick) return;

  // HF token if gated
  let hfToken: string | undefined;
  if (gated) {
    hfToken = await vscode.window.showInputBox({ prompt: "Gated model — enter HF token", password: true, placeHolder: "hf_...", ignoreFocusOut: true });
    if (!hfToken) return;
  }

  const cost = offerPick.offer.roundedPricePerHr * durPick.value;
  const confirm = await vscode.window.showWarningMessage(
    `Deploy custom model from ${link}?\n\nGPU: ${offerPick.label} · Duration: ${durPick.label} · Cost: $${cost.toFixed(2)}`,
    { modal: true },
    "Deploy",
  );
  if (confirm !== "Deploy") return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Deploying custom model…" },
    async () => {
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
      } else {
        vscode.window.showErrorMessage(res.error || "Deploy failed.");
      }
    },
  );
}

// Destroy a deploy (with confirmation)
async function cmdDestroyDeploy(item?: unknown) {
  if (!checkConfigured()) return;
  const deploy = getDeployFromItem(item);
  // Handle async quickPick
  const resolved = await Promise.resolve(deploy);
  if (!resolved) return;

  const confirm = await vscode.window.showWarningMessage(
    `Destroy "${resolved.modelLabel}"?\n\nThis terminates the GPU instance and stops billing immediately. The endpoint and API key will stop working.`,
    { modal: true },
    "Destroy",
  );
  if (confirm !== "Destroy") return;

  const res = await client.destroyDeploy(resolved.instanceId);
  if (res.ok) {
    vscode.window.showInformationMessage(`✓ Destroyed ${resolved.modelLabel} — billing stopped.`);
    deploysProvider.load();
  } else {
    vscode.window.showErrorMessage("Destroy failed.");
  }
}

// Stop a deploy (pause without destroying)
async function cmdStopDeploy(item?: unknown) {
  if (!checkConfigured()) return;
  const deploy = await Promise.resolve(getDeployFromItem(item));
  if (!deploy) return;
  const res = await client.stopInstance(deploy.instanceRecordId);
  if (res.ok) {
    vscode.window.showInformationMessage(`⏸ Stopped ${deploy.modelLabel}.`);
    deploysProvider.load();
  } else {
    vscode.window.showErrorMessage("Stop failed.");
  }
}

// Start a stopped deploy
async function cmdStartDeploy(item?: unknown) {
  if (!checkConfigured()) return;
  const deploy = await Promise.resolve(getDeployFromItem(item));
  if (!deploy) return;
  const res = await client.startInstance(deploy.instanceRecordId);
  if (res.ok) {
    vscode.window.showInformationMessage(`▶ Started ${deploy.modelLabel}.`);
    deploysProvider.load();
  } else {
    vscode.window.showErrorMessage("Start failed.");
  }
}

// View vLLM boot/server logs
async function cmdViewLogs(item?: unknown) {
  if (!checkConfigured()) return;
  const deploy = await Promise.resolve(getDeployFromItem(item));
  if (!deploy) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Fetching logs for ${deploy.modelLabel}…` },
    async () => {
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
      } else {
        vscode.window.showWarningMessage(res.error || "No logs available yet — the instance may still be booting.");
      }
    },
  );
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
async function cmdExecOnInstance(item?: unknown) {
  if (!checkConfigured()) return;
  const deploy = await Promise.resolve(getDeployFromItem(item));
  if (!deploy) return;

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
  if (!pick) return;

  let command = pick.label;
  if (pick.label === "$(custom)") {
    command = await vscode.window.showInputBox({ prompt: "Enter a shell command", placeHolder: "nvidia-smi", ignoreFocusOut: true }) || "";
    if (!command) return;
  }

  // Require explicit confirmation for any command not on the safe allowlist.
  if (!EXEC_ALLOWLIST.has(command.trim())) {
    const confirm = await vscode.window.showWarningMessage(
      "This will execute an arbitrary command on your GPU instance. Continue?",
      "Run it",
      "Cancel",
    );
    if (confirm !== "Run it") return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Running: ${command}` },
    async () => {
      const res = await client.execOnInstance(deploy.instanceId, command);
      const channel = vscode.window.createOutputChannel(`Capix LLM: ${deploy.modelLabel} Shell`, "shell");
      channel.clear();
      channel.appendLine(`$ ${command}`);
      if (res.ok) {
        channel.append(res.stdout);
        if (res.stderr) channel.append(`\n[stderr]\n${res.stderr}`);
      } else {
        channel.append(`[error] ${res.error || "Command failed"}`);
      }
      channel.show();
    },
  );
}

// Copy the OpenAI base URL to clipboard
async function cmdCopyEndpoint(item?: unknown) {
  const deploy = await Promise.resolve(getDeployFromItem(item));
  if (!deploy) return;
  const status = await client.getDeployStatus(deploy.instanceId);
  if (status.ok && status.baseOpenAiUrl) {
    vscode.env.clipboard.writeText(status.baseOpenAiUrl);
    vscode.window.showInformationMessage(`Endpoint copied: ${status.baseOpenAiUrl}`);
  } else if (status.ok && status.endpoint) {
    vscode.env.clipboard.writeText(`${status.endpoint}/v1`);
    vscode.window.showInformationMessage(`Endpoint copied: ${status.endpoint}/v1`);
  } else {
    vscode.window.showWarningMessage("Endpoint not ready yet — the model is still provisioning.");
  }
}

// Copy the API key
async function cmdCopyApiKey(modelId?: string | unknown) {
  // If called from a hosted endpoint item, modelId is a string
  if (typeof modelId === "string") {
    const res = await client.revealHostedKey(modelId);
    if (res.ok && res.apiKey) {
      vscode.env.clipboard.writeText(res.apiKey);
      vscode.window.showInformationMessage("Hosted endpoint API key copied.");
    } else {
      vscode.window.showErrorMessage(res.error || "Failed to reveal key.");
    }
    return;
  }

  // Otherwise it's a deploy item — get the key from status
  const deploy = await Promise.resolve(getDeployFromItem(modelId));
  if (!deploy) return;
  const status = await client.getDeployStatus(deploy.instanceId);
  if (status.ok && status.apiKey) {
    vscode.env.clipboard.writeText(status.apiKey);
    vscode.window.showInformationMessage("API key copied to clipboard.");
  } else {
    vscode.window.showWarningMessage("No API key available for this deploy.");
  }
}

// ── Cloud panel commands ──────────────────────────────────────────────────

// Deploy an agent (GitHub repo → pod)
async function cmdDeployAgent() {
  if (!checkConfigured()) return;
  const repoUrl = await vscode.window.showInputBox({
    prompt: "GitHub repository URL",
    placeHolder: "https://github.com/owner/repo",
    ignoreFocusOut: true,
    validateInput: (v) => v.startsWith("https://github.com/") ? null : "Must be a GitHub URL",
  });
  if (!repoUrl) return;

  const branch = await vscode.window.showInputBox({ prompt: "Branch", placeHolder: "main", ignoreFocusOut: true }) || "main";
  const useInference = await vscode.window.showQuickPick(
    [{ label: "Yes", value: true }, { label: "No", value: false }],
    { placeHolder: "Route LLM calls via Capix Unified Inference?" },
  );

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Deploying ${repoUrl.split("/").pop()}…` },
    async () => {
      const res = await client.deployAgent(repoUrl, branch, {}, useInference?.value || false);
      if (res.ok) {
        vscode.window.showInformationMessage("✓ Agent deployed — check the Agents panel.");
        agentsProvider.load();
        devTokens.onDeploy();
      } else {
        vscode.window.showErrorMessage(res.error || "Agent deploy failed.");
      }
    },
  );
}

// Trigger a serverless job
async function cmdTriggerJob() {
  if (!checkConfigured()) return;
  const yaml = await vscode.window.showInputBox({
    prompt: "Paste your capix-job.yml",
    placeHolder: "apiVersion: capix/v1\nkind: ServerlessJob",
    ignoreFocusOut: true,
  });
  if (!yaml) return;

  const res = await client.triggerJob(yaml);
  if (res.ok) {
    vscode.window.showInformationMessage("✓ Serverless job triggered — check the Jobs panel.");
    jobsProvider.load();
    devTokens.onDeploy();
  } else {
    vscode.window.showErrorMessage(res.error || "Job trigger failed.");
  }
}

// Create an API key (for the chat gateway)
async function cmdCreateApiKey() {
  if (!checkConfigured()) return;
  const name = await vscode.window.showInputBox({ prompt: "API key name", placeHolder: "IDE Chat", ignoreFocusOut: true });
  if (!name) return;

  const res = await client.createApiKey(name);
  if (res.ok && res.secret) {
    vscode.env.clipboard.writeText(res.secret);
    vscode.window.showInformationMessage("✓ API key created and copied to clipboard.", res.warning || "");
    apiKeysProvider.load();
  } else {
    vscode.window.showErrorMessage(res.error || "Failed to create API key.");
  }
}

// Open an SSH terminal to a deployed instance/agent/job
async function cmdOpenTerminal(item?: unknown) {
  // Check if the item has SSH info (from instances or agents trees)
  const sshHost = (item as { _sshHost?: string })?._sshHost;
  const sshPort = (item as { _sshPort?: number })?._sshPort;
  const sshCommand = (item as { _sshCommand?: string })?._sshCommand;
  const label = (item as { label?: string })?.label || "instance";

  if (sshHost && sshPort) {
    await terminalManager.openSshSession({ host: sshHost, port: sshPort, label });
    return;
  }

  // If it's a plain command string (agents/jobs store full ssh commands)
  if (sshCommand) {
    // Parse "ssh -p PORT root@HOST"
    const match = sshCommand.match(/ssh\s+(?:-p\s+(\d+)\s+)?(\w+)@([\w.-]+)/);
    if (match) {
      await terminalManager.openSshSession({ host: match[3], port: Number(match[1]) || 22, user: match[2], label });
      return;
    }
  }

  // No item — prompt the user to pick from instances
  if (!checkConfigured()) return;
  await instancesProvider.load();
  if (instancesProvider.instances.length === 0) {
    vscode.window.showInformationMessage("No instances available to SSH into.");
    return;
  }
  const pick = await vscode.window.showQuickPick(
    instancesProvider.instances.map((inst) => {
      const node = inst.nodes.find((n) => n.sshHost);
      return {
        label: inst.tier,
        description: `${inst.status} · ${node?.location || ""}`,
        host: node?.sshHost,
        port: node?.sshPort,
      };
    }).filter((p) => p.host),
    { placeHolder: "Select an instance to SSH into" },
  );
  if (pick?.host && pick.port) {
    await terminalManager.openSshSession({ host: pick.host, port: pick.port, label: pick.label });
  }
}

// Covenant: add a memory entry
async function cmdCovenantRemember() {
  const content = await vscode.window.showInputBox({
    prompt: "What should I remember?",
    placeHolder: "e.g. We use Drizzle ORM, not Prisma, for this project.",
    ignoreFocusOut: true,
  });
  if (!content) return;

  const typePick = await vscode.window.showQuickPick(
    [
      { label: "Decision", value: "decision" as const },
      { label: "Pattern", value: "pattern" as const },
      { label: "Feedback", value: "feedback" as const },
      { label: "Context", value: "context" as const },
    ],
    { placeHolder: "Memory type" },
  );
  if (!typePick) return;

  await covenant.remember({ type: typePick.value, content, source: "user" });
  vscode.window.showInformationMessage("✓ Remembered. This will be included in future chat context.");
  devTokens.onDecision();
}

// Authentication is owned by the native main-process PKCE broker. The legacy
// extension must never accept bearer credentials from a query string,
// clipboard, input box or workspace setting.
async function cmdConnectWallet() {
  const verifier = randomBytes(48).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  let timeout: NodeJS.Timeout | undefined;
  const server = createServer(async (request, response) => {
    try {
      const callback = new URL(request.url || "/", "http://127.0.0.1");
      const code = callback.searchParams.get("code");
      if (!code || callback.searchParams.get("state") !== state) throw new Error("OAuth callback validation failed");
      const redirectUri = `http://127.0.0.1:${(server.address() as { port: number }).port}/oauth/callback`;
      const tokenResponse = await fetch("https://www.capix.network/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri, client_id: "capix-ide" }),
      });
      const tokens = await tokenResponse.json() as { access_token?: string; refresh_token?: string; error?: string };
      if (!tokenResponse.ok || !tokens.access_token) throw new Error(tokens.error || `Token exchange failed (${tokenResponse.status})`);
      await client.saveOAuthTokens(tokens.access_token, tokens.refresh_token);
      response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
      response.end("Capix sign-in complete. Return to CapixIDE.");
      vscode.window.showInformationMessage("Capix sign-in complete.");
      await refreshAll();
      await vscode.commands.executeCommand("capix.agent.refreshAuth");
    } catch (error) {
      response.writeHead(400, { "content-type": "text/plain", "cache-control": "no-store" });
      response.end("Capix sign-in failed. Return to CapixIDE.");
      vscode.window.showErrorMessage(`Capix sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (timeout) clearTimeout(timeout); server.close();
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error("Unable to create secure sign-in callback"); }
  timeout = setTimeout(() => server.close(), 120_000);
  const redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`;
  const authorize = new URL("https://www.capix.network/oauth/authorize");
  Object.entries({ response_type: "code", client_id: "capix-ide", redirect_uri: redirectUri, scope: "openid account catalog", code_challenge: challenge, code_challenge_method: "S256", state, nonce: randomBytes(24).toString("base64url") }).forEach(([key, value]) => authorize.searchParams.set(key, value));
  await vscode.env.openExternal(vscode.Uri.parse(authorize.toString()));
}

// Top up wallet balance — shared across web and IDE
async function cmdTopUp() {
  if (!checkConfigured()) return;

  const pick = await vscode.window.showQuickPick(
    [
      { label: "SOL (Solana)", description: "Deposit with your Solana wallet", value: "sol" },
      { label: "USDC (Solana)", description: "Stablecoin on Solana", value: "usdc" },
      { label: "USDC on Base", description: "Send from any EVM wallet", value: "usdc_base" },
    ],
    { placeHolder: "Select a deposit method" },
  );
  if (!pick) return;

  if (pick.value === "usdc_base") {
    const treasuryRes = await client.getBaseTreasury().catch(() => ({ ok: false }) as { ok: boolean });
    if (!treasuryRes.ok || !(treasuryRes as { treasury?: string }).treasury) {
      vscode.window.showErrorMessage("Base deposits not configured. Use SOL or USDC, or top up at the web billing page.");
      return;
    }
    const treasury = (treasuryRes as { treasury: string }).treasury;
    const amount = await vscode.window.showInputBox({ prompt: "Amount in USD", placeHolder: "10", ignoreFocusOut: true, validateInput: (v) => Number(v) > 0 ? null : "Enter a positive number" });
    if (!amount) return;

    const copied = await vscode.window.showInformationMessage(`Send ${amount} USDC on Base to:\n${treasury}\n\nThen submit the tx hash.`, "Copy address", "Open Billing Page");
    if (copied === "Copy address") { vscode.env.clipboard.writeText(treasury); }

    const evmAddress = await vscode.window.showInputBox({ prompt: "Your EVM sender address (0x...)", placeHolder: "0x...", ignoreFocusOut: true, validateInput: (v) => /^0x[a-fA-F0-9]{40}$/.test(v) ? null : "Must be 0x + 40 hex chars" });
    if (!evmAddress) return;
    const txHash = await vscode.window.showInputBox({ prompt: "Paste your Base tx hash (0x...)", placeHolder: "0x...", ignoreFocusOut: true, validateInput: (v) => v.startsWith("0x") && v.length > 20 ? null : "Must be a 0x hash" });
    if (!txHash) return;

    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Verifying Base transaction…" }, async () => {
      const res = await client.submitBaseDeposit(txHash, Number(amount));
      if (res.ok) {
        vscode.window.showInformationMessage(`✓ Deposited $${Number(amount).toFixed(2)} — balance $${(res.balanceUsd || 0).toFixed(2)}.`);
        profileProvider.refresh();
      } else {
        vscode.window.showErrorMessage(res.error || "Verification failed.");
      }
    });
  } else {
    vscode.window.showInformationMessage(`Open the billing page to deposit ${pick.label}.`, "Open Billing Page").then((action) => {
      if (action === "Open Billing Page") vscode.env.openExternal(vscode.Uri.parse(`${client.getBaseUrl()}/cloud/billing`));
    });
  }
}

// Launch capix-code (the CLI coding assistant) in a terminal, pre-configured
// with the user's Capix endpoint + API key from SecretStorage.
async function cmdLaunchCapixCode() {
  // Read the auto-configured endpoint (set by auto-connect when a deploy goes live)
  const config = vscode.workspace.getConfiguration("capix");
  const baseUrl = config.get<string>("ai.baseUrl") || `${client.getBaseUrl()}/api/v1`;
  const model = config.get<string>("ai.model") || "auto";

  // Get the API key from SecretStorage
  let apiKey = await client.getSecret("capix.ai.apiKey") || "";
  // If no key from a deployed LLM, try the session token for the gateway
  if (!apiKey) {
    const token = await client.getStoredToken();
    if (token.startsWith("cpx_session.")) {
      apiKey = token;
    } else {
      vscode.window.showWarningMessage(
        "Capix Code: no API key configured. Set one with 'Capix: Connect Wallet' or deploy an LLM first.",
        "Connect Wallet",
      ).then((action) => {
        if (action === "Connect Wallet") vscode.commands.executeCommand("capix.connectWallet");
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
  const pick = await vscode.window.showQuickPick(
    [
      { label: "Auto", description: "Dynamically pick best model per task (reasoning vs coding)", value: "auto" as const, picked: current === "auto" },
      { label: "Private", description: "Use a deployed private uncensored LLM — no filters", value: "private" as const, picked: current === "private" },
      { label: "Loop", description: "Private LLM + continuous build until task complete, then destroy", value: "loop" as const, picked: current === "loop" },
    ],
    { placeHolder: `Current: ${current.toUpperCase()} — select a routing mode` },
  );
  if (!pick) return;
  await smartRouter.setMode(pick.value);

  if (pick.value === "private" && !smartRouter.hasPrivateEndpoint()) {
    const deploy = await vscode.window.showInformationMessage(
      "No private LLM is deployed. Deploy one now?",
      "Deploy",
    );
    if (deploy === "Deploy") {
      vscode.commands.executeCommand("capix.deployPrivateLlm");
    }
  }
}

// Deploy a private uncensored LLM via the Capix API
async function cmdDeployPrivateLlm() {
  if (!client.isConfigured) {
    vscode.window.showWarningMessage("Connect your wallet first.", "Connect Wallet").then((a) => {
      if (a === "Connect Wallet") vscode.commands.executeCommand("capix.connectWallet");
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
  if (statusBarItem) updateStatusBar(statusBarItem);
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
  if (model) smartRouter.blockModel(model);
}

// Favor a model (always prefer)
async function cmdRouterFavorModel() {
  const model = await vscode.window.showInputBox({
    prompt: "Model ID to favor (e.g. 'deepseek/deepseek-r1')",
    placeHolder: "provider/model-name",
    ignoreFocusOut: true,
  });
  if (model) smartRouter.favorModel(model);
}
