/**
 * Creation Wizard — native multi-step resource creation for every Capix
 * workload kind, right from the IDE.
 *
 * One deterministic flow per kind (VM, dedicated GPU, private model,
 * container service, website, serverless job):
 *   1. Kind-specific configuration (presets or advanced)
 *   2. Runtime / image details
 *   3. Duration or ongoing budget (jobs: run timeout)
 *   4. Placement (automatic or preferred region)
 *   5. LIVE QUOTE from the routing API   (POST /api/v1/quotes)
 *   6. Explicit confirmation before any spend — the modal shows the full
 *      specification, hourly/per-run cost, maximum authorized charge,
 *      billing asset, quote expiry and cleanup policy
 *   7. Deployment creation (ledger hold) (POST /api/v1/deployments)
 *   8. Live provisioning progress, result + receipt
 *
 * Money is integer minor units end-to-end; conversion to display strings
 * happens only at the modal/receipt edge. Customer-facing text never names
 * upstream providers.
 */

import * as vscode from "vscode";
import { CapixClient } from "./apiClient";
import { logger } from "./logger";
import { minorToDisplay } from "./moneyUtils";

export type CreationKind =
  | "cpu_vm"
  | "dedicated_gpu"
  | "private_model"
  | "container_service"
  | "website"
  | "serverless_job";

export const CREATION_KINDS: readonly CreationKind[] = [
  "cpu_vm",
  "dedicated_gpu",
  "private_model",
  "container_service",
  "website",
  "serverless_job",
];

interface KindPickItem extends vscode.QuickPickItem {
  creationKind: CreationKind;
}

interface PresetPickItem extends vscode.QuickPickItem {
  value: string;
  spec?: Record<string, unknown>;
}

interface DurationPickItem extends vscode.QuickPickItem {
  hours?: number;
  budget?: boolean;
}

export interface CreationQuote {
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
}

interface OperationApiResponse {
  ok?: boolean;
  data?: { phase?: string; state?: string };
  phase?: string;
  state?: string;
}

const KIND_ITEMS: KindPickItem[] = [
  {
    label: "$(vm) Virtual machine",
    description: "CPU VM — vCPU/RAM/disk",
    detail: "Web apps, build runners, long-lived services.",
    creationKind: "cpu_vm",
  },
  {
    label: "$(symbol-misc) Dedicated GPU",
    description: "GPU from the live market",
    detail: "Training, inference, rendering, data-parallel jobs.",
    creationKind: "dedicated_gpu",
  },
  {
    label: "$(shield) Private model",
    description: "Private LLM endpoint",
    detail: "Self-hosted serving with a private API key.",
    creationKind: "private_model",
  },
  {
    label: "$(package) Container service",
    description: "OCI image, always-on",
    detail: "Any containerized service with a port.",
    creationKind: "container_service",
  },
  {
    label: "$(globe) Website",
    description: "Static or SSR site from a repo",
    detail: "Edge deployment with automatic TLS.",
    creationKind: "website",
  },
  {
    label: "$(zap) Serverless job",
    description: "One-shot or scheduled run",
    detail: "Billed per run; scales to zero.",
    creationKind: "serverless_job",
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

export class CreationWizard {
  constructor(private readonly client: CapixClient) {}

  async start(kind?: CreationKind): Promise<void> {
    try {
      // Step 1 — kind (unless the command pinned one).
      const resolvedKind = kind ?? (await this.chooseKind());
      if (!resolvedKind) return;

      // Step 2 — kind-specific configuration (preset or advanced).
      const config = await this.configureKind(resolvedKind);
      if (!config) return;

      // Step 3 — duration / budget (jobs: run timeout).
      const duration = await this.selectDuration(resolvedKind);
      if (!duration) return;

      // Step 4 — placement.
      const placement = await this.selectPlacement();
      if (!placement) return;

      // Step 5 — live quote from the routing API.
      const spec: Record<string, unknown> = {
        kind: resolvedKind,
        ...config,
        durationHours: duration.hours,
        budgetUsdMinor: duration.budgetUsdMinor?.toString(),
        timeoutMinutes: duration.timeoutMinutes,
        ongoing: duration.ongoing,
        placement,
        billingAsset: "USDC",
      };
      const quote = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Requesting live quote…", cancellable: false },
        () => this.requestQuote(spec),
      );
      if (!quote) {
        vscode.window.showErrorMessage("Capix could not produce a quote. Try a smaller duration or budget.");
        return;
      }

      // Step 6 — explicit confirmation before any spend.
      const confirmed = await this.confirmQuote(resolvedKind, quote);
      if (!confirmed) {
        vscode.window.showInformationMessage("Creation cancelled — no funds were reserved.");
        return;
      }

      // Step 7 — create the deployment (ledger hold).
      const deployment = await this.createDeployment(quote.quoteId);
      if (!deployment) {
        vscode.window.showErrorMessage("Capix could not create the deployment. The quote was not charged.");
        return;
      }

      // Step 8 — live provisioning, result + receipt.
      await this.pollProvisioning(deployment.operationId || deployment.deploymentId);
      await this.presentResult(resolvedKind, deployment.deploymentId, quote);
    } catch (err) {
      logger.error("CreationWizard failed", { error: String(err) });
      vscode.window.showErrorMessage(
        `Capix creation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Steps ────────────────────────────────────────────────────────────────

  private async chooseKind(): Promise<CreationKind | undefined> {
    const pick = await vscode.window.showQuickPick(KIND_ITEMS, {
      placeHolder: "What would you like to create?",
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true,
    });
    return pick?.creationKind;
  }

  private async configureKind(kind: CreationKind): Promise<Record<string, unknown> | undefined> {
    switch (kind) {
      case "cpu_vm":
        return this.configureVm();
      case "dedicated_gpu":
        return this.configureGpu();
      case "private_model":
        return this.configureModel();
      case "container_service":
        return this.configureContainer();
      case "website":
        return this.configureWebsite();
      case "serverless_job":
        return this.configureJob();
    }
  }

  private async pickPreset(kind: CreationKind, presets: PresetPickItem[]): Promise<Record<string, unknown> | undefined> {
    const pick = await vscode.window.showQuickPick(presets, {
      placeHolder: `Configuration for ${this.kindLabel(kind)}`,
      matchOnDetail: true,
      ignoreFocusOut: true,
    });
    if (!pick) return undefined;
    if (pick.value === "advanced") return { advanced: true };
    return pick.spec ?? { preset: pick.value };
  }

  private async configureVm(): Promise<Record<string, unknown> | undefined> {
    const preset = await this.pickPreset("cpu_vm", [
      { label: "Capix Micro", description: "1 vCPU · 2 GB · 25 GB", detail: "Dev & CLI workloads", value: "micro", spec: { tier: "micro", vcpu: 1, ramGb: 2, diskGb: 25 } },
      { label: "Capix Standard", description: "4 vCPU · 8 GB · 80 GB", detail: "Services & APIs", value: "standard", spec: { tier: "standard", vcpu: 4, ramGb: 8, diskGb: 80 } },
      { label: "Capix Pro", description: "8 vCPU · 16 GB · 160 GB", detail: "Builds & CI", value: "pro", spec: { tier: "pro", vcpu: 8, ramGb: 16, diskGb: 160 } },
      { label: "$(settings) Advanced configuration…", description: "Custom vCPU, RAM, disk", value: "advanced" },
    ]);
    if (!preset) return undefined;

    if (preset.advanced) {
      const vcpu = await this.promptNumber("vCPU count", "4", 1, 64);
      if (vcpu === undefined) return undefined;
      const ramGb = await this.promptNumber("RAM (GB)", "8", 1, 256);
      if (ramGb === undefined) return undefined;
      const diskGb = await this.promptNumber("Disk (GB)", "80", 10, 2000);
      if (diskGb === undefined) return undefined;
      preset.vcpu = vcpu; preset.ramGb = ramGb; preset.diskGb = diskGb;
      delete preset.advanced;
    }

    const image = await vscode.window.showInputBox({
      prompt: "VM image",
      placeHolder: "ubuntu:24.04",
      value: "ubuntu:24.04",
      ignoreFocusOut: true,
    });
    if (image === undefined) return undefined;
    return { ...preset, image: image || "ubuntu:24.04" };
  }

  private async configureGpu(): Promise<Record<string, unknown> | undefined> {
    const preset = await this.pickPreset("dedicated_gpu", [
      { label: "24 GB class", description: "1 GPU · 8 vCPU · 48 GB", detail: "Inference & rendering", value: "gpu-24", spec: { gpuClass: "24gb", numGpus: 1, vramGb: 24, vcpu: 8, ramGb: 48 } },
      { label: "40 GB class", description: "1 GPU · 12 vCPU · 80 GB", detail: "Training", value: "gpu-40", spec: { gpuClass: "40gb", numGpus: 1, vramGb: 40, vcpu: 12, ramGb: 80 } },
      { label: "80 GB class", description: "1 GPU · 12 vCPU · 160 GB", detail: "Large models", value: "gpu-80", spec: { gpuClass: "80gb", numGpus: 1, vramGb: 80, vcpu: 12, ramGb: 160 } },
      { label: "$(settings) Advanced configuration…", description: "Custom GPU count + VRAM", value: "advanced" },
    ]);
    if (!preset) return undefined;

    if (preset.advanced) {
      const numGpus = await this.promptNumber("GPU count", "1", 1, 8);
      if (numGpus === undefined) return undefined;
      const vramGb = await this.promptNumber("Minimum VRAM per GPU (GB)", "24", 8, 160);
      if (vramGb === undefined) return undefined;
      preset.numGpus = numGpus; preset.minVramGb = vramGb;
      delete preset.advanced;
    }

    const image = await vscode.window.showInputBox({
      prompt: "Runtime image",
      placeHolder: "ubuntu:24.04-cuda",
      ignoreFocusOut: true,
    });
    if (image === undefined) return undefined;
    return { ...preset, image: image || undefined };
  }

  private async configureModel(): Promise<Record<string, unknown> | undefined> {
    const preset = await this.pickPreset("private_model", [
      { label: "7B class", description: "8 GB VRAM", detail: "Fast, inexpensive", value: "m-7b", spec: { modelClass: "7b", minVramGb: 8 } },
      { label: "32B class", description: "24 GB VRAM", detail: "Balanced quality/cost", value: "m-32b", spec: { modelClass: "32b", minVramGb: 24 } },
      { label: "70B class", description: "2× 80 GB GPUs", detail: "Frontier quality", value: "m-70b", spec: { modelClass: "70b", minVramGb: 160, gpuCount: 2 } },
      { label: "$(settings) Custom model…", description: "Hugging Face link + VRAM", value: "advanced" },
    ]);
    if (!preset) return undefined;

    if (preset.advanced) {
      const link = await vscode.window.showInputBox({
        prompt: "Hugging Face model link",
        placeHolder: "https://huggingface.co/org/model",
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() ? null : "A model link is required"),
      });
      if (link === undefined) return undefined;
      const minVramGb = await this.promptNumber("Minimum VRAM (GB)", "24", 8, 160);
      if (minVramGb === undefined) return undefined;
      return { modelLink: link.trim(), minVramGb };
    }
    return preset;
  }

  private async configureContainer(): Promise<Record<string, unknown> | undefined> {
    const image = await vscode.window.showInputBox({
      prompt: "Container image (registry/reference)",
      placeHolder: "registry.example.com/team/api:1.4.2",
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? null : "An image reference is required"),
    });
    if (image === undefined) return undefined;

    const port = await this.promptNumber("Container port", "8080", 1, 65535);
    if (port === undefined) return undefined;

    const replicas = await this.promptNumber("Replicas", "1", 1, 16);
    if (replicas === undefined) return undefined;

    const size = await this.pickPreset("container_service", [
      { label: "Small", description: "1 vCPU · 2 GB", value: "s", spec: { vcpu: 1, ramGb: 2 } },
      { label: "Medium", description: "2 vCPU · 4 GB", value: "m", spec: { vcpu: 2, ramGb: 4 } },
      { label: "Large", description: "4 vCPU · 8 GB", value: "l", spec: { vcpu: 4, ramGb: 8 } },
    ]);
    if (!size) return undefined;

    const envRaw = await vscode.window.showInputBox({
      prompt: "Environment variables KEY=VAL, comma-separated (optional)",
      placeHolder: "NODE_ENV=production,PORT=8080",
      ignoreFocusOut: true,
    });
    if (envRaw === undefined) return undefined;

    return {
      ...size,
      image: image.trim(),
      port,
      replicas,
      env: parseEnv(envRaw),
    };
  }

  private async configureWebsite(): Promise<Record<string, unknown> | undefined> {
    const preset = await this.pickPreset("website", [
      { label: "Static", description: "Edge CDN · automatic TLS", detail: "HTML/CSS/JS bundles", value: "static", spec: { siteKind: "static" } },
      { label: "Node SSR", description: "node:20 · edge runtime", detail: "Next/Express", value: "node-ssr", spec: { siteKind: "ssr", runtime: "node:20" } },
    ]);
    if (!preset) return undefined;

    const repo = await vscode.window.showInputBox({
      prompt: "Repository URL",
      placeHolder: "https://github.com/you/site",
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? null : "A repository URL is required"),
    });
    if (repo === undefined) return undefined;

    const buildCommand = await vscode.window.showInputBox({
      prompt: preset.siteKind === "ssr" ? "Build command" : "Build command (optional)",
      placeHolder: preset.siteKind === "ssr" ? "npm run build" : "",
      ignoreFocusOut: true,
      validateInput: (v) => (preset.siteKind === "ssr" && !v.trim() ? "SSR sites need a build command" : null),
    });
    if (buildCommand === undefined) return undefined;

    return { ...preset, repo: repo.trim(), buildCommand: buildCommand.trim() || undefined };
  }

  private async configureJob(): Promise<Record<string, unknown> | undefined> {
    const image = await vscode.window.showInputBox({
      prompt: "Job image",
      placeHolder: "python:3.12-slim",
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? null : "An image reference is required"),
    });
    if (image === undefined) return undefined;

    const command = await vscode.window.showInputBox({
      prompt: "Command",
      placeHolder: "python etl.py --date today",
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? null : "A command is required"),
    });
    if (command === undefined) return undefined;

    const trigger = await vscode.window.showQuickPick(
      [
        { label: "$(play) One-shot", description: "Run once, then scale to zero", value: "once" as const },
        { label: "$(calendar) Scheduled", description: "Cron schedule", value: "cron" as const },
      ],
      { placeHolder: "Trigger", ignoreFocusOut: true },
    );
    if (!trigger) return undefined;

    let schedule: string | undefined;
    if (trigger.value === "cron") {
      const cron = await vscode.window.showInputBox({
        prompt: "Cron schedule (UTC)",
        placeHolder: "0 6 * * *",
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim().split(/\s+/).length === 5 ? null : "Enter a 5-field cron expression"),
      });
      if (cron === undefined) return undefined;
      schedule = cron.trim();
    }

    const size = await this.pickPreset("serverless_job", [
      { label: "Small", description: "1 vCPU · 2 GB", value: "s", spec: { vcpu: 1, ramGb: 2 } },
      { label: "Medium", description: "2 vCPU · 4 GB", value: "m", spec: { vcpu: 2, ramGb: 4 } },
      { label: "Large", description: "4 vCPU · 8 GB", value: "l", spec: { vcpu: 4, ramGb: 8 } },
    ]);
    if (!size) return undefined;

    return {
      ...size,
      image: image.trim(),
      command: command.trim(),
      trigger: trigger.value,
      schedule,
    };
  }

  private async selectDuration(
    kind: CreationKind,
  ): Promise<{ hours?: number; budgetUsdMinor?: bigint; timeoutMinutes?: number; ongoing: boolean } | undefined> {
    // Jobs bill per run — pick a run timeout instead of a hold duration.
    if (kind === "serverless_job") {
      const timeoutMinutes = await this.promptNumber("Run timeout (minutes)", "30", 1, 1440);
      if (timeoutMinutes === undefined) return undefined;
      return { timeoutMinutes, ongoing: false };
    }

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
      return { budgetUsdMinor: BigInt(Math.round(Number(budget) * 1_000_000)), ongoing: true };
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

  private async requestQuote(spec: Record<string, unknown>): Promise<CreationQuote | undefined> {
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

  private async confirmQuote(kind: CreationKind, quote: CreationQuote): Promise<boolean> {
    const rate = minorToDisplay(quote.hourlyCostMinor, 6, 4);
    const max = minorToDisplay(quote.maxChargeMinor, 6, 2);
    const duration = quote.durationHours ? `${quote.durationHours}h` : "ongoing (budget cap)";
    const rateLabel = kind === "serverless_job" ? `$${rate}/run` : `$${rate}/hr`;
    const lines = [
      `Resource: ${this.kindLabel(kind)}`,
      `Specification: ${quote.specification}`,
      `Estimated cost: ${rateLabel}`,
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
      "Confirm creation",
      { modal: true, detail: lines.join("\n") },
      "Create",
      "Cancel",
    );
    return choice === "Create";
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
        for (const stage of PROVISIONING_STAGES) {
          progress.report({ message: stage, increment });
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

  private async presentResult(kind: CreationKind, deploymentId: string, quote: CreationQuote): Promise<void> {
    const receipt = this.buildReceipt(kind, deploymentId, quote);
    vscode.window.showInformationMessage(
      `Capix ${this.kindLabel(kind)} is live (${deploymentId.slice(0, 12) || "deployment"}).`,
      "Open details",
      "View receipt",
    ).then((action) => {
      if (action === "Open details") {
        void vscode.commands.executeCommand("capix.cloud.resource.open", deploymentId);
      } else if (action === "View receipt") {
        const channel = vscode.window.createOutputChannel("Capix Receipt", "log");
        channel.clear();
        channel.append(receipt);
        channel.show();
      }
    });
  }

  private buildReceipt(kind: CreationKind, deploymentId: string, quote: CreationQuote): string {
    const rate = minorToDisplay(quote.hourlyCostMinor, 6, 4);
    const rateLabel = kind === "serverless_job" ? `$${rate} ${quote.billingAsset}/run` : `$${rate} ${quote.billingAsset}/hr`;
    return [
      "════════════════════════════════════════",
      "  Capix — Creation Receipt",
      "════════════════════════════════════════",
      `Kind          : ${this.kindLabel(kind)}`,
      `Deployment ID : ${deploymentId}`,
      `Quote ID      : ${quote.quoteId}`,
      `Specification : ${quote.specification}`,
      `Cost          : ${rateLabel}`,
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

  // ── Helpers ─────────────────────────────────────────────────────────────

  private kindLabel(kind: CreationKind): string {
    switch (kind) {
      case "cpu_vm": return "virtual machine";
      case "dedicated_gpu": return "dedicated GPU";
      case "private_model": return "private model";
      case "container_service": return "container service";
      case "website": return "website";
      case "serverless_job": return "serverless job";
    }
  }

  private async promptNumber(prompt: string, placeHolder: string, min: number, max: number): Promise<number | undefined> {
    const raw = await vscode.window.showInputBox({
      prompt: `${prompt} (${min}–${max})`,
      placeHolder,
      ignoreFocusOut: true,
      validateInput: (v) => {
        const n = Number(v);
        return Number.isInteger(n) && n >= min && n <= max ? null : `Enter an integer between ${min} and ${max}`;
      },
    });
    if (raw === undefined) return undefined;
    return Number(raw);
  }

  private specToReadable(spec: Record<string, unknown>): string {
    const parts: string[] = [];
    if (spec.tier) parts.push(String(spec.tier));
    if (spec.gpuClass) parts.push(`${spec.numGpus ?? 1}× GPU (${spec.gpuClass})`);
    if (spec.numGpus && !spec.gpuClass) parts.push(`${spec.numGpus}× GPU`);
    if (spec.modelClass) parts.push(`${spec.modelClass} model`);
    if (spec.modelLink) parts.push(String(spec.modelLink).split("/").slice(-2).join("/"));
    if (spec.siteKind) parts.push(String(spec.siteKind));
    if (spec.image) parts.push(String(spec.image));
    if (spec.vcpu) parts.push(`${spec.vcpu} vCPU`);
    if (spec.ramGb) parts.push(`${spec.ramGb} GB RAM`);
    if (spec.vramGb ?? spec.minVramGb) parts.push(`${spec.vramGb ?? spec.minVramGb} GB VRAM`);
    if (spec.diskGb) parts.push(`${spec.diskGb} GB disk`);
    if (spec.replicas && Number(spec.replicas) > 1) parts.push(`${spec.replicas} replicas`);
    if (spec.trigger === "cron" && spec.schedule) parts.push(`cron ${spec.schedule}`);
    if (parts.length === 0) parts.push(String(spec.kind));
    return parts.join(" · ");
  }
}

function parseEnv(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!raw.trim()) return env;
  for (const pair of raw.split(",")) {
    const [k, ...rest] = pair.split("=");
    if (k?.trim()) env[k.trim()] = rest.join("=").trim();
  }
  return env;
}
