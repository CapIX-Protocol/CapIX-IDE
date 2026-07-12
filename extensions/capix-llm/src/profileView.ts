/**
 * Profile webview — shows wallet balance, active deploy billing, top-up,
 * and usage history in the Capix IDE sidebar.
 *
 * Uses a webview (not a tree) because we need rich formatting: balance
 * cards, billing rate table, and interactive top-up buttons.
 */

import * as vscode from "vscode";
import { CapixApiError, CapixClient } from "./apiClient";
import { logger } from "./logger";

interface BillingData {
  balance: { usd: number; sol: number; usdc: number };
  activeInstances: number;
  totalSpent: number;
  updatedAt?: string;
  transactions?: Array<Record<string, unknown>>;
  instances: Array<{
    id: string;
    tier: string;
    status: string;
    startedAt: string;
    costUsdPerHour: number;
    paymentAsset: string;
  }>;
}

interface BaseTreasury {
  treasury: string;
  chain: string;
  contract: string;
  explorer: string;
}

export class ProfileViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private billing: BillingData | null = null;
  private baseTreasury: BaseTreasury | null = null;
  private loading = false;
  private billingError: string | null = null;

  constructor(
    private client: CapixClient,
    private extensionUri: vscode.Uri,
  ) {}

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    view.webview.html = this.getHtml();
    view.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    this.refresh();
  }

  async refresh() {
    if (!this.view) return;
    this.loading = true;
    this.billingError = null;
    this.view.webview.postMessage({ type: "loading", value: true });
    this.view.webview.postMessage({ type: "billingError", value: null });

    try {
      const configured = await this.client.checkConfigured();
      this.view.webview.postMessage({ type: "auth", configured });
      if (!configured) {
        this.billing = null;
        return;
      }
      const [billingRes, treasuryRes] = await Promise.all([
        this.client.getBalance(),
        this.client.getBaseTreasury().catch(() => ({ ok: false }) as { ok: boolean }),
      ]);

      if (billingRes.ok) {
        const br = billingRes as { ok?: boolean; balance?: { usd: number; sol: number; usdc: number }; activeInstances?: number; totalSpent?: number; updatedAt?: string; transactions?: Array<Record<string, unknown>>; instances?: unknown[] };
        this.billing = {
          balance: br.balance!,
          activeInstances: br.activeInstances || 0,
          totalSpent: br.totalSpent || 0,
          updatedAt: br.updatedAt,
          transactions: br.transactions || [],
          instances: (br.instances || []) as BillingData["instances"],
        };
      }

      if (treasuryRes.ok) {
        this.baseTreasury = treasuryRes as unknown as BaseTreasury;
      }
    } catch (err) {
      logger.error("ProfileViewProvider.refresh failed", { error: String(err) });
      this.billingError = err instanceof CapixApiError && err.status === 401
        ? "Your Capix session expired. Select Connect Wallet to sign in again."
        : err instanceof CapixApiError && err.status === 503
          ? "Billing is temporarily unavailable. Your balance is safe; retry shortly."
          : "Billing could not be loaded. Check your connection and retry.";
    } finally {
      this.loading = false;
      this.view.webview.postMessage({ type: "loading", value: false });
      this.view.webview.postMessage({ type: "billing", value: this.billing });
      this.view.webview.postMessage({ type: "treasury", value: this.baseTreasury });
      this.view.webview.postMessage({ type: "billingError", value: this.billingError });
    }
  }

  private handleMessage(msg: { type: string; value?: unknown }) {
    switch (msg.type) {
      case "refresh":
        this.refresh();
        break;
      case "topUp":
        vscode.commands.executeCommand("capix.topUp");
        break;
      case "openBilling":
        vscode.commands.executeCommand("capix.openBilling");
        break;
      case "resetSession":
        vscode.commands.executeCommand("capix.resetSessionAndSignIn");
        break;
      case "copyTreasury":
        if (this.baseTreasury) {
          vscode.env.clipboard.writeText(this.baseTreasury.treasury);
          vscode.window.showInformationMessage("Treasury address copied.");
        }
        break;
    }
  }

  private getHtml(): string {
    // M2 fix: generate a CSP nonce per render to prevent script injection.
    const crypto = require("crypto");
    const nonce = crypto.randomBytes(16).toString("base64");
    const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">`;
    return `<!DOCTYPE html>
<html>
<head>
${cspMeta}
<style>
  body {
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    color: var(--vscode-foreground, #d4d4d4);
    background: var(--vscode-sideBar-background, #1e1e1e);
    padding: 12px;
    margin: 0;
  }
  .loading { opacity: 0.5; pointer-events: none; }
  .card {
    border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.08));
    border-radius: 8px;
    padding: 12px;
    margin-bottom: 12px;
    background: var(--vscode-sideBarSectionHeader-background, rgba(255,255,255,0.02));
  }
  .balance-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 8px;
  }
  .balance-main {
    font-size: 28px;
    font-weight: 700;
    color: var(--vscode-textLink-foreground, #3DCED6);
  }
  .balance-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    opacity: 0.6;
  }
  .stats {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-top: 8px;
  }
  .stat-box {
    border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.06));
    border-radius: 6px;
    padding: 8px;
    text-align: center;
  }
  .stat-value {
    font-size: 16px;
    font-weight: 600;
    color: var(--vscode-charts-blue, #3DCED6);
  }
  .stat-label {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    opacity: 0.5;
    margin-top: 2px;
  }
  .btn {
    display: inline-block;
    padding: 8px 16px;
    border: none;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    cursor: pointer;
    margin-right: 8px;
    margin-top: 4px;
  }
  .btn-primary {
    background: #14F195;
    color: #000;
  }
  .btn-secondary {
    background: rgba(255,255,255,0.08);
    color: var(--vscode-foreground, #d4d4d4);
  }
  .btn:hover { opacity: 0.9; }
  .section-title {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.15em;
    opacity: 0.5;
    margin-bottom: 8px;
    margin-top: 16px;
  }
  .deploy-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 0;
    border-bottom: 1px solid rgba(255,255,255,0.04);
    font-size: 12px;
  }
  .deploy-row:last-child { border-bottom: none; }
  .deploy-name { font-weight: 500; }
  .deploy-rate {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    color: #14F195;
  }
  .deploy-status {
    font-size: 9px;
    text-transform: uppercase;
    padding: 1px 6px;
    border-radius: 4px;
    margin-left: 6px;
  }
  .status-running { background: rgba(20,241,149,0.12); color: #14F195; }
  .status-stopped { background: rgba(255,174,0,0.12); color: #FFAE00; }
  .status-destroyed { background: rgba(255,100,100,0.12); color: #FF6464; }
  .empty {
    text-align: center;
    padding: 16px;
    font-size: 12px;
    opacity: 0.4;
  }
  .treasury-box {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10px;
    word-break: break-all;
    background: rgba(0,0,0,0.3);
    padding: 8px;
    border-radius: 4px;
    margin-top: 4px;
    cursor: pointer;
  }
  .treasury-box:hover { background: rgba(0,0,0,0.4); }
  .connect-prompt {
    text-align: center;
    padding: 24px 12px;
  }
  .connect-prompt p {
    font-size: 12px;
    opacity: 0.6;
    margin-bottom: 12px;
  }
  .billing-rate {
    font-size: 10px;
    opacity: 0.5;
    margin-top: 2px;
  }
</style>
</head>
<body>
  <div id="content">
    <div class="loading-msg empty">Loading your profile…</div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let isConfigured = false;

    // M3 fix: escape all user-controlled values before rendering into innerHTML.
    function esc(s) {
      if (s === null || s === undefined) return '';
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    function render(data) {
      const content = document.getElementById('content');
      if (!data && !isConfigured) {
        content.innerHTML = \`
          <div class="connect-prompt">
            <p>Connect your Capix wallet to view balance, top up, and manage billing.</p>
            <button class="btn btn-primary" onclick="vscode.postMessage({ type: 'resetSession' })">Reset Session and Sign In</button>
          </div>
        \`;
        return;
      }
      if (!data) {
        content.innerHTML = '<div class="empty">Unable to load billing data. Check your connection.</div>';
        return;
      }

      const b = data.balance || {};
      const instances = data.instances || [];
      const activeCount = instances.filter(i => i.status === 'running').length;
      const hourlyTotal = instances.filter(i => i.status === 'running').reduce((s, i) => s + (i.costUsdPerHour || 0), 0);
      const minuteRate = (hourlyTotal / 60).toFixed(4);
      const updated = data.updatedAt ? new Date(data.updatedAt).toLocaleTimeString() : 'just now';
      const recentRows = (data.transactions || []).slice(0, 5).map(tx => {
        const kind = esc(tx.type || tx.kind || tx.description || 'Ledger entry');
        const amount = esc(tx.amount || tx.amountMinor || tx.amount_minor || '');
        const asset = esc(tx.asset || tx.currency || '');
        return '<div class="deploy-row"><span class="deploy-name">' + kind + '</span><span>' + amount + ' ' + asset + '</span></div>';
      }).join('') || '<div class="empty">No ledger activity yet</div>';

      let deployRows = '';
      if (instances.length === 0) {
        deployRows = '<div class="empty">No active deploys</div>';
      } else {
        deployRows = instances.map(inst => {
          const statusClass = inst.status === 'running' ? 'status-running' : inst.status === 'stopped' ? 'status-stopped' : 'status-destroyed';
          return \`
            <div class="deploy-row">
              <div>
                <span class="deploy-name">\${esc(inst.tier)}</span>
                <span class="deploy-status \${esc(statusClass)}">\${esc(inst.status)}</span>
              </div>
              <div style="text-align: right">
                <div class="deploy-rate">$\${(inst.costUsdPerHour || 0).toFixed(2)}/hr</div>
                <div class="billing-rate">$\\\{(inst.costUsdPerHour / 60).toFixed(4)}/min</div>
              </div>
            </div>
          \`;
        }).join('');
      }

      content.innerHTML = \`
        <div class="card">
          <div class="balance-row">
            <div>
              <div class="balance-label">Wallet Balance</div>
              <div class="balance-main">$\${(b.usd || 0).toFixed(2)}</div>
            </div>
          </div>
          <div class="stats">
            <div class="stat-box">
              <div class="stat-value">$\${(b.sol || 0).toFixed(4)}</div>
              <div class="stat-label">≈ SOL</div>
            </div>
            <div class="stat-box">
              <div class="stat-value">$\${(b.usdc || 0).toFixed(2)}</div>
              <div class="stat-label">≈ USDC</div>
            </div>
          </div>
          <div style="margin-top: 12px;">
            <button class="btn btn-primary" onclick="vscode.postMessage({ type: 'topUp' })">+ Top Up</button>
            <button class="btn btn-secondary" onclick="vscode.postMessage({ type: 'openBilling' })">Billing Page →</button>
          </div>
          <div class="section-title">Recent activity · updated \${esc(updated)}</div>
          \${recentRows}
        </div>

        <div class="card">
          <div class="balance-row">
            <div>
              <div class="balance-label">Active Billing</div>
              <div style="font-size: 20px; font-weight: 600; color: #14F195;">$\${hourlyTotal.toFixed(2)}/hr</div>
              <div class="billing-rate">$\${minuteRate}/min · \${activeCount} active deploys</div>
            </div>
            <div>
              <div class="stat-label">Total Spent</div>
              <div class="stat-value" style="font-size: 14px;">$\${(data.totalSpent || 0).toFixed(2)}</div>
            </div>
          </div>
          <div class="section-title">Active Deploy Costs</div>
          \${deployRows}
        </div>

        <div class="card" id="treasury-card" style="display: none;">
          <div class="section-title">USDC on Base (SuperGemma chain)</div>
          <div class="billing-rate">Send USDC to this address from any EVM wallet:</div>
          <div class="treasury-box" id="treasury-addr" onclick="copyTreasury()"></div>
          <div class="billing-rate" style="margin-top: 4px;">Then submit the tx hash via Top Up → verify on the billing page.</div>
        </div>
      \`;
    }

    function renderTreasury(data) {
      const card = document.getElementById('treasury-card');
      const addr = document.getElementById('treasury-addr');
      if (!card || !addr) return;
      if (data && data.treasury) {
        card.style.display = 'block';
        addr.textContent = data.treasury;
      }
    }

    function copyTreasury() {
      vscode.postMessage({ type: 'copyTreasury' });
    }

    // Listen for messages from the extension.
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'loading') {
        document.body.classList.toggle('loading', msg.value);
      } else if (msg.type === 'billing') {
        render(msg.value);
      } else if (msg.type === 'billingError' && msg.value) {
        document.getElementById('content').innerHTML = '<div class="connect-prompt"><p>' + esc(msg.value) + '</p><button class="btn btn-primary" onclick="vscode.postMessage({ type: \'resetSession\' })">Reset Session and Sign In</button></div>';
      } else if (msg.type === 'auth') {
        isConfigured = Boolean(msg.configured);
      } else if (msg.type === 'treasury') {
        renderTreasury(msg.value);
      }
    });

    // Initial load message.
    vscode.postMessage({ type: 'refresh' });
  </script>
</body>
</html>`;
  }
}
