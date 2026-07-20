/**
 * Tree views — deploys data provider.
 *
 * The "My Deploys" / "Model Catalog" / "Ready Now (Hosted)" sidebar tree
 * views were consolidated into the tabbed `capix.cloud.hub` webview
 * (Deployments + Models tabs). DeploysTreeProvider stays as a data store:
 * the deploy lifecycle commands (stop / start / destroy / logs / copy
 * endpoint / copy API key) read its `deploys` snapshot when invoked
 * without a tree item.
 */

import * as vscode from 'vscode';
import { CapixClient } from './apiClient';
import { logger } from './logger';

// ── Tree item type enums ──────────────────────────────────────────────────
type DeployState = 'running' | 'stopped' | 'loading' | 'unknown' | 'destroyed';

// ── My Deploys tree ───────────────────────────────────────────────────────
export class DeploysTreeProvider implements vscode.TreeDataProvider<DeployItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  public deploys: Array<{
    instanceId: number;
    modelLabel: string;
    state: DeployState;
    endpoint: string | null;
    ready: boolean;
    gpu: string;
    location: string;
    pricePerHr: number;
    apiKey: string | null;
    instanceRecordId: string;
    canonical: boolean;
  }> = [];

  constructor(private client: CapixClient) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  async load(): Promise<void> {
    try {
      const res = await this.client.listDeploys();
      if (!res.ok) {
        this.deploys = [];
        this.refresh();
        return;
      }
      this.deploys = (
        res.deploys
          .filter((d) => d.live)
          .map((d) => {
            const instance = d.instance as { id?: string };
            const live = d.live!;
            const state: DeployState = live.ready
              ? 'running'
              : live.state === 'running'
                ? 'loading'
                : live.state === 'stopped'
                  ? 'stopped'
                  : 'unknown';
            return {
              instanceId: live.instanceId,
              modelLabel: live.modelLabel,
              state,
              endpoint: live.endpoint,
              ready: live.ready,
              gpu: live.gpu,
              location: live.location,
              pricePerHr: live.pricePerHr,
              apiKey: live.apiKey,
              // Canonical GPU/LLM deployments are saga resources, not SSH-capable
              // VMs. Keep their opaque owner-scoped ID so multiple provisioning
              // sagas never collapse into the old numeric `instanceId = 0` row.
              instanceRecordId: instance.id || `llm-${live.instanceId}`,
              canonical: Boolean(instance.id?.startsWith('gpu_')),
            };
          }) as {
          instanceId: number;
          modelLabel: string;
          state: DeployState;
          endpoint: string | null;
          ready: boolean;
          gpu: string;
          location: string;
          pricePerHr: number;
          apiKey: string | null;
          instanceRecordId: string;
          canonical: boolean;
        }[]
      ).concat(
        res.deploys
          .filter((d) => !d.live)
          .map((d) => {
            const inst = d.instance as { id?: string; tier?: string; status?: string };
            return {
              instanceId: 0,
              modelLabel: inst.tier?.replace(/^LLM · /, '') || 'Unknown',
              state: 'destroyed' as DeployState,
              endpoint: null,
              ready: false,
              gpu: '',
              location: '',
              pricePerHr: 0,
              apiKey: null,
              instanceRecordId: inst.id || '',
              canonical: Boolean(inst.id?.startsWith('gpu_')),
            };
          }) as {
          instanceId: number;
          modelLabel: string;
          state: DeployState;
          endpoint: string | null;
          ready: boolean;
          gpu: string;
          location: string;
          pricePerHr: number;
          apiKey: string | null;
          instanceRecordId: string;
          canonical: boolean;
        }[]
      );
      this.refresh();
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 401) logger.info('Deploys are waiting for a refreshed Capix session');
      else if (status === 503) logger.info('Deploys are temporarily unavailable');
      else logger.warn('DeploysTreeProvider.load failed', { error: String(err) });
      this.deploys = [];
      this.refresh();
    }
  }

  getTreeItem(element: DeployItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<DeployItem[]> {
    if (!(await this.client.checkConfigured())) {
      return [
        new DeployItem(
          'Connect wallet to view deploys',
          'capix-info',
          vscode.TreeItemCollapsibleState.None,
          {
            command: 'capix.connectWallet',
            title: 'Connect',
          }
        ),
      ];
    }
    if (this.deploys.length === 0) {
      return [
        new DeployItem(
          'No deploys yet — deploy a model below',
          'capix-info',
          vscode.TreeItemCollapsibleState.None
        ),
      ];
    }
    return this.deploys.map((d) => {
      const icon =
        d.state === 'running'
          ? 'check'
          : d.state === 'loading'
            ? 'loading'
            : d.state === 'stopped'
              ? 'debug-stop'
              : d.state === 'destroyed'
                ? 'trash'
                : 'circle';
      const ctxValue = d.canonical
        ? 'capix-canonical-deploy'
        : d.state === 'running'
          ? 'capix-deploy-running'
          : d.state === 'stopped'
            ? 'capix-deploy-stopped'
            : d.state === 'destroyed'
              ? 'capix-deploy-destroyed'
              : 'capix-deploy';
      const label = `${d.modelLabel} · ${d.state === 'loading' ? 'provisioning' : d.state}`;
      const desc =
        d.ready && d.endpoint
          ? `${d.gpu} · ${d.location} · $${d.pricePerHr.toFixed(2)}/hr`
          : d.gpu
            ? `${d.gpu} · ${d.location}`
            : '';
      const item = new DeployItem(label, ctxValue, vscode.TreeItemCollapsibleState.None);
      item.description = desc;
      item.iconPath = new vscode.ThemeIcon(icon);
      item.tooltip = d.ready
        ? `Endpoint: ${d.endpoint}/v1\nEndpoint ready — copy the base URL + API key to start using it.`
        : d.state === 'loading'
          ? `Provisioning on ${d.gpu} in ${d.location}\nModel download takes 2–10 min.`
          : `${d.state} deploy`;
      item.contextValue = ctxValue;
      (item as DeployItem & { _deploy?: typeof d })._deploy = d;
      return item;
    });
  }
}

// ── Tree item subclasses ──────────────────────────────────────────────────
export class DeployItem extends vscode.TreeItem {
  constructor(
    label: string,
    contextValue: string,
    collapsible: vscode.TreeItemCollapsibleState,
    command?: vscode.Command
  ) {
    super(label, collapsible);
    this.contextValue = contextValue;
    if (command) this.command = command;
  }
}
