/**
 * Cloud Hub — the single "Capix Cloud" sidebar surface (`capix.cloud.hub`).
 *
 * One tabbed webview that replaces the nine views that used to compete for
 * the capix-cloud activity container (overview, profile, deploys, instances,
 * jobs, api-keys, catalog, hosted, resource). Tabs:
 *
 *     Overview | Deployments | Instances | Jobs | API Keys | Models | Account
 *
 * Every tab fetches through the same {@link CapixClient} paths the retired
 * tree views used. A tab whose backend route is unavailable shows a designed
 * empty/error state with the real reason — never an indefinite spinner and
 * never fabricated counts.
 *
 * Tab selection persists across webview restore via getState/setState and is
 * mirrored host-side in {@link CloudHubState} so full HTML re-renders keep
 * the active tab.
 *
 * Design tokens (@capix/ui-tokens): dark foundation, cyan accents (#3DCED6),
 * green primary (#14F195). Tab bar: horizontal, top, 32px, cyan underline on
 * the active tab, compact mono labels.
 */

import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { CapixApiError, CapixClient } from './apiClient';
import { logger } from './logger';
import { dollarsToMicro, microToDisplay } from './moneyUtils';
import type { CatalogModel, HostedEndpoint, LlmDeploy } from './types';
import { icon } from "./webviewIcons";

// ── Tab state model ─────────────────────────────────────────────────────────

export type CloudHubTab =
  'overview' | 'deployments' | 'instances' | 'jobs' | 'apikeys' | 'models' | 'account';

export const CLOUD_HUB_TABS: Array<{ id: CloudHubTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'deployments', label: 'Deployments' },
  { id: 'instances', label: 'Instances' },
  { id: 'jobs', label: 'Jobs' },
  { id: 'apikeys', label: 'API Keys' },
  { id: 'models', label: 'Models' },
  { id: 'account', label: 'Account' },
];

const DEFAULT_TAB: CloudHubTab = 'overview';

/** Type guard — accepts only canonical hub tab ids. */
export function isCloudHubTab(value: unknown): value is CloudHubTab {
  return typeof value === 'string' && CLOUD_HUB_TABS.some((t) => t.id === value);
}

/** Serializable hub UI state (mirrored into the webview via setState). */
export interface CloudHubState {
  activeTab: CloudHubTab;
}

/** Initial hub state; an unknown/restored tab falls back to Overview. */
export function createCloudHubState(restoredTab?: unknown): CloudHubState {
  return { activeTab: isCloudHubTab(restoredTab) ? restoredTab : DEFAULT_TAB };
}

/** Switch the active tab. Unknown ids are ignored (state is returned unchanged). */
export function setHubTab(state: CloudHubState, tab: unknown): CloudHubState {
  if (!isCloudHubTab(tab)) return state;
  return { activeTab: tab };
}

// ── Per-tab data mapping (pure — unit-tested) ───────────────────────────────

export type HubDeploymentState = 'running' | 'provisioning' | 'stopped' | 'destroyed' | 'unknown';

export interface HubDeployment {
  instanceId: number;
  modelLabel: string;
  state: HubDeploymentState;
  endpoint: string | null;
  ready: boolean;
  gpu: string;
  location: string;
  pricePerHr: number;
  instanceRecordId: string;
}

/** Map the listDeploys response into hub rows (same semantics as the retired deploys tree). */
export function mapDeployments(
  deploys: Array<{ instance: unknown; live: LlmDeploy | null }>
): HubDeployment[] {
  const live = deploys
    .filter((d) => d.live)
    .map((d): HubDeployment => {
      const instance = d.instance as { id?: string };
      const l = d.live!;
      const state: HubDeploymentState = l.ready
        ? 'running'
        : l.state === 'running'
          ? 'provisioning'
          : l.state === 'stopped'
            ? 'stopped'
            : 'unknown';
      return {
        instanceId: l.instanceId,
        modelLabel: l.modelLabel,
        state,
        endpoint: l.endpoint,
        ready: l.ready,
        gpu: l.gpu,
        location: l.location,
        pricePerHr: l.pricePerHr,
        instanceRecordId: instance.id || `llm-${l.instanceId}`,
      };
    });
  const destroyed = deploys
    .filter((d) => !d.live)
    .map((d): HubDeployment => {
      const inst = d.instance as { id?: string; tier?: string };
      return {
        instanceId: 0,
        modelLabel: inst.tier?.replace(/^LLM · /, '') || 'Unknown',
        state: 'destroyed' as HubDeploymentState,
        endpoint: null,
        ready: false,
        gpu: '',
        location: '',
        pricePerHr: 0,
        instanceRecordId: inst.id || '',
      };
    });
  return live.concat(destroyed);
}

export type HubInstanceBadge = 'active' | 'provisioning' | 'stopped' | 'destroyed' | 'unknown';

export interface HubInstance {
  id: string;
  tier: string;
  status: string;
  badge: HubInstanceBadge;
  costUsdPerHour: number;
  startedAt?: string;
}

const DESTROYED = new Set(['terminated', 'deleted', 'destroyed', 'cancelled', 'failed', 'destroy']);
const ACTIVE = new Set(['running', 'active', 'ready', 'healthy']);
const PROVISIONING = new Set([
  'pending',
  'provisioning',
  'loading',
  'starting',
  'creating',
  'queued',
]);

/** Bucket a raw instance status string into a display badge. */
export function instanceBadge(status: string): HubInstanceBadge {
  const s = (status || '').toLowerCase();
  if (ACTIVE.has(s)) return 'active';
  if (PROVISIONING.has(s)) return 'provisioning';
  if (DESTROYED.has(s)) return 'destroyed';
  if (s === 'stopped') return 'stopped';
  return 'unknown';
}

/** Map the listInstances response into hub rows. */
export function mapInstances(
  instances: Array<{
    id: string;
    tier: string;
    status: string;
    startedAt?: string;
    costUsdPerHour: number;
  }>
): HubInstance[] {
  return instances.map((i) => ({
    id: i.id,
    tier: i.tier,
    status: i.status || 'unknown',
    badge: instanceBadge(i.status),
    costUsdPerHour: i.costUsdPerHour || 0,
    startedAt: i.startedAt,
  }));
}

export interface HubJob {
  id: string;
  name: string;
  status: string;
}

/** Map the getJobs response defensively — the jobs API shape is not yet stable. */
export function mapJobs(raw: unknown[]): HubJob[] {
  return raw.map((entry, index) => {
    const row = (entry ?? {}) as Record<string, unknown>;
    return {
      id: String(row.id ?? row.jobId ?? `job-${index}`),
      name: String(row.name ?? row.label ?? row.id ?? `Job ${index + 1}`),
      status: String(row.status ?? row.state ?? 'unknown'),
    };
  });
}

export interface HubApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  status: string;
  totalRequests: number;
  lastUsedAt?: string;
}

/** Map the getApiKeys response defensively. */
export function mapApiKeys(raw: unknown[]): HubApiKey[] {
  return raw.map((entry, index) => {
    const row = (entry ?? {}) as Record<string, unknown>;
    const requests = Number(row.totalRequests ?? row.requests ?? 0);
    return {
      id: String(row.id ?? row.keyId ?? `key-${index}`),
      name: String(row.name ?? row.label ?? 'API key'),
      keyPrefix: String(row.keyPrefix ?? row.prefix ?? ''),
      status: String(row.status ?? 'active'),
      totalRequests: Number.isFinite(requests) ? requests : 0,
      lastUsedAt: row.lastUsedAt ? String(row.lastUsedAt) : undefined,
    };
  });
}

export interface HubModelGroups {
  featured: CatalogModel[];
  community: CatalogModel[];
  hosted: HostedEndpoint[];
}

/** Group the catalog the way the retired catalog tree did (featured vs community). */
export function mapModels(models: CatalogModel[], hosted: HostedEndpoint[]): HubModelGroups {
  return {
    featured: models.filter((m) => m.featured || m.partner === 'supergemma'),
    community: models.filter((m) => !m.featured && m.partner !== 'supergemma'),
    hosted,
  };
}

export interface HubAccount {
  balanceUsd: string;
  balanceSol: string;
  balanceUsdc: string;
  totalSpent: string;
  activeInstances: number;
  transactions: Array<{ kind: string; amount: string; asset: string }>;
}

/** Map the getBalance response into the account tab shape. */
export function mapAccount(res: {
  balance?: { usd: string; sol: string; usdc: string };
  totalSpent?: string;
  activeInstances?: number;
  transactions?: unknown[];
}): HubAccount {
  const balance = res.balance ?? { usd: '0.00', sol: '0.0000', usdc: '0.00' };
  const transactions = (res.transactions ?? []).slice(0, 8).map((tx) => {
    const row = tx as Record<string, unknown>;
    return {
      kind: String(row.type || row.kind || row.description || row.memo || 'Ledger entry'),
      amount: String(row.amount || row.amountMinor || row.amount_minor || ''),
      asset: String(row.asset || row.currency || ''),
    };
  });
  return {
    balanceUsd: balance.usd || '0.00',
    balanceSol: balance.sol || '0.0000',
    balanceUsdc: balance.usdc || '0.00',
    totalSpent: res.totalSpent || '0.00',
    activeInstances: res.activeInstances ?? 0,
    transactions,
  };
}

// ── Fetched snapshot ────────────────────────────────────────────────────────

interface HubData {
  account: HubAccount | null;
  deployments: HubDeployment[];
  instances: HubInstance[];
  jobs: HubJob[];
  apiKeys: HubApiKey[];
  models: HubModelGroups;
  updatedAt: string;
}

interface RawInstance {
  id: string;
  tier: string;
  status: string;
  startedAt?: string;
  costUsdPerHour: number;
}

// ── Provider ────────────────────────────────────────────────────────────────

export class CloudHubProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'capix.cloud.hub';

  private view?: vscode.WebviewView;
  private state: CloudHubState = createCloudHubState();
  private data: HubData | null = null;
  /** Per-tab load failure reasons — rendered as designed error states. */
  private errors: Partial<Record<CloudHubTab, string>> = {};
  private loading = false;
  private configured = false;
  private catalog: CatalogModel[] = [];

  constructor(
    private readonly client: CapixClient,
    private readonly extensionUri: vscode.Uri
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = this.getHtml();
    view.webview.onDidReceiveMessage((msg) => void this.handleMessage(msg));
    void this.refresh();
  }

  /** Current tab state (host-side mirror of the webview's getState/setState). */
  getState(): CloudHubState {
    return this.state;
  }

  async refresh(): Promise<void> {
    if (!this.view || this.loading) return;
    this.loading = true;
    this.errors = {};
    try {
      this.configured = await this.client.checkConfigured();
      if (!this.configured) {
        this.data = null;
        return;
      }

      const fail = (tab: CloudHubTab, label: string) => (err: unknown) => {
        const reason =
          err instanceof CapixApiError && err.status === 401
            ? 'Your Capix session expired. Sign in again to load this tab.'
            : err instanceof CapixApiError && err.status
              ? `${label} could not be loaded (HTTP ${err.status}).`
              : `${label} could not be loaded. Check your connection and retry.`;
        logger.warn(`CloudHub.${tab} load failed`, { error: String(err) });
        this.errors[tab] = reason;
        return null;
      };

      const [balanceRes, deploysRes, instancesRes, jobsRes, keysRes, catalogRes, hostedRes] =
        await Promise.all([
          this.client.getBalance().catch(fail('account', 'Account data')),
          this.client.listDeploys().catch(fail('deployments', 'Deployments')),
          this.client.listInstances().catch(fail('instances', 'Instances')),
          this.client.getJobs().catch(fail('jobs', 'Serverless jobs')),
          this.client.getApiKeys().catch(fail('apikeys', 'API keys')),
          this.client.getCatalog().catch(fail('models', 'Model catalog')),
          this.client.getHosted().catch(() => null), // hosted section degrades silently
        ]);

      if (balanceRes && !balanceRes.ok)
        this.errors.account = balanceRes.error || 'Account data could not be loaded.';
      if (deploysRes && !deploysRes.ok)
        this.errors.deployments = 'Deployments could not be loaded.';
      if (catalogRes && !catalogRes.ok) this.errors.models = 'Model catalog could not be loaded.';

      this.catalog = catalogRes?.models ?? [];
      this.data = {
        account: balanceRes?.ok ? mapAccount(balanceRes) : null,
        deployments: deploysRes?.ok ? mapDeployments(deploysRes.deploys) : [],
        instances: instancesRes ? mapInstances(instancesRes.instances as RawInstance[]) : [],
        jobs: jobsRes?.ok ? mapJobs(jobsRes.jobs ?? []) : [],
        apiKeys: keysRes?.ok ? mapApiKeys(keysRes.keys ?? []) : [],
        models: mapModels(this.catalog, hostedRes?.ok ? (hostedRes.endpoints ?? []) : []),
        updatedAt: balanceRes?.updatedAt || new Date().toISOString(),
      };
    } catch (err) {
      logger.error('CloudHubProvider.refresh failed', { error: String(err) });
      this.errors.overview = 'Cloud data could not be loaded. Check your connection and retry.';
    } finally {
      this.loading = false;
      // Render the authoritative snapshot directly (mirrors the dashboard) so
      // the hub never sits behind an indefinite loading placeholder.
      if (this.view) this.view.webview.html = this.getHtml();
    }
  }

  // ── Messages ────────────────────────────────────────────────────────────

  private async handleMessage(msg: { type: string; tab?: string; id?: string }): Promise<void> {
    switch (msg.type) {
      case 'tab':
        this.state = setHubTab(this.state, msg.tab);
        if (this.view) this.view.webview.html = this.getHtml();
        return;
      case 'refresh':
        await this.refresh();
        return;
      case 'newResource':
        await vscode.commands.executeCommand('capix.cloud.deploy');
        return;
      case 'topUp':
        await vscode.commands.executeCommand('capix.topUp');
        return;
      case 'openBilling':
        await vscode.commands.executeCommand('capix.openBilling');
        return;
      case 'signIn':
        await vscode.commands.executeCommand('capix.resetSessionAndSignIn');
        return;
      case 'openConsole':
        await vscode.commands.executeCommand('capix.openConsole');
        return;
      case 'openInstance':
        if (msg.id) await vscode.commands.executeCommand('capix.openInstance', msg.id);
        return;
      case 'stopInstance':
        await this.controlInstance(msg.id, 'stop');
        return;
      case 'destroyInstance':
        await this.confirmDestroyInstance(msg.id);
        return;
      case 'deployModel': {
        const model = this.catalog.find((m) => m.id === msg.id);
        if (model) await vscode.commands.executeCommand('capix.deployModel', model);
        return;
      }
      case 'deployAction': {
        // Route lifecycle actions through the existing command handlers by
        // synthesizing the tree item shape they consume.
        const deploy = this.data?.deployments.find((d) => d.instanceRecordId === msg.id);
        if (!deploy || deploy.instanceId <= 0) return;
        const item = {
          _deploy: {
            instanceId: deploy.instanceId,
            modelLabel: deploy.modelLabel,
            instanceRecordId: deploy.instanceRecordId,
          },
        };
        const command =
          msg.id && msg.tab === 'logs'
            ? 'capix.viewLogs'
            : msg.tab === 'stop'
              ? 'capix.stopDeploy'
              : msg.tab === 'start'
                ? 'capix.startDeploy'
                : msg.tab === 'destroy'
                  ? 'capix.destroyDeploy'
                  : msg.tab === 'copyEndpoint'
                    ? 'capix.copyEndpoint'
                    : 'capix.copyApiKey';
        await vscode.commands.executeCommand(command, item);
        return;
      }
      case 'createApiKey':
        await vscode.commands.executeCommand('capix.createApiKey');
        await this.refresh();
        return;
      case 'revokeApiKey':
        await this.confirmRevokeKey(msg.id);
        return;
      case 'triggerJob':
        await vscode.commands.executeCommand('capix.triggerJob');
        return;
    }
  }

  private async controlInstance(id: string | undefined, action: 'stop' | 'destroy'): Promise<void> {
    if (!id) return;
    try {
      await this.client.controlInstance(id, action);
      await this.refresh();
    } catch (err) {
      logger.error('CloudHub.controlInstance failed', { id, action, error: String(err) });
      vscode.window.showErrorMessage(`Capix: Could not ${action} resource — ${String(err)}`);
    }
  }

  private async confirmDestroyInstance(id: string | undefined): Promise<void> {
    if (!id) return;
    const confirm = await vscode.window.showWarningMessage(
      `Destroy resource ${id}? Billing stops immediately and this cannot be undone.`,
      { modal: true },
      'Destroy'
    );
    if (confirm !== 'Destroy') return;
    await this.controlInstance(id, 'destroy');
  }

  private async confirmRevokeKey(id: string | undefined): Promise<void> {
    if (!id) return;
    const key = this.data?.apiKeys.find((k) => k.id === id);
    const confirm = await vscode.window.showWarningMessage(
      `Revoke API key "${key?.name ?? id}"? Clients using it will lose access immediately.`,
      { modal: true },
      'Revoke'
    );
    if (confirm !== 'Revoke') return;
    try {
      await this.client.revokeApiKey(id);
      await this.refresh();
    } catch (err) {
      logger.error('CloudHub.revokeApiKey failed', { id, error: String(err) });
      vscode.window.showErrorMessage(`Capix: Could not revoke API key — ${String(err)}`);
    }
  }

  // ── HTML ────────────────────────────────────────────────────────────────

  private getHtml(): string {
    const nonce = randomBytes(16).toString('base64');
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">`;
    const tabs = CLOUD_HUB_TABS.map(
      (t) =>
        `<button class="hub-tab${t.id === this.state.activeTab ? ' active' : ''}" data-tab="${t.id}">${t.label}</button>`
    ).join('');
    return `<!DOCTYPE html>
<html lang="en">
<head>
${csp}
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>${HUB_STYLES}</style>
</head>
<body>
  <header class="hub-header">
    <div class="balance-chip">${this.balanceChipHtml()}</div>
    <button class="btn btn-new" data-action="newResource">+ New Resource</button>
  </header>
  <nav class="hub-tabs">${tabs}</nav>
  <main id="content">${this.tabHtml()}</main>
  <script nonce="${nonce}">${HUB_SCRIPT}</script>
</body>
</html>`;
  }

  private balanceChipHtml(): string {
    if (!this.data?.account || !this.configured) {
      return `<span class="chip-label">Balance</span><span class="chip-value">—</span>`;
    }
    const a = this.data.account;
    return `<span class="chip-label">Balance</span>
      <span class="chip-value">$${esc(a.balanceUsd)}</span>
      <span class="chip-sub">${esc(a.balanceSol)} SOL · ${esc(a.balanceUsdc)} USDC</span>`;
  }

  private errorHtml(tab: CloudHubTab): string | null {
    const reason = this.errors[tab];
    if (!reason) return null;
    return `<div class="state error"><p>${esc(reason)}</p><button class="btn btn-secondary" data-action="refresh">Retry</button></div>`;
  }

  private tabHtml(): string {
    if (this.loading && !this.data) {
      return `<div class="state loading">Loading Capix Cloud…</div>`;
    }
    if (!this.configured || !this.data) {
      return `<div class="state connect"><p>Sign in to view your Capix cloud resources, balance, and usage.</p><button class="btn btn-primary" data-action="signIn">Sign In</button></div>`;
    }
    switch (this.state.activeTab) {
      case 'deployments':
        return this.errorsHtml('deployments') ?? this.deploymentsHtml();
      case 'instances':
        return this.errorsHtml('instances') ?? this.instancesHtml();
      case 'jobs':
        return this.errorsHtml('jobs') ?? this.jobsHtml();
      case 'apikeys':
        return this.errorsHtml('apikeys') ?? this.apiKeysHtml();
      case 'models':
        return this.errorsHtml('models') ?? this.modelsHtml();
      case 'account':
        return this.errorsHtml('account') ?? this.accountHtml();
      case 'overview':
      default:
        return this.errorHtml('overview') ?? this.overviewHtml();
    }
  }

  private errorsHtml(tab: CloudHubTab): string | null {
    return this.errorHtml(tab);
  }

  // ── Tabs ────────────────────────────────────────────────────────────────

  private overviewHtml(): string {
    const d = this.data!;
    const a = d.account;
    const live = d.instances.filter((i) => i.badge !== 'destroyed');
    const active = live.filter((i) => i.badge === 'active');
    const provisioning = live.filter((i) => i.badge === 'provisioning');
    const hourlyMicro = active.reduce((sum, i) => sum + dollarsToMicro(i.costUsdPerHour), 0);
    const privateModels = d.deployments.filter((dep) => dep.state !== 'destroyed');
    const updated = new Date(d.updatedAt).toLocaleTimeString();

    const instanceRows = live.length
      ? live
          .map(
            (i) => `<div class="res-row">
              <div class="res-main">
                <span class="res-name">${esc(i.tier)}</span>
                <span class="res-badge badge-${esc(i.badge)}">${esc(i.status)}</span>
                <span class="res-id">#${esc(i.id.slice(0, 8))}</span>
              </div>
              <div class="res-actions">
                <span class="res-rate">${esc(microToDisplay(dollarsToMicro(i.costUsdPerHour), 2))}/hr</span>
                <button class="icon-btn" data-action="openInstance" data-id="${esc(i.id)}" title="Open">${icon("link")}</button>
                ${i.badge === 'active' ? `<button class="icon-btn" data-action="stopInstance" data-id="${esc(i.id)}" title="Stop">${icon("debug-stop")}</button>` : ''}
                <button class="icon-btn danger" data-action="destroyInstance" data-id="${esc(i.id)}" title="Destroy">${icon("trash")}</button>
              </div>
            </div>`
          )
          .join('')
      : `<div class="state subtle">No active resources — provision one to get started.</div>`;

    const privateRows = privateModels.length
      ? privateModels
          .map(
            (m) =>
              `<div class="res-row"><div class="res-main"><span class="res-name">${esc(m.modelLabel)}</span><span class="res-badge badge-${esc(m.state)}">${esc(m.state)}</span></div><span class="res-rate">${esc(microToDisplay(dollarsToMicro(m.pricePerHr), 2))}/hr</span></div>`
          )
          .join('')
      : `<div class="state subtle">No private models deployed.</div>`;

    const recentRows = a?.transactions.length
      ? a.transactions
          .slice(0, 5)
          .map(
            (r) =>
              `<div class="res-row"><span class="res-name">${esc(r.kind)}</span><span class="recent-amt">${esc(r.amount)} ${esc(r.asset)}</span></div>`
          )
          .join('')
      : `<div class="state subtle">No ledger activity yet.</div>`;

    return `
      <section class="card stat-row">
        <div class="stat"><div class="stat-value">${esc(microToDisplay(hourlyMicro, 2))}/hr</div><div class="stat-label">Hourly spend</div></div>
        <div class="stat"><div class="stat-value">${esc(String(active.length))}</div><div class="stat-label">Active</div></div>
        <div class="stat"><div class="stat-value">${esc(String(provisioning.length))}</div><div class="stat-label">Provisioning</div></div>
        <div class="stat"><div class="stat-value">$${esc(a?.totalSpent ?? '0.00')}</div><div class="stat-label">Total spent</div></div>
      </section>
      <section class="card">
        <div class="section-head"><h2>Active Resources</h2><button class="btn btn-mini" data-action="refresh">${icon("refresh")}</button></div>
        ${instanceRows}
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

  private deploymentsHtml(): string {
    const deployments = this.data!.deployments;
    if (deployments.length === 0) {
      return `<div class="state subtle"><p>No deployments yet.</p><button class="btn btn-primary" data-action="newResource">Deploy a model</button></div>`;
    }
    const rows = deployments
      .map((d) => {
        const live = d.instanceId > 0 && d.state !== 'destroyed';
        const actions = live
          ? [
              d.ready && d.endpoint
                ? `<button class="icon-btn" data-action="deployAction" data-tab="copyEndpoint" data-id="${esc(d.instanceRecordId)}" title="Copy endpoint">${icon("link")}</button>`
                : '',
              d.ready
                ? `<button class="icon-btn" data-action="deployAction" data-tab="copyApiKey" data-id="${esc(d.instanceRecordId)}" title="Copy API key">${icon("key")}</button>`
                : '',
              `<button class="icon-btn" data-action="deployAction" data-tab="logs" data-id="${esc(d.instanceRecordId)}" title="View logs">${icon("output")}</button>`,
              d.state === 'running' || d.state === 'provisioning'
                ? `<button class="icon-btn" data-action="deployAction" data-tab="stop" data-id="${esc(d.instanceRecordId)}" title="Stop">${icon("debug-stop")}</button>`
                : '',
              d.state === 'stopped'
                ? `<button class="icon-btn" data-action="deployAction" data-tab="start" data-id="${esc(d.instanceRecordId)}" title="Start">${icon("debug-start")}</button>`
                : '',
              `<button class="icon-btn danger" data-action="deployAction" data-tab="destroy" data-id="${esc(d.instanceRecordId)}" title="Destroy">${icon("trash")}</button>`,
            ].join('')
          : '';
        const meta =
          d.ready && d.endpoint
            ? `${esc(d.gpu)} · ${esc(d.location)} · $${d.pricePerHr.toFixed(2)}/hr`
            : d.gpu
              ? `${esc(d.gpu)} · ${esc(d.location)}`
              : '';
        return `<div class="res-row">
          <div class="res-main">
            <span class="res-name">${esc(d.modelLabel)}</span>
            <span class="res-badge badge-${esc(d.state)}">${esc(d.state)}</span>
            ${meta ? `<span class="res-id">${meta}</span>` : ''}
          </div>
          <div class="res-actions">${actions}</div>
        </div>`;
      })
      .join('');
    return `<section class="card">
      <div class="section-head"><h2>Deployments</h2><button class="btn btn-mini" data-action="refresh">${icon("refresh")}</button></div>
      ${rows}
    </section>`;
  }

  private instancesHtml(): string {
    const instances = this.data!.instances;
    if (instances.length === 0) {
      return `<div class="state subtle"><p>No instances — deploy from the console or + New Resource.</p></div>`;
    }
    const rows = instances
      .map(
        (i) => `<div class="res-row">
          <div class="res-main">
            <span class="res-name">${esc(i.tier)}</span>
            <span class="res-badge badge-${esc(i.badge)}">${esc(i.status)}</span>
          </div>
          <div class="res-actions">
            <span class="res-rate">${esc(microToDisplay(dollarsToMicro(i.costUsdPerHour), 2))}/hr</span>
            <button class="icon-btn" data-action="openInstance" data-id="${esc(i.id)}" title="Open detail">${icon("link")}</button>
            ${i.badge === 'active' ? `<button class="icon-btn" data-action="stopInstance" data-id="${esc(i.id)}" title="Stop">${icon("debug-stop")}</button>` : ''}
            ${i.badge !== 'destroyed' ? `<button class="icon-btn danger" data-action="destroyInstance" data-id="${esc(i.id)}" title="Destroy">${icon("trash")}</button>` : ''}
          </div>
        </div>`
      )
      .join('');
    return `<section class="card">
      <div class="section-head"><h2>Instances</h2><button class="btn btn-mini" data-action="refresh">${icon("refresh")}</button></div>
      ${rows}
    </section>`;
  }

  private jobsHtml(): string {
    const jobs = this.data!.jobs;
    const rows = jobs.length
      ? jobs
          .map(
            (j) => `<div class="res-row">
              <div class="res-main">
                <span class="res-name">${esc(j.name)}</span>
                <span class="res-badge badge-${esc(instanceBadge(j.status))}">${esc(j.status)}</span>
              </div>
              <span class="res-id">${esc(j.id)}</span>
            </div>`
          )
          .join('')
      : `<div class="state subtle">No serverless jobs yet — trigger one to see it here with live status.</div>`;
    return `<section class="card">
      <div class="section-head"><h2>Serverless Jobs</h2><button class="btn btn-mini" data-action="refresh">${icon("refresh")}</button></div>
      ${rows}
      <button class="btn btn-secondary btn-block" data-action="triggerJob">Trigger a job…</button>
    </section>`;
  }

  private apiKeysHtml(): string {
    const keys = this.data!.apiKeys;
    const rows = keys.length
      ? keys
          .map(
            (k) => `<div class="res-row">
              <div class="res-main">
                <span class="res-name">${esc(k.name)}</span>
                <span class="res-id">${esc(k.keyPrefix)}</span>
                <span class="res-badge badge-${esc(k.status === 'active' ? 'active' : 'stopped')}">${esc(k.status)}</span>
              </div>
              <div class="res-actions">
                <span class="res-id">${esc(String(k.totalRequests))} reqs</span>
                <button class="icon-btn danger" data-action="revokeApiKey" data-id="${esc(k.id)}" title="Revoke">${icon("trash")}</button>
              </div>
            </div>`
          )
          .join('')
      : `<div class="state subtle">The IDE signs in with your OAuth session — no API key required. Create one only for external gateway access.</div>`;
    return `<section class="card">
      <div class="section-head"><h2>API Keys</h2><button class="btn btn-mini" data-action="refresh">${icon("refresh")}</button></div>
      ${rows}
      <button class="btn btn-secondary btn-block" data-action="createApiKey">+ Create API key…</button>
    </section>`;
  }

  private modelsHtml(): string {
    const { featured, community, hosted } = this.data!.models;
    const modelRow = (m: CatalogModel) => `<div class="res-row">
      <div class="res-main">
        <span class="res-name">${esc(m.label)}</span>
        <span class="res-id">${esc(String(m.paramB))}B · ${esc(String(m.minVramGb))}GB VRAM</span>
      </div>
      <button class="btn btn-mini" data-action="deployModel" data-id="${esc(m.id)}">Deploy</button>
    </div>`;
    const hostedRows = hosted.length
      ? hosted
          .map(
            (h) => `<div class="res-row">
              <div class="res-main">
                <span class="res-name">${esc(h.modelLabel)}</span>
                <span class="res-badge badge-active">ready now</span>
                <span class="res-id">${esc(h.region)}</span>
              </div>
            </div>`
          )
          .join('')
      : `<div class="state subtle">No hosted endpoints live right now.</div>`;
    const featuredRows = featured.length ? featured.map(modelRow).join('') : '';
    const communityRows = community.length ? community.map(modelRow).join('') : '';
    const catalogRows =
      featuredRows || communityRows
        ? `${featuredRows ? `<div class="section-head"><h2>SuperGemma × Capix (featured)</h2></div>${featuredRows}` : ''}
         ${communityRows ? `<div class="section-head"><h2>Community models</h2></div>${communityRows}` : ''}`
        : `<div class="state subtle">Model catalog is empty.</div>`;
    return `<section class="card">
        <div class="section-head"><h2>Ready Now (Hosted)</h2><button class="btn btn-mini" data-action="refresh">${icon("refresh")}</button></div>
        ${hostedRows}
      </section>
      <section class="card">${catalogRows}</section>`;
  }

  private accountHtml(): string {
    const a = this.data!.account;
    if (!a) {
      return `<div class="state error"><p>Account data could not be loaded.</p><button class="btn btn-secondary" data-action="refresh">Retry</button></div>`;
    }
    const txRows = a.transactions.length
      ? a.transactions
          .map(
            (t) =>
              `<div class="res-row"><span class="res-name">${esc(t.kind)}</span><span class="recent-amt">${esc(t.amount)} ${esc(t.asset)}</span></div>`
          )
          .join('')
      : `<div class="state subtle">No ledger activity yet.</div>`;
    return `
      <section class="card">
        <div class="section-head"><h2>Wallet</h2><button class="btn btn-mini" data-action="refresh">${icon("refresh")}</button></div>
        <div class="account-balance">$${esc(a.balanceUsd)}</div>
        <div class="account-sub">${esc(a.balanceSol)} SOL · ${esc(a.balanceUsdc)} USDC</div>
        <div class="btn-row">
          <button class="btn btn-primary" data-action="topUp">+ Top Up</button>
          <button class="btn btn-secondary" data-action="openBilling">Billing →</button>
        </div>
      </section>
      <section class="card stat-row stat-row-2">
        <div class="stat"><div class="stat-value">${esc(String(a.activeInstances))}</div><div class="stat-label">Active instances</div></div>
        <div class="stat"><div class="stat-value">$${esc(a.totalSpent)}</div><div class="stat-label">Total spent</div></div>
      </section>
      <section class="card">
        <div class="section-head"><h2>Ledger</h2></div>
        ${txRows}
      </section>`;
  }
}

// ── Inline styles + script ──────────────────────────────────────────────────
// @capix/ui-tokens: dark foundation, cyan accents, green primary.
const HUB_STYLES = `
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
    margin: 0; padding: 0;
    font-size: 12px;
  }
  .hub-header {
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px; padding: 10px 10px 8px;
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

  /* Tab bar: horizontal, top, 32px, cyan underline on the active tab. */
  .hub-tabs {
    display: flex; align-items: stretch; height: 32px;
    border-bottom: 1px solid var(--capix-border);
    overflow-x: auto; scrollbar-width: none;
  }
  .hub-tabs::-webkit-scrollbar { display: none; }
  .hub-tab {
    flex: 0 0 auto;
    background: transparent; border: none; cursor: pointer;
    border-bottom: 2px solid transparent;
    color: var(--capix-muted);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10px; text-transform: uppercase; letter-spacing: .08em;
    padding: 0 12px;
  }
  .hub-tab:hover { color: var(--capix-fg); }
  .hub-tab.active { color: var(--capix-cyan); border-bottom-color: var(--capix-cyan); }

  main { padding: 10px; }
  .btn {
    border: none; border-radius: 6px; cursor: pointer;
    font-weight: 600; font-size: 11px; padding: 7px 14px;
    font-family: inherit;
  }
  .btn-new { background: var(--capix-green); color: #000; }
  .btn-primary { background: var(--capix-green); color: #000; }
  .btn-secondary { background: rgba(255,255,255,0.08); color: var(--capix-fg); }
  .btn-mini { background: transparent; color: var(--capix-cyan); padding: 4px 8px; font-size: 11px; border: 1px solid rgba(61,206,214,0.35); }
  .btn-block { width: 100%; margin-top: 10px; text-align: center; }
  .btn:hover { opacity: .88; }
  .btn-row { display: flex; gap: 8px; margin-top: 12px; }
  .card {
    background: var(--capix-surface);
    border: 1px solid var(--capix-border);
    border-radius: 8px; padding: 12px; margin-bottom: 10px;
  }
  .stat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .stat-row-2 { grid-template-columns: repeat(2, 1fr); }
  .stat { text-align: center; }
  .stat-value { font-size: 15px; font-weight: 700; color: var(--capix-cyan); font-family: var(--vscode-editor-font-family, monospace); }
  .stat-label { font-size: 9px; text-transform: uppercase; letter-spacing: .1em; color: var(--capix-muted); margin-top: 2px; }
  .section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .section-head h2 { font-size: 10px; text-transform: uppercase; letter-spacing: .12em; color: var(--capix-muted); margin: 0; font-weight: 600; }
  .updated { font-size: 9px; color: var(--capix-muted); }
  .res-row {
    display: flex; align-items: center; justify-content: space-between; gap: 6px;
    padding: 7px 0; border-bottom: 1px solid rgba(255,255,255,0.045);
  }
  .res-row:last-child { border-bottom: none; }
  .res-main { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }
  .res-name { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .res-id { font-size: 9px; color: var(--capix-muted); font-family: var(--vscode-editor-font-family, monospace); }
  .res-badge { font-size: 8px; text-transform: uppercase; padding: 1px 6px; border-radius: 999px; letter-spacing: .04em; }
  .badge-active, .badge-running, .badge-ready, .badge-healthy { background: rgba(20,241,149,0.12); color: var(--capix-green); }
  .badge-provisioning, .badge-pending, .badge-loading, .badge-starting, .badge-creating, .badge-queued { background: rgba(61,206,214,0.12); color: var(--capix-cyan); }
  .badge-stopped, .badge-unknown { background: rgba(255,174,0,0.12); color: var(--capix-amber); }
  .badge-destroyed { background: rgba(255,100,100,0.12); color: var(--capix-red); }
  .res-rate { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; color: var(--capix-green); }
  .recent-amt { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; color: var(--capix-muted); }
  .res-actions { display: flex; align-items: center; gap: 4px; }
  .icon-btn {
    background: transparent; border: none; cursor: pointer; color: var(--capix-muted);
    font-family: inherit; font-size: 12px; padding: 2px 4px; border-radius: 4px;
  }
  .icon-btn:hover { background: rgba(255,255,255,0.08); color: var(--capix-fg); }
  .icon-btn.danger:hover { color: var(--capix-red); }
  .account-balance { font-size: 26px; font-weight: 700; color: var(--capix-cyan); }
  .account-sub { font-size: 10px; color: var(--capix-muted); font-family: var(--vscode-editor-font-family, monospace); margin-top: 2px; }
  .state { padding: 20px 8px; text-align: center; color: var(--capix-muted); }
  .state.connect p, .state.error p { margin-bottom: 12px; }
  .state.subtle { padding: 14px; text-align: center; opacity: .55; }
  .state.subtle .btn { margin-top: 8px; }
`;

const HUB_SCRIPT = `
  const vscode = acquireVsCodeApi();
  // Restore the persisted tab selection (getState/setState) on fresh loads.
  const saved = vscode.getState();
  if (saved && saved.tab) vscode.postMessage({ type: 'tab', tab: saved.tab });
  document.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target.closest('[data-action],[data-tab]') : null;
    if (!target) return;
    if (target.dataset.tab && target.classList.contains('hub-tab')) {
      vscode.setState({ tab: target.dataset.tab });
      vscode.postMessage({ type: 'tab', tab: target.dataset.tab });
    } else if (target.dataset.action) {
      vscode.postMessage({ type: target.dataset.action, id: target.dataset.id || undefined, tab: target.dataset.tab || undefined });
    }
  });
`;

// Minimal HTML escaper used while building the server-rendered snapshot.
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
