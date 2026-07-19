/**
 * Capix Infra Stack Service — the IDE's live view over the whole Capix
 * infrastructure stack.
 *
 * One broker-backed surface for everything the assistant (and the infra
 * panel) needs to know about a customer's footprint:
 *
 *   - Real-time deployment status and health, normalized from the canonical
 *     owner-scoped `/api/v1/deployments` inventory, with a polling watcher
 *     that emits change events for the panel and the agent runtime.
 *   - Log streaming from any deployment (incremental poll over the cloud
 *     logs route; only new lines are emitted).
 *   - SSH terminal integration through {@link TerminalManager} — credentials
 *     come from the OS credential store via `getStoredSshCredential`, host
 *     keys stay pinned by the terminal manager's TOFU policy.
 *   - Port forwarding / tunneling (`ssh -L … -N`) tracked as first-class
 *     sessions that can be listed and closed.
 *   - Resource scaling and lifecycle actions (scale / start / stop /
 *     destroy) against the control plane.
 *   - Marketplace, earnings and cost data for the dashboard and architect
 *     mode — all integer minor units end to end.
 *
 * Auth: every call goes through {@link CapixClient}, which delegates token
 * reads/refreshes to the shared `@capix/auth-broker` — the same identity as
 * every other Capix app. No credentials are ever handled here directly.
 */

import type { CapixClient } from "./apiClient";
import type { CatalogModel, GpuOffer } from "./types";
import { dollarsToMicro, microToDisplay } from "./moneyUtils";
import { logger } from "./logger";

// ── Types ───────────────────────────────────────────────────────────────────

export type DeploymentHealth = "healthy" | "degraded" | "unhealthy" | "unknown";

export interface DeploymentNodeStatus {
  nodeId: string;
  location: string;
  gpu: string | null;
  agentOnline: boolean;
  sshAvailable: boolean;
}

export interface InfraDeployment {
  id: string;
  name: string;
  status: string;
  health: DeploymentHealth;
  startedAt: string;
  costUsdPerHour: number;
  nodes: DeploymentNodeStatus[];
}

export interface DeploymentStatusEvent {
  deploymentId: string;
  name: string;
  previous: string;
  current: string;
  health: DeploymentHealth;
  at: string;
}

export type LogStreamEvent =
  | { type: "append"; deploymentId: string; lines: string[] }
  | { type: "error"; deploymentId: string; message: string }
  | { type: "end"; deploymentId: string };

export interface PortForwardSession {
  id: string;
  deploymentId: string;
  localPort: number;
  remotePort: number;
  active: boolean;
}

export interface MarketplaceListing {
  askId: number;
  gpu: string;
  numGpus: number;
  vramGb: number;
  pricePerHr: number;
  location: string;
  reliability: number;
}

export interface EarningsOverview {
  devTokenBalance: number;
  devTokenTotalEarned: number;
  walletUsd: string;
  totalSpentUsd: string;
  activeInstances: number;
}

export interface CostEntry {
  id: string;
  name: string;
  status: string;
  costUsdPerHour: number;
  startedAt: string;
}

export interface CostOverview {
  balanceUsd: string;
  totalSpentUsd: string;
  hourlyBurnMicro: number;
  entries: CostEntry[];
}

export interface InfraStackOptions {
  /** Watcher poll interval (default 15s). */
  statusPollMs?: number;
  /** Log stream poll interval (default 2s). */
  logPollMs?: number;
}

/** Minimal terminal handle the service needs for tunnel lifecycle. */
interface DisposableTerminal {
  dispose(): void;
}

/** Terminal surface this service relies on (satisfied by TerminalManager). */
export interface InfraTerminalAdapter {
  openSshSession(target: {
    host: string;
    port: number;
    label: string;
    privateKey?: string;
  }): Promise<void>;
  openPortForward(
    target: { host: string; port: number; label: string; privateKey?: string },
    localPort: number,
    remotePort: number,
  ): Promise<DisposableTerminal>;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Health rollup from the deployment phase plus per-node agent liveness. */
export function computeDeploymentHealth(
  status: string,
  nodes: Array<{ agentOnline: boolean }>,
): DeploymentHealth {
  const phase = status.toLowerCase();
  if (["failed", "error", "unhealthy"].includes(phase)) return "unhealthy";
  if (!["running", "active"].includes(phase)) return "unknown";
  if (nodes.length === 0) return "unknown";
  return nodes.every((node) => node.agentOnline) ? "healthy" : "degraded";
}

/** Normalize one cloud-logs entry (string or structured row) to a line. */
export function normalizeLogLine(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    const row = entry as { message?: unknown; line?: unknown; ts?: unknown; timestamp?: unknown };
    const text = typeof row.message === "string" ? row.message
      : typeof row.line === "string" ? row.line
      : JSON.stringify(entry);
    const ts = typeof row.ts === "string" ? row.ts
      : typeof row.timestamp === "string" ? row.timestamp
      : "";
    return ts ? `${ts} ${text}` : text;
  }
  return String(entry);
}

function validatePort(port: number, name: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ── Service ─────────────────────────────────────────────────────────────────

export class InfraStackService {
  private readonly client: CapixClient;
  private readonly terminals?: InfraTerminalAdapter;
  private readonly statusPollMs: number;
  private readonly logPollMs: number;

  private readonly statusListeners = new Set<(event: DeploymentStatusEvent) => void>();
  private readonly lastStatuses = new Map<string, string>();
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private readonly portForwards = new Map<string, { session: PortForwardSession; terminal: DisposableTerminal }>();
  private forwardSeq = 0;

  constructor(client: CapixClient, terminals?: InfraTerminalAdapter, options: InfraStackOptions = {}) {
    this.client = client;
    this.terminals = terminals;
    this.statusPollMs = options.statusPollMs ?? 15_000;
    this.logPollMs = options.logPollMs ?? 2_000;
  }

  // ── Status + health ─────────────────────────────────────────────────────

  /** Live deployment inventory with normalized health. */
  async listDeployments(): Promise<InfraDeployment[]> {
    const { instances } = await this.client.listInstances();
    return instances.map((instance) => ({
      id: instance.id,
      name: instance.tier,
      status: instance.status,
      health: computeDeploymentHealth(instance.status, instance.nodes),
      startedAt: instance.startedAt,
      costUsdPerHour: instance.costUsdPerHour,
      nodes: instance.nodes.map((node) => ({
        nodeId: node.nodeId,
        location: node.location,
        gpu: node.gpu,
        agentOnline: node.agentOnline,
        sshAvailable: node.sshAvailable === true || Boolean(node.sshHost),
      })),
    }));
  }

  /** Status of a single deployment. Throws when the id is unknown. */
  async getDeploymentStatus(deploymentId: string): Promise<InfraDeployment> {
    const deployments = await this.listDeployments();
    const match = deployments.find((deployment) => deployment.id === deploymentId);
    if (!match) throw new Error(`Unknown deployment: ${deploymentId}`);
    return match;
  }

  /** Subscribe to deployment status changes; returns an unsubscribe fn. */
  onDidChangeStatus(handler: (event: DeploymentStatusEvent) => void): () => void {
    this.statusListeners.add(handler);
    return () => {
      this.statusListeners.delete(handler);
    };
  }

  /**
   * Start polling the inventory and emitting change events. Returns a stop
   * handle; starting again replaces the previous watcher.
   */
  startWatching(): () => void {
    this.stopWatching();
    const tick = async () => {
      try {
        const deployments = await this.listDeployments();
        const seen = new Set<string>();
        for (const deployment of deployments) {
          seen.add(deployment.id);
          const previous = this.lastStatuses.get(deployment.id);
          if (previous !== undefined && previous !== deployment.status) {
            const event: DeploymentStatusEvent = {
              deploymentId: deployment.id,
              name: deployment.name,
              previous,
              current: deployment.status,
              health: deployment.health,
              at: new Date().toISOString(),
            };
            for (const listener of this.statusListeners) listener(event);
          }
          this.lastStatuses.set(deployment.id, deployment.status);
        }
        for (const id of [...this.lastStatuses.keys()]) {
          if (!seen.has(id)) this.lastStatuses.delete(id);
        }
      } catch (err) {
        logger.warn("infra status poll failed", { error: String(err) });
      }
    };
    void tick();
    this.watchTimer = setInterval(() => void tick(), this.statusPollMs);
    this.watchTimer.unref?.();
    return () => this.stopWatching();
  }

  stopWatching(): void {
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
  }

  // ── Logs ────────────────────────────────────────────────────────────────

  /** One-shot log fetch, tail-limited, for tools and the log viewer. */
  async fetchLogs(deploymentId: string, tailLines = 200): Promise<string[]> {
    const result = await this.client.getPodLogs(deploymentId);
    const lines = (result.logs ?? []).map(normalizeLogLine);
    return lines.slice(-Math.max(1, tailLines));
  }

  /**
   * Stream logs from a deployment until `signal` aborts. Only lines not seen
   * in earlier polls are emitted, so consumers can append blindly.
   */
  async streamLogs(
    deploymentId: string,
    onEvent: (event: LogStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    let seen = 0;
    while (!signal?.aborted) {
      try {
        const result = await this.client.getPodLogs(deploymentId);
        const lines = (result.logs ?? []).map(normalizeLogLine);
        if (lines.length > seen) {
          onEvent({ type: "append", deploymentId, lines: lines.slice(seen) });
          seen = lines.length;
        }
      } catch (err) {
        onEvent({
          type: "error",
          deploymentId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      await delay(this.logPollMs, signal);
    }
    onEvent({ type: "end", deploymentId });
  }

  // ── SSH + tunnels ───────────────────────────────────────────────────────

  /** Open (or focus) an SSH terminal on a deployment's node. */
  async openSshTerminal(deploymentId: string): Promise<void> {
    if (!this.terminals) throw new Error("SSH terminal integration is unavailable");
    const credential = await this.client.getStoredSshCredential(deploymentId);
    await this.terminals.openSshSession({
      host: credential.host,
      port: credential.port,
      label: deploymentId,
      privateKey: credential.privateKey,
    });
  }

  /**
   * Open a local port-forward tunnel (`ssh -L local:localhost:remote -N`)
   * into a deployment and track it as a closeable session.
   */
  async openPortForward(
    deploymentId: string,
    remotePort: number,
    localPort = remotePort,
  ): Promise<PortForwardSession> {
    if (!this.terminals) throw new Error("SSH terminal integration is unavailable");
    validatePort(remotePort, "remotePort");
    validatePort(localPort, "localPort");
    const credential = await this.client.getStoredSshCredential(deploymentId);
    const terminal = await this.terminals.openPortForward(
      {
        host: credential.host,
        port: credential.port,
        label: deploymentId,
        privateKey: credential.privateKey,
      },
      localPort,
      remotePort,
    );
    const session: PortForwardSession = {
      id: `pf-${Date.now()}-${++this.forwardSeq}`,
      deploymentId,
      localPort,
      remotePort,
      active: true,
    };
    this.portForwards.set(session.id, { session, terminal });
    return { ...session };
  }

  listPortForwards(): PortForwardSession[] {
    return [...this.portForwards.values()].map((entry) => ({ ...entry.session }));
  }

  /** Tear down a tunnel. Returns false when the id is unknown. */
  closePortForward(id: string): boolean {
    const entry = this.portForwards.get(id);
    if (!entry || !entry.session.active) return false;
    entry.terminal.dispose();
    entry.session.active = false;
    return true;
  }

  // ── Scaling + lifecycle ─────────────────────────────────────────────────

  /** Scale a deployment's replica count (1–16). */
  async scaleDeployment(deploymentId: string, replicas: number): Promise<void> {
    if (!Number.isInteger(replicas) || replicas < 1 || replicas > 16) {
      throw new Error("replicas must be an integer between 1 and 16");
    }
    const result = await this.client.post<{ ok: boolean; error?: string }>(
      `/api/v1/deployments/${encodeURIComponent(deploymentId)}/scale`,
      { replicas },
    );
    if (!result.ok) throw new Error(result.error || "scale_failed");
  }

  /** One-click lifecycle action (start / stop / destroy). */
  async controlDeployment(
    deploymentId: string,
    action: "start" | "stop" | "destroy",
  ): Promise<void> {
    const result = await this.client.controlInstance(deploymentId, action);
    if (!result.ok) throw new Error(result.error || `${action}_failed`);
  }

  // ── Marketplace / nodes / earnings / models ─────────────────────────────

  /** Live GPU marketplace listings, cheapest first. */
  async browseMarketplace(): Promise<MarketplaceListing[]> {
    const result = await this.client.getGpuOffers();
    const offers = (result.offers ?? []) as Array<Partial<GpuOffer>>;
    return offers
      .filter((offer) => typeof offer.askId === "number")
      .map((offer) => ({
        askId: Number(offer.askId),
        gpu: String(offer.gpu ?? "GPU"),
        numGpus: Number(offer.numGpus ?? 1),
        vramGb: Number(offer.totalVramGb ?? offer.vramGb ?? 0),
        pricePerHr: Number(offer.pricePerHr ?? 0),
        location: String(offer.location ?? "global"),
        reliability: Number(offer.reliability ?? 0),
      }))
      .sort((a, b) => a.pricePerHr - b.pricePerHr || b.reliability - a.reliability);
  }

  /** Flattened node statuses across every deployment. */
  async getNodeStatuses(): Promise<Array<DeploymentNodeStatus & { deploymentId: string; deploymentName: string }>> {
    const deployments = await this.listDeployments();
    return deployments.flatMap((deployment) =>
      deployment.nodes.map((node) => ({
        ...node,
        deploymentId: deployment.id,
        deploymentName: deployment.name,
      })),
    );
  }

  /** Wallet + dev-token earnings overview. */
  async getEarnings(): Promise<EarningsOverview> {
    const [balance, devTokens] = await Promise.all([
      this.client.getBalance(),
      this.client.getDevTokenBalance().catch(() => ({ ok: false as const, balance: 0, totalEarned: 0 })),
    ]);
    return {
      devTokenBalance: Number(devTokens.balance ?? 0),
      devTokenTotalEarned: Number(devTokens.totalEarned ?? 0),
      walletUsd: balance.balance?.usd ?? "0.00",
      totalSpentUsd: balance.totalSpent ?? "0.00",
      activeInstances: Number(balance.activeInstances ?? 0),
    };
  }

  /** Model catalog (for model_list / architect mode). */
  async listModels(): Promise<CatalogModel[]> {
    const result = await this.client.getCatalog();
    return result.models ?? [];
  }

  /** Deploy a catalog model onto a marketplace offer. */
  async deployModel(modelId: string, askId: number, durationHours: number) {
    if (!Number.isInteger(durationHours) || durationHours < 1) {
      throw new Error("durationHours must be a positive integer");
    }
    const result = await this.client.deployModel(modelId, askId, durationHours);
    if (!result.ok) throw new Error(result.error || "deploy_failed");
    return result;
  }

  /** Kick off a fine-tuning / training job on the control plane. */
  async startTrainingJob(options: {
    baseModel: string;
    datasetUrl: string;
    gpuCount?: number;
    durationHours?: number;
  }) {
    if (!options.baseModel) throw new Error("baseModel is required");
    if (!options.datasetUrl) throw new Error("datasetUrl is required");
    const result = await this.client.post<{ ok: boolean; jobId?: string; error?: string }>(
      "/api/v1/training/jobs",
      options,
    );
    if (!result.ok) throw new Error(result.error || "training_failed");
    return result;
  }

  // ── Cost tracking ───────────────────────────────────────────────────────

  /** Balance, spend and per-deployment hourly burn for the dashboard. */
  async getCostOverview(): Promise<CostOverview> {
    const [balance, deployments] = await Promise.all([
      this.client.getBalance(),
      this.listDeployments().catch(() => [] as InfraDeployment[]),
    ]);
    const entries: CostEntry[] = deployments.map((deployment) => ({
      id: deployment.id,
      name: deployment.name,
      status: deployment.status,
      costUsdPerHour: deployment.costUsdPerHour,
      startedAt: deployment.startedAt,
    }));
    const hourlyBurnMicro = entries.reduce(
      (total, entry) => total + dollarsToMicro(entry.costUsdPerHour),
      0,
    );
    return {
      balanceUsd: balance.balance?.usd ?? "0.00",
      totalSpentUsd: balance.totalSpent ?? "0.00",
      hourlyBurnMicro,
      entries,
    };
  }

  /** Display helper shared by the panel and tools. */
  formatHourlyBurn(overview: CostOverview): string {
    return `$${microToDisplay(overview.hourlyBurnMicro, 4)}/hr`;
  }

  /** Release the watcher and every open tunnel. */
  dispose(): void {
    this.stopWatching();
    for (const [, entry] of this.portForwards) {
      if (entry.session.active) entry.terminal.dispose();
      entry.session.active = false;
    }
    this.portForwards.clear();
    this.statusListeners.clear();
  }
}
