/**
 * ModelPicker — a quick-pick surface over the synced model list.
 *
 * Shows all available models grouped by category (Capix Auto / Featured / Your
 * Private Models / Community), with specs inline. The chosen default is
 * persisted to the `capix.ai.model` workspace setting so every surface (Capix
 * Code panel, the CLI launcher, the gateway) reads the same selection.
 *
 * Design tokens (@capix/ui-tokens): cyan #3DCED6 accents.
 */

import * as vscode from "vscode";
import type { ModelEntry, ModelSync } from "./modelSync";
import { logger } from "./logger";

interface ModelQuickPickItem extends vscode.QuickPickItem {
  model: ModelEntry;
}

const CONFIG_SECTION = "capix";
const CONFIG_KEY = "ai.model";
const DEFAULT_MODEL = "auto";

export class ModelPicker {
  constructor(private sync: ModelSync) {}

  /**
   * Shows a QuickPick with all models grouped by category:
   * ── Capix Auto ─────────────
   *   capix/auto (recommended)
   * ── Featured ───────────────
   *   supergemma-gemma3-27b (27B, 128K context, $0.0008/1K)
   * ── Your Private Models ────
   *   microsoft/phi-3 (ready, $0.15/hr)
   *   your-org/custom-model (provisioning...)
   * ── Community ──────────────
   *   qwen2.5-coder-7b
   *   llama-3.3-70b
   */
  async show(): Promise<ModelEntry | undefined> {
    let models = this.sync.getModels();
    if (models.length === 0) {
      models = await this.sync.refresh();
    }

    const currentDefault = this.getCurrentDefault();
    const items: Array<ModelQuickPickItem | (vscode.QuickPickItem & { kind: vscode.QuickPickItemKind.Separator })> = [];

    const auto = models.filter((m) => m.id === "capix/auto");
    const featured = models.filter(
      (m) => m.id !== "capix/auto" && (m.provider === "capix" && !m.isPrivate),
    );
    const privateModels = models.filter((m) => m.isPrivate);
    const community = models.filter((m) => m.provider === "community");

    const addGroup = (title: string, group: ModelEntry[]) => {
      if (group.length === 0) return;
      items.push({ label: title, kind: vscode.QuickPickItemKind.Separator });
      for (const m of group) {
        items.push(this.toItem(m, currentDefault));
      }
    };

    if (auto.length === 0) {
      // Always offer Capix Auto even when the sync hasn't populated yet.
      addGroup("Capix Auto", [
        {
          id: "capix/auto",
          name: "Capix Auto",
          provider: "capix",
          isPrivate: false,
          status: "ready",
          modelRef: DEFAULT_MODEL,
          description: "Dynamic routing — picks the best model per task.",
        },
      ]);
    } else {
      addGroup("Capix Auto", auto);
    }
    addGroup("Featured", featured);
    addGroup("Your Private Models", privateModels);
    addGroup("Community", community);

    const picked = (await vscode.window.showQuickPick(items, {
      placeHolder: "Select a model — Capix Code + the gateway will use this",
      matchOnDescription: true,
      matchOnDetail: true,
    })) as ModelQuickPickItem | undefined;

    if (!picked || !picked.model) return undefined;
    await this.setDefault(picked.model.modelRef ?? picked.model.id, picked.model.name);
    return picked.model;
  }

  /** Get the current default model (persisted in workspace settings). */
  getCurrentDefault(): string {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    return config.get<string>(CONFIG_KEY) || DEFAULT_MODEL;
  }

  /** Set the default model (persists to `capix.ai.model`). */
  async setDefault(modelRef: string, label?: string): Promise<void> {
    try {
      const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
      await config.update(
        CONFIG_KEY,
        modelRef,
        vscode.ConfigurationTarget.Global,
      );
      logger.info("ModelPicker default set", { modelRef, label });
    } catch (err) {
      logger.error("ModelPicker.setDefault failed", { error: String(err) });
    }
  }

  private toItem(m: ModelEntry, currentDefault: string): ModelQuickPickItem {
    const isCurrent = (m.modelRef ?? m.id) === currentDefault;
    const isAuto = m.id === "capix/auto";
    const parts: string[] = [];
    if (m.parameters) parts.push(m.parameters);
    if (m.contextWindow) parts.push(this.formatContext(m.contextWindow));
    if (m.costPer1kTokens != null) {
      parts.push(`$${m.costPer1kTokens}/1K`);
    } else if (m.pricePerHour != null && m.pricePerHour > 0) {
      parts.push(`$${m.pricePerHour.toFixed(2)}/hr`);
    }

    let label = m.name;
    if (isAuto) label += " (recommended)";
    if (isCurrent) label = "$(check) " + label;

    let description = parts.join(" · ");
    if (m.isPrivate) {
      description = `${this.statusLabel(m.status)}${description ? " · " + description : ""}`;
    }

    let detail = m.description ?? "";
    if (m.isPrivate && m.endpoint) detail = `${m.endpoint}`;

    return {
      label,
      description,
      detail: detail || undefined,
      model: m,
      picked: isCurrent,
    };
  }

  private statusLabel(status: ModelEntry["status"]): string {
    switch (status) {
      case "ready":
        return "ready";
      case "provisioning":
        return "provisioning…";
      case "failed":
        return "failed";
      default:
        return status;
    }
  }

  private formatContext(tokens: number): string {
    if (tokens >= 1000) {
      const k = tokens / 1000;
      return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}K context`;
    }
    return `${tokens} context`;
  }
}
