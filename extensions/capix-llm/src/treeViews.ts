/**
 * Tree views for the Capix LLM sidebar:
 * 1. My Deploys — running/stopped/provisioning LLM instances with lifecycle controls
 * 2. Model Catalog — browseable catalog with deploy action
 * 3. Ready Now (Hosted) — always-on Capix-hosted endpoints
 */

import * as vscode from "vscode";
import { CapixClient } from "./apiClient";
import { logger } from "./logger";
import type { CatalogModel, LlmDeploy } from "./types";

// ── Tree item type enums ──────────────────────────────────────────────────
type DeployState = "running" | "stopped" | "loading" | "unknown" | "destroyed";

// ── My Deploys tree ───────────────────────────────────────────────────────
export class DeploysTreeProvider implements vscode.TreeDataProvider<DeployItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  public deploys: Array<{ instanceId: number; modelLabel: string; state: DeployState; endpoint: string | null; ready: boolean; gpu: string; location: string; pricePerHr: number; apiKey: string | null; instanceRecordId: string }> = [];

  constructor(private client: CapixClient) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  async load(): Promise<void> {
    try {
      const res = await this.client.listDeploys();
      if (!res.ok) { this.deploys = []; this.refresh(); return; }
      this.deploys = (res.deploys
        .filter((d) => d.live)
        .map((d) => {
          const live = d.live!;
          const state: DeployState =
            live.ready ? "running" :
            live.state === "running" ? "loading" :
            live.state === "stopped" ? "stopped" :
            "unknown";
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
            instanceRecordId: `llm-${live.instanceId}`,
          };
        }) as { instanceId: number; modelLabel: string; state: DeployState; endpoint: string | null; ready: boolean; gpu: string; location: string; pricePerHr: number; apiKey: string | null; instanceRecordId: string }[])
        .concat(
          (res.deploys
            .filter((d) => !d.live)
            .map((d) => {
              const inst = d.instance as { id?: string; tier?: string; status?: string };
              return {
                instanceId: 0,
                modelLabel: inst.tier?.replace(/^LLM · /, "") || "Unknown",
                state: "destroyed" as DeployState,
                endpoint: null,
                ready: false,
                gpu: "",
                location: "",
                pricePerHr: 0,
                apiKey: null,
                instanceRecordId: inst.id || "",
              };
            }) as { instanceId: number; modelLabel: string; state: DeployState; endpoint: string | null; ready: boolean; gpu: string; location: string; pricePerHr: number; apiKey: string | null; instanceRecordId: string }[])
        );
      this.refresh();
    } catch (err) {
      const status=(err as {status?:number}).status;
      if(status===401) logger.info("Deploys are waiting for a refreshed Capix session");
      else if(status===503) logger.info("Deploys are temporarily unavailable");
      else logger.error("DeploysTreeProvider.load failed", { error: String(err) });
      this.deploys = [];
      this.refresh();
    }
  }

  getTreeItem(element: DeployItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<DeployItem[]> {
    if (!await this.client.checkConfigured()) {
      return [new DeployItem("Connect wallet to view deploys", "capix-info", vscode.TreeItemCollapsibleState.None, {
        command: "capix.connectWallet",
        title: "Connect",
      })];
    }
    if (this.deploys.length === 0) {
      return [new DeployItem("No deploys yet — deploy a model below", "capix-info", vscode.TreeItemCollapsibleState.None)];
    }
    return this.deploys.map((d) => {
      const icon = d.state === "running" ? "$(check)" : d.state === "loading" ? "$(loading~spin)" : d.state === "stopped" ? "$(debug-stop)" : d.state === "destroyed" ? "$(trash)" : "$(circle)";
      const ctxValue = d.state === "running" ? "capix-deploy-running" : d.state === "stopped" ? "capix-deploy-stopped" : d.state === "destroyed" ? "capix-deploy-destroyed" : "capix-deploy";
      const label = `${d.modelLabel} · ${d.state === "loading" ? "provisioning" : d.state}`;
      const desc = d.ready && d.endpoint ? `${d.gpu} · ${d.location} · $${d.pricePerHr.toFixed(2)}/hr` : d.gpu ? `${d.gpu} · ${d.location}` : "";
      const item = new DeployItem(label, ctxValue, vscode.TreeItemCollapsibleState.None);
      item.description = desc;
      item.iconPath = new vscode.ThemeIcon(icon);
      item.tooltip = d.ready ? `Endpoint: ${d.endpoint}/v1\nEndpoint ready — copy the base URL + API key to start using it.` : d.state === "loading" ? `Provisioning on ${d.gpu} in ${d.location}\nModel download takes 2–10 min.` : `${d.state} deploy`;
      item.contextValue = ctxValue;
      (item as DeployItem & { _deploy?: typeof d })._deploy = d;
      return item;
    });
  }
}

// ── Model Catalog tree ────────────────────────────────────────────────────
export class CatalogTreeProvider implements vscode.TreeDataProvider<CatalogItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private models: CatalogModel[] = [];
  private loaded = false;

  constructor(private client: CapixClient) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  async load(): Promise<void> {
    try {
      const res = await this.client.getCatalog();
      if (res.ok) {
        this.models = res.models || [];
      }
    } catch (err) {
      logger.error("CatalogTreeProvider.load failed", { error: String(err) });
    }
    this.loaded = true;
    this.refresh();
  }

  getTreeItem(element: CatalogItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: CatalogItem): Promise<CatalogItem[]> {
    if (!await this.client.checkConfigured()) {
      return [new CatalogItem("Connect wallet to browse catalog", "capix-info", vscode.TreeItemCollapsibleState.None, {
        command: "capix.connectWallet",
        title: "Connect",
      })];
    }

    // Top-level: show featured (SuperGemma) + community categories
    if (!element) {
      if (!this.loaded) await this.load();
      if (this.models.length === 0) {
        return [new CatalogItem("Loading catalog…", "capix-info", vscode.TreeItemCollapsibleState.None)];
      }
      const featured = this.models.filter((m) => m.featured || m.partner === "supergemma");
      const community = this.models.filter((m) => !m.featured && m.partner !== "supergemma");
      const items: CatalogItem[] = [];
      if (featured.length > 0) {
        const cat = new CatalogItem("SuperGemma × Capix (featured)", "capix-category", vscode.TreeItemCollapsibleState.Expanded);
        (cat as CatalogItem & { _models?: CatalogModel[] })._models = featured;
        cat.iconPath = new vscode.ThemeIcon("$(star)");
        items.push(cat);
      }
      if (community.length > 0) {
        const cat = new CatalogItem("Community models", "capix-category", vscode.TreeItemCollapsibleState.Expanded);
        (cat as CatalogItem & { _models?: CatalogModel[] })._models = community;
        cat.iconPath = new vscode.ThemeIcon("$(library)");
        items.push(cat);
      }
      return items;
    }

    // Category expanded: show its models
    const models = (element as CatalogItem & { _models?: CatalogModel[] })._models;
    if (models) {
      return models.map((m) => {
        const item = new CatalogItem(m.label, "capix-model", vscode.TreeItemCollapsibleState.None, {
          command: "capix.deployModel",
          title: "Deploy",
          arguments: [m],
        });
        item.description = `${m.paramB}B · ${m.minVramGb}GB VRAM`;
        item.iconPath = new vscode.ThemeIcon(m.partner === "supergemma" ? "$(star)" : "$(symbol-method)");
        item.tooltip = `${m.tagline}\n${m.description}\n\nClick to deploy.`;
        (item as CatalogItem & { _model?: CatalogModel })._model = m;
        return item;
      });
    }
    return [];
  }
}

// ── Hosted endpoints tree ─────────────────────────────────────────────────
export class HostedTreeProvider implements vscode.TreeDataProvider<CatalogItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private hosted: { modelId: string; modelLabel: string; region: string; healthy: boolean; isSuperGemma: boolean }[] = [];

  constructor(private client: CapixClient) {}

  refresh(): void { this._onDidChange.fire(); }

  async load(): Promise<void> {
    try {
      const res = await this.client.getHosted();
      if (res.ok) {
        this.hosted = (res.endpoints || []).map((e) => ({
          modelId: e.modelId, modelLabel: e.modelLabel, region: e.region,
          healthy: e.healthy, isSuperGemma: e.isSuperGemma,
        }));
      } else {
        this.hosted = [];
      }
    } catch (err) { logger.error("HostedTreeProvider.load failed", { error: String(err) }); this.hosted = []; }
    this.refresh();
  }

  getTreeItem(element: CatalogItem): vscode.TreeItem { return element; }

  async getChildren(): Promise<CatalogItem[]> {
    if (this.hosted.length === 0) {
      return [new CatalogItem("No hosted endpoints live — deploy your own below", "capix-info", vscode.TreeItemCollapsibleState.None)];
    }
    return this.hosted.map((e) => {
      const item = new CatalogItem(e.modelLabel, "capix-hosted", vscode.TreeItemCollapsibleState.None, {
        command: "capix.copyApiKey",
        title: "Reveal key",
        arguments: [e.modelId],
      });
      item.description = `${e.region} · ready now`;
      item.iconPath = new vscode.ThemeIcon("$(pulse)");
      item.tooltip = `Capix-hosted — ready to use immediately.\nClick to reveal the API key.`;
      return item;
    });
  }
}

// ── Tree item subclasses ──────────────────────────────────────────────────
export class DeployItem extends vscode.TreeItem {
  constructor(label: string, contextValue: string, collapsible: vscode.TreeItemCollapsibleState, command?: vscode.Command) {
    super(label, collapsible);
    this.contextValue = contextValue;
    if (command) this.command = command;
  }
}

export class CatalogItem extends vscode.TreeItem {
  constructor(label: string, contextValue: string, collapsible: vscode.TreeItemCollapsibleState, command?: vscode.Command) {
    super(label, collapsible);
    this.contextValue = contextValue;
    if (command) this.command = command;
  }
}
