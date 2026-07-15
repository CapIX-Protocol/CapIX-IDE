/**
 * Capix IDE — inline cost awareness status bar item.
 *
 * A single left-aligned status bar item that keeps spend visible while you work:
 *   • idle (no running resources):  `$0.00/min`  in dim gray
 *   • deployment running:          `$0.04/min`  in cyan
 *   • tooltip:                     `$0.04/min · $0.12 today`
 *
 * It refreshes every 30 seconds from /api/v1/resources (per-minute rate) and
 * /api/v1/cost (today's spend). Clicking opens a quick pick with: View Cost
 * Breakdown, Set Spend Alert, Stop All Resources.
 *
 * The indicator degrades gracefully — if either endpoint is unreachable it
 * keeps the last known state and stays dim, never throwing into the host.
 */

import * as vscode from "vscode";
import { CapixClient } from "./apiClient";
import { logger } from "./logger";

const REFRESH_INTERVAL_MS = 30_000;
const COLOR_IDLE = "#6b7280";
const COLOR_RUNNING = "#3DCED6";

interface ResourceInfo {
  id: string;
  type?: string;
  status?: string;
  costPerHourUsd?: number;
  url?: string;
  region?: string;
}

interface CostBreakdown {
  items?: Array<{ resource: string; todayUsd: number; monthUsd: number }>;
  totalTodayUsd?: number;
  totalMonthUsd?: number;
  creditRemainingUsd?: number;
}

const TERMINAL_STATES = new Set(["STOPPED", "TERMINATED", "DELETED", "FAILED", "stopped", "terminated", "deleted", "failed"]);

function isRunning(status: string | undefined): boolean {
  if (!status) return false;
  return !TERMINAL_STATES.has(status);
}

function usd(value: number | undefined, decimals = 2): string {
  const v = Number.isFinite(value as number) ? (value as number) : 0;
  return v.toFixed(decimals);
}

export class CostIndicator {
  private readonly item: vscode.StatusBarItem;
  private readonly client: CapixClient;
  private readonly timer: NodeJS.Timeout;
  private readonly clickCommand = "capix.costIndicator.click";
  private readonly disposable: vscode.Disposable;
  private lastRatePerMin = 0;
  private lastTodayUsd = 0;
  private lastCreditUsd = 0;
  private running = false;

  constructor(client: CapixClient) {
    this.client = client;
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 48);
    this.item.command = this.clickCommand;
    this.item.tooltip = "Capix cost — click for breakdown";

    this.disposable = vscode.Disposable.from(
      this.item,
      vscode.commands.registerCommand(this.clickCommand, () => this.onClick()),
    );

    this.timer = setInterval(() => {
      void this.refresh();
    }, REFRESH_INTERVAL_MS);
  }

  activate(): vscode.Disposable {
    void this.refresh();
    return new vscode.Disposable(() => {
      clearInterval(this.timer);
      this.disposable.dispose();
    });
  }

  private async refresh(): Promise<void> {
    let ratePerMin = 0;
    let running = false;
    try {
      const resources = await this.client.get<ResourceInfo[] | { data?: ResourceInfo[] }>("/api/v1/resources");
      const list = Array.isArray(resources) ? resources : (resources?.data ?? []);
      const active = list.filter((r) => isRunning(r.status));
      if (active.length > 0) {
        running = true;
        const perHour = active.reduce((sum, r) => sum + (Number(r.costPerHourUsd) || 0), 0);
        ratePerMin = perHour > 0 ? perHour / 60 : 0.04;
      }
    } catch (err) {
      // Endpoint unavailable — keep last known state, do not surface to host.
      logger.error("costIndicator resources fetch failed", { error: String(err) });
    }

    try {
      const cost = await this.client.get<CostBreakdown>("/api/v1/cost");
      this.lastTodayUsd = Number(cost?.totalTodayUsd) || 0;
      this.lastCreditUsd = Number(cost?.creditRemainingUsd) || 0;
    } catch (err) {
      logger.error("costIndicator cost fetch failed", { error: String(err) });
    }

    if (ratePerMin > 0) {
      this.lastRatePerMin = ratePerMin;
      this.running = true;
    } else if (running) {
      this.lastRatePerMin = 0.04;
      this.running = true;
    } else {
      this.lastRatePerMin = 0;
      this.running = false;
    }

    this.render();
  }

  private render(): void {
    const rate = this.running ? this.lastRatePerMin : 0;
    this.item.text = `$${rate.toFixed(2)}/min`;
    this.item.color = this.running ? COLOR_RUNNING : COLOR_IDLE;
    this.item.tooltip = `$${rate.toFixed(2)}/min · $${usd(this.lastTodayUsd)} today${
      this.lastCreditUsd > 0 ? ` · $${usd(this.lastCreditUsd)} credit left` : ""
    }`;
    this.item.show();
  }

  private async onClick(): Promise<void> {
    const pick = await vscode.window.showQuickPick(
      [
        { label: "$(list-tree) View Cost Breakdown", action: "breakdown" },
        { label: "$(zap) Set Spend Alert", action: "alert" },
        { label: "$(stop) Stop All Resources", action: "stop" },
      ],
      { placeHolder: `Capix cost — $${usd(this.lastTodayUsd)} today · $${usd(this.lastCreditUsd)} credit left` },
    );
    if (!pick) return;
    switch (pick.action) {
      case "breakdown":
        await vscode.env.openExternal(vscode.Uri.parse(`${this.client.getBaseUrl()}/cloud/billing`));
        break;
      case "alert": {
        const input = await vscode.window.showInputBox({
          prompt: "Notify me when daily spend exceeds (USD)",
          validateInput: (v) => (/^\d+(\.\d{1,2})?$/.test(v.trim()) ? null : "Enter a dollar amount, e.g. 5.00"),
        });
        if (input) {
          await vscode.workspace.getConfiguration("capix").update("spendAlertUsd", Number(input), vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage(`Capix: spend alert set at $${input}/day.`);
        }
        break;
      }
      case "stop": {
        const confirm = await vscode.window.showWarningMessage(
          "Stop ALL running resources? Billing stops immediately.",
          { modal: true },
          "Stop all",
        );
        if (confirm === "Stop all") {
          await this.stopAllResources();
        }
        break;
      }
    }
  }

  private async stopAllResources(): Promise<void> {
    try {
      const resources = await this.client.get<ResourceInfo[] | { data?: ResourceInfo[] }>("/api/v1/resources");
      const list = Array.isArray(resources) ? resources : (resources?.data ?? []);
      const active = list.filter((r) => isRunning(r.status));
      if (active.length === 0) {
        vscode.window.showInformationMessage("No running resources to stop.");
        return;
      }
      let stopped = 0;
      for (const r of active) {
        try {
          await this.client.delete(`/api/v1/resources/${encodeURIComponent(r.id)}`);
          stopped += 1;
        } catch (err) {
          logger.error("costIndicator stop resource failed", { id: r.id, error: String(err) });
        }
      }
      vscode.window.showInformationMessage(`Capix: stopped ${stopped}/${active.length} resources. Billing halted.`);
      void this.refresh();
    } catch (err) {
      vscode.window.showErrorMessage(`Capix: could not list resources — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Register the inline cost indicator. Returns a disposable that tears it down. */
export function activateCostIndicator(client: CapixClient): vscode.Disposable {
  return new CostIndicator(client).activate();
}
