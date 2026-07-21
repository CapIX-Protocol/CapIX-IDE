/**
 * routeStats — live route cost/latency telemetry for the status bar.
 *
 * Every streamed inference call through `CapixClient.streamAgentChat`
 * records a sample (latency, routed model/region, usage cost) into the
 * `routeStats` singleton. The `RouteStatusBar` renders the current route,
 * last-request latency and session cost, and opens the Run-On selector on
 * click — the "what does this cost me right now, and where could it run
 * instead" loop from the status bar.
 */

import * as vscode from "vscode";

export interface RouteSample {
  latencyMs: number;
  model: string;
  region: string;
  /** Micro-USD string as emitted by the gateway usage event. */
  costMinor: string;
}

class RouteStats {
  private lastSample: RouteSample | null = null;
  private requests = 0;
  private sessionCostMicro = 0;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  record(sample: RouteSample): void {
    this.lastSample = sample;
    this.requests++;
    const micro = Number(sample.costMinor);
    if (Number.isFinite(micro)) this.sessionCostMicro += micro;
    this.emitter.fire();
  }

  snapshot(): {
    lastLatencyMs: number | null;
    lastModel: string;
    lastRegion: string;
    requests: number;
    sessionCostUsd: number;
  } {
    return {
      lastLatencyMs: this.lastSample ? this.lastSample.latencyMs : null,
      lastModel: this.lastSample?.model ?? "",
      lastRegion: this.lastSample?.region ?? "",
      requests: this.requests,
      sessionCostUsd: this.sessionCostMicro / 1_000_000,
    };
  }
}

export const routeStats = new RouteStats();

/** Status bar meter: route · latency · session cost. Click → run target. */
export class RouteStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(context: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.item.command = "capix.runOn";
    this.disposables.push(
      routeStats.onDidChange(() => this.update()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("capix.ai.preferredProvider") || e.affectsConfiguration("capix.ai.preferredModel")) {
          this.update();
        }
      }),
    );
    context.subscriptions.push(this);
    this.update();
    this.item.show();
  }

  private update(): void {
    const snap = routeStats.snapshot();
    const config = vscode.workspace.getConfiguration("capix");
    const route = config.get<string>("ai.preferredProvider", "auto");
    const model = config.get<string>("ai.preferredModel", "");
    const latency = snap.lastLatencyMs !== null ? `${(snap.lastLatencyMs / 1000).toFixed(1)}s` : "—";
    const cost = snap.sessionCostUsd > 0 ? `$${snap.sessionCostUsd.toFixed(4)}` : "$0.00";
    this.item.text = `$(zap) ${route} · ${latency} · ${cost}`;
    const tip = new vscode.MarkdownString(undefined, true);
    tip.appendMarkdown("**Capix route meter**\n\n");
    tip.appendMarkdown(`- Route preference: \`${route}\`${model ? ` (${model})` : ""}\n`);
    if (snap.lastModel) tip.appendMarkdown(`- Last routed model: \`${snap.lastModel}\` (${snap.lastRegion || "global"})\n`);
    tip.appendMarkdown(`- Last request latency: ${latency}\n`);
    tip.appendMarkdown(`- Requests this session: ${snap.requests}\n`);
    tip.appendMarkdown(`- Session inference cost: ${cost}\n\n`);
    tip.appendMarkdown("Click to choose where the agent runs — this machine, your GPU, or Capix Cloud.");
    this.item.tooltip = tip;
  }

  dispose(): void {
    this.item.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
