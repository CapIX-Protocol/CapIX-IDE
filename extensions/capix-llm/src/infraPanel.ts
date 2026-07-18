/**
 * capix-llm/infraPanel — the infra management webview.
 *
 * One editor-area panel (command `capix.infra.openPanel`) that gives the
 * customer — and the assistant — a live cockpit over the whole Capix infra
 * stack:
 *
 *     Dashboard | Logs | Costs | Marketplace
 *
 *   - Dashboard: every deployment with live status/health, plus one-click
 *     actions (start, stop, destroy, scale, SSH, logs). Status changes from
 *     the {@link InfraStackService} watcher are pushed in real time.
 *   - Logs: streaming log viewer with client-side filtering; lines are
 *     appended as they arrive from the service's incremental log stream.
 *   - Costs: wallet balance, total spend, hourly burn and per-deployment
 *     cost entries (integer minor units, formatted at render time).
 *   - Marketplace: live GPU offers, cheapest first.
 *
 * Auth and data flow through the broker-backed {@link CapixClient} via the
 * service; the webview itself never touches credentials. Strict CSP:
 * `default-src 'none'`, inline styles only, scripts behind a per-render
 * nonce. Visual foundation matches the other Capix panels (@capix/ui-tokens
 * dark: canvas #0a0e14, brand cyan #3DCED6, green #14F195, amber #FFAE00,
 * error #ff5252).
 */

import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import type { InfraStackService, InfraDeployment, CostOverview, MarketplaceListing } from "./infraStack";
import { microToDisplay } from "./moneyUtils";
import { logger } from "./logger";

export type InfraTab = "dashboard" | "logs" | "costs" | "marketplace";

interface PanelState {
  configured: boolean;
  deployments: InfraDeployment[];
  costs: CostOverview | null;
  marketplace: MarketplaceListing[];
  error: string | null;
  updatedAt: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** JSON for safe embedding inside an inline <script> block. */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

const PANEL_SCRIPT = `
const vscode = acquireVsCodeApi();
const state = { tab: 'dashboard', logsDeployment: null, logLines: [], filter: '' };

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.type === 'log:append' && state.logsDeployment === msg.deploymentId) {
    state.logLines.push(...msg.lines);
    renderLogs();
  } else if (msg.type === 'log:error') {
    state.logLines.push('[stream error] ' + msg.message);
    renderLogs();
  } else if (msg.type === 'log:end') {
    state.logLines.push('[stream ended]');
    renderLogs();
  }
});

function activate(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('active', el.dataset.tab === tab));
  document.querySelectorAll('.page').forEach((el) => el.classList.toggle('active', el.id === 'page-' + tab));
  vscode.postMessage({ type: 'activate-tab', tab });
}

function viewLogs(id) {
  state.logsDeployment = id;
  state.logLines = [];
  activate('logs');
  vscode.postMessage({ type: 'logs', id });
}

function setFilter(value) {
  state.filter = value.toLowerCase();
  renderLogs();
}

function renderLogs() {
  const el = document.getElementById('log-view');
  if (!el) return;
  const lines = state.filter ? state.logLines.filter((l) => l.toLowerCase().includes(state.filter)) : state.logLines;
  el.textContent = lines.join('\\n') || '(no log lines yet)';
  el.scrollTop = el.scrollHeight;
}

function act(action, id) {
  vscode.postMessage({ type: 'action', action, id });
}

function scale(id) {
  const input = document.getElementById('scale-' + id);
  const replicas = Number(input && input.value);
  if (Number.isInteger(replicas) && replicas >= 1) vscode.postMessage({ type: 'scale', id, replicas });
}

function openSsh(id) {
  vscode.postMessage({ type: 'ssh', id });
}

document.querySelectorAll('.tab').forEach((el) => el.addEventListener('click', () => activate(el.dataset.tab)));
`;

const PANEL_STYLE = `
  body { margin: 0; padding: 0; background: #0a0e14; color: #d5dbe5; font-family: var(--vscode-font-family, system-ui); font-size: 13px; }
  header { padding: 12px 16px 0; }
  h1 { font-size: 15px; margin: 0 0 4px; color: #3DCED6; }
  .sub { color: #7d8698; font-size: 12px; margin-bottom: 8px; }
  nav { display: flex; gap: 4px; border-bottom: 1px solid #1c2431; padding: 0 16px; }
  .tab { padding: 6px 12px; cursor: pointer; color: #7d8698; border-bottom: 2px solid transparent; }
  .tab.active { color: #3DCED6; border-bottom-color: #3DCED6; }
  .page { display: none; padding: 16px; }
  .page.active { display: block; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #1c2431; }
  th { color: #7d8698; font-weight: 600; font-size: 11px; text-transform: uppercase; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; }
  .pill.healthy { background: rgba(20,241,149,.15); color: #14F195; }
  .pill.degraded { background: rgba(255,174,0,.15); color: #FFAE00; }
  .pill.unhealthy { background: rgba(255,82,82,.15); color: #ff5252; }
  .pill.unknown { background: rgba(125,134,152,.15); color: #7d8698; }
  button { background: #141b26; color: #d5dbe5; border: 1px solid #26303f; border-radius: 4px; padding: 3px 10px; cursor: pointer; font-size: 12px; margin-right: 4px; }
  button:hover { border-color: #3DCED6; color: #3DCED6; }
  button.danger:hover { border-color: #ff5252; color: #ff5252; }
  input[type=number] { width: 56px; background: #141b26; border: 1px solid #26303f; color: #d5dbe5; border-radius: 4px; padding: 2px 6px; }
  input[type=text] { width: 260px; background: #141b26; border: 1px solid #26303f; color: #d5dbe5; border-radius: 4px; padding: 4px 8px; }
  #log-view { background: #070a10; border: 1px solid #1c2431; border-radius: 6px; padding: 10px; height: 420px; overflow: auto; white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; margin-top: 10px; }
  .cards { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
  .card { background: #10151d; border: 1px solid #1c2431; border-radius: 8px; padding: 12px 16px; min-width: 150px; }
  .card .value { font-size: 18px; color: #3DCED6; }
  .card .label { color: #7d8698; font-size: 11px; text-transform: uppercase; }
  .error { color: #ff5252; padding: 16px; }
  .empty { color: #7d8698; padding: 24px; text-align: center; }
  .toolbar { display: flex; align-items: center; gap: 10px; }
`;

export class InfraPanel {
  private static current: InfraPanel | null = null;

  private readonly panel: vscode.WebviewPanel;
  private readonly service: InfraStackService;
  private activeTab: InfraTab = "dashboard";
  private state: PanelState = {
    configured: false,
    deployments: [],
    costs: null,
    marketplace: [],
    error: null,
    updatedAt: "",
  };
  private logAbort: AbortController | null = null;
  private logsDeployment: string | null = null;
  private readonly unsubscribeStatus: () => void;

  /** Open (or focus) the singleton infra panel. */
  static createOrShow(extensionUri: vscode.Uri, service: InfraStackService): InfraPanel {
    if (InfraPanel.current) {
      InfraPanel.current.panel.reveal();
      void InfraPanel.current.refresh();
      return InfraPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      "capix.infra.panel",
      "Capix Infrastructure",
      vscode.ViewColumn.One,
      { enableScripts: true, localResourceRoots: [extensionUri], retainContextWhenHidden: true },
    );
    InfraPanel.current = new InfraPanel(panel, service);
    return InfraPanel.current;
  }

  /** Test-only handle: current instance, if any. */
  static get currentInstance(): InfraPanel | null {
    return InfraPanel.current;
  }

  private constructor(panel: vscode.WebviewPanel, service: InfraStackService) {
    this.panel = panel;
    this.service = service;
    this.panel.webview.html = this.render();
    this.panel.webview.onDidReceiveMessage((msg) => void this.handleMessage(msg));
    this.panel.onDidDispose(() => {
      InfraPanel.current = null;
      this.stopLogStream();
      this.unsubscribeStatus();
    });
    this.unsubscribeStatus = this.service.onDidChangeStatus(() => void this.refresh());
    void this.refresh();
  }

  // ── data ────────────────────────────────────────────────────────────────

  async refresh(): Promise<void> {
    try {
      const [deployments, costs, marketplace] = await Promise.all([
        this.service.listDeployments(),
        this.service.getCostOverview().catch(() => null),
        this.service.browseMarketplace().catch(() => []),
      ]);
      this.state = {
        configured: true,
        deployments,
        costs,
        marketplace,
        error: null,
        updatedAt: new Date().toISOString(),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.state.error = message;
      if (/^(401|not authenticated)/i.test(message)) this.state.configured = false;
    }
    this.panel.webview.html = this.render();
  }

  // ── messages ────────────────────────────────────────────────────────────

  private async handleMessage(msg: unknown): Promise<void> {
    const m = msg as { type?: string; tab?: string; id?: string; action?: string; replicas?: number };
    if (!m?.type) return;
    try {
      switch (m.type) {
        case "refresh":
          await this.refresh();
          break;
        case "activate-tab":
          if (m.tab) this.activeTab = m.tab as InfraTab;
          break;
        case "action":
          if (m.id && (m.action === "start" || m.action === "stop" || m.action === "destroy")) {
            if (m.action === "destroy") {
              const confirm = await vscode.window.showWarningMessage(
                `Destroy deployment ${m.id}? This cannot be undone.`,
                { modal: true },
                "Destroy",
              );
              if (confirm !== "Destroy") return;
            }
            await this.service.controlDeployment(m.id, m.action);
            await this.refresh();
          }
          break;
        case "scale":
          if (m.id && typeof m.replicas === "number") {
            await this.service.scaleDeployment(m.id, m.replicas);
            await this.refresh();
          }
          break;
        case "ssh":
          if (m.id) await this.service.openSshTerminal(m.id);
          break;
        case "logs":
          if (m.id) this.startLogStream(m.id);
          break;
        case "stopLogs":
          this.stopLogStream();
          break;
      }
    } catch (err) {
      logger.error("infra panel action failed", { error: String(err) });
    }
  }

  // ── log streaming ─────────────────────────────────────────────────────────

  private startLogStream(deploymentId: string): void {
    this.stopLogStream();
    this.logsDeployment = deploymentId;
    this.logAbort = new AbortController();
    void this.service.streamLogs(
      deploymentId,
      (event) => {
        if (event.type === "append") {
          void this.panel.webview.postMessage({ type: "log:append", deploymentId, lines: event.lines });
        } else if (event.type === "error") {
          void this.panel.webview.postMessage({ type: "log:error", deploymentId, message: event.message });
        } else {
          void this.panel.webview.postMessage({ type: "log:end", deploymentId });
        }
      },
      this.logAbort.signal,
    );
  }

  private stopLogStream(): void {
    this.logAbort?.abort();
    this.logAbort = null;
    this.logsDeployment = null;
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  private render(): string {
    const nonce = randomBytes(16).toString("base64");
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
${csp}
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Capix Infrastructure</title>
<style>${PANEL_STYLE}</style>
</head>
<body data-state="${escapeHtml(embedJson({ logsDeployment: this.logsDeployment }))}">
<header>
  <h1>Capix Infrastructure</h1>
  <div class="sub">${this.state.updatedAt ? `Updated ${escapeHtml(this.state.updatedAt)}` : "Loading…"}</div>
</header>
<nav>
  ${(["dashboard", "logs", "costs", "marketplace"] as InfraTab[])
    .map((tab) => `<div class="tab${tab === this.activeTab ? " active" : ""}" data-tab="${tab}">${tab[0].toUpperCase()}${tab.slice(1)}</div>`)
    .join("")}
</nav>
${this.renderBody()}
<script nonce="${nonce}">${PANEL_SCRIPT}</script>
</body>
</html>`;
  }

  private renderBody(): string {
    if (!this.state.configured) {
      return `<div class="empty">Sign in to Capix to manage your infrastructure.</div>`;
    }
    if (this.state.error) {
      return `<div class="error">${escapeHtml(this.state.error)}</div>`;
    }
    return `
<div class="page${this.activeTab === "dashboard" ? " active" : ""}" id="page-dashboard">${this.renderDashboard()}</div>
<div class="page${this.activeTab === "logs" ? " active" : ""}" id="page-logs">${this.renderLogsPage()}</div>
<div class="page${this.activeTab === "costs" ? " active" : ""}" id="page-costs">${this.renderCosts()}</div>
<div class="page${this.activeTab === "marketplace" ? " active" : ""}" id="page-marketplace">${this.renderMarketplace()}</div>`;
  }

  private renderDashboard(): string {
    if (this.state.deployments.length === 0) {
      return `<div class="empty">No deployments yet. Ask the assistant to deploy a model, or use Capix: New Cloud Resource…</div>`;
    }
    const rows = this.state.deployments
      .map((d) => {
        const id = escapeHtml(d.id);
        return `<tr>
  <td>${escapeHtml(d.name)}<br><span class="sub">${id}</span></td>
  <td>${escapeHtml(d.status)} <span class="pill ${d.health}">${d.health}</span></td>
  <td>${d.nodes.length}</td>
  <td>$${d.costUsdPerHour.toFixed(4)}/hr</td>
  <td>
    <button onclick="act('start','${id}')">Start</button>
    <button onclick="act('stop','${id}')">Stop</button>
    <button class="danger" onclick="act('destroy','${id}')">Destroy</button>
    <input type="number" id="scale-${id}" min="1" max="16" value="1">
    <button onclick="scale('${id}')">Scale</button>
    <button onclick="openSsh('${id}')">SSH</button>
    <button onclick="viewLogs('${id}')">Logs</button>
  </td>
</tr>`;
      })
      .join("");
    return `<table>
<thead><tr><th>Deployment</th><th>Status</th><th>Nodes</th><th>Cost</th><th>Actions</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
  }

  private renderLogsPage(): string {
    return `<div class="toolbar">
  <span>Deployment: <strong>${this.logsDeployment ? escapeHtml(this.logsDeployment) : "(pick Logs on the dashboard)"}</strong></span>
  <input type="text" placeholder="Filter logs…" oninput="setFilter(this.value)">
  <button onclick="vscode.postMessage({type:'stopLogs'})">Stop stream</button>
</div>
<div id="log-view"></div>`;
  }

  private renderCosts(): string {
    const costs = this.state.costs;
    if (!costs) return `<div class="empty">Cost data unavailable.</div>`;
    const rows = costs.entries
      .map(
        (entry) => `<tr>
  <td>${escapeHtml(entry.name)}<br><span class="sub">${escapeHtml(entry.id)}</span></td>
  <td>${escapeHtml(entry.status)}</td>
  <td>$${entry.costUsdPerHour.toFixed(4)}/hr</td>
  <td>${escapeHtml(entry.startedAt)}</td>
</tr>`,
      )
      .join("");
    return `<div class="cards">
  <div class="card"><div class="value">$${escapeHtml(costs.balanceUsd)}</div><div class="label">Balance</div></div>
  <div class="card"><div class="value">$${escapeHtml(costs.totalSpentUsd)}</div><div class="label">Total spent</div></div>
  <div class="card"><div class="value">$${microToDisplay(costs.hourlyBurnMicro, 4)}/hr</div><div class="label">Hourly burn</div></div>
</div>
${costs.entries.length ? `<table>
<thead><tr><th>Deployment</th><th>Status</th><th>Rate</th><th>Since</th></tr></thead>
<tbody>${rows}</tbody>
</table>` : `<div class="empty">No billable deployments.</div>`}`;
  }

  private renderMarketplace(): string {
    if (this.state.marketplace.length === 0) {
      return `<div class="empty">No marketplace offers available right now.</div>`;
    }
    const rows = this.state.marketplace
      .map(
        (l) => `<tr>
  <td>${l.numGpus}× ${escapeHtml(l.gpu)}</td>
  <td>${l.vramGb} GB</td>
  <td>$${l.pricePerHr.toFixed(4)}/hr</td>
  <td>${escapeHtml(l.location)}</td>
  <td>${(l.reliability * 100).toFixed(1)}%</td>
  <td>ask ${l.askId}</td>
</tr>`,
      )
      .join("");
    return `<table>
<thead><tr><th>GPU</th><th>VRAM</th><th>Price</th><th>Location</th><th>Reliability</th><th>Offer</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
  }
}
