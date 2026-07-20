import * as vscode from 'vscode';
import { CapixClient } from './apiClient';
import { logger } from './logger';
import { dollarsToMicro, microToDisplay } from './moneyUtils';

// ── Types ──────────────────────────────────────────────────────────────────
export interface CloudInstance {
  id: string;
  tier: string;
  status: string;
  costUsdPerHour: number;
  startedAt: string;
  nodes: Array<{
    id: string;
    sshHost: string | null;
    sshPort: number | null;
    gpu: string | null;
    agentOnline: boolean;
    sshAvailable?: boolean;
  }>;
}

// ── Instances tree ──────────────────────────────────────────────────────────
export class InstancesTreeProvider implements vscode.TreeDataProvider<CloudItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  public instances: CloudInstance[] = [];
  private loading: Promise<void> | null = null;

  constructor(private client: CapixClient) {}
  refresh(): void {
    this._onDidChange.fire();
  }

  async load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const res = await this.client.listInstances();
        this.instances = res.instances;
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 401) logger.info('Instances are waiting for a refreshed Capix session');
        else if (status === 503) logger.info('Instances are temporarily unavailable');
        else logger.warn('InstancesTreeProvider.load failed', { error: String(err) });
        this.instances = [];
      }
      this.refresh();
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  getTreeItem(element: CloudItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<CloudItem[]> {
    if (!(await this.client.checkConfigured())) {
      return [
        CloudItem.info('Connect wallet to view instances'),
      ];
    }
    if (this.instances.length === 0) {
      return [CloudItem.info('No instances yet — deploy one below')];
    }
    return this.instances.map((inst) => {
      const item = new CloudItem(
        `${inst.tier}`,
        `capix-instance-${inst.status}`,
        vscode.TreeItemCollapsibleState.None
      );
      item.description = `${inst.status} · $${microToDisplay(dollarsToMicro(inst.costUsdPerHour), 2)}/hr`;
      item.iconPath = new vscode.ThemeIcon(
        inst.status === 'running'
          ? 'vm-active'
          : inst.status === 'stopped'
            ? 'vm-outline'
            : 'vm-connect'
      );
      item.tooltip = `${inst.tier}\n${inst.nodes.length} node(s) · since ${new Date(inst.startedAt).toLocaleString()}`;
      item.contextValue = `capix-instance-${inst.status}`;
      item.command = { command: 'capix.openInstance', title: 'Open', arguments: [inst.id] };
      (item as CloudItem & { _instanceId?: string })._instanceId = inst.id;
      (item as CloudItem & { _sshAvailable?: boolean })._sshAvailable = inst.nodes.some(
        (n) => n.sshAvailable
      );
      (item as CloudItem & { _sshHost?: string })._sshHost =
        inst.nodes.find((n) => n.sshHost)?.sshHost ?? undefined;
      (item as CloudItem & { _sshPort?: number })._sshPort =
        inst.nodes.find((n) => n.sshPort)?.sshPort ?? undefined;
      return item;
    });
  }
}

// ── Shared cloud tree item ───────────────────────────────────────────────────
export class CloudItem extends vscode.TreeItem {
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

  static info(label: string): CloudItem {
    const item = new CloudItem(label, 'capix-info', vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('info');
    return item;
  }
}
