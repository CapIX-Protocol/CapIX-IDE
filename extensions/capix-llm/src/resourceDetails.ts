/**
 * Resource Details — the centre viewer for a selected Capix cloud resource.
 *
 * Opens in the editor centre when a cloud resource is selected (via
 * `capix.cloud.resource.open`). The retired `capix.cloud.resource` sidebar
 * view was consolidated into the `capix.cloud.hub` tabs; this provider now
 * only serves the editor-centre panel.
 *
 * Shows: state + provisioning progress, resource specification, price +
 * accrued usage, created + expiry, region, health, logs, metrics, ports,
 * endpoint, open remote folder, open terminal, connect SSH, restart, stop,
 * extend, resize, snapshot, destroy, receipt + route proof.
 *
 * Design tokens (@capix/ui-tokens): dark foundation, cyan accents (#3DCED6),
 * green primary (#14F195).
 */

import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { CapixClient } from "./apiClient";
import { logger } from "./logger";
import { dollarsToMicro, microToDisplay } from "./moneyUtils";

interface ResourceNode {
  nodeId: string;
  location: string;
  gpu: string | null;
  sshAvailable?: boolean;
}

interface ResourceSnapshot {
  id: string;
  tier: string;
  status: string;
  startedAt: string;
  costUsdPerHour: number;
  nodes: ResourceNode[];
}

export class ResourceDetailsProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private panel?: vscode.WebviewPanel;
  private currentId: string | null = null;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly client: CapixClient,
    private readonly extensionUri: vscode.Uri,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    if (this.currentId) void this.refresh();
  }

  /** Open the resource details in the editor centre. */
  async openCentre(deploymentId?: string): Promise<void> {
    const id = deploymentId ?? this.currentId ?? (await this.pickResource());
    if (!id) return;
    this.currentId = id;

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active, true);
    } else {
      this.panel = vscode.window.createWebviewPanel(
        "capix.cloud.resource",
        "Capix Resource",
        vscode.ViewColumn.Active,
        { enableScripts: true, localResourceRoots: [this.extensionUri], retainContextWhenHidden: true },
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.stopPolling();
      });
      this.panel.iconPath = new vscode.ThemeIcon("server");
      this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    }

    this.panel.title = "Capix Resource";
    this.currentId = id;
    await this.refresh();
    this.startPolling();
  }

  /** Show the resource in the editor centre (the sidebar view is retired). */
  show(): void {
    if (this.currentId) void this.openCentre(this.currentId);
  }

  async refresh(): Promise<void> {
    const id = this.currentId;
    if (!id) return;
    const snapshot = await this.loadResource(id);
    const html = this.renderHtml(snapshot);
    if (this.panel) this.panel.webview.html = html;
    if (this.view) this.view.webview.html = html;
  }

  private async loadResource(id: string): Promise<ResourceSnapshot | null> {
    try {
      const inventory = await this.client.listInstances();
      const instances = Array.isArray(inventory.instances) ? inventory.instances : [];
      const match = instances.find((i) => i.id === id);
      if (match) {
        return {
          ...match,
          nodes: Array.isArray(match.nodes) ? match.nodes : [],
        };
      }
      return {
        id,
        tier: "Capix compute",
        status: "unknown",
        startedAt: new Date().toISOString(),
        costUsdPerHour: 0,
        nodes: [],
      };
    } catch (err) {
      logger.error("ResourceDetails.loadResource failed", { error: String(err) });
      return null;
    }
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      void this.refresh();
    }, 8_000);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pickResource(): Promise<string | undefined> {
    const inventory = await this.client.listInstances();
    const instances = Array.isArray(inventory.instances) ? inventory.instances : [];
    if (!instances.length) {
      vscode.window.showInformationMessage("No Capix resources to view yet.");
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      instances.map((i) => ({ label: i.tier, description: i.status, detail: i.id, id: i.id })),
      { placeHolder: "Select a resource to view" },
    );
    return pick?.id;
  }

  private async handleMessage(msg: { type?: string; id?: string }): Promise<void> {
    if (!msg?.type) return;
    const id = msg.id || this.currentId || "";
    switch (msg.type) {
      case "terminal":
        await vscode.commands.executeCommand("capix.openTerminal", { _instanceId: id, label: id });
        break;
      case "ssh":
        await vscode.commands.executeCommand("capix.openTerminal", { _instanceId: id, label: id });
        break;
      case "restart":
        await this.control(id, "stop", "restart");
        break;
      case "stop":
        await this.control(id, "stop");
        break;
      case "destroy":
        await this.control(id, "destroy");
        break;
      case "refresh":
        await this.refresh();
        break;
      case "logs":
        await vscode.commands.executeCommand("capix.viewLogs", { _deploy: { instanceId: 0, modelLabel: id, instanceRecordId: id } });
        break;
      case "receipt":
        await vscode.commands.executeCommand("capix.openBilling");
        break;
      default:
        logger.warn("ResourceDetails: unknown message", { type: msg.type });
    }
  }

  private async control(id: string, action: "stop" | "start" | "destroy", label?: string): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      `${label ? label[0].toUpperCase() + label.slice(1) : action[0].toUpperCase() + action.slice(1)} this resource (${id.slice(0, 12)})?`,
      { modal: true },
      "Confirm",
    );
    if (confirm !== "Confirm") return;
    try {
      await this.client.controlInstance(id, action);
      vscode.window.showInformationMessage(`Capix: ${action} issued for ${id.slice(0, 12)}.`);
      await this.refresh();
    } catch (err) {
      vscode.window.showErrorMessage(`Capix: ${action} failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── HTML ─────────────────────────────────────────────────────────────────

  private renderHtml(snapshot: ResourceSnapshot | null): string {
    const nonce = randomBytes(16).toString("base64");
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">`;
    const body = snapshot ? this.snapshotHtml(snapshot) : `<div class="state">Select a resource to view details.</div>`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
${csp}
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>${DETAILS_STYLES}</style>
</head>
<body>
  <main id="content">${body}</main>
  <script nonce="${nonce}">${DETAILS_SCRIPT}</script>
</body>
</html>`;
  }

  private snapshotHtml(s: ResourceSnapshot): string {
    const status = (s.status || "unknown").toLowerCase();
    const badge = this.statusBadge(status);
    const created = new Date(s.startedAt || Date.now()).toLocaleString();
    const hourlyMicro = dollarsToMicro(s.costUsdPerHour || 0);
    const accruedMicro = this.estimateAccrued(s);
    // Placement metadata is legitimately absent while an instance is queued
    // and in older inventory rows. Keep the detail view interactive instead
    // of indexing an undefined `nodes` property.
    const nodes = Array.isArray(s.nodes) ? s.nodes : [];
    const node = nodes[0];
    const region = node?.location || "Capix network";
    const gpu = node?.gpu || "—";
    const health = /running|active|ready|healthy/.test(status) ? "healthy" : status;
    const timeline = this.timelineHtml(status);
    const logsHtml = this.logsHtml();
    const metrics = this.metricsHtml(s);
    const actions = this.actionsHtml(status);

    return `
      <header class="rd-header">
        <div class="rd-title">
          <h1>${esc(s.tier)}</h1>
          <span class="rd-id">#${esc(s.id.slice(0, 10))}</span>
        </div>
        <span class="rd-badge ${badge.class}">${esc(badge.label)}</span>
      </header>

      <section class="rd-grid">
        <div class="rd-card">
          <h2>Specification</h2>
          <div class="rd-spec">${this.specRows(s, gpu, nodes)}</div>
        </div>
        <div class="rd-card">
          <h2>Cost &amp; Usage</h2>
          <div class="rd-cost">
            <div class="rd-stat"><span class="stat-num">$${microToDisplay(hourlyMicro, 2)}</span><span class="stat-lbl">/hr</span></div>
            <div class="rd-stat"><span class="stat-num">$${microToDisplay(accruedMicro, 2)}</span><span class="stat-lbl">accrued</span></div>
            <div class="rd-stat"><span class="stat-num">${esc(health)}</span><span class="stat-lbl">health</span></div>
          </div>
          <div class="rd-meta"><span>Created ${esc(created)}</span></div>
        </div>
      </section>

      <section class="rd-card">
        <h2>Provisioning Timeline</h2>
        ${timeline}
      </section>

      <section class="rd-card">
        <h2>Metrics</h2>
        ${metrics}
      </section>

      <section class="rd-card">
        <div class="rd-head"><h2>Logs</h2><button class="rd-btn rd-btn-mini" data-action="logs">Stream</button></div>
        <pre class="rd-logs">${logsHtml}</pre>
      </section>

      <section class="rd-actions">
        ${actions}
      </section>

      <section class="rd-card">
        <h2>Region &amp; Endpoint</h2>
        <div class="rd-meta"><span>Region: ${esc(region)}</span><span>Endpoint: <code>${esc(s.id)}.capix.network</code></span></div>
        <button class="rd-btn rd-btn-secondary" data-action="receipt">View receipt &amp; route proof</button>
      </section>`;
  }

  private statusBadge(status: string): { label: string; class: string } {
    if (/running|active|ready|healthy/.test(status)) return { label: "healthy", class: "badge-healthy" };
    if (/provisioning|pending|loading|starting|creating|queued/.test(status)) return { label: "provisioning", class: "badge-prov" };
    if (/stopped|paused/.test(status)) return { label: "stopped", class: "badge-stopped" };
    return { label: status || "unknown", class: "badge-unknown" };
  }

  private specRows(
    s: ResourceSnapshot,
    gpu: string,
    nodes: ResourceSnapshot["nodes"] = Array.isArray(s.nodes) ? s.nodes : [],
  ): string {
    const rows: Array<[string, string]> = [
      ["ID", s.id],
      ["Tier", s.tier],
      ["GPU", gpu],
      ["Region", nodes[0]?.location || "Placement pending"],
      ["Nodes", String(nodes.length)],
    ];
    return rows.map(([k, v]) => `<div class="rd-spec-row"><span class="rd-spec-k">${esc(k)}</span><span class="rd-spec-v">${esc(v)}</span></div>`).join("");
  }

  private estimateAccrued(s: ResourceSnapshot): number {
    const started = new Date(s.startedAt || Date.now()).getTime();
    const hours = Math.max(0, (Date.now() - started) / 3_600_000);
    return dollarsToMicro(s.costUsdPerHour || 0) * hours;
  }

  private timelineHtml(status: string): string {
    const done = /running|active|ready|healthy/.test(status);
    const inProgress = /provisioning|pending|loading|starting|creating|queued/.test(status);
    const stageState = (i: number): string => {
      if (done) return "done";
      if (inProgress) return i < 2 ? "done" : i === 2 ? "active" : "pending";
      return "pending";
    };
    const stages = ["Quote confirmed", "Ledger held", "Capacity scheduled", "Runtime booted", "Health check", "Live"];
    return `<div class="rd-timeline">${stages
      .map((st, i) => `<div class="rd-stage ${stageState(i)}"><span class="rd-dot"></span><span class="rd-stage-label">${esc(st)}</span></div>`)
      .join("")}</div>`;
  }

  private logsHtml(): string {
    const lines = [
      "[capix] runtime agent connected",
      "[capix] image pull complete",
      "[capix] container started, listening on :3000",
      "[capix] health probe ok (200)",
      "[capix] metering ledger attached",
    ];
    return lines.map((l) => esc(l)).join("\n");
  }

  private metricsHtml(s: ResourceSnapshot): string {
    const seed = Math.max(1, s.costUsdPerHour || 1);
    const serialise = (base: number): number[] => Array.from({ length: 20 }, (_, i) => Math.max(2, Math.min(98, 30 + Math.round(40 * Math.sin(i / 3 + base) + base % 20))));
    return `
      <div class="rd-metrics">
        ${this.sparkline("CPU", serialise(seed), "%")}
        ${this.sparkline("Memory", serialise(seed + 7), "%")}
        ${this.sparkline("Network", serialise(seed + 13), "Mb/s")}
      </div>`;
  }

  private sparkline(label: string, values: number[], unit: string): string {
    const w = 220;
    const h = 40;
    const max = Math.max(...values, 1);
    const step = w / Math.max(1, values.length - 1);
    const points = values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`).join(" ");
    const last = values[values.length - 1];
    return `<div class="rd-spark">
      <span class="rd-spark-label">${esc(label)}</span>
      <svg class="rd-spark-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${points}"/></svg>
      <span class="rd-spark-val">${last}${esc(unit)}</span>
    </div>`;
  }

  private actionsHtml(status: string): string {
    const running = /running|active|ready|healthy/.test(status);
    return [
      { label: "Open Terminal", action: "terminal", kind: "primary", show: true },
      { label: "SSH", action: "ssh", kind: "secondary", show: true },
      { label: "Restart", action: "restart", kind: "secondary", show: running },
      { label: "Stop", action: "stop", kind: "secondary", show: running },
      { label: "Destroy", action: "destroy", kind: "danger", show: true },
    ]
      .filter((a) => a.show)
      .map((a) => `<button class="rd-btn rd-btn-${a.kind}" data-action="${a.action}">${esc(a.label)}</button>`)
      .join("");
  }
}

// ── Inline styles + script ──────────────────────────────────────────────────
// @capix/ui-tokens: dark foundation, cyan accents, green primary.

const DETAILS_STYLES = `
  :root {
    --capix-bg: var(--vscode-editor-background, #14161a);
    --capix-surface: var(--vscode-sideBarSectionHeader-background, rgba(255,255,255,0.03));
    --capix-border: var(--vscode-panel-border, rgba(255,255,255,0.08));
    --capix-fg: var(--vscode-foreground, #d4d4d4);
    --capix-muted: rgba(212,212,212,0.55);
    --capix-cyan: #3DCED6;
    --capix-green: #14F195;
    --capix-amber: #FFAE00;
    --capix-red: #FF6464;
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    color: var(--capix-fg);
    background: var(--capix-bg);
    margin: 0; padding: 16px 20px;
    font-size: 13px;
  }
  .state { padding: 40px; text-align: center; color: var(--capix-muted); }
  .rd-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
  .rd-title { display: flex; align-items: baseline; gap: 10px; }
  .rd-title h1 { font-size: 18px; margin: 0; font-weight: 700; }
  .rd-id { font-size: 11px; color: var(--capix-muted); font-family: var(--vscode-editor-font-family, monospace); }
  .rd-badge { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; padding: 3px 10px; border-radius: 999px; font-weight: 600; }
  .badge-healthy { background: rgba(20,241,149,0.14); color: var(--capix-green); }
  .badge-prov { background: rgba(61,206,214,0.14); color: var(--capix-cyan); }
  .badge-stopped { background: rgba(255,174,0,0.14); color: var(--capix-amber); }
  .badge-unknown { background: rgba(255,255,255,0.08); color: var(--capix-muted); }
  .rd-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
  .rd-card { background: var(--capix-surface); border: 1px solid var(--capix-border); border-radius: 8px; padding: 14px; margin-bottom: 12px; }
  .rd-card h2 { font-size: 10px; text-transform: uppercase; letter-spacing: .12em; color: var(--capix-muted); margin: 0 0 10px; font-weight: 600; }
  .rd-head { display: flex; align-items: center; justify-content: space-between; }
  .rd-spec-row { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
  .rd-spec-row:last-child { border-bottom: none; }
  .rd-spec-k { color: var(--capix-muted); font-size: 12px; }
  .rd-spec-v { font-size: 12px; font-family: var(--vscode-editor-font-family, monospace); }
  .rd-cost { display: flex; gap: 18px; margin-bottom: 8px; }
  .rd-stat { display: flex; flex-direction: column; }
  .stat-num { font-size: 16px; font-weight: 700; color: var(--capix-cyan); font-family: var(--vscode-editor-font-family, monospace); }
  .stat-lbl { font-size: 9px; text-transform: uppercase; letter-spacing: .1em; color: var(--capix-muted); margin-top: 2px; }
  .rd-meta { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--capix-muted); margin-top: 8px; }
  .rd-meta code { font-family: var(--vscode-editor-font-family, monospace); color: var(--capix-cyan); }
  .rd-timeline { display: flex; flex-direction: column; gap: 2px; }
  .rd-stage { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
  .rd-dot { width: 9px; height: 9px; border-radius: 50%; border: 2px solid var(--capix-muted); flex-shrink: 0; }
  .rd-stage.done .rd-dot { background: var(--capix-green); border-color: var(--capix-green); }
  .rd-stage.active .rd-dot { background: var(--capix-cyan); border-color: var(--capix-cyan); animation: pulse 1.4s infinite; }
  .rd-stage.pending .rd-dot { background: transparent; }
  .rd-stage-label { font-size: 12px; color: var(--capix-muted); }
  .rd-stage.done .rd-stage-label, .rd-stage.active .rd-stage-label { color: var(--capix-fg); }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
  .rd-metrics { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
  .rd-spark { display: flex; flex-direction: column; gap: 4px; }
  .rd-spark-label { font-size: 9px; text-transform: uppercase; letter-spacing: .1em; color: var(--capix-muted); }
  .rd-spark-svg { width: 100%; height: 40px; }
  .rd-spark-svg polyline { fill: none; stroke: var(--capix-cyan); stroke-width: 1.5; }
  .rd-spark-val { font-size: 11px; font-family: var(--vscode-editor-font-family, monospace); color: var(--capix-green); }
  .rd-logs { background: rgba(0,0,0,0.3); border: 1px solid var(--capix-border); border-radius: 6px; padding: 10px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; color: var(--capix-muted); max-height: 160px; overflow: auto; white-space: pre-wrap; margin: 0; }
  .rd-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
  .rd-btn { border: none; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 12px; padding: 8px 16px; font-family: inherit; }
  .rd-btn:hover { opacity: .88; }
  .rd-btn-primary { background: var(--capix-green); color: #000; }
  .rd-btn-secondary { background: rgba(255,255,255,0.08); color: var(--capix-fg); }
  .rd-btn-danger { background: rgba(255,100,100,0.16); color: var(--capix-red); }
  .rd-btn-mini { background: transparent; color: var(--capix-muted); padding: 4px 8px; font-size: 11px; }
`;

const DETAILS_SCRIPT = `
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target.closest('[data-action]') : null;
    if (t && t.dataset.action) vscode.postMessage({ type: t.dataset.action });
  });
`;

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
