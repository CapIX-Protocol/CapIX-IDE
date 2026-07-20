
/**
 * Run-On selector — the execution-target model for CapixIDE and Capix Code.
 *
 * A single searchable QuickPick that lets the developer choose where the
 * current workspace / coding agent runs:
 *   • This Computer      — local execution
 *   • Capix Cloud        — provisioned compute on the Capix network
 *   • Remote Machine     — an externally-managed host reachable over SSH
 *
 * Within "Capix Cloud" the selector progressively discloses a second tier:
 * Existing Instance | New Compute | New GPU | New Private Model | Automatic.
 *
 * The chosen target is persisted per-workspace and surfaced to every surface
 * that consumes it: the status bar, the Capix Code composer, and the
 * deployment wizard. Design tokens (@capix/ui-tokens): dark foundation, cyan
 * accents (#3DCED6), green primary (#14F195).
 */

import * as vscode from "vscode";
import { logger } from "./logger";
import { RouteStatusBar } from "./routeStats";

export type RunOnTarget = "local" | "capix-cloud" | "remote-machine";

export interface CapixCloudTarget {
  type: "existing-instance" | "new-compute" | "new-gpu" | "new-private-model" | "automatic";
  instanceId?: string;
  modelId?: string;
}

export interface RunOnConfig {
  target: RunOnTarget;
  project?: string;
  repository?: string;
  branch?: string;
  environment?: string;
  regionPreference?: string;
  runtimeStatus?: string;
  estimatedCost?: { amount: string; asset: string; scale: number };
  currentSessionCost?: { amount: string; asset: string; scale: number };
  capixCloudTarget?: CapixCloudTarget;
}

interface TargetPickItem extends vscode.QuickPickItem {
  target: RunOnTarget;
}

interface CloudSubPickItem extends vscode.QuickPickItem {
  cloudType: CapixCloudTarget["type"];
}

interface ContextPickItem extends vscode.QuickPickItem {
  value: "configure" | "skip";
}

const STATE_KEY = "capix.runOn.config";

const TARGET_ITEMS: TargetPickItem[] = [
  {
    label: "$(device-desktop) This Computer",
    description: "Run locally on this machine",
    detail: "No cloud resources are provisioned; commands execute in your local shell.",
    target: "local",
  },
  {
    label: "$(cloud) Capix Cloud",
    description: "Provisioned compute on the Capix network",
    detail: "Reuse an existing instance or spin up compute, GPU, or a private model.",
    target: "capix-cloud",
  },
  {
    label: "$(remote) Remote Machine",
    description: "An externally-managed host over SSH",
    detail: "Execute on a remote machine you own or have configured separately.",
    target: "remote-machine",
  },
];

const CLOUD_SUB_ITEMS: CloudSubPickItem[] = [
  {
    label: "$(server) Existing Instance",
    description: "Reuse a running Capix deployment",
    cloudType: "existing-instance",
  },
  {
    label: "$(vm) New Compute",
    description: "General-purpose Capix compute (VPS)",
    cloudType: "new-compute",
  },
  {
    label: "$(symbol-misc) New GPU",
    description: "Dedicated GPU capacity from the live market",
    cloudType: "new-gpu",
  },
  {
    label: "$(shield) New Private Model",
    description: "Provision a private, uncensored LLM endpoint",
    cloudType: "new-private-model",
  },
  {
    label: "$(sparkle) Automatic",
    description: "Let Capix pick the best-fit resource",
    cloudType: "automatic",
  },
];

export class RunOnSelector {
  private config: RunOnConfig | null = null;
  private readonly handlers = new Set<(config: RunOnConfig) => void>();

  constructor(private readonly context: vscode.ExtensionContext) {
    // Route cost/latency meter next to the run-target command (capix.runOn).
    // Self-registers into context.subscriptions.
    new RouteStatusBar(context);
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const raw = this.context.workspaceState.get<string>(STATE_KEY);
      if (raw) this.config = JSON.parse(raw) as RunOnConfig;
    } catch (err) {
      logger.warn("RunOnSelector.load failed", { error: String(err) });
    }
  }

  /**
   * Show the Run-On selector. Returns the chosen configuration, or
   * `undefined` if the user dismisses any step.
   */
  async show(): Promise<RunOnConfig | undefined> {
    // Step 1 — choose the execution target.
    const targetPick = await vscode.window.showQuickPick(TARGET_ITEMS, {
      placeHolder: "Where should this run?",
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true,
    });
    if (!targetPick) return undefined;

    const config: RunOnConfig = { target: targetPick.target };

    // Step 2 — progressively disclose Capix Cloud sub-options.
    if (targetPick.target === "capix-cloud") {
      const sub = await vscode.window.showQuickPick(CLOUD_SUB_ITEMS, {
        placeHolder: "Capix Cloud — choose a resource type",
        matchOnDescription: true,
        matchOnDetail: true,
        ignoreFocusOut: true,
      });
      if (!sub) return undefined;
      config.capixCloudTarget = { type: sub.cloudType };

      if (sub.cloudType === "existing-instance") {
        const instanceId = await vscode.window.showInputBox({
          prompt: "Deployment ID to reuse (e.g. dep_…)",
          placeHolder: "dep_",
          ignoreFocusOut: true,
          validateInput: (v) => (v.trim().length > 0 ? null : "Enter a deployment ID"),
        });
        if (instanceId) config.capixCloudTarget.instanceId = instanceId.trim();
      }

      if (sub.cloudType === "new-private-model") {
        const modelId = await vscode.window.showInputBox({
          prompt: "Model ID (optional)",
          placeHolder: "e.g. qwen2.5-32b",
          ignoreFocusOut: true,
        });
        if (modelId) config.capixCloudTarget.modelId = modelId.trim();
      }
    }

    // Step 3 — optional context (project / branch / region / budget).
    const contextPick = await vscode.window.showQuickPick<ContextPickItem>(
      [
        { label: "$(settings) Configure context…", value: "configure" },
        { label: "$(check) Use defaults", value: "skip" },
      ],
      { placeHolder: "Adjust project, branch, region or budget?", ignoreFocusOut: true },
    );
    if (!contextPick) return undefined;

    if (contextPick.value === "configure") {
      config.branch =
        (await vscode.window.showInputBox({
          prompt: "Git branch (optional)",
          placeHolder: "main",
          ignoreFocusOut: true,
        })) || undefined;

      config.environment =
        (await vscode.window.showQuickPick(
          ["development", "staging", "production"].map((e) => ({ label: e })),
          { placeHolder: "Environment", ignoreFocusOut: true },
        ))?.label || undefined;

      config.regionPreference =
        (await vscode.window.showQuickPick(
          [
            { label: "Automatic (best available)", value: "global" },
            { label: "Europe", value: "eu" },
            { label: "North America", value: "us" },
            { label: "Asia-Pacific", value: "asia" },
          ],
          { placeHolder: "Region preference", ignoreFocusOut: true },
        ))?.value || undefined;
    }

    // Attach workspace-derived context.
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (ws) config.project = ws.name;
    if (config.branch) config.repository = ws?.name;

    config.runtimeStatus = "ready";
    this.persistAndEmit(config);
    return config;
  }

  /** The current Run-On context for display (status bar, composer header). */
  getCurrentTarget(): RunOnConfig | null {
    return this.config;
  }

  /** Register a handler invoked whenever the target changes. */
  onTargetChanged(handler: (config: RunOnConfig) => void): void {
    this.handlers.add(handler);
  }

  private persistAndEmit(config: RunOnConfig): void {
    this.config = config;
    void this.context.workspaceState.update(STATE_KEY, JSON.stringify(config));
    for (const handler of this.handlers) {
      try {
        handler(config);
      } catch (err) {
        logger.warn("RunOnSelector handler threw", { error: String(err) });
      }
    }
  }
}

/** Render a short, human-readable label for a Run-On target (status bar). */
export function runOnLabel(config: RunOnConfig | null): string {
  if (!config) return "$(question) Run on: —";
  switch (config.target) {
    case "local":
      return "$(device-desktop) Run on: This Computer";
    case "remote-machine":
      return "$(remote) Run on: Remote Machine";
    case "capix-cloud": {
      const sub = config.capixCloudTarget?.type ?? "automatic";
      const map: Record<CapixCloudTarget["type"], string> = {
        "existing-instance": "$(server) Run on: Capix Cloud · Existing",
        "new-compute": "$(vm) Run on: Capix Cloud · Compute",
        "new-gpu": "$(symbol-misc) Run on: Capix Cloud · GPU",
        "new-private-model": "$(shield) Run on: Capix Cloud · Private",
        automatic: "$(sparkle) Run on: Capix Cloud · Auto",
      };
      return map[sub];
    }
  }
}
