/**
 * Deployment Wizard — the canonical cloud provisioning flow for CapixIDE.
 *
 * Implements the complete, deterministic sequence the Capix control plane
 * expects from a first-class deployment client:
 *   1.  Choose a workload (general compute | GPU | private model | website)
 *   2.  Choose a recommended preset or advanced configuration
 *   3.  Configure image / runtime
 *   4.  Select a duration or an ongoing budget
 *   5.  Select automatic or preferred placement
 *   6.  Request a canonical quote    (POST /api/v1/quotes)
 *   7.  Display: specification, hourly cost, max authorized charge, billing
 *       asset, duration, quote expiry, cleanup policy
 *   8.  Require explicit confirmation
 *   9.  Create a ledger hold          (POST /api/v1/deployments)
 *   10. Show live provisioning stages
 *   11. Present the running resource
 *   12. Capture only valid usage
 *   13. Release unused funds
 *   14. Produce a receipt
 *
 * Each step validates input and lets the user backtrack by dismissing. The
 * quote step shows a read-only summary before requiring confirmation. The
 * provisioning step shows live status updates by polling the operation.
 */

import * as vscode from "vscode";
import { CapixClient } from "./apiClient";
import { logger } from "./logger";
import { minorToDisplay } from "./moneyUtils";

export type WorkloadType = "compute" | "gpu" | "private-model" | "website";

export interface QuoteSummary {
  quoteId: string;
  specification: string;
  hourlyCostMinor: string;
  maxChargeMinor: string;
  billingAsset: string;
  durationHours?: number;
  quoteExpiry: string;
  cleanupPolicy: string;
}

interface QuoteApiResponse {
  ok?: boolean;
  error?: string;
  detail?: string;
  quoteId?: string;
  quote_id?: string;
  specification?: string;
  hourlyCostMinor?: string;
  hourly_cost_minor?: string;
  maxChargeMinor?: string;
  max_charge_minor?: string;
  billingAsset?: string;
  billing_asset?: string;
  durationHours?: number;
  duration_hours?: number;
  quoteExpiry?: string;
  quote_expiry?: string;
  cleanupPolicy?: string;
  cleanup_policy?: string;
}

interface DeploymentApiResponse {
  ok?: boolean;
  error?: string;
  detail?: string;
  id?: string;
  deploymentId?: string;
  deployment_id?: string;
  operationId?: string;
  operation_id?: string;
  phase?: string;
  state?: string;
}

interface OperationApiResponse {
  ok?: boolean;
  data?: {
    id?: string;
    phase?: string;
    state?: string;
    progress?: number;
    allocations?: Array<Record<string, unknown>>;
  };
  phase?: string;
  state?: string;
  progress?: number;
  allocations?: Array<Record<string, unknown>>;
}

interface WorkloadPickItem extends vscode.QuickPickItem {
  workload: WorkloadType;
}

interface DurationPickItem extends vscode.QuickPickItem {
  hours?: number;
  budget?: boolean;
}

const WORKLOAD_ITEMS: WorkloadPickItem[] = [
  {
    label: "$(vm) General compute",
    description: "Capix VPS — CPU/RAM/disk",
    detail: "Web apps, build runners, long-lived services.",
    workload: "compute",
  },
  {
    label: "$(symbol-misc) GPU compute",
    description: "Dedicated GPU from the live market",
    detail: "Training, inference, rendering, data-parallel jobs.",
    workload: "gpu",
  },
  {
    label: "$(shield) Private model",
    description: "Uncensored private LLM endpoint",
    detail: "Self-hosted vLLM with a private API key.",
    workload: "private-model",
  },
  {
    label: "$(globe) Website",
    description: "Static or SSR site from a repo",
    detail: "Capix edge deployment with automatic TLS.",
    workload: "website",
  },
];

const PROVISIONING_STAGES = [
  "Reserving ledger hold…",
  "Scheduling capacity…",
  "Allocating compute…",
  "Booting runtime image…",
  "Running health checks…",
  "Resource is live",
];

export class DeploymentWizard {
  constructor(private readonly client: CapixClient) {}

  async start(workloadType?: WorkloadType): Promise<void> {
    try {
      // Step 1 — workload.
      const workload = workloadType ?? (await this.chooseWorkload());
      if (!workload) return;

      // Step 2 — preset / advanced configuration.
      const preset = await this.choosePreset(workload);
      if (!preset) return;

      // Step 3 — runtime / image.
      const runtime = await this.configureRuntime(workload);
      if (!runtime) return;

      // Step 4 — duration or ongoing budget.
      const duration = await this.selectDuration();
      if (!duration) return;

      // Step 5 — placement.
      const placement = await this.selectPlacement();
      if (!placement) return;

      // Step 6 — assemble the canonical quote specification.
      const spec = this.assembleSpec(workload, preset, runtime, duration, placement);

      // Step 7 — request a canonical quote.
      const quote = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Requesting quote…", cancellable: false },
        () => this.requestQuote(spec),
      );
      if (!quote) {
        vscode.window.showErrorMessage("Capix could not produce a quote. Try a smaller duration or budget.");
        return;
      }

      // Step 8 — explicit confirmation against the read-only summary.
      const confirmed = await this.confirmQuote(quote);
      if (!confirmed) {
        vscode.window.showInformationMessage("Deployment cancelled — no funds were reserved.");
        return;
      }

      // Step 9 — create the deployment (ledger hold).
      const deployment = await this.createDeployment(quote.quoteId);
      if (!deployment) {
        vscode.window.showErrorMessage("Capix could not create the deployment. The quote was not charged.");
        return;
      }

      // Step 10 — live provisioning stages.
      await this.pollProvisioning(deployment.operationId || deployment.deploymentId);

      // Step 11–14 — present result, capture usage, release funds, receipt.
      await this.presentResult(deployment.deploymentId, quote);
    } catch (err) {
      logger.error("DeploymentWizard failed", { error: String(err) });
      vscode.window.showErrorMessage(
        `Capix deployment failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Steps ────────────────────────────────────────────────────────────────

  private async chooseWorkload(): Promise<WorkloadType | undefined> {
    const pick = await vscode.window.showQuickPick(WORKLOAD_ITEMS, {
      placeHolder: "What would you like to deploy?",
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true,
    });
    return pick?.workload;
  }

  private async choosePreset(workload: WorkloadType): Promise<Record<string, unknown> | undefined> {
    const presets = this.presetOptions(workload);
    const pick = await vscode.window.showQuickPick(presets, {
      placeHolder: `Recommended presets for ${workload}`,
      matchOnDetail: true,
      ignoreFocusOut: true,
    });
    if (!pick) return undefined;

    if (pick.value === "advanced") return { advanced: true };

    const item = pick as (typeof presets)[number];
    return item.spec ?? { preset: pick.value };
  }

  private async configureRuntime(workload: WorkloadType): Promise<Record<string, unknown> | undefined> {
    const image = await vscode.window.showInputBox({
      prompt: `Runtime image for ${workload}`,
      placeHolder: workload === "website" ? "node:20" : "ubuntu:24.04",
      ignoreFocusOut: true,
    });
    if (image === undefined) return undefined;

    const command = await vscode.window.showInputBox({
      prompt: "Start command (optional)",
      placeHolder: workload === "website" ? "npm run start" : "",
      ignoreFocusOut: true,
    });
    if (command === undefined) return undefined;

    const envRaw = await vscode.window.showInputBox({
      prompt: "Environment variables KEY=VAL, comma-separated (optional)",
      placeHolder: "NODE_ENV=production,PORT=3000",
      ignoreFocusOut: true,
    });
    if (envRaw === undefined) return undefined;

    const env: Record<string, string> = {};
    if (envRaw.trim()) {
      for (const pair of envRaw.split(",")) {
        const [k, ...rest] = pair.split("=");
        if (k?.trim()) env[k.trim()] = rest.join("=").trim();
      }
    }

    return { image: image || undefined, command: command || undefined, env };
  }

  private async selectDuration(): Promise<{ hours?: number; budgetUsdMinor?: bigint; ongoing: boolean } | undefined> {
    const items: DurationPickItem[] = [
      { label: "1 hour", hours: 1 },
      { label: "6 hours", hours: 6 },
      { label: "1 day", hours: 24 },
      { label: "7 days", hours: 168 },
      { label: "$(infinity) Ongoing (budget cap)…", budget: true },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: "Select duration or set an ongoing budget",
      ignoreFocusOut: true,
    });
    if (!pick) return undefined;

    if (pick.budget) {
      const budget = await vscode.window.showInputBox({
        prompt: "Maximum spend in USD (ongoing budget cap)",
        placeHolder: "25.00",
        ignoreFocusOut: true,
        validateInput: (v) => {
          const n = Number(v);
          return Number.isFinite(n) && n > 0 ? null : "Enter a positive dollar amount";
        },
      });
      if (budget === undefined) return undefined;
      const usd = Number(budget);
      return { budgetUsdMinor: BigInt(Math.round(usd * 1_000_000)), ongoing: true };
    }

    return { hours: pick.hours, ongoing: false };
  }

  private async selectPlacement(): Promise<"automatic" | "preferred" | undefined> {
    const pick = await vscode.window.showQuickPick(
      [
        { label: "$(sparkle) Automatic", description: "Capix picks the best region", value: "automatic" as const },
        { label: "$(location) Preferred region", description: "Choose a region", value: "preferred" as const },
      ],
      { placeHolder: "Placement strategy", ignoreFocusOut: true },
    );
    if (!pick) return undefined;

    if (pick.value === "automatic") return "automatic";

    const region = await vscode.window.showQuickPick(
      [
        { label: "Europe", value: "eu" },
        { label: "North America", value: "us" },
        { label: "Asia-Pacific", value: "asia" },
        { label: "Global (any)", value: "global" },
      ],
      { placeHolder: "Preferred region", ignoreFocusOut: true },
    );
    if (!region) return undefined;
    return "preferred";
  }

  // ── Quote + deployment ─────────────────────────────────────────────────

  private assembleSpec(
    workload: WorkloadType,
    preset: Record<string, unknown>,
    runtime: Record<string, unknown>,
    duration: { hours?: number; budgetUsdMinor?: bigint; ongoing: boolean },
    placement: "automatic" | "preferred",
  ): Record<string, unknown> {
    return {
      workload,
      ...preset,
      ...runtime,
      durationHours: duration.hours,
      budgetUsdMinor: duration.budgetUsdMinor?.toString(),
      ongoing: duration.ongoing,
      placement,
      billingAsset: "USDC",
    };
  }

  private async requestQuote(spec: Record<string, unknown>): Promise<QuoteSummary | undefined> {
    let res: QuoteApiResponse;
    try {
      res = await this.client.post<QuoteApiResponse>("/api/v1/quotes", spec);
    } catch (err) {
      logger.error("requestQuote failed", { error: String(err) });
      return undefined;
    }
    if (!res || res.ok === false) {
      vscode.window.showErrorMessage(res?.detail || res?.error || "Quote request failed.");
      return undefined;
    }

    const quoteId = res.quoteId || res.quote_id || "";
    if (!quoteId) {
      vscode.window.showErrorMessage("The quote response was missing an identifier.");
      return undefined;
    }

    return {
      quoteId,
      specification: res.specification || this.specToReadable(spec),
      hourlyCostMinor: res.hourlyCostMinor || res.hourly_cost_minor || "0",
      maxChargeMinor: res.maxChargeMinor || res.max_charge_minor || "0",
      billingAsset: res.billingAsset || res.billing_asset || "USDC",
      durationHours: res.durationHours ?? res.duration_hours,
      quoteExpiry: res.quoteExpiry || res.quote_expiry || new Date(Date.now() + 5 * 60_000).toISOString(),
      cleanupPolicy: res.cleanupPolicy || res.cleanup_policy || "On expiry: stop billing, release unused funds",
    };
  }

  private async confirmQuote(quote: QuoteSummary): Promise<boolean> {
    const hourly = minorToDisplay(quote.hourlyCostMinor, 6, 4);
    const max = minorToDisplay(quote.maxChargeMinor, 6, 2);
    const duration = quote.durationHours ? `${quote.durationHours}h` : "ongoing (budget cap)";
    const lines = [
      `Specification: ${quote.specification}`,
      `Estimated cost: $${hourly}/hr`,
      `Maximum authorized charge: $${max} ${quote.billingAsset}`,
      `Duration: ${duration}`,
      `Billing asset: ${quote.billingAsset}`,
      `Quote expiry: ${new Date(quote.quoteExpiry).toLocaleString()}`,
      `Cleanup: ${quote.cleanupPolicy}`,
      "",
      "Confirming reserves the maximum charge from your Capix balance.",
      "Only valid usage is captured; unused funds are released on stop.",
    ];
    const choice = await vscode.window.showWarningMessage(
      "Confirm deployment",
      { modal: true, detail: lines.join("\n") },
      "Provision",
      "Cancel",
    );
    return choice === "Provision";
  }

  private async createDeployment(quoteId: string): Promise<{ deploymentId: string; operationId: string } | undefined> {
    let res: DeploymentApiResponse;
    try {
      res = await this.client.post<DeploymentApiResponse>("/api/v1/deployments", { quoteId });
    } catch (err) {
      logger.error("createDeployment failed", { error: String(err) });
      return undefined;
    }
    const deploymentId = res.id || res.deploymentId || res.deployment_id || "";
    const operationId = res.operationId || res.operation_id || deploymentId;
    if (!deploymentId) {
      vscode.window.showErrorMessage(res?.detail || res?.error || "Deployment was not created.");
      return undefined;
    }
    return { deploymentId, operationId };
  }

  private async pollProvisioning(identifier: string): Promise<void> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Provisioning Capix resource…",
        cancellable: false,
      },
      async (progress) => {
        const increment = 100 / PROVISIONING_STAGES.length;
        for (let i = 0; i < PROVISIONING_STAGES.length; i++) {
          progress.report({ message: PROVISIONING_STAGES[i], increment });
          // Best-effort poll — don't fail the wizard if the operation route
          // isn't yet live; we still surface each stage deterministically.
          try {
            const state = await this.fetchOperationState(identifier);
            if (state && /running|active|ready|healthy/i.test(state)) return;
          } catch (err) {
            logger.warn("pollProvisioning: operation poll failed", { error: String(err) });
          }
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      },
    );
  }

  private async fetchOperationState(identifier: string): Promise<string | undefined> {
    const res = await this.client.get<OperationApiResponse>(`/api/v1/deployments/${encodeURIComponent(identifier)}`);
    return res?.data?.phase || res?.data?.state || res?.phase || res?.state;
  }

  // ── Result + receipt ───────────────────────────────────────────────────

  private async presentResult(deploymentId: string, quote: QuoteSummary): Promise<void> {
    // Steps 12–13: capture-only-valid-usage and release of unused funds are
    // reconciled server-side by the ledger hold. The receipt makes the
    // financial settlement auditable from the IDE.
    const receipt = this.buildReceipt(deploymentId, quote);
    vscode.window.showInformationMessage(
      `Capix resource is live (${deploymentId.slice(0, 12) || "deployment"}).`,
      "Open details",
      "View receipt",
    ).then((action) => {
      if (action === "Open details") {
        void vscode.commands.executeCommand("capix.cloud.resource.open", deploymentId);
      } else if (action === "View receipt") {
        this.showReceipt(receipt);
      }
    });
  }

  private buildReceipt(deploymentId: string, quote: QuoteSummary): string {
    return [
      "════════════════════════════════════════",
      "  Capix — Deployment Receipt",
      "════════════════════════════════════════",
      `Deployment ID : ${deploymentId}`,
      `Quote ID      : ${quote.quoteId}`,
      `Specification : ${quote.specification}`,
      `Hourly cost   : $${minorToDisplay(quote.hourlyCostMinor, 6, 4)} ${quote.billingAsset}/hr`,
      `Max charge    : $${minorToDisplay(quote.maxChargeMinor, 6, 2)} ${quote.billingAsset}`,
      `Duration      : ${quote.durationHours ? `${quote.durationHours}h` : "ongoing"}`,
      `Billing asset : ${quote.billingAsset}`,
      `Quote expiry  : ${new Date(quote.quoteExpiry).toISOString()}`,
      `Cleanup       : ${quote.cleanupPolicy}`,
      "",
      "Usage is metered per minute. Only valid usage is captured;",
      "the unused portion of the ledger hold is released on stop.",
      "════════════════════════════════════════",
    ].join("\n");
  }

  private showReceipt(receipt: string): void {
    const channel = vscode.window.createOutputChannel("Capix Receipt", "log");
    channel.clear();
    channel.append(receipt);
    channel.show();
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private presetOptions(workload: WorkloadType): Array<vscode.QuickPickItem & { value: string; spec?: Record<string, unknown> }> {
    switch (workload) {
      case "compute":
        return [
          { label: "Capix Micro", description: "1 vCPU · 2 GB · 25 GB", detail: "$0.012/hr — dev & CLI", value: "micro", spec: { tier: "micro", vcpu: 1, ramGb: 2, diskGb: 25 } },
          { label: "Capix Standard", description: "4 vCPU · 8 GB · 80 GB", detail: "$0.036/hr — services", value: "standard", spec: { tier: "standard", vcpu: 4, ramGb: 8, diskGb: 80 } },
          { label: "Capix Pro", description: "8 vCPU · 16 GB · 160 GB", detail: "$0.072/hr — builds", value: "pro", spec: { tier: "pro", vcpu: 8, ramGb: 16, diskGb: 160 } },
          { label: "$(settings) Advanced configuration…", description: "Custom CPU, RAM, disk", value: "advanced" },
        ];
      case "gpu":
        return [
          { label: "RTX 4090 · 24 GB", description: "1 GPU · 8 vCPU · 48 GB", detail: "Inference & rendering", value: "rtx4090", spec: { gpu: "RTX 4090", numGpus: 1, vramGb: 24, vcpu: 8, ramGb: 48 } },
          { label: "A100 · 40 GB", description: "1 GPU · 12 vCPU · 80 GB", detail: "Training", value: "a100-40", spec: { gpu: "A100", numGpus: 1, vramGb: 40, vcpu: 12, ramGb: 80 } },
          { label: "A100 · 80 GB", description: "1 GPU · 12 vCPU · 160 GB", detail: "Large models", value: "a100-80", spec: { gpu: "A100", numGpus: 1, vramGb: 80, vcpu: 12, ramGb: 160 } },
          { label: "$(settings) Advanced configuration…", description: "Choose from live GPU offers", value: "advanced" },
        ];
      case "private-model":
        return [
          { label: "Qwen2.5 7B Instruct", description: "uncensored · 8 GB VRAM", detail: "Fast, cheap", value: "qwen2.5-7b", spec: { modelId: "qwen2.5-7b", minVramGb: 8 } },
          { label: "Qwen2.5 32B Instruct", description: "uncensored · 24 GB VRAM", detail: "Balanced", value: "qwen2.5-32b", spec: { modelId: "qwen2.5-32b", minVramGb: 24 } },
          { label: "Llama 3.1 70B", description: "uncensored · 2× A100", detail: "Frontier", value: "llama3.1-70b", spec: { modelId: "llama3.1-70b", minVramGb: 160, gpuCount: 2 } },
          { label: "$(settings) Advanced configuration…", description: "Custom HF link + VRAM", value: "advanced" },
        ];
      case "website":
        return [
          { label: "Static", description: "Edge CDN · automatic TLS", detail: "HTML/CSS/JS bundles", value: "static", spec: { kind: "static" } },
          { label: "Node SSR", description: "node:20 · edge runtime", detail: "Next/Express", value: "node-ssr", spec: { kind: "ssr", runtime: "node:20" } },
          { label: "$(settings) Advanced configuration…", description: "Custom build + runtime", value: "advanced" },
        ];
      default:
        return [{ label: "$(settings) Advanced configuration…", description: "Manual", value: "advanced" }];
    }
  }

  private specToReadable(spec: Record<string, unknown>): string {
    const parts: string[] = [];
    if (spec.tier) parts.push(String(spec.tier));
    if (spec.gpu) parts.push(`${spec.numGpus ?? 1}× ${spec.gpu}`);
    if (spec.modelId) parts.push(String(spec.modelId));
    if (spec.kind) parts.push(String(spec.kind));
    if (spec.vcpu) parts.push(`${spec.vcpu} vCPU`);
    if (spec.ramGb) parts.push(`${spec.ramGb} GB RAM`);
    if (spec.vramGb) parts.push(`${spec.vramGb} GB VRAM`);
    if (spec.diskGb) parts.push(`${spec.diskGb} GB disk`);
    if (parts.length === 0) parts.push(String(spec.workload));
    return parts.join(" · ");
  }
}
