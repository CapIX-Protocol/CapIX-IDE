import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {
    createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })),
    showErrorMessage: vi.fn(),
  },
}));

import {
  ArchitectMode,
  estimatePlanCostMicro,
  pickModelForWorkload,
  recommendGpuOffers,
} from "../src/architectMode";
import type { CapixClient } from "../src/apiClient";
import type { CatalogModel } from "../src/types";
import type { InfraStackService } from "../src/infraStack";

const CATALOG: CatalogModel[] = [
  { id: "codex-7b", label: "Codex 7B", family: "codex", category: "coding", paramB: 7, minVramGb: 16, gpuCount: 1, maxModelLen: 8192, quantization: "fp16", gated: false, tagline: "", description: "" },
  { id: "codex-34b", label: "Codex 34B", family: "codex", category: "coding", paramB: 34, minVramGb: 80, gpuCount: 1, maxModelLen: 16384, quantization: "fp16", gated: false, tagline: "", description: "", popular: true },
  { id: "chat-8b", label: "Chat 8B", family: "chat", category: "chat", paramB: 8, minVramGb: 16, gpuCount: 1, maxModelLen: 8192, quantization: "fp16", gated: false, tagline: "", description: "" },
];

const OFFERS = [
  { askId: 3, gpu: "H100", location: "eu", pricePerHr: 2.5, reliability: 0.99, vramGb: 80 },
  { askId: 1, gpu: "A100", location: "us", pricePerHr: 1.0, reliability: 0.9, vramGb: 40 },
  { askId: 2, gpu: "A100", location: "us", pricePerHr: 1.0, reliability: 0.97, vramGb: 40 },
  { askId: 4, gpu: "RTX 4090", location: "us", pricePerHr: 0.4, reliability: 0.8, vramGb: 24 },
];

describe("recommendGpuOffers", () => {
  it("filters by VRAM floor and sorts cheapest-first, reliability tiebreak", () => {
    const result = recommendGpuOffers(OFFERS, 40);
    expect(result.map((o) => o.askId)).toEqual([2, 1, 3]);
  });

  it("applies the budget cap", () => {
    const result = recommendGpuOffers(OFFERS, 40, 1.0);
    expect(result.map((o) => o.askId)).toEqual([2, 1]);
  });

  it("returns empty when nothing fits", () => {
    expect(recommendGpuOffers(OFFERS, 160)).toEqual([]);
  });
});

describe("estimatePlanCostMicro", () => {
  it("computes integer micro-USD totals", () => {
    // $1.5/hr × 2h = $3.00 → 30000 micro (scale 4)
    expect(estimatePlanCostMicro(1.5, 2)).toBe(30000);
  });

  it("rejects invalid input", () => {
    expect(estimatePlanCostMicro(-1, 2)).toBe(0);
    expect(estimatePlanCostMicro(1, 0)).toBe(0);
    expect(estimatePlanCostMicro(1, 1.5)).toBe(0);
  });
});

describe("pickModelForWorkload", () => {
  it("prefers category match, then popular, then smallest", () => {
    expect(pickModelForWorkload(CATALOG, "coding")?.id).toBe("codex-34b");
    expect(pickModelForWorkload(CATALOG, "chat")?.id).toBe("chat-8b");
  });

  it("returns null when the category has no models", () => {
    expect(pickModelForWorkload(CATALOG, "vision")).toBeNull();
  });

  it("falls back to the full catalog for training/batch", () => {
    expect(pickModelForWorkload(CATALOG, "training")).not.toBeNull();
  });
});

describe("ArchitectMode", () => {
  let client: CapixClient;
  let service: InfraStackService;
  let architect: ArchitectMode;

  const serviceWith = (deployments: Array<Record<string, unknown>>) =>
    ({
      listDeployments: vi.fn(async () => deployments),
      listModels: vi.fn(async () => CATALOG),
      browseMarketplace: vi.fn(async () => OFFERS),
      deployModel: vi.fn(async () => ({
        ok: true,
        instanceId: 9,
        label: "Codex 34B",
        apiKey: "key",
        model: { id: "codex-34b", label: "Codex 34B", maxModelLen: 16384 },
        gpu: "A100",
        location: "us",
        pricePerHr: 1.0,
        chargedUsd: 2.0,
        endpoint: "https://endpoint",
      })),
    }) as unknown as InfraStackService;

  beforeEach(() => {
    client = { checkConfigured: vi.fn(async () => true) } as unknown as CapixClient;
    service = serviceWith([]);
    architect = new ArchitectMode(client, service);
  });

  it("requires sign-in", async () => {
    client = { checkConfigured: vi.fn(async () => false) } as unknown as CapixClient;
    architect = new ArchitectMode(client, service);
    await expect(architect.buildPlan("goal", { kind: "coding" })).rejects.toThrow("sign-in");
  });

  it("builds an infra-aware plan with a real-time cost estimate", async () => {
    const plan = await architect.buildPlan("serve a coding assistant", { kind: "coding", hours: 2 });

    expect(plan.recommendation.model?.id).toBe("codex-34b");
    // codex-34b needs 80 GB → only the H100 fits
    expect(plan.recommendation.offer).toMatchObject({ askId: 3, gpu: "H100", pricePerHr: 2.5 });
    expect(plan.estimate).toMatchObject({ hours: 2, hourlyMicro: 25000, totalMicro: 50000 });
    expect(plan.estimate?.displayTotal).toBe("$5.00 for 2h");
    expect(plan.reuseDeploymentId).toBeUndefined();

    const deployStep = plan.steps.find((s) => s.action?.type === "deploy_model");
    expect(deployStep?.action).toEqual({ type: "deploy_model", modelId: "codex-34b", askId: 3, durationHours: 2 });
    expect(plan.steps.map((s) => s.id)).toEqual(["deploy", "verify", "connect"]);
  });

  it("reuses a live deployment that already covers the workload", async () => {
    service = serviceWith([
      { id: "dep-9", name: "LLM · codex-34b", status: "running", health: "healthy", startedAt: "", costUsdPerHour: 2.5, nodes: [] },
    ]);
    architect = new ArchitectMode(client, service);

    const plan = await architect.buildPlan("more coding", { kind: "coding" });
    expect(plan.reuseDeploymentId).toBe("dep-9");
    expect(plan.steps.some((s) => s.action?.type === "deploy_model")).toBe(false);
    expect(plan.infraContext).toEqual([{ id: "dep-9", name: "LLM · codex-34b", status: "running", health: "healthy" }]);
  });

  it("records infra context and a rationale when no offer fits", async () => {
    const plan = await architect.buildPlan("cheap coding", { kind: "coding", budgetUsdPerHr: 0.5 });
    expect(plan.recommendation.offer).toBeNull();
    expect(plan.estimate).toBeNull();
    expect(plan.recommendation.rationale).toContain("no live marketplace offer fits");
    expect(plan.steps.some((s) => s.action?.type === "deploy_model")).toBe(false);
  });

  it("one-click deploys from a plan exactly once", async () => {
    const plan = await architect.buildPlan("deploy it", { kind: "coding" });
    const result = await architect.deployFromPlan(plan.id);

    expect(service.deployModel).toHaveBeenCalledWith("codex-34b", 3, 1);
    expect(result).toEqual({ instanceId: 9, label: "Codex 34B", endpoint: "https://endpoint" });
    expect(plan.steps.find((s) => s.id === "deploy")?.status).toBe("done");

    await expect(architect.deployFromPlan(plan.id)).rejects.toThrow("no pending deploy step");
  });

  it("rejects unknown plans", async () => {
    await expect(architect.deployFromPlan("plan-nope")).rejects.toThrow("Unknown plan");
  });

  it("estimates workloads without creating a plan", async () => {
    const estimate = await architect.estimateWorkload({ kind: "chat", hours: 4 });
    // chat-8b needs 16 GB → cheapest fit is the RTX 4090 at $0.4/hr
    expect(estimate).toMatchObject({ hours: 4, hourlyMicro: 4000, totalMicro: 16000 });
    expect(architect.listPlans()).toHaveLength(0);
  });
});
