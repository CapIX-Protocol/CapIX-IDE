/**
 * ModelSync — cross-product model synchronization.
 *
 * Aggregates the full model surface (the Capix Auto router, hosted featured
 * endpoints, the public catalog, and the user's private deploys) into a single
 * cached list. Auto-refreshes every 60s so private models provisioned on the
 * web chat, Capix Code, or the MCP server appear in the IDE picker without a
 * manual reload. Emits an event whenever the list materially changes so
 * pickers and status bars can re-render.
 *
 * Design tokens (@capix/ui-tokens): dark foundation #0a0e14, cyan #3DCED6.
 */

import * as vscode from "vscode";
import { CapixClient } from "./apiClient";
import { logger } from "./logger";

export interface ModelEntry {
  id: string;
  name: string;
  provider: "capix" | "community" | "private";
  parameters?: string; // "27B", "7B", etc.
  contextWindow?: number;
  costPer1kTokens?: number;
  isPrivate: boolean;
  status: "ready" | "provisioning" | "failed";
  endpoint?: string;
  owner?: string;
  /** Hourly cost (private deploys). Used by the picker for "$/hr" labels. */
  pricePerHour?: number;
  /** Short tagline for display. */
  description?: string;
  /** The gateway model identifier to persist/send (falls back to `id`). */
  modelRef?: string;
}

export type ModelStatus = ModelEntry["status"];

type ModelsChangedHandler = (models: ModelEntry[]) => void;

const ACTIVE_STATES = new Set(["running", "active", "ready", "healthy", "live"]);
const PROVISIONING_STATES = new Set([
  "pending",
  "provisioning",
  "loading",
  "starting",
  "creating",
  "queued",
  "active",
  "loading",
]);
const FAILED_STATES = new Set([
  "terminated",
  "deleted",
  "destroyed",
  "failed",
  "cancelled",
  "stopped",
]);

function deploymentStateToStatus(state: string | undefined): ModelStatus {
  const s = (state || "").toLowerCase();
  if (ACTIVE_STATES.has(s)) return "ready";
  if (PROVISIONING_STATES.has(s)) return "provisioning";
  if (FAILED_STATES.has(s)) return "failed";
  return "provisioning";
}

export class ModelSync {
  private models: ModelEntry[] = [];
  private refreshTimer: NodeJS.Timeout | null = null;
  private readonly handlers = new Set<ModelsChangedHandler>();
  private refreshing = false;
  private static readonly REFRESH_INTERVAL_MS = 60_000;

  constructor(private client: CapixClient) {}

  /** Fetch all available models (public + private) and update the cache. */
  async refresh(): Promise<ModelEntry[]> {
    if (this.refreshing) return this.models;
    this.refreshing = true;
    try {
      const configured = await this.client.checkConfigured();
      const next: ModelEntry[] = [];

      // 1. The always-on Capix Auto router — recommended default.
      next.push({
        id: "capix/auto",
        name: "Capix Auto",
        provider: "capix",
        isPrivate: false,
        status: "ready",
        modelRef: "auto",
        description: "Dynamic routing — picks the best model per task.",
      });

      if (configured) {
        const [catalogRes, hostedRes, deploysRes] = await Promise.all([
          this.client
            .getCatalog()
            .catch((err: unknown) => {
              logger.warn("ModelSync.getCatalog failed", { error: String(err) });
              return null;
            }),
          this.client
            .getHosted()
            .catch((err: unknown) => {
              logger.warn("ModelSync.getHosted failed", { error: String(err) });
              return null;
            }),
          this.client
            .listDeploys()
            .catch((err: unknown) => {
              logger.warn("ModelSync.listDeploys failed", { error: String(err) });
              return null;
            }),
        ]);

        const catalog = catalogRes?.ok ? catalogRes.models : [];
        const catalogById = new Map(catalog.map((m) => [m.id, m]));

        // 2. Hosted (featured) endpoints — ready-now Capix models.
        const hostedEndpoints = hostedRes?.ok ? hostedRes.endpoints : [];
        for (const ep of hostedEndpoints) {
          const matched = catalogById.get(ep.modelId);
          next.push({
            id: `capix/hosted/${ep.modelId}`,
            name: ep.modelLabel || ep.modelId,
            provider: "capix",
            parameters: matched ? `${matched.paramB}B` : undefined,
            contextWindow: matched?.maxModelLen,
            isPrivate: false,
            status: ep.healthy ? "ready" : "provisioning",
            endpoint: ep.baseUrl,
            modelRef: ep.modelId,
            description: ep.isSuperGemma
              ? "Supergemma — Capix-tuned flagship."
              : matched?.tagline,
          });
        }

        // 3. Catalog (community) models not already covered by a hosted endpoint.
        const hostedIds = new Set(hostedEndpoints.map((e) => e.modelId));
        for (const m of catalog) {
          if (hostedIds.has(m.id)) continue;
          next.push({
            id: m.id,
            name: m.label,
            provider: m.partner || m.featured ? "capix" : "community",
            parameters: `${m.paramB}B`,
            contextWindow: m.maxModelLen,
            isPrivate: false,
            status: "ready",
            modelRef: m.id,
            description: m.tagline,
          });
        }

        // 4. Private (user-deployed) models from the GPU sagas / live deploys.
        if (deploysRes?.ok) {
          for (const deploy of deploysRes.deploys || []) {
            const live = deploy.live;
            const instance = deploy.instance as
              | { id?: string; tier?: string; status?: string; expiresAt?: string }
              | undefined;
            const state = live?.state || instance?.status;
            const label =
              live?.modelLabel || instance?.tier || "Private model";
            // Skip destroyed deploys — they're not selectable.
            if (FAILED_STATES.has((state || "").toLowerCase())) continue;
            const ref =
              live?.instanceId != null
                ? `capix/private/${live.instanceId}`
                : `capix/private/${instance?.id || label}`;
            next.push({
              id: ref,
              name: label,
              provider: "private",
              isPrivate: true,
              status: deploymentStateToStatus(state),
              endpoint: live?.endpoint || undefined,
              pricePerHour: live?.pricePerHr || undefined,
              owner: "you",
              modelRef: live?.modelLabel || label,
            });
          }
        }
      }

      const changed = !this.sameModels(this.models, next);
      this.models = next;
      if (changed) this.emit();
      return next;
    } catch (err) {
      logger.error("ModelSync.refresh failed", { error: String(err) });
      return this.models;
    } finally {
      this.refreshing = false;
    }
  }

  /** Get the current model list (cached). */
  getModels(): ModelEntry[] {
    return this.models;
  }

  /** Get a model by ID. */
  getModel(id: string): ModelEntry | undefined {
    return this.models.find((m) => m.id === id);
  }

  /** Resolve a persisted gateway model ref to a display name. */
  resolveName(modelRef: string): string {
    const entry = this.models.find((m) => (m.modelRef ?? m.id) === modelRef);
    return entry?.name ?? modelRef;
  }

  /** Check if a (typically private) model is ready. */
  async checkModelStatus(id: string): Promise<ModelStatus> {
    const entry = this.getModel(id);
    if (!entry) return "failed";
    if (!entry.isPrivate) return entry.status;
    try {
      const deploysRes = await this.client.listDeploys();
      if (!deploysRes.ok) return entry.status;
      const match = deploysRes.deploys.find((d) => {
        const live = d.live;
        const instance = d.instance as { id?: string } | undefined;
        const ref =
          live?.instanceId != null
            ? `capix/private/${live.instanceId}`
            : `capix/private/${instance?.id || live?.modelLabel}`;
        return ref === id;
      });
      if (!match) return entry.status;
      const instance = match.instance as { status?: string } | undefined;
      return deploymentStateToStatus(match.live?.state || instance?.status);
    } catch (err) {
      logger.warn("ModelSync.checkModelStatus failed", { error: String(err) });
      return entry.status;
    }
  }

  /** Start auto-refresh (every 60s). */
  startAutoRefresh(): void {
    if (this.refreshTimer) return;
    this.refresh().catch((err) =>
      logger.warn("ModelSync initial refresh failed", { error: String(err) }),
    );
    this.refreshTimer = setInterval(() => {
      this.refresh().catch((err) =>
        logger.warn("ModelSync auto-refresh failed", { error: String(err) }),
      );
    }, ModelSync.REFRESH_INTERVAL_MS);
  }

  /** Stop auto-refresh. */
  stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /** Emit an event when models change. */
  onModelsChanged(handler: ModelsChangedHandler): vscode.Disposable {
    this.handlers.add(handler);
    return new vscode.Disposable(() => {
      this.handlers.delete(handler);
    });
  }

  private emit(): void {
    const snapshot = this.models;
    for (const handler of this.handlers) {
      try {
        handler(snapshot);
      } catch (err) {
        logger.warn("ModelSync handler threw", { error: String(err) });
      }
    }
  }

  private sameModels(a: ModelEntry[], b: ModelEntry[]): boolean {
    if (a.length !== b.length) return false;
    const key = (m: ModelEntry) => `${m.id}|${m.status}|${m.endpoint ?? ""}`;
    const ak = a.map(key).sort().join(";");
    const bk = b.map(key).sort().join(";");
    return ak === bk;
  }
}
