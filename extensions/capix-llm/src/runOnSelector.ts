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
      const subPick = await vscode.window.showQuickPick(CLOUD_SUB_ITEMS, {
        placeHolder: "Capix Cloud: choose the compute profile",
        matchOnDescription: true,
        ignoreFocusOut: true,
      });
      if (!subPick) return undefined;
      config.capixCloudTarget = { type: subPick.cloudType };

      if (subPick.cloudType === "existing-instance") {
        const instanceId = await vscode.window.showInputBox({
          prompt: "Existing instance ID (from Capix Cloud → Instances)",
          placeHolder: "inst_…",
          ignoreFocusOut: true,
        });
        if (!instanceId) return undefined;
        config.capixCloudTarget.instanceId = instanceId.trim();
      }
      if (subPick.cloudType === "new-private-model") {
        const modelId = await vscode.window.showInputBox({
          prompt: "Private model ID or Hugging Face link",
          placeHolder: "meta-llama/Llama-3.1-8B-Instruct",
          ignoreFocusOut: true,
        });
        if (!modelId) return undefined;
        config.capixCloudTarget.modelId = modelId.trim();
      }
    }

    if (targetPick.target === "remote-machine") {
      const host = await vscode.window.showInputBox({
        prompt: "Remote host (user@host[:port])",
        placeHolder: "dev@192.168.1.20",
        ignoreFocusOut: true,
      });
      if (!host) return undefined;
      config.environment = host.trim();
    }

    // Step 3 — optionally bind the workspace context.
    const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name;
    if (workspaceName) {
      const contextPick = await vscode.window.showQuickPick<ContextPickItem>(
        [
          {
            label: "$(folder) Use current workspace",
            description: workspaceName,
            value: "configure",
          },
          {
            label: "$(circle-slash) Skip for now",
            description: "Run without binding a project context",
            value: "skip",
          },
        ],
        { placeHolder: "Bind this run target to the current workspace?", ignoreFocusOut: true },
      );
      if (!contextPick) return undefined;
      if (contextPick.value === "configure") {
        config.project = workspaceName;
      }
    }

    await this.set(config);
    return config;
  }

  /** Current configuration (may be `null` until the user picks one). */
  current(): RunOnConfig | null {
    return this.config;
  }

  /** Subscribe to configuration changes (status bar, composer, wizard). */
  onDidChange(handler: (config: RunOnConfig) => void): vscode.Disposable {
    this.handlers.add(handler);
    return new vscode.Disposable(() => this.handlers.delete(handler));
  }

  /** Persist + broadcast a new configuration. */
  async set(config: RunOnConfig): Promise<void> {
    this.config = config;
    try {
      await this.context.workspaceState.update(STATE_KEY, JSON.stringify(config));
    } catch (err) {
      logger.warn("RunOnSelector.set failed", { error: String(err) });
    }
    for (const handler of this.handlers) {
      try {
        handler(config);
      } catch (err) {
        logger.warn("RunOnSelector handler failed", { error: String(err) });
      }
    }
  }

  /** Human-readable one-liner for status surfaces. */
  describe(): string {
    if (!this.config) return "Choose run target";
    const c = this.config;
    switch (c.target) {
      case "local":
        return "This Computer";
      case "remote-machine":
        return c.environment ? `Remote · ${c.environment}` : "Remote Machine";
      case "capix-cloud": {
        const sub = c.capixCloudTarget?.type;
        if (sub === "existing-instance" && c.capixCloudTarget?.instanceId) {
          return `Capix Cloud · ${c.capixCloudTarget.instanceId}`;
        }
        if (sub === "new-private-model" && c.capixCloudTarget?.modelId) {
          return `Capix Cloud · ${c.capixCloudTarget.modelId}`;
        }
        const labels: Record<NonNullable<CapixCloudTarget["type"]>, string> = {
          "existing-instance": "Existing Instance",
          "new-compute": "New Compute",
          "new-gpu": "New GPU",
          "new-private-model": "New Private Model",
          automatic: "Automatic",
        };
        return `Capix Cloud · ${sub ? labels[sub] : "Unconfigured"}`;
      }
    }
  }
}
