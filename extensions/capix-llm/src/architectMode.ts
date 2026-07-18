/**
 * Capix Architect Mode — infra-aware planning for the assistant.
 *
 * Before the agent writes a line of code, architect mode answers "what
 * should this run on, what will it cost, and how do we ship it?" against
 * the LIVE Capix infra stack rather than static guesses:
 *
 *   - Full infra stack awareness: the customer's running deployments are
 *     part of the plan context — architect mode reuses a suitable live
 *     deployment instead of provisioning a duplicate.
 *   - Cost estimation with real-time pricing: hourly and total estimates
 *     are computed from the marketplace offer's current `pricePerHr`, in
 *     integer micro-USD end to end (see moneyUtils).
 *   - Resource recommendation: workload kind + VRAM requirement + budget
 *     pick the cheapest reliable GPU offer that actually fits the model.
 *   - One-click deploy: the plan's deploy step is executable — the panel or
 *     the agent runtime calls `deployFromPlan` (a billing action, so the
 *     runtime's approval gate applies upstream).
 */

import type { CapixClient } from "./apiClient";
import type { InfraDeployment, InfraStackService } from "./infraStack";
import type { CatalogModel, GpuOffer } from "./types";
import { dollarsToMicro, microToDisplay } from "./moneyUtils";

// ── Types ───────────────────────────────────────────────────────────────────

export type WorkloadKind = "chat" | "coding" | "reasoning" | "vision" | "training" | "batch";

export interface ArchitectWorkload {
  kind: WorkloadKind;
  /** Hard VRAM floor; when omitted the chosen model's minimum is used. */
  minVramGb?: number;
  /** Optional budget cap used to filter offers. */
  budgetUsdPerHr?: number;
  /** Planned reservation length for cost estimation (default 1h). */
  hours?: number;
}

export interface PlanCostEstimate {
  /** Hourly rate in integer micro-USD (scale 4). */
  hourlyMicro: number;
  /** Total for the planned reservation, integer micro-USD. */
  totalMicro: number;
  hours: number;
  displayHourly: string;
  displayTotal: string;
}

export interface ArchitectPlanStep {
  id: string;
  title: string;
  detail: string;
  status: "pending" | "done";
  action?: {
    type: "deploy_model";
    modelId: string;
    askId: number;
    durationHours: number;
  };
}

export interface ArchitectPlan {
  id: string;
  goal: string;
  createdAt: string;
  /** Live deployments considered while planning (infra awareness). */
  infraContext: Array<{ id: string; name: string; status: string; health: string }>;
  /** Set when a live deployment already covers the workload. */
  reuseDeploymentId?: string;
  recommendation: {
    model: CatalogModel | null;
    offer: { askId: number; gpu: string; pricePerHr: number; location: string; reliability: number } | null;
    rationale: string;
  };
  estimate: PlanCostEstimate | null;
  steps: ArchitectPlanStep[];
}

// ── Pure helpers (unit-tested directly) ─────────────────────────────────────

/**
 * Filter offers to those that fit the VRAM floor and budget, cheapest first
 * (ties broken by reliability). Returns [] when nothing fits — callers must
 * surface that rather than silently overspending.
 */
export function recommendGpuOffers<T extends Pick<GpuOffer, "askId" | "pricePerHr" | "reliability"> & { vramGb: number }>(
  offers: T[],
  minVramGb: number,
  budgetUsdPerHr?: number,
): T[] {
  return offers
    .filter((offer) => {
      if (offer.vramGb < minVramGb) return false;
      if (budgetUsdPerHr !== undefined && offer.pricePerHr > budgetUsdPerHr) return false;
      return true;
    })
    .slice()
    .sort((a, b) => a.pricePerHr - b.pricePerHr || b.reliability - a.reliability);
}

/** Integer cost estimate: micro-USD per hour × hours. */
export function estimatePlanCostMicro(pricePerHr: number, hours: number): number {
  if (!Number.isFinite(pricePerHr) || pricePerHr < 0) return 0;
  if (!Number.isInteger(hours) || hours < 1) return 0;
  return dollarsToMicro(pricePerHr) * hours;
}

/**
 * Pick the catalog model for a workload: category match first, then
 * popular/featured, then the smallest parameter count that fits.
 */
export function pickModelForWorkload(models: CatalogModel[], kind: WorkloadKind): CatalogModel | null {
  const category = kind === "training" || kind === "batch" ? null : kind;
  const candidates = category ? models.filter((m) => m.category === category) : models.slice();
  if (candidates.length === 0) return null;
  return candidates.slice().sort((a, b) => {
    const score = (m: CatalogModel) => (m.popular ? 2 : 0) + (m.featured ? 1 : 0);
    return score(b) - score(a) || a.paramB - b.paramB;
  })[0];
}

// ── Architect mode ──────────────────────────────────────────────────────────

export class ArchitectMode {
  private readonly service: InfraStackService;
  private readonly client: CapixClient;
  private readonly plans = new Map<string, ArchitectPlan>();
  private planSeq = 0;

  constructor(client: CapixClient, service: InfraStackService) {
    this.client = client;
    this.service = service;
  }

  getPlan(id: string): ArchitectPlan | null {
    return this.plans.get(id) ?? null;
  }

  listPlans(): ArchitectPlan[] {
    return [...this.plans.values()];
  }

  /**
   * Build an infra-aware plan for a goal + workload. Reads live deployments,
   * the model catalog and marketplace offers; reuses an existing deployment
   * when one already runs a suitable model.
   */
  async buildPlan(goal: string, workload: ArchitectWorkload): Promise<ArchitectPlan> {
    if (!(await this.client.checkConfigured())) {
      throw new Error("Capix sign-in is required to use architect mode");
    }
    const [deployments, models, listings] = await Promise.all([
      this.service.listDeployments().catch(() => [] as InfraDeployment[]),
      this.service.listModels(),
      this.service.browseMarketplace(),
    ]);

    const model = pickModelForWorkload(models, workload.kind);
    const minVram = workload.minVramGb ?? model?.minVramGb ?? 0;
    const hours = Number.isInteger(workload.hours) && (workload.hours ?? 0) >= 1 ? Number(workload.hours) : 1;

    // Infra awareness: a running deployment of the same model already covers
    // the workload — reuse it instead of double-billing the wallet.
    const reusable = model
      ? deployments.find(
          (d) =>
            ["running", "active"].includes(d.status) &&
            (d.name.includes(model.id) || d.name.includes(model.label)),
        )
      : undefined;

    const fits = recommendGpuOffers(
      listings.map((l) => ({
        askId: l.askId,
        gpu: l.gpu,
        location: l.location,
        pricePerHr: l.pricePerHr,
        reliability: l.reliability,
        vramGb: l.vramGb,
      })),
      minVram,
      workload.budgetUsdPerHr,
    );
    const offer = fits[0] ?? null;

    const estimate: PlanCostEstimate | null = offer
      ? (() => {
          const hourlyMicro = dollarsToMicro(offer.pricePerHr);
          const totalMicro = estimatePlanCostMicro(offer.pricePerHr, hours);
          return {
            hourlyMicro,
            totalMicro,
            hours,
            displayHourly: `$${microToDisplay(hourlyMicro, 4)}/hr`,
            displayTotal: `$${microToDisplay(totalMicro, 2)} for ${hours}h`,
          };
        })()
      : null;

    const rationale = reusable
      ? `Deployment ${reusable.id} already runs ${reusable.name} — reuse it instead of provisioning new capacity.`
      : !model
        ? `No catalog model matches the "${workload.kind}" workload.`
        : !offer
          ? `${model.label} needs ${minVram} GB VRAM${workload.budgetUsdPerHr !== undefined ? ` within $${workload.budgetUsdPerHr.toFixed(2)}/hr` : ""}, but no live marketplace offer fits.`
          : `${model.label} on ${offer.gpu} at $${offer.pricePerHr.toFixed(4)}/hr (${offer.location}, reliability ${(offer.reliability * 100).toFixed(1)}%) is the cheapest live offer that fits ${minVram} GB VRAM.`;

    const steps: ArchitectPlanStep[] = [];
    if (reusable) {
      steps.push({
        id: "verify",
        title: "Verify existing deployment",
        detail: `Check ${reusable.id} health and endpoint readiness before routing traffic.`,
        status: "pending",
      });
    } else if (model && offer) {
      steps.push(
        {
          id: "deploy",
          title: `Deploy ${model.label}`,
          detail: `Provision offer ${offer.askId} (${offer.gpu}) and deploy for ${hours}h — ${estimate?.displayTotal ?? ""}.`,
          status: "pending",
          action: { type: "deploy_model", modelId: model.id, askId: offer.askId, durationHours: hours },
        },
        {
          id: "verify",
          title: "Verify endpoint",
          detail: "Wait for the deployment to reach running/healthy and the endpoint to respond.",
          status: "pending",
        },
      );
    }
    steps.push({
      id: "connect",
      title: "Connect assistant route",
      detail: "Point the IDE assistant at the deployment endpoint (auto-connect writes base URL + key to SecretStorage).",
      status: "pending",
    });

    const plan: ArchitectPlan = {
      id: `plan-${Date.now()}-${++this.planSeq}`,
      goal,
      createdAt: new Date().toISOString(),
      infraContext: deployments.map((d) => ({ id: d.id, name: d.name, status: d.status, health: d.health })),
      reuseDeploymentId: reusable?.id,
      recommendation: { model, offer, rationale },
      estimate,
      steps,
    };
    this.plans.set(plan.id, plan);
    return plan;
  }

  /**
   * Execute a plan's deploy step (one-click deploy). Billing action — the
   * caller (panel click or agent-runtime approval) is the authorization
   * boundary. Marks steps done as they complete.
   */
  async deployFromPlan(planId: string): Promise<{ instanceId: number; label: string; endpoint: string | null }> {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`Unknown plan: ${planId}`);
    const step = plan.steps.find((s) => s.action?.type === "deploy_model" && s.status === "pending");
    if (!step?.action) throw new Error(`Plan ${planId} has no pending deploy step`);
    const { modelId, askId, durationHours } = step.action;

    const result = await this.service.deployModel(modelId, askId, durationHours);
    step.status = "done";
    return {
      instanceId: result.instanceId,
      label: result.label,
      endpoint: result.endpoint,
    };
  }

  /**
   * Quote a catalog model on the cheapest fitting offer — the "how much
   * would this cost?" path for the assistant, with real-time pricing.
   */
  async estimateWorkload(workload: ArchitectWorkload): Promise<PlanCostEstimate | null> {
    const [models, listings] = await Promise.all([
      this.service.listModels(),
      this.service.browseMarketplace(),
    ]);
    const model = pickModelForWorkload(models, workload.kind);
    const minVram = workload.minVramGb ?? model?.minVramGb ?? 0;
    const hours = Number.isInteger(workload.hours) && (workload.hours ?? 0) >= 1 ? Number(workload.hours) : 1;
    const offer = recommendGpuOffers(
      listings.map((l) => ({ askId: l.askId, pricePerHr: l.pricePerHr, reliability: l.reliability, vramGb: l.vramGb })),
      minVram,
      workload.budgetUsdPerHr,
    )[0];
    if (!offer) return null;
    const hourlyMicro = dollarsToMicro(offer.pricePerHr);
    const totalMicro = estimatePlanCostMicro(offer.pricePerHr, hours);
    return {
      hourlyMicro,
      totalMicro,
      hours,
      displayHourly: `$${microToDisplay(hourlyMicro, 4)}/hr`,
      displayTotal: `$${microToDisplay(totalMicro, 2)} for ${hours}h`,
    };
  }
}
