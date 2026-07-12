/**
 * Cloud Panels — tree views for all Capix cloud resources:
 * 1. Instances (VPS + GPU + LLM deploys) with start/stop/destroy/SSH controls
 * 2. Agents (GitHub repo deploys) with view logs / SSH
 * 3. Serverless Jobs with trigger / view logs
 * 4. API Keys with create / revoke / copy
 *
 * Each panel maps directly to the web console's /cloud/* routes
 * and shares the same session token — so a deploy created on the web
 * shows up in the IDE instantly (and vice versa).
 */

import * as vscode from "vscode";
import { CapixClient } from "./apiClient";
import { logger } from "./logger";

// ── Shared types for cloud resources ───────────────────────────────────────
interface CloudInstance {
  id: string; tier: string; status: string; startedAt: string;
  costUsdPerHour: number; nodes: Array<{
    nodeId: string; location: string; sshHost: string | null; sshPort: number | null;
    gpu: string | null; agentOnline: boolean; sshAvailable?: boolean;
  }>;
}

interface CloudAgent {
  id: string; repoName: string; status: string; sshHost: string; sshPort: number;
  sshCommand: string; nodeName: string; nodeGpu: string; nodeLocation: string;
}

interface CloudJob {
  id: string; name: string; status: string; sshCommand: string;
  nodeName: string; nodeGpu: string; nodeLocation: string;
}

interface CloudApiKey {
  id: string; name: string; keyPrefix: string; status: string;
  totalRequests: number; lastUsedAt?: string;
}

// ── Instances tree ──────────────────────────────────────────────────────────
export class InstancesTreeProvider implements vscode.TreeDataProvider<CloudItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  public instances: CloudInstance[] = [];
  private loading: Promise<void> | null = null;

  constructor(private client: CapixClient) {}
  refresh(): void { this._onDidChange.fire(); }

  async load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const res = await this.client.listInstances();
        this.instances = res.instances;
      } catch (err) {
        logger.error("InstancesTreeProvider.load failed", { error: String(err) });
        this.instances = [];
      }
      this.refresh();
    })().finally(() => { this.loading = null; });
    return this.loading;
  }

  getTreeItem(element: CloudItem): vscode.TreeItem { return element; }

  async getChildren(): Promise<CloudItem[]> {
    if (!await this.client.checkConfigured()) {
      return [CloudItem.info("Connect wallet to view instances")];
    }
    if (this.instances.length === 0) {
      return [CloudItem.info("No instances — deploy from the Console")];
    }
    return this.instances.map((inst) => {
      const item = new CloudItem(
        `${inst.tier}`,
        `capix-instance-${inst.status}`,
        vscode.TreeItemCollapsibleState.None,
      );
      item.description = `${inst.status} · $${inst.costUsdPerHour.toFixed(2)}/hr`;
      item.iconPath = new vscode.ThemeIcon(
        inst.status === "running" ? "$(vm-active)" :
        inst.status === "stopped" ? "$(vm-outline)" : "$(vm-connect)",
      );
      item.tooltip = `${inst.tier}\n${inst.nodes.length} node(s) · since ${new Date(inst.startedAt).toLocaleString()}`;
      item.contextValue = `capix-instance-${inst.status}`;
      item.command = { command: "capix.openInstance", title: "Open", arguments: [inst.id] };
      (item as CloudItem & { _instanceId?: string })._instanceId = inst.id;
      (item as CloudItem & { _sshAvailable?: boolean })._sshAvailable = inst.nodes.some((n) => n.sshAvailable);
      (item as CloudItem & { _sshHost?: string })._sshHost = inst.nodes.find((n) => n.sshHost)?.sshHost ?? undefined;
      (item as CloudItem & { _sshPort?: number })._sshPort = inst.nodes.find((n) => n.sshPort)?.sshPort ?? undefined;
      return item;
    });
  }
}

// ── Agents tree ─────────────────────────────────────────────────────────────
export class AgentsTreeProvider implements vscode.TreeDataProvider<CloudItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  public agents: CloudAgent[] = [];

  constructor(private client: CapixClient) {}
  refresh(): void { this._onDidChange.fire(); }

  async load(): Promise<void> {
    // Customer launch: agent deployment is intentionally disabled. Do not hit
    // a disabled production route and misreport that expected state as a fault.
    this.agents = [];
    this.refresh();
  }

  getTreeItem(element: CloudItem): vscode.TreeItem { return element; }

  async getChildren(): Promise<CloudItem[]> {
    if (!await this.client.checkConfigured()) {
      return [CloudItem.info("Connect wallet to view agents")];
    }
    if (this.agents.length === 0) return [CloudItem.info("Agent deployment — coming later")];
    return this.agents.map((a) => {
      const item = new CloudItem(a.repoName, "capix-agent", vscode.TreeItemCollapsibleState.None);
      item.description = `${a.status} · ${a.nodeGpu} · ${a.nodeLocation}`;
      item.iconPath = new vscode.ThemeIcon("$(github)");
      item.tooltip = `${a.repoName}\nNode: ${a.nodeName} (${a.nodeGpu})\nSSH: ${a.sshCommand}`;
      item.contextValue = "capix-agent";
      (item as CloudItem & { _sshCommand?: string })._sshCommand = a.sshCommand;
      return item;
    });
  }
}

// ── Serverless Jobs tree ─────────────────────────────────────────────────────
export class JobsTreeProvider implements vscode.TreeDataProvider<CloudItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  public jobs: CloudJob[] = [];

  constructor(private client: CapixClient) {}
  refresh(): void { this._onDidChange.fire(); }

  async load(): Promise<void> {
    this.jobs = [];
    this.refresh();
  }

  getTreeItem(element: CloudItem): vscode.TreeItem { return element; }

  async getChildren(): Promise<CloudItem[]> {
    if (!await this.client.checkConfigured()) return [CloudItem.info("Connect wallet to view jobs")];
    if (this.jobs.length === 0) return [CloudItem.info("Serverless jobs — coming later")];
    return this.jobs.map((j) => {
      const item = new CloudItem(j.name, "capix-job", vscode.TreeItemCollapsibleState.None);
      item.description = `${j.status} · ${j.nodeGpu}`;
      item.iconPath = new vscode.ThemeIcon("$(server-process)");
      item.tooltip = `${j.name}\nSSH: ${j.sshCommand}`;
      item.contextValue = "capix-job";
      (item as CloudItem & { _sshCommand?: string })._sshCommand = j.sshCommand;
      return item;
    });
  }
}

// ── API Keys tree ─────────────────────────────────────────────────────────────
export class ApiKeysTreeProvider implements vscode.TreeDataProvider<CloudItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  public keys: CloudApiKey[] = [];

  constructor(private client: CapixClient) {}
  refresh(): void { this._onDidChange.fire(); }

  async load(): Promise<void> {
    // Desktop chat uses the short-lived OAuth session; customers do not need
    // to create or paste a portal API key.
    this.keys = [];
    this.refresh();
  }

  getTreeItem(element: CloudItem): vscode.TreeItem { return element; }

  async getChildren(): Promise<CloudItem[]> {
    if (!await this.client.checkConfigured()) return [CloudItem.info("Connect wallet to view API keys")];
    if (this.keys.length === 0) return [CloudItem.info("OAuth connected · no API key required")];
    return this.keys.map((k) => {
      const item = new CloudItem(k.name, "capix-apikey", vscode.TreeItemCollapsibleState.None);
      item.description = `${k.keyPrefix} · ${k.status} · ${k.totalRequests} reqs`;
      item.iconPath = new vscode.ThemeIcon("$(key)");
      item.tooltip = `${k.name}\nKey: ${k.keyPrefix}\nStatus: ${k.status}\nRequests: ${k.totalRequests}${k.lastUsedAt ? `\nLast used: ${k.lastUsedAt}` : ""}`;
      item.contextValue = `capix-apikey-${k.status}`;
      return item;
    });
  }
}

// ── Shared cloud tree item ───────────────────────────────────────────────────
export class CloudItem extends vscode.TreeItem {
  constructor(label: string, contextValue: string, collapsible: vscode.TreeItemCollapsibleState, command?: vscode.Command) {
    super(label, collapsible);
    this.contextValue = contextValue;
    if (command) this.command = command;
  }

  static info(label: string): CloudItem {
    const item = new CloudItem(label, "capix-info", vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon("$(info)");
    return item;
  }
}
