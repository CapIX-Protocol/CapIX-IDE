/**
 * Website tree view — website projects, production deployments, preview
 * deployments, custom domains, and build logs for the current Capix account.
 *
 * Each website project is a top-level collapsible row that expands into its
 * production deploy, preview deploys, custom domains, and the latest build.
 * All data is read-only from the /api/v1/websites/* routes and shares the
 * same session token as the web console — a deploy created on the web shows
 * up in the IDE instantly (and vice versa).
 */

import * as vscode from "vscode";
import { CapixClient } from "./apiClient";
import { logger } from "./logger";

// ── Website resource shapes ────────────────────────────────────────────────
interface WebsiteProject {
  id: string; name: string; repo: string; productionUrl: string | null;
  status: string; lastDeployAt: string | null; framework: string;
}

interface WebsiteDetail {
  production?: { deployId: string; url: string; createdAt: string; branch: string; status: string; };
  previews?: Array<{ deployId: string; url: string; createdAt: string; branch: string; label: string; status: string; expiresAt: string; }>;
  domains?: Array<{ domain: string; status: string; primary: boolean; tlsExpiry: string | null; }>;
  latestBuild?: { buildId: string; status: string; startedAt: string; durationMs: number; logUrl: string | null; };
}

// ── Discriminated tree item ────────────────────────────────────────────────
type WebsiteNodeKind =
  | "website"
  | "section-production" | "section-previews" | "section-domains" | "section-builds"
  | "production" | "preview" | "domain" | "build"
  | "info";

class SiteItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly kind: WebsiteNodeKind,
    collapsible: vscode.TreeItemCollapsibleState,
    command?: vscode.Command,
  ) {
    super(label, collapsible);
    this.contextValue = `capix-${kind}`;
    if (command) this.command = command;
  }

  static info(label: string): SiteItem {
    const item = new SiteItem(label, "info", vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon("info");
    return item;
  }
}

// ── Provider ───────────────────────────────────────────────────────────────
export class WebsiteTreeProvider implements vscode.TreeDataProvider<SiteItem> {
  private _onDidChange = new vscode.EventEmitter<SiteItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private websites: WebsiteProject[] = [];
  private loading: Promise<void> | null = null;

  /** Cached website detail keyed by website id. */
  private details = new Map<string, WebsiteDetail>();

  constructor(private client: CapixClient) {}

  refresh(): void { this._onDidChange.fire(undefined); }

  async load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const configured = await this.client.checkConfigured();
        if (!configured) { this.websites = []; this.details.clear(); return; }
        const res = await this.client.get<{ ok: boolean; websites?: WebsiteProject[] }>("/api/v1/websites");
        this.websites = res.websites || [];
        this.details.clear();
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 401) logger.info("Website resources are waiting for a refreshed Capix session");
        else if (status === 503) logger.info("Website resources are temporarily unavailable");
        else logger.warn("WebsiteTreeProvider.load failed", { error: String(err) });
        this.websites = [];
        this.details.clear();
      }
      this.refresh();
    })().finally(() => { this.loading = null; });
    return this.loading;
  }

  getTreeItem(element: SiteItem): vscode.TreeItem { return element; }

  async getChildren(element?: SiteItem): Promise<SiteItem[]> {
    if (!await this.client.checkConfigured()) {
      return [SiteItem.info("Connect wallet to view websites")];
    }

    // Top-level: website projects
    if (!element) {
      if (this.websites.length === 0) {
        return [SiteItem.info("No websites — deploy with /capix website deploy <repo>")];
      }
      return this.websites.map((w) => {
        const item = new SiteItem(w.name, "website", vscode.TreeItemCollapsibleState.Collapsed);
        item.description = w.productionUrl ? w.productionUrl : "no production URL";
        item.iconPath = new vscode.ThemeIcon("globe");
        item.tooltip = `${w.name}\nRepo: ${w.repo}\nFramework: ${w.framework}\nStatus: ${w.status}\nProduction: ${w.productionUrl || "(none)"}${w.lastDeployAt ? `\nLast deploy: ${new Date(w.lastDeployAt).toLocaleString()}` : ""}`;
        (item as SiteItem & { _websiteId?: string })._websiteId = w.id;
        return item;
      });
    }

    // Website expansion → detail sections
    if (element.kind === "website") {
      const id = (element as SiteItem & { _websiteId?: string })._websiteId;
      if (!id) return [];
      return this.websiteDetailRows(id);
    }

    return [];
  }

  private async websiteDetailRows(websiteId: string): Promise<SiteItem[]> {
    let detail = this.details.get(websiteId);
    if (!detail) {
      try {
        detail = await this.client.get<WebsiteDetail>(`/api/v1/websites/${encodeURIComponent(websiteId)}`);
        if (!detail) return [SiteItem.info("No details available for this website.")];
        this.details.set(websiteId, detail);
      } catch (err) {
        logger.error("WebsiteTreeProvider.websiteDetailRows failed", { error: String(err), websiteId });
        return [SiteItem.info("Failed to load website details")];
      }
    }

    const items: SiteItem[] = [];

    // Production deployment
    items.push(this.sectionHeader("Production", detail.production ? 1 : 0, "section-production"));
    if (detail.production) {
      const p = detail.production;
      const item = new SiteItem(p.branch, "production", vscode.TreeItemCollapsibleState.None, {
        command: "capix.openInstance", title: "Open", arguments: [p.deployId],
      });
      item.description = `${p.status} · ${new Date(p.createdAt).toLocaleDateString()}`;
      item.iconPath = new vscode.ThemeIcon("rocket");
      item.tooltip = `Branch: ${p.branch}\nURL: ${p.url}\nStatus: ${p.status}\nDeployed: ${new Date(p.createdAt).toLocaleString()}`;
      items.push(item);
    } else {
      items.push(SiteItem.info("No production deployment — promote a preview"));
    }

    // Preview deployments
    const previews = detail.previews || [];
    items.push(this.sectionHeader("Previews", previews.length, "section-previews"));
    if (previews.length === 0) {
      items.push(SiteItem.info("No preview deployments"));
    } else {
      for (const pv of previews) {
        const item = new SiteItem(pv.label || pv.branch, "preview", vscode.TreeItemCollapsibleState.None, {
          command: "capix.openInstance", title: "Open", arguments: [pv.deployId],
        });
        item.description = `${pv.status} · ${new Date(pv.createdAt).toLocaleDateString()}`;
        item.iconPath = new vscode.ThemeIcon("git-branch");
        item.tooltip = `Label: ${pv.label}\nBranch: ${pv.branch}\nURL: ${pv.url}\nStatus: ${pv.status}\nCreated: ${new Date(pv.createdAt).toLocaleString()}\nExpires: ${new Date(pv.expiresAt).toLocaleString()}`;
        items.push(item);
      }
    }

    // Custom domains
    const domains = detail.domains || [];
    items.push(this.sectionHeader("Custom Domains", domains.length, "section-domains"));
    if (domains.length === 0) {
      items.push(SiteItem.info("No custom domains"));
    } else {
      for (const d of domains) {
        const item = new SiteItem(d.domain, "domain", vscode.TreeItemCollapsibleState.None);
        const primaryTag = d.primary ? " · primary" : "";
        item.description = `${d.status}${primaryTag}${d.tlsExpiry ? ` · TLS ${new Date(d.tlsExpiry).toLocaleDateString()}` : ""}`;
        item.iconPath = new vscode.ThemeIcon(d.status === "verified" ? "link" : "warning");
        item.tooltip = `Domain: ${d.domain}\nStatus: ${d.status}\nPrimary: ${d.primary ? "yes" : "no"}${d.tlsExpiry ? `\nTLS expires: ${new Date(d.tlsExpiry).toLocaleString()}` : ""}`;
        items.push(item);
      }
    }

    // Build logs
    const build = detail.latestBuild;
    items.push(this.sectionHeader("Build Logs", build ? 1 : 0, "section-builds"));
    if (build) {
      const item = new SiteItem(`Build ${build.buildId.slice(0, 8)}`, "build", vscode.TreeItemCollapsibleState.None, {
        command: "capix.viewLogs", title: "View logs", arguments: [build.buildId],
      });
      item.description = `${build.status} · ${Math.round(build.durationMs / 1000)}s · ${new Date(build.startedAt).toLocaleDateString()}`;
      item.iconPath = new vscode.ThemeIcon(build.status === "success" ? "check" : build.status === "failed" ? "error" : "loading");
      item.tooltip = `Build: ${build.buildId}\nStatus: ${build.status}\nStarted: ${new Date(build.startedAt).toLocaleString()}\nDuration: ${Math.round(build.durationMs / 1000)}s${build.logUrl ? `\nLogs: ${build.logUrl}` : ""}`;
      items.push(item);
    } else {
      items.push(SiteItem.info("No build logs yet"));
    }

    return items;
  }

  private sectionHeader(label: string, count: number, kind: WebsiteNodeKind): SiteItem {
    const item = new SiteItem(label, kind, vscode.TreeItemCollapsibleState.None);
    item.description = String(count);
    item.iconPath = new vscode.ThemeIcon("folder");
    return item;
  }
}
