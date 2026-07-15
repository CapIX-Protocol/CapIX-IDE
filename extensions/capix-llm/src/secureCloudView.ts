/**
 * Secure Cloud tree view — confidential deployments, attestation status,
 * proof receipts, and TEE tier display for the current Capix account.
 *
 * Confidential deployments (VM/GPU inside a Trusted Execution Environment)
 * expand to show their TEE tier, attestation status, TCB version, and
 * evidence hash. Proof receipts from zkVM provers are listed in a separate
 * category. All data is read-only from the /api/v1/secure/* and
 * /api/v1/proofs routes.
 */

import * as vscode from "vscode";
import { CapixClient } from "./apiClient";
import { logger } from "./logger";

// ── Secure Cloud resource shapes ───────────────────────────────────────────
interface ConfidentialDeployment {
  id: string; workload: string; teeTier: string; attestationStatus: string;
  region: string; costUsdPerHour: number; startedAt: string;
}

interface TeeDetail {
  teeTier: string; evidenceHash: string; attestationStatus: string;
  verificationTime: string; tcbVersion: string; certificateChain: string;
}

interface ProofReceipt {
  id: string; provingSystem: string; circuitId: string; claim: string;
  verified: boolean; producer: string; createdAt: string;
}

// ── Discriminated tree item ────────────────────────────────────────────────
type SecureNodeKind =
  | "category-deployments" | "category-proofs"
  | "deployment" | "detail"
  | "proof" | "info";

class SecureItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly kind: SecureNodeKind,
    collapsible: vscode.TreeItemCollapsibleState,
    command?: vscode.Command,
  ) {
    super(label, collapsible);
    this.contextValue = `capix-${kind}`;
    if (command) this.command = command;
  }

  static info(label: string): SecureItem {
    const item = new SecureItem(label, "info", vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon("$(info)");
    return item;
  }
}

// ── Provider ───────────────────────────────────────────────────────────────
export class SecureCloudTreeProvider implements vscode.TreeDataProvider<SecureItem> {
  private _onDidChange = new vscode.EventEmitter<SecureItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private deployments: ConfidentialDeployment[] = [];
  private proofs: ProofReceipt[] = [];
  private loading: Promise<void> | null = null;

  /** Cached TEE detail keyed by deployment id. */
  private teeDetails = new Map<string, TeeDetail>();

  constructor(private client: CapixClient) {}

  refresh(): void { this._onDidChange.fire(undefined); }

  async load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const configured = await this.client.checkConfigured();
        if (!configured) { this.clear(); return; }
        const [deploysRes, proofsRes] = await Promise.allSettled([
          this.client.get<{ ok: boolean; deployments?: ConfidentialDeployment[] }>("/api/v1/secure/deployments"),
          this.client.get<{ ok: boolean; proofs?: ProofReceipt[] }>("/api/v1/proofs"),
        ]);
        this.deployments = deploysRes.status === "fulfilled" ? (deploysRes.value.deployments || []) : [];
        this.proofs = proofsRes.status === "fulfilled" ? (proofsRes.value.proofs || []) : [];
        this.teeDetails.clear();
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 401) logger.info("Secure Cloud resources are waiting for a refreshed Capix session");
        else if (status === 503) logger.info("Secure Cloud resources are temporarily unavailable");
        else logger.error("SecureCloudTreeProvider.load failed", { error: String(err) });
        this.clear();
      }
      this.refresh();
    })().finally(() => { this.loading = null; });
    return this.loading;
  }

  private clear(): void {
    this.deployments = [];
    this.proofs = [];
    this.teeDetails.clear();
  }

  getTreeItem(element: SecureItem): vscode.TreeItem { return element; }

  async getChildren(element?: SecureItem): Promise<SecureItem[]> {
    if (!await this.client.checkConfigured()) {
      return [SecureItem.info("Connect wallet to view Secure Cloud resources")];
    }

    // Top-level categories
    if (!element) {
      const items: SecureItem[] = [];
      items.push(this.category("Confidential Deployments", "category-deployments", this.deployments.length, "$(shield)"));
      items.push(this.category("Proof Receipts", "category-proofs", this.proofs.length, "$(verified)"));
      return items;
    }

    switch (element.kind) {
      case "category-deployments": return this.deploymentRows();
      case "category-proofs": return this.proofRows();
      case "deployment": {
        const id = (element as SecureItem & { _deploymentId?: string })._deploymentId;
        if (!id) return [];
        return this.deploymentDetailRows(id);
      }
    }
    return [];
  }

  private category(label: string, kind: SecureNodeKind, count: number, icon: string): SecureItem {
    const item = new SecureItem(label, kind, vscode.TreeItemCollapsibleState.Expanded);
    item.description = String(count);
    item.iconPath = new vscode.ThemeIcon(icon);
    return item;
  }

  private deploymentRows(): SecureItem[] {
    if (this.deployments.length === 0) {
      return [SecureItem.info("No confidential deployments — deploy with /capix secure deploy")];
    }
    return this.deployments.map((d) => {
      const label = `${d.workload} · ${d.teeTier}`;
      const item = new SecureItem(label, "deployment", vscode.TreeItemCollapsibleState.Collapsed);
      const attestation = d.attestationStatus === "verified" ? "verified ✓" : d.attestationStatus === "failed" ? "failed ✗" : d.attestationStatus;
      item.description = `${attestation} · ${d.region} · $${d.costUsdPerHour.toFixed(2)}/hr`;
      const icon = d.attestationStatus === "verified" ? "$(shield)" : d.attestationStatus === "failed" ? "$(error)" : "$(loading~spin)";
      item.iconPath = new vscode.ThemeIcon(icon);
      item.tooltip = `${d.workload}\nTEE tier: ${d.teeTier}\nAttestation: ${attestation}\nRegion: ${d.region}\nCost: $${d.costUsdPerHour.toFixed(2)}/hr\nStarted: ${new Date(d.startedAt).toLocaleString()}`;
      (item as SecureItem & { _deploymentId?: string })._deploymentId = d.id;
      return item;
    });
  }

  private async deploymentDetailRows(deploymentId: string): Promise<SecureItem[]> {
    let detail = this.teeDetails.get(deploymentId);
    if (!detail) {
      try {
        const res = await this.client.get<{ ok: boolean; tee?: TeeDetail }>(`/api/v1/secure/deployments/${encodeURIComponent(deploymentId)}/tee`);
        detail = res.tee;
        if (!detail) return [SecureItem.info("No TEE status available — the workload may not be running yet.")];
        this.teeDetails.set(deploymentId, detail);
      } catch (err) {
        logger.error("SecureCloudTreeProvider.deploymentDetailRows failed", { error: String(err), deploymentId });
        return [SecureItem.info("Failed to load TEE status")];
      }
    }

    const items: SecureItem[] = [];
    items.push(this.detailRow("TEE Tier", detail.teeTier, "$(shield)"));
    const attestationLabel = detail.attestationStatus === "verified" ? "verified ✓" : detail.attestationStatus === "failed" ? "failed ✗" : detail.attestationStatus;
    items.push(this.detailRow("Attestation", attestationLabel, detail.attestationStatus === "verified" ? "$(check)" : "$(error)"));
    items.push(this.detailRow("TCB Version", detail.tcbVersion, "$(versions)"));
    items.push(this.detailRow("Evidence Hash", detail.evidenceHash, "$(fingerprint)"));
    items.push(this.detailRow("Verification Time", detail.verificationTime, "$(history)"));
    items.push(this.detailRow("Cert Chain", detail.certificateChain, "$(link)"));
    return items;
  }

  private proofRows(): SecureItem[] {
    if (this.proofs.length === 0) {
      return [SecureItem.info("No proof receipts — proofs are produced by confidential workloads")];
    }
    return this.proofs.map((p) => {
      const item = new SecureItem(p.circuitId, "proof", vscode.TreeItemCollapsibleState.None, {
        command: "capix.openInstance", title: "Inspect", arguments: [p.id],
      });
      item.description = `${p.provingSystem} · ${p.verified ? "verified ✓" : "unverified"} · ${new Date(p.createdAt).toLocaleDateString()}`;
      item.iconPath = new vscode.ThemeIcon(p.verified ? "$(verified)" : "$(question)");
      item.tooltip = `Proof: ${p.id}\nSystem: ${p.provingSystem}\nCircuit: ${p.circuitId}\nClaim: ${p.claim}\nVerified: ${p.verified ? "yes" : "no"}\nProducer: ${p.producer}\nCreated: ${new Date(p.createdAt).toLocaleString()}`;
      return item;
    });
  }

  private detailRow(label: string, value: string, icon: string): SecureItem {
    const item = new SecureItem(label, "detail", vscode.TreeItemCollapsibleState.None);
    item.description = value;
    item.iconPath = new vscode.ThemeIcon(icon);
    item.tooltip = `${label}: ${value}`;
    return item;
  }
}
