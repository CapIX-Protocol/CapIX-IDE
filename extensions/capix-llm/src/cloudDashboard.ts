/**
 * Cloud Dashboard — the "Cloud" destination's main view.
 *
 * A single webview that replaces the dozens of sidebar accordions (balance,
 * deployments, instances, agents, jobs, api-keys all stacked in one narrow
 * column). The dashboard shows a compact balance chip, a prominent new-resource
 * action, active + provisioning resources (destroyed resources are hidden from
 * the default state), private models, current hourly spend, recent usage, and a
 * navigation strip for the eight cloud surfaces.
 *
 * Design tokens (@capix/ui-tokens): dark foundation, cyan accents (#3DCED6),
 * green primary (#14F195). No giant wallet card — balance is a compact chip.
 */

import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { CapixApiError, CapixClient } from "./apiClient";
import { logger } from "./logger";
import { dollarsToMicro, microToDisplay } from "./moneyUtils";

interface DashboardInstance {
  id: string;
  tier: string;
  status: string;
  startedAt?: string;
  costUsdPerHour: number;
  paymentAsset?: string;
}

interface DashboardData {
  configured: boolean;
  balanceUsd: string;
  balanceSol: string;
  balanceUsdc: string;
  totalSpent: string;
  hourlySpendMicro: number;
  activeCount: number;
  provisioningCount: number;
  instances: DashboardInstance[];
  privateModels: DashboardInstance[];
  recent: Array<{ kind: string; amount: string; asset: string }>;
  updatedAt: string;
}

const DESTROYED = new Set([
  "terminated",
  "deleted",
  "destroyed",
  "cancelled",
  "failed",
  "destroy",
]);
const ACTIVE = new Set(["running", "active", "ready", "healthy"]);
const PROVISIONING = new Set([
  "pending",
  "provisioning",
  "loading",
  "starting",
  "creating",
  "queued",
]);

const NAV_TABS: Array<{ id: string; label: string; icon: string }> = [
  { id: "overview", label: "Overview", icon: "preview" },
  { id: "compute", label: "Compute", icon: "server" },
  { id: "gpus", label: "GPUs", icon: "symbol-misc" },
  { id: "private-models", label: "Private Models", icon: "shield" },
  { id: "websites", label: "Websites", icon: "globe" },
  { id: "usage", label: "Usage", icon: "graph" },
  { id: "api-keys", label: "API Keys", icon: "key" },
  { id: "network", label: "Network", icon: "radio-tower" },
];

export class CloudDashboardProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private data: DashboardData | null = null;
  private loading = false;
  private error: string | null = null;
  private configured = false;

  constructor(
    private client: CapixClient,
    private extensionUri: vscode.Uri,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    view.webview.html = this.getHtml();
    view.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.view || this.loading) return;
    this.loading = true;
    this.error = null;
    this.view.webview.postMessage({ type: "loading", value: true });
    this.view.webview.postMessage({ type: "error", value: null });

    try {
      this.configured = await this.client.checkConfigured();
      this.view.webview.postMessage({ type: "auth", configured: this.configured });
      if (!this.configured) {
        this.data = null;
        this.view.webview.html = this.getHtml();
        return;
      }

      const [balRes, deploysRes] = await Promise.all([
        this.client.getBalance().catch((err: unknown) => {
          logger.error("CloudDashboard.getBalance failed", { error: String(err) });
          return null;
        }),
        this.client.listDeploys().catch((err: unknown) => {
          logger.error("CloudDashboard.listDeploys failed", { error: String(err) });
          return null;
        }),
      ]);

      if (balRes && !balRes.ok) {
        this.error = balRes.error || "Cloud data could not be loaded.";
      }

      const balance = balRes?.balance ?? { usd: "0.00", sol: "0.0000", usdc: "0.00" };
      const instancesRaw = (balRes?.instances ?? []) as DashboardInstance[];
      const totalSpent = balRes?.totalSpent ?? "0.00";

      // Active + provisioning resources only — destroyed resources never
      // dominate the default state.
      const visible = instancesRaw.filter(
        (i) => !DESTROYED.has((i.status || "").toLowerCase()),
      );
      const active = visible.filter((i) => ACTIVE.has((i.status || "").toLowerCase()));
      const provisioning = visible.filter((i) =>
        PROVISIONING.has((i.status || "").toLowerCase()),
      );

      // Hourly spend across running resources.
      const hourlyMicro = active.reduce(
        (sum, i) => sum + dollarsToMicro(i.costUsdPerHour || 0),
        0,
      );

      // Private models: live LLM deploys (sagas with workload "llm").
      const privateModels: DashboardInstance[] = (deploysRes?.deploys ?? [])
        .filter((d) => d.live)
        .map((d) => {
          const inst = d.instance as { id?: string; tier?: string; status?: string };
          const live = d.live!;
          return {
            id: String(inst.id ?? ""),
            tier: live.modelLabel || inst.tier || "Private model",
            status: live.state,
            costUsdPerHour: live.pricePerHr || 0,
          };
        });

      const recent = (balRes?.transactions ?? [])
        .slice(0, 5)
        .map((tx) => {
          const row = tx as Record<string, unknown>;
          const kind =
            String(
              row.type || row.kind || row.description || row.memo || "Ledger entry",
            );
          const amount = String(
            row.amount || row.amountMinor || row.amount_minor || "",
          );
          const asset = String(row.asset || row.currency || "");
          return { kind, amount, asset };
        });

      this.data = {
        configured: true,
        balanceUsd: balance.usd || "0.00",
        balanceSol: balance.sol || "0.0000",
        balanceUsdc: balance.usdc || "0.00",
        totalSpent,
        hourlySpendMicro: hourlyMicro,
        activeCount: active.length,
        provisioningCount: provisioning.length,
        instances: visible,
        privateModels,
        recent,
        updatedAt: balRes?.updatedAt || new Date().toISOString(),
      };
    } catch (err) {
      logger.error("CloudDashboardProvider.refresh failed", { error: String(err) });
      this.error =
        err instanceof CapixApiError && err.status === 401
          ? "Your Capix session expired. Sign in again to view cloud resources."
          : "Cloud data could not be loaded. Check your connection and retry.";
    } finally {
      this.loading = false;
      // Render the authoritative snapshot directly (mirrors ProfileView) so the
      // dashboard never sits behind an indefinite loading placeholder.
      if (this.view) this.view.webview.html = this.getHtml();
    }
  }

  private handleMessage(msg: { type: string; id?: string; tab?: string }): void {
    switch (msg.type) {
      case "refresh":
        this.refresh();
        break;
      case "newResource":
        vscode.commands.executeCommand("capix.cloud.deploy");
        break;
      case "topUp":
        vscode.commands.executeCommand("capix.topUp");
        break;
      case "openBilling":
        vscode.commands.executeCommand("capix.openBilling");
        break;
      case "signIn":
        vscode.commands.executeCommand("capix.resetSessionAndSignIn");
        break;
      case "openConsole":
        vscode.commands.executeCommand("capix.openConsole");
        break;
      case "openInstance":
        if (msg.id) vscode.commands.executeCommand("capix.openInstance", msg.id);
        break;
      case "stopInstance":
        this.controlInstance(msg.id, "stop");
        break;
      case "destroyInstance":
        this.confirmDestroy(msg.id);
        break;
      case "nav":
        this.routeNav(msg.tab);
        break;
    }
  }

  private routeNav(tab?: string): void {
    switch (tab) {
      case "compute":
        vscode.commands.executeCommand("capix.deployVps");
        break;
      case "gpus":
        vscode.commands.executeCommand("capix.deployModel");
        break;
      case "private-models":
        vscode.commands.executeCommand("capix.deployPrivateLlm");
        break;
      case "usage":
        vscode.commands.executeCommand("capix.openBilling");
        break;
      case "api-keys":
        vscode.commands.executeCommand("capix.createApiKey");
        break;
      case "network":
        vscode.env.openExternal(
          vscode.Uri.parse(`${this.client.getBaseUrl()}/cloud/network`),
        );
        break;
      case "websites":
        vscode.env.openExternal(
          vscode.Uri.parse(`${this.client.getBaseUrl()}/cloud/websites`),
        );
        break;
      case "overview":
      default:
        this.refresh();
        break;
    }
  }

  private async controlInstance(
    id: string | undefined,
    action: "stop" | "start" | "destroy",
  ): Promise<void> {
    if (!id) return;
    try {
      await this.client.controlInstance(id, action);
      await this.refresh();
    } catch (err) {
      logger.error("CloudDashboard.controlInstance failed", {
        id,
        action,
        error: String(err),
      });
      vscode.window.showErrorMessage(
        `Capix: Could not ${action} resource — ${String(err)}`,
      );
    }
  }

  private async confirmDestroy(id: string | undefined): Promise<void> {
    if (!id) return;
    const confirm = await vscode.window.showWarningMessage(
      `Destroy resource ${id}? Billing stops immediately and this cannot be undone.`,
      { modal: true },
      "Destroy",
    );
    if (confirm !== "Destroy") return;
    await this.controlInstance(id, "destroy");
  }

  // ── HTML ──────────────────────────────────────────────────────────────────

  private getHtml(): string {
    const nonce = randomBytes(16).toString("base64");
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">`;
    const body = this.snapshotHtml();

    const tabs = NAV_TABS.map(
      (t) =>
        `<button class="nav-tab" data-nav="${t.id}">${t.label}</button>`,
    ).join("");

    return `<!DOCTYPE html>
<html lang="en">
<head>
${csp}
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>${DASHBOARD_STYLES}</style>
</head>
<body>
  <header class="dash-header">
    <div class="balance-chip" id="balance-chip">${this.balanceChipHtml()}</div>
    <button class="btn btn-new" id="new-resource">+ New Resource</button>
  </header>
  <nav class="nav-bar">${tabs}</nav>
  <main id="content">${body}</main>
  <script nonce="${nonce}">${DASHBOARD_SCRIPT}</script>
</body>
</html>`;
  }

  private balanceChipHtml(): string {
    if (!this.data || !this.configured) {
      return `<span class="chip-label">Balance</span><span class="chip-value">—</span>`;
    }
    return `<span class="chip-label">Balance</span>
      <span class="chip-value">$${esc(this.data.balanceUsd)}</span>
      <span class="chip-sub">${esc(this.data.balanceSol)} SOL · ${esc(this.data.balanceUsdc)} USDC</span>`;
  }

  private snapshotHtml(): string {
    if (this.loading) {
      return `<div class="state loading">Loading cloud resources…</div>`;
    }
    if (this.error) {
      return `<div class="state error"><p>${esc(this.error)}</p><button class="btn btn-secondary" data-action="refresh">Retry</button></div>`;
    }
    if (!this.configured || !this.data) {
      return `<div class="state connect"><p>Sign in to view your Capix cloud resources, balance, and usage.</p><button class="btn btn-primary" data-action="signIn">Sign In</button></div>`;
    }

    const d = this.data;
    const updated = new Date(d.updatedAt).toLocaleTimeString();

    const instancesRows = d.instances.length
      ? d.instances
          .map((i) => {
            const status = (i.status || "unknown").toLowerCase();
            const badge = ACTIVE.has(status)
              ? "running"
              : PROVISIONING.has(status)
                ? "provisioning"
                : status;
            return `<div class="res-row">
              <div class="res-main">
                <span class="res-name">${esc(i.tier)}</span>
                <span class="res-badge badge-${esc(badge)}">${esc(badge)}</span>
                <span class="res-id">#${esc(i.id.slice(0, 8))}</span>
              </div>
              <div class="res-actions">
                <span class="res-rate">${esc(microToDisplay(dollarsToMicro(i.costUsdPerHour), 2))}/hr</span>
                <button class="icon-btn" data-action="openInstance" data-id="${esc(i.id)}" title="Open">$(link)</button>
                ${
                  ACTIVE.has(status)
                    ? `<button class="icon-btn" data-action="stopInstance" data-id="${esc(i.id)}" title="Stop">$(debug-stop)</button>`
                    : ""
                }
                <button class="icon-btn danger" data-action="destroyInstance" data-id="${esc(i.id)}" title="Destroy">$(trash)</button>
              </div>
            </div>`;
          })
          .join("")
      : `<div class="state subtle">No active resources — provision one to get started.</div>`;

    const privateRows = d.privateModels.length
      ? d.privateModels
          .map(
            (m) =>
              `<div class="res-row"><div class="res-main"><span class="res-name">${esc(m.tier)}</span><span class="res-badge badge-${esc(m.status)}">${esc(m.status)}</span></div><span class="res-rate">${esc(microToDisplay(dollarsToMicro(m.costUsdPerHour), 2))}/hr</span></div>`,
          )
          .join("")
      : `<div class="state subtle">No private models deployed.</div>`;

    const recentRows = d.recent.length
      ? d.recent
          .map(
            (r) =>
              `<div class="res-row"><span class="res-name">${esc(r.kind)}</span><span class="recent-amt">${esc(r.amount)} ${esc(r.asset)}</span></div>`,
          )
          .join("")
      : `<div class="state subtle">No ledger activity yet.</div>`;

    return `
      <section class="card stat-row">
        <div class="stat">
          <div class="stat-value">${esc(microToDisplay(d.hourlySpendMicro, 2))}/hr</div>
          <div class="stat-label">Hourly spend</div>
        </div>
        <div class="stat">
          <div class="stat-value">${esc(String(d.activeCount))}</div>
          <div class="stat-label">Active</div>
        </div>
        <div class="stat">
          <div class="stat-value">${esc(String(d.provisioningCount))}</div>
          <div class="stat-label">Provisioning</div>
        </div>
        <div class="stat">
          <div class="stat-value">$${esc(d.totalSpent)}</div>
          <div class="stat-label">Total spent</div>
        </div>
      </section>

      <section class="card">
        <div class="section-head">
          <h2>Active Resources</h2>
          <button class="btn btn-mini" data-action="refresh">$(refresh)</button>
        </div>
        ${instancesRows}
      </section>

      <section class="card">
        <div class="section-head"><h2>Private Models</h2></div>
        ${privateRows}
      </section>

      <section class="card">
        <div class="section-head"><h2>Recent Usage</h2><span class="updated">updated ${esc(updated)}</span></div>
        ${recentRows}
        <button class="btn btn-secondary btn-block" data-action="openBilling">Detailed billing →</button>
      </section>`;
  }
}

// ── Inline styles + script ──────────────────────────────────────────────────
// @capix/ui-tokens: dark foundation, cyan accents, green primary.
const DASHBOARD_STYLES = `
  :root {
    --capix-bg: var(--vscode-sideBar-background, #14161a);
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
    margin: 0; padding: 10px;
    font-size: 12px;
  }
  .dash-header {
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px; margin-bottom: 10px;
  }
  .balance-chip {
    display: flex; align-items: baseline; gap: 6px;
    background: var(--capix-surface);
    border: 1px solid var(--capix-border);
    border-radius: 999px;
    padding: 4px 12px;
  }
  .chip-label { font-size: 9px; text-transform: uppercase; letter-spacing: .1em; color: var(--capix-muted); }
  .chip-value { font-weight: 700; color: var(--capix-cyan); font-size: 14px; }
  .chip-sub { font-size: 9px; color: var(--capix-muted); font-family: var(--vscode-editor-font-family, monospace); }
  .btn {
    border: none; border-radius: 6px; cursor: pointer;
    font-weight: 600; font-size: 11px; padding: 7px 14px;
    font-family: inherit;
  }
  .btn-new { background: var(--capix-green); color: #000; }
  .btn-primary { background: var(--capix-green); color: #000; }
  .btn-secondary { background: rgba(255,255,255,0.08); color: var(--capix-fg); }
  .btn-mini { background: transparent; color: var(--capix-muted); padding: 4px 8px; font-size: 11px; }
  .btn-block { width: 100%; margin-top: 10px; text-align: center; }
  .btn:hover { opacity: .88; }
  .nav-bar {
    display: flex; flex-wrap: wrap; gap: 2px;
    border-bottom: 1px solid var(--capix-border);
    margin-bottom: 12px; padding-bottom: 6px;
  }
  .nav-tab {
    background: transparent; border: none; cursor: pointer;
    color: var(--capix-muted); font-family: inherit; font-size: 10px;
    padding: 4px 8px; border-radius: 5px; text-transform: uppercase;
    letter-spacing: .06em;
  }
  .nav-tab:hover { background: rgba(61,206,214,0.1); color: var(--capix-cyan); }
  .card {
    background: var(--capix-surface);
    border: 1px solid var(--capix-border);
    border-radius: 8px; padding: 12px; margin-bottom: 10px;
  }
  .stat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .stat { text-align: center; }
  .stat-value { font-size: 15px; font-weight: 700; color: var(--capix-cyan); font-family: var(--vscode-editor-font-family, monospace); }
  .stat-label { font-size: 9px; text-transform: uppercase; letter-spacing: .1em; color: var(--capix-muted); margin-top: 2px; }
  .section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .section-head h2 { font-size: 10px; text-transform: uppercase; letter-spacing: .12em; color: var(--capix-muted); margin: 0; font-weight: 600; }
  .updated { font-size: 9px; color: var(--capix-muted); }
  .res-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 7px 0; border-bottom: 1px solid rgba(255,255,255,0.045);
  }
  .res-row:last-child { border-bottom: none; }
  .res-main { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .res-name { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .res-id { font-size: 9px; color: var(--capix-muted); font-family: var(--vscode-editor-font-family, monospace); }
  .res-badge { font-size: 8px; text-transform: uppercase; padding: 1px 6px; border-radius: 999px; letter-spacing: .04em; }
  .badge-running, .badge-active, .badge-ready, .badge-healthy { background: rgba(20,241,149,0.12); color: var(--capix-green); }
  .badge-provisioning, .badge-pending, .badge-loading, .badge-starting, .badge-creating, .badge-queued { background: rgba(61,206,214,0.12); color: var(--capix-cyan); }
  .badge-stopped { background: rgba(255,174,0,0.12); color: var(--capix-amber); }
  .res-rate { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; color: var(--capix-green); }
  .recent-amt { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; color: var(--capix-muted); }
  .res-actions { display: flex; align-items: center; gap: 4px; }
  .icon-btn {
    background: transparent; border: none; cursor: pointer; color: var(--capix-muted);
    font-family: inherit; font-size: 12px; padding: 2px 4px; border-radius: 4px;
  }
  .icon-btn:hover { background: rgba(255,255,255,0.08); color: var(--capix-fg); }
  .icon-btn.danger:hover { color: var(--capix-red); }
  .state { padding: 20px 8px; text-align: center; color: var(--capix-muted); }
  .state.connect p, .state.error p { margin-bottom: 12px; }
  .state.subtle { padding: 14px; text-align: center; opacity: .5; }
`;

const DASHBOARD_SCRIPT = `
  const vscode = acquireVsCodeApi();
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  // Event delegation — keeps CSP happy (no inline handlers).
  document.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target.closest('[data-action],[data-nav]') : null;
    if (!target) return;
    if (target.dataset.action) {
      vscode.postMessage({ type: target.dataset.action, id: target.dataset.id || undefined });
    } else if (target.dataset.nav) {
      vscode.postMessage({ type: 'nav', tab: target.dataset.nav });
    }
  });
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'loading') document.body.classList.toggle('loading', msg.value);
  });
`;

// Minimal HTML escaper used while building the server-rendered snapshot.
function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
