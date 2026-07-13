/**
 * Settlement webview — shows settlement layer status, proof verification,
 * settlement epochs, and CPX billing in a static (enableScripts: false) HTML
 * webview. All interactivity goes through command URIs (enableCommandUris).
 *
 * Security:
 *  - enableScripts: false — no JS injection surface.
 *  - enableCommandUris: true — buttons use `command:` links.
 *  - CSP nonce per render — defence-in-depth against inline script.
 *  - HTML escaping on all user/API-controlled values.
 *  - No floating point for money — string minor units only.
 *  - Never claims mainnet settlement — shows actual cluster name.
 */

import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import {
  CapixApiError,
  CapixClient,
  type CpxBilling,
  type SettlementEpoch,
  type SettlementStatus,
} from "./apiClient";
import { logger } from "./logger";

export class SettlementViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private status: SettlementStatus | null = null;
  private epochs: SettlementEpoch[] = [];
  private cpx: CpxBilling | null = null;
  private loading = false;
  private error: string | null = null;

  constructor(
    private client: CapixClient,
    private extensionUri: vscode.Uri,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: false,
      enableCommandUris: true,
      localResourceRoots: [],
    };
    view.webview.html = this.getLoadingHtml();
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.view) return;
    this.loading = true;
    this.error = null;
    this.view.webview.html = this.getLoadingHtml();

    try {
      const configured = await this.client.checkConfigured();
      if (!configured) {
        this.error = "Connect your Capix wallet to view settlement status.";
        this.view.webview.html = this.getNotConnectedHtml();
        return;
      }

      const [statusRes, epochsRes, cpxRes] = await Promise.all([
        this.client.getSettlementStatus(),
        this.client.getSettlementEpochs(),
        this.client.getCpxBilling(),
      ]);

      if (statusRes.ok) {
        const { ok, error, ...status } = statusRes;
        void ok; void error;
        this.status = status;
      }
      if (epochsRes.ok) {
        this.epochs = epochsRes.epochs || [];
      }
      if (cpxRes.ok) {
        const { ok, error, ...cpx } = cpxRes;
        void ok; void error;
        this.cpx = cpx;
      }
    } catch (err) {
      logger.error("SettlementViewProvider.refresh failed", { error: String(err) });
      this.error = err instanceof CapixApiError && err.status === 401
        ? "Your Capix session expired. Please sign in again."
        : err instanceof CapixApiError && err.status === 503
          ? "Settlement data is temporarily unavailable. Retry shortly."
          : "Could not load settlement data. Check your connection.";
    } finally {
      this.loading = false;
      if (this.error) {
        this.view.webview.html = this.getErrorHtml();
      } else {
        this.view.webview.html = this.getContentHtml();
      }
    }
  }

  // ── HTML escaping ────────────────────────────────────────────────────────

  private esc(s: unknown): string {
    if (s === null || s === undefined) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ── Command URI helper ──────────────────────────────────────────────────

  private cmd(command: string, ...args: unknown[]): string {
    const json = JSON.stringify(args);
    return `command:${command}?${encodeURIComponent(json)}`;
  }

  // ── Money formatting (string minor units, no float) ──────────────────────

  private formatMinor(minor: string, decimals: number): string {
    if (!minor || minor === "0") return "0." + "0".repeat(Math.max(0, decimals));
    const isNegative = minor.startsWith("-");
    const abs = isNegative ? minor.slice(1) : minor;
    const padded = abs.padStart(decimals + 1, "0");
    const intPart = padded.slice(0, padded.length - decimals);
    const fracPart = padded.slice(padded.length - decimals);
    return (isNegative ? "-" : "") + intPart + "." + fracPart;
  }

  private truncateRoot(root: string, chars = 10): string {
    if (!root) return "—";
    if (root.length <= chars * 2 + 4) return this.esc(root);
    return this.esc(root.slice(0, chars) + "…" + root.slice(-chars));
  }

  // ── Solana explorer URL (never claims mainnet) ───────────────────────────

  private explorerUrl(txSignature: string, cluster: string): string {
    const base = `https://explorer.solana.com/tx/${encodeURIComponent(txSignature)}`;
    const params = new URLSearchParams();
    if (cluster && cluster !== "mainnet-beta" && cluster !== "mainnet") {
      params.set("cluster", cluster);
    }
    const query = params.toString();
    return query ? `${base}?${query}` : base;
  }

  private clusterLabel(cluster: string): string {
    if (!cluster) return "unknown";
    // Never claim mainnet — show the raw cluster name from the API.
    if (cluster === "mainnet-beta") return "Solana mainnet-beta";
    if (cluster === "devnet") return "Solana devnet";
    if (cluster === "testnet") return "Solana testnet";
    return this.esc(cluster);
  }

  // ── HTML renders ──────────────────────────────────────────────────────────

  private getLoadingHtml(): string {
    const nonce = this.nonce();
    return `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${this.styles()}</style>
</head>
<body>
<div class="empty">Loading settlement status…</div>
</body>
</html>`;
  }

  private getNotConnectedHtml(): string {
    const nonce = this.nonce();
    return `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${this.styles()}</style>
</head>
<body>
<div class="connect-prompt">
  <p>${this.esc(this.error)}</p>
  <a class="btn btn-primary" href="command:capix.connectWallet">Sign In</a>
</div>
</body>
</html>`;
  }

  private getErrorHtml(): string {
    const nonce = this.nonce();
    return `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${this.styles()}</style>
</head>
<body>
<div class="connect-prompt">
  <p>${this.esc(this.error)}</p>
  <a class="btn btn-primary" href="command:capix.refreshSettlement">Retry</a>
</div>
</body>
</html>`;
  }

  private getContentHtml(): string {
    const status = this.status;
    const epochs = this.epochs.slice(0, 5);
    const cpx = this.cpx;
    const nonce = this.nonce();
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">`;

    // ── Settlement status card ──
    let statusHtml: string;
    if (status) {
      const pausedBadge = status.paused
        ? `<span class="badge badge-paused">PAUSED</span>`
        : `<span class="badge badge-active">ACTIVE</span>`;
      const ts = status.lastAnchoredTimestamp
        ? new Date(status.lastAnchoredTimestamp).toLocaleString()
        : "not yet anchored";

      statusHtml = `
        <div class="card">
          <div class="section-title">Settlement Status ${pausedBadge}</div>
          <div class="kv"><span class="k">Current Epoch</span><span class="v mono">${this.esc(status.currentEpoch)}</span></div>
          <div class="kv"><span class="k">Last Finalized</span><span class="v mono">${this.esc(status.lastFinalizedEpoch)}</span></div>
          <div class="kv"><span class="k">Settlement Root</span><span class="v mono root">${this.truncateRoot(status.lastSettlementRoot)}</span></div>
          <div class="kv"><span class="k">Cluster</span><span class="v">${this.clusterLabel(status.cluster)}</span></div>
          <div class="kv"><span class="k">Program</span><span class="v mono">${this.esc(status.programId ? status.programId.slice(0, 8) + "…" : "—")}</span></div>
          <div class="kv"><span class="k">Anchored</span><span class="v">${this.esc(ts)}</span></div>
        </div>
      `;

      // ── Anchored on Solana card ──
      if (status.lastFinalizedEpoch !== "0" && status.lastSettlementRoot) {
        const lastEpochTxSig = this.epochs.length > 0 ? (this.epochs[0]?.txSignature || "") : "";
        const explorer = this.explorerUrl(
          lastEpochTxSig,
          status.cluster,
        );
        const verifyUri = this.cmd("capix.verifyLocally", "balance");
        const downloadUri = this.cmd("capix.viewProof", "balance");

        statusHtml += `
          <div class="card anchor-card">
            <div class="section-title">Anchored on Solana</div>
            <p class="muted small">The settlement root for epoch ${this.esc(status.lastFinalizedEpoch)} is anchored on-chain.</p>
            <div class="btn-group">
              <a class="btn btn-primary" href="${this.esc(verifyUri)}">Verify Locally</a>
              <a class="btn btn-secondary" href="${this.esc(downloadUri)}">Proof JSON</a>
              <a class="btn btn-secondary" href="${this.esc(explorer)}" target="_blank">Explorer →</a>
            </div>
          </div>
        `;
      }
    } else {
      statusHtml = `<div class="card"><div class="empty">No settlement data available.</div></div>`;
    }

    // ── Settlement epochs ──
    let epochsHtml: string;
    if (epochs.length > 0) {
      const rows = epochs.map((ep) => {
        const ts = ep.anchoredAt
          ? new Date(ep.anchoredAt).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
          : "—";
        const explorer = ep.txSignature
          ? this.explorerUrl(ep.txSignature, status?.cluster || "")
          : null;
        const explorerLink = explorer
          ? `<a class="link" href="${this.esc(explorer)}" target="_blank">verify</a>`
          : `<span class="muted">—</span>`;
        return `
          <div class="epoch-row">
            <div class="epoch-left">
              <div class="epoch-num mono">#${this.esc(ep.epoch)}</div>
              <div class="epoch-root mono">${this.truncateRoot(ep.root, 8)}</div>
            </div>
            <div class="epoch-right">
              <div class="muted small">${this.esc(ts)}</div>
              <div class="muted small">leaves: ${this.esc(ep.leafCount)}</div>
              ${explorerLink}
            </div>
          </div>
        `;
      }).join("");
      epochsHtml = `
        <div class="card">
          <div class="section-title">Recent Settlement Epochs</div>
          ${rows}
        </div>
      `;
    } else {
      epochsHtml = `<div class="card"><div class="section-title">Recent Settlement Epochs</div><div class="empty">No finalized epochs yet.</div></div>`;
    }

    // ── CPX billing card ──
    let cpxHtml: string;
    if (cpx) {
      const d = cpx.decimals || 6;
      const wallet = this.formatMinor(cpx.walletBalanceMinor, d);
      const deposited = this.formatMinor(cpx.depositedBalanceMinor, d);
      const priceUsd = cpx.priceUsd ? `$${this.esc(cpx.priceUsd)}` : "—";
      const perMin = this.formatMinor(cpx.perMinuteRateMinor, d);
      const burned = this.formatMinor(cpx.burnedThisEpochMinor, d);
      const priceTs = cpx.priceUpdatedAt
        ? new Date(cpx.priceUpdatedAt).toLocaleTimeString()
        : "—";

      cpxHtml = `
        <div class="card">
          <div class="section-title">CPX Billing</div>
          <div class="balance-grid">
            <div class="balance-box">
              <div class="balance-label">Wallet CPX</div>
              <div class="balance-val mono">${wallet}</div>
            </div>
            <div class="balance-box">
              <div class="balance-label">Deposited CPX</div>
              <div class="balance-val mono">${deposited}</div>
            </div>
          </div>
          <div class="kv"><span class="k">CPX/USD</span><span class="v">${priceUsd}</span></div>
          <div class="kv"><span class="k">Price Source</span><span class="v">${this.esc(cpx.priceSource || "—")}</span></div>
          <div class="kv"><span class="k">Price Updated</span><span class="v">${this.esc(priceTs)}</span></div>
          <div class="kv"><span class="k">Per-Minute Rate</span><span class="v mono">${perMin} CPX/min</span></div>
          <div class="kv"><span class="k">Burned This Epoch</span><span class="v mono">${burned} CPX</span></div>
          <div class="disclosure">
            CPX is burned at settlement — providers are never paid in CPX.
          </div>
        </div>
      `;
    } else {
      cpxHtml = `<div class="card"><div class="section-title">CPX Billing</div><div class="empty">CPX billing data unavailable.</div></div>`;
    }

    // ── Full page ──
    return `<!DOCTYPE html>
<html>
<head>
${csp}
<style>${this.styles()}</style>
</head>
<body>
${statusHtml}
${epochsHtml}
${cpxHtml}
<div class="card">
  <div class="btn-group">
    <a class="btn btn-secondary" href="${this.esc(this.cmd("capix.refreshSettlement"))}">Refresh</a>
    <a class="btn btn-secondary" href="${this.esc(this.cmd("capix.cpxBilling"))}">CPX Billing →</a>
  </div>
</div>
</body>
</html>`;
  }

  private nonce(): string {
    return randomBytes(16).toString("base64");
  }

  private styles(): string {
    return `
      body {
        font-family: var(--vscode-font-family, system-ui, sans-serif);
        color: var(--vscode-foreground, #d4d4d4);
        background: var(--vscode-sideBar-background, #1e1e1e);
        padding: 12px;
        margin: 0;
      }
      .card {
        border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.08));
        border-radius: 8px;
        padding: 12px;
        margin-bottom: 12px;
        background: var(--vscode-sideBarSectionHeader-background, rgba(255,255,255,0.02));
      }
      .section-title {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.15em;
        opacity: 0.5;
        margin-bottom: 8px;
      }
      .kv {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        padding: 3px 0;
        font-size: 12px;
      }
      .k { opacity: 0.6; }
      .v { font-weight: 500; word-break: break-all; text-align: right; }
      .mono { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
      .root { color: var(--vscode-textLink-foreground, #3DCED6); }
      .badge {
        font-size: 9px;
        text-transform: uppercase;
        font-weight: 700;
        padding: 1px 6px;
        border-radius: 4px;
        margin-left: 6px;
      }
      .badge-active { background: rgba(20,241,149,0.12); color: #14F195; }
      .badge-paused { background: rgba(255,174,0,0.12); color: #FFAE00; }
      .btn {
        display: inline-block;
        padding: 7px 14px;
        border: none;
        border-radius: 6px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        text-decoration: none;
        cursor: pointer;
        margin-right: 6px;
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
      .btn:hover { opacity: 0.85; }
      .btn-group { margin-top: 8px; }
      .anchor-card { border-color: rgba(20,241,149,0.2); }
      .balance-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        margin-bottom: 8px;
      }
      .balance-box {
        border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.06));
        border-radius: 6px;
        padding: 8px;
        text-align: center;
      }
      .balance-label {
        font-size: 9px;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        opacity: 0.5;
        margin-bottom: 2px;
      }
      .balance-val {
        font-size: 14px;
        font-weight: 600;
        color: var(--vscode-charts-blue, #3DCED6);
      }
      .epoch-row {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        padding: 6px 0;
        border-bottom: 1px solid rgba(255,255,255,0.04);
        font-size: 11px;
      }
      .epoch-row:last-child { border-bottom: none; }
      .epoch-num { font-weight: 600; }
      .epoch-root { color: var(--vscode-textLink-foreground, #3DCED6); font-size: 10px; margin-top: 2px; }
      .epoch-right { text-align: right; }
      .link { color: var(--vscode-textLink-foreground, #3DCED6); text-decoration: none; font-size: 10px; }
      .link:hover { text-decoration: underline; }
      .muted { opacity: 0.5; }
      .small { font-size: 10px; }
      .empty {
        text-align: center;
        padding: 16px;
        font-size: 12px;
        opacity: 0.4;
      }
      .disclosure {
        margin-top: 8px;
        padding: 8px;
        border-radius: 6px;
        background: rgba(255,174,0,0.06);
        border: 1px solid rgba(255,174,0,0.15);
        font-size: 10px;
        line-height: 1.4;
        opacity: 0.8;
      }
      .connect-prompt {
        text-align: center;
        padding: 24px 12px;
      }
      .connect-prompt p {
        font-size: 12px;
        opacity: 0.6;
        margin-bottom: 12px;
      }
    `;
  }
}
