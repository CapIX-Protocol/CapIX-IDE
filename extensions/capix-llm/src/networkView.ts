/**
 * Network tree view — VPCs, subnets, security groups, public endpoints,
 * DNS records, and active SSH connections for the current Capix account.
 *
 * Top-level categories expand into resource rows; a VPC row expands further
 * into its subnets, security groups, and routes. All data is read-only from
 * the /api/v1/network/* and /api/v1/endpoints routes and shares the same
 * session token as the web console.
 */

import * as vscode from "vscode";
import { CapixClient } from "./apiClient";
import { logger } from "./logger";

// ── Network resource shapes ────────────────────────────────────────────────
interface Vpc { id: string; name: string; cidrBlock: string; region: string; state: string; }
interface Subnet { id: string; name: string; cidrBlock: string; visibility: string; state: string; }
interface SecurityGroup { id: string; name: string; ruleCount: number; }
interface Route { destination: string; target: string; type: string; }
interface PublicEndpoint { id: string; label: string; url: string; status: string; healthy: boolean; }
interface DnsRecord { id: string; name: string; type: string; value: string; ttl: number; }
interface SshSession { deploymentId: string; host: string; port: number; pid: number; expiresAt: string; }

// ── Discriminated tree item ────────────────────────────────────────────────
type NetNodeKind = "category-vpcs" | "category-endpoints" | "category-dns" | "category-ssh" | "vpc" | "subnet" | "security-group" | "route" | "endpoint" | "dns" | "ssh" | "info";

class NetItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly kind: NetNodeKind,
    collapsible: vscode.TreeItemCollapsibleState,
    command?: vscode.Command,
  ) {
    super(label, collapsible);
    this.contextValue = `capix-${kind}`;
    if (command) this.command = command;
  }

  static info(label: string): NetItem {
    const item = new NetItem(label, "info", vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon("$(info)");
    return item;
  }
}

// ── Provider ───────────────────────────────────────────────────────────────
export class NetworkTreeProvider implements vscode.TreeDataProvider<NetItem> {
  private _onDidChange = new vscode.EventEmitter<NetItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private vpcs: Vpc[] = [];
  private endpoints: PublicEndpoint[] = [];
  private dns: DnsRecord[] = [];
  private ssh: SshSession[] = [];
  private loading: Promise<void> | null = null;

  /** Cached child payloads keyed by VPC id. */
  private vpcChildren = new Map<string, { subnets: Subnet[]; securityGroups: SecurityGroup[]; routes: Route[] }>();

  constructor(private client: CapixClient) {}

  refresh(): void { this._onDidChange.fire(undefined); }

  async load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const configured = await this.client.checkConfigured();
        if (!configured) { this.clear(); return; }
        const [vpcsRes, endpointsRes, dnsRes, sshRes] = await Promise.allSettled([
          this.client.get<{ ok: boolean; vpcs?: Vpc[] }>("/api/v1/network/vpcs"),
          this.client.get<{ ok: boolean; endpoints?: PublicEndpoint[] }>("/api/v1/endpoints"),
          this.client.get<{ ok: boolean; records?: DnsRecord[] }>("/api/v1/network/dns"),
          this.client.get<{ ok: boolean; sessions?: SshSession[] }>("/api/v1/deployments?sshOnly=true"),
        ]);
        this.vpcs = vpcsRes.status === "fulfilled" ? (vpcsRes.value.vpcs || []) : [];
        this.endpoints = endpointsRes.status === "fulfilled" ? (endpointsRes.value.endpoints || []) : [];
        this.dns = dnsRes.status === "fulfilled" ? (dnsRes.value.records || []) : [];
        this.ssh = sshRes.status === "fulfilled" ? (sshRes.value.sessions || []) : [];
        this.vpcChildren.clear();
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 401) logger.info("Network resources are waiting for a refreshed Capix session");
        else if (status === 503) logger.info("Network resources are temporarily unavailable");
        else logger.error("NetworkTreeProvider.load failed", { error: String(err) });
        this.clear();
      }
      this.refresh();
    })().finally(() => { this.loading = null; });
    return this.loading;
  }

  private clear(): void {
    this.vpcs = [];
    this.endpoints = [];
    this.dns = [];
    this.ssh = [];
    this.vpcChildren.clear();
  }

  getTreeItem(element: NetItem): vscode.TreeItem { return element; }

  async getChildren(element?: NetItem): Promise<NetItem[]> {
    if (!await this.client.checkConfigured()) {
      return [NetItem.info("Connect wallet to view network resources")];
    }

    // Top-level categories
    if (!element) {
      const items: NetItem[] = [];
      items.push(this.category("VPCs", "category-vpcs", this.vpcs.length, "$(symbol-namespace)"));
      items.push(this.category("Public Endpoints", "category-endpoints", this.endpoints.length, "$(globe)"));
      items.push(this.category("DNS Records", "category-dns", this.dns.length, "$(link)"));
      items.push(this.category("SSH Connections", "category-ssh", this.ssh.length, "$(terminal)"));
      return items;
    }

    // Category expansions
    switch (element.kind) {
      case "category-vpcs": return this.vpcRows();
      case "category-endpoints": return this.endpointRows();
      case "category-dns": return this.dnsRows();
      case "category-ssh": return this.sshRows();
    }

    // VPC row expansion → subnets + security groups + routes
    if (element.kind === "vpc") {
      const vpcId = (element as NetItem & { _vpcId?: string })._vpcId;
      if (!vpcId) return [];
      return this.vpcDetailRows(vpcId);
    }

    return [];
  }

  private category(label: string, kind: NetNodeKind, count: number, icon: string): NetItem {
    const item = new NetItem(label, kind, vscode.TreeItemCollapsibleState.Expanded);
    item.description = String(count);
    item.iconPath = new vscode.ThemeIcon(icon);
    return item;
  }

  private vpcRows(): NetItem[] {
    if (this.vpcs.length === 0) return [NetItem.info("No VPCs — create one with /capix network create")];
    return this.vpcs.map((v) => {
      const item = new NetItem(v.name || v.id, "vpc", vscode.TreeItemCollapsibleState.Collapsed);
      item.description = `${v.cidrBlock} · ${v.region} · ${v.state}`;
      item.iconPath = new vscode.ThemeIcon("$(vm-connect)");
      item.tooltip = `${v.name}\nCIDR: ${v.cidrBlock}\nRegion: ${v.region}\nState: ${v.state}`;
      (item as NetItem & { _vpcId?: string })._vpcId = v.id;
      return item;
    });
  }

  private endpointRows(): NetItem[] {
    if (this.endpoints.length === 0) return [NetItem.info("No public endpoints — create one with /capix endpoints create")];
    return this.endpoints.map((e) => {
      const item = new NetItem(e.label || e.id, "endpoint", vscode.TreeItemCollapsibleState.None, {
        command: "capix.openInstance", title: "Open", arguments: [e.id],
      });
      item.description = `${e.status}${e.healthy ? " · healthy" : " · unhealthy"}`;
      item.iconPath = new vscode.ThemeIcon(e.healthy ? "$(globe)" : "$(warning)");
      item.tooltip = `${e.label}\nURL: ${e.url}\nStatus: ${e.status}\nHealthy: ${e.healthy ? "yes" : "no"}`;
      return item;
    });
  }

  private dnsRows(): NetItem[] {
    if (this.dns.length === 0) return [NetItem.info("No DNS records")];
    return this.dns.map((r) => {
      const item = new NetItem(r.name, "dns", vscode.TreeItemCollapsibleState.None);
      item.description = `${r.type} · ${r.value} · ${r.ttl}s`;
      item.iconPath = new vscode.ThemeIcon("$(link)");
      item.tooltip = `${r.name} (${r.type})\nValue: ${r.value}\nTTL: ${r.ttl}s`;
      return item;
    });
  }

  private sshRows(): NetItem[] {
    if (this.ssh.length === 0) return [NetItem.info("No active SSH sessions — connect with /capix ssh")];
    return this.ssh.map((s) => {
      const item = new NetItem(`${s.deploymentId}`, "ssh", vscode.TreeItemCollapsibleState.None, {
        command: "capix.openTerminal", title: "Open", arguments: [s.deploymentId],
      });
      item.description = `${s.host}:${s.port} · pid ${s.pid}`;
      item.iconPath = new vscode.ThemeIcon("$(terminal)");
      item.tooltip = `Deployment: ${s.deploymentId}\nHost: ${s.host}:${s.port}\nPID: ${s.pid}\nExpires: ${new Date(s.expiresAt).toLocaleString()}`;
      return item;
    });
  }

  private async vpcDetailRows(vpcId: string): Promise<NetItem[]> {
    let cached = this.vpcChildren.get(vpcId);
    if (!cached) {
      try {
        const [subnetsRes, sgRes, routesRes] = await Promise.allSettled([
          this.client.get<{ ok: boolean; subnets?: Subnet[] }>(`/api/v1/network/vpcs/${encodeURIComponent(vpcId)}/subnets`),
          this.client.get<{ ok: boolean; securityGroups?: SecurityGroup[] }>(`/api/v1/network/vpcs/${encodeURIComponent(vpcId)}/security-groups`),
          this.client.get<{ ok: boolean; routes?: Route[] }>(`/api/v1/network/vpcs/${encodeURIComponent(vpcId)}/routes`),
        ]);
        cached = {
          subnets: subnetsRes.status === "fulfilled" ? (subnetsRes.value.subnets || []) : [],
          securityGroups: sgRes.status === "fulfilled" ? (sgRes.value.securityGroups || []) : [],
          routes: routesRes.status === "fulfilled" ? (routesRes.value.routes || []) : [],
        };
        this.vpcChildren.set(vpcId, cached);
      } catch (err) {
        logger.error("NetworkTreeProvider.vpcDetailRows failed", { error: String(err), vpcId });
        return [NetItem.info("Failed to load VPC details")];
      }
    }

    const items: NetItem[] = [];
    const subHeader = this.subHeader("Subnets", cached.subnets.length);
    items.push(subHeader);
    for (const s of cached.subnets) {
      const item = new NetItem(s.name || s.id, "subnet", vscode.TreeItemCollapsibleState.None);
      item.description = `${s.cidrBlock} · ${s.visibility} · ${s.state}`;
      item.iconPath = new vscode.ThemeIcon("$(circuit-board)");
      item.tooltip = `${s.name}\nCIDR: ${s.cidrBlock}\nVisibility: ${s.visibility}\nState: ${s.state}`;
      items.push(item);
    }

    const sgHeader = this.subHeader("Security Groups", cached.securityGroups.length);
    items.push(sgHeader);
    for (const g of cached.securityGroups) {
      const item = new NetItem(g.name || g.id, "security-group", vscode.TreeItemCollapsibleState.None);
      item.description = `${g.ruleCount} rule(s)`;
      item.iconPath = new vscode.ThemeIcon("$(shield)");
      item.tooltip = `${g.name}\nRules: ${g.ruleCount}`;
      items.push(item);
    }

    const routeHeader = this.subHeader("Routes", cached.routes.length);
    items.push(routeHeader);
    for (const r of cached.routes) {
      const item = new NetItem(r.destination, "route", vscode.TreeItemCollapsibleState.None);
      item.description = `${r.target} · ${r.type}`;
      item.iconPath = new vscode.ThemeIcon("$(arrow-swap)");
      item.tooltip = `Destination: ${r.destination}\nTarget: ${r.target}\nType: ${r.type}`;
      items.push(item);
    }
    return items;
  }

  private subHeader(label: string, count: number): NetItem {
    const item = new NetItem(label, "info", vscode.TreeItemCollapsibleState.None);
    item.description = String(count);
    item.iconPath = new vscode.ThemeIcon("$(folder)");
    return item;
  }
}
