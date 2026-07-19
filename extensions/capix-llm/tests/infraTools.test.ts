import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {
    createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })),
    showErrorMessage: vi.fn(),
  },
}));

import { createInfraTools, INFRA_TOOL_NAMES } from "../src/infraTools";
import type { CapixClient } from "../src/apiClient";
import type { InfraStackService } from "../src/infraStack";

function makeClient(configured = true): CapixClient {
  return {
    checkConfigured: vi.fn(async () => configured),
  } as unknown as CapixClient;
}

function makeService(overrides: Record<string, unknown> = {}): InfraStackService {
  return {
    listDeployments: vi.fn(async () => [
      {
        id: "dep-1",
        name: "LLM · llama-3-8b",
        status: "running",
        health: "healthy",
        startedAt: "2026-07-01T00:00:00.000Z",
        costUsdPerHour: 1.5,
        nodes: [
          { nodeId: "n1", location: "us-east", gpu: "A100", agentOnline: true, sshAvailable: true },
        ],
      },
    ]),
    getDeploymentStatus: vi.fn(async (id: string) => {
      if (id !== "dep-1") throw new Error(`Unknown deployment: ${id}`);
      return {
        id: "dep-1",
        name: "LLM · llama-3-8b",
        status: "running",
        health: "healthy",
        startedAt: "2026-07-01T00:00:00.000Z",
        costUsdPerHour: 1.5,
        nodes: [{ nodeId: "n1", location: "us-east", gpu: "A100", agentOnline: true, sshAvailable: true }],
      };
    }),
    fetchLogs: vi.fn(async () => ["boot", "ready"]),
    openSshTerminal: vi.fn(async () => undefined),
    scaleDeployment: vi.fn(async () => undefined),
    browseMarketplace: vi.fn(async () => [
      { askId: 1, gpu: "A100", numGpus: 1, vramGb: 40, pricePerHr: 1.0, location: "us", reliability: 0.95 },
    ]),
    getNodeStatuses: vi.fn(async () => [
      { nodeId: "n1", location: "us-east", gpu: "A100", agentOnline: true, sshAvailable: true, deploymentId: "dep-1", deploymentName: "LLM" },
    ]),
    getEarnings: vi.fn(async () => ({
      devTokenBalance: 7,
      devTokenTotalEarned: 42,
      walletUsd: "10.00",
      totalSpentUsd: "5.00",
      activeInstances: 1,
    })),
    listModels: vi.fn(async () => [
      { id: "llama-3-8b", label: "Llama 3 8B", category: "chat", paramB: 8, minVramGb: 16 },
    ]),
    deployModel: vi.fn(async () => ({
      ok: true,
      instanceId: 9,
      label: "Llama 3 8B",
      apiKey: "key",
      model: { id: "llama-3-8b", label: "Llama 3 8B", maxModelLen: 8192 },
      gpu: "A100",
      location: "us",
      pricePerHr: 1.0,
      chargedUsd: 4.0,
      endpoint: "https://endpoint",
    })),
    startTrainingJob: vi.fn(async () => ({ ok: true, jobId: "job-1" })),
    ...overrides,
  } as unknown as InfraStackService;
}

describe("createInfraTools", () => {
  let client: CapixClient;
  let service: InfraStackService;
  let tools: ReturnType<typeof createInfraTools>;

  const tool = (name: string) => {
    const found = tools.find((t) => t.name === name);
    if (!found) throw new Error(`tool missing: ${name}`);
    return found;
  };

  beforeEach(() => {
    client = makeClient();
    service = makeService();
    tools = createInfraTools(client, service);
  });

  it("registers exactly the documented infra tools", () => {
    expect(tools.map((t) => t.name)).toEqual([...INFRA_TOOL_NAMES]);
  });

  it("marks side-effectful tools as always requiring approval", () => {
    for (const name of ["deploy_ssh", "deploy_scale", "model_deploy", "model_train"]) {
      expect(tool(name).alwaysRequiresApproval).toBe(true);
    }
    for (const name of ["deploy_list", "deploy_status", "deploy_logs", "marketplace_browse", "node_status", "earnings_check", "model_list"]) {
      expect(tool(name).alwaysRequiresApproval).toBeUndefined();
    }
  });

  it("assigns billing risk to paid actions", () => {
    expect(tool("deploy_scale").riskClass).toBe("billing");
    expect(tool("model_deploy").riskClass).toBe("billing");
    expect(tool("model_train").riskClass).toBe("billing");
    expect(tool("deploy_ssh").riskClass).toBe("execute");
    expect(tool("marketplace_browse").riskClass).toBe("network");
    expect(tool("deploy_list").riskClass).toBe("read");
  });

  it("fails fast when signed out", async () => {
    tools = createInfraTools(makeClient(false), service);
    const result = await tool("deploy_list").execute({}, { sessionId: "s", turnId: "t", workspaceRoot: "/" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("sign-in");
    expect(service.listDeployments).not.toHaveBeenCalled();
  });

  it("deploy_list formats live deployments", async () => {
    const result = await tool("deploy_list").execute({}, { sessionId: "s", turnId: "t", workspaceRoot: "/" });
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("dep-1");
    expect(result.output).toContain("running/healthy");
    expect(result.output).toContain("$1.5000/hr");
    expect(result.metadata).toEqual({ count: 1 });
  });

  it("deploy_status requires deploymentId and shows node health", async () => {
    const missing = await tool("deploy_status").execute({}, { sessionId: "s", turnId: "t", workspaceRoot: "/" });
    expect(missing.isError).toBe(true);
    expect(missing.output).toContain("deploymentId");

    const result = await tool("deploy_status").execute({ deploymentId: "dep-1" }, { sessionId: "s", turnId: "t", workspaceRoot: "/" });
    expect(result.output).toContain("health: healthy");
    expect(result.output).toContain("n1 — online");
  });

  it("deploy_logs passes the tail through", async () => {
    const result = await tool("deploy_logs").execute(
      { deploymentId: "dep-1", tailLines: 50 },
      { sessionId: "s", turnId: "t", workspaceRoot: "/" },
    );
    expect(service.fetchLogs).toHaveBeenCalledWith("dep-1", 50);
    expect(result.output).toBe("boot\nready");
  });

  it("deploy_ssh opens a terminal", async () => {
    const result = await tool("deploy_ssh").execute({ deploymentId: "dep-1" }, { sessionId: "s", turnId: "t", workspaceRoot: "/" });
    expect(service.openSshTerminal).toHaveBeenCalledWith("dep-1");
    expect(result.output).toContain("SSH terminal opened");
  });

  it("deploy_scale validates and scales", async () => {
    const bad = await tool("deploy_scale").execute({ deploymentId: "dep-1" }, { sessionId: "s", turnId: "t", workspaceRoot: "/" });
    expect(bad.isError).toBe(true);

    const result = await tool("deploy_scale").execute(
      { deploymentId: "dep-1", replicas: 3 },
      { sessionId: "s", turnId: "t", workspaceRoot: "/" },
    );
    expect(service.scaleDeployment).toHaveBeenCalledWith("dep-1", 3);
    expect(result.output).toContain("scaled to 3");
  });

  it("marketplace_browse lists offers", async () => {
    const result = await tool("marketplace_browse").execute({}, { sessionId: "s", turnId: "t", workspaceRoot: "/" });
    expect(result.output).toContain("A100");
    expect(result.output).toContain("95.0%");
  });

  it("node_status lists nodes", async () => {
    const result = await tool("node_status").execute({}, { sessionId: "s", turnId: "t", workspaceRoot: "/" });
    expect(result.output).toContain("n1 (LLM) — online");
  });

  it("earnings_check summarizes wallet and dev tokens", async () => {
    const result = await tool("earnings_check").execute({}, { sessionId: "s", turnId: "t", workspaceRoot: "/" });
    expect(result.output).toContain("$10.00");
    expect(result.output).toContain("lifetime earned: 42");
  });

  it("model_list lists catalog models", async () => {
    const result = await tool("model_list").execute({}, { sessionId: "s", turnId: "t", workspaceRoot: "/" });
    expect(result.output).toContain("llama-3-8b");
    expect(result.output).toContain("min 16 GB VRAM");
  });

  it("model_deploy deploys and reports the endpoint", async () => {
    const result = await tool("model_deploy").execute(
      { modelId: "llama-3-8b", askId: 1, durationHours: 4 },
      { sessionId: "s", turnId: "t", workspaceRoot: "/" },
    );
    expect(service.deployModel).toHaveBeenCalledWith("llama-3-8b", 1, 4);
    expect(result.output).toContain("instance 9");
    expect(result.output).toContain("https://endpoint");
  });

  it("model_train validates required args and starts a job", async () => {
    const bad = await tool("model_train").execute({ baseModel: "m" }, { sessionId: "s", turnId: "t", workspaceRoot: "/" });
    expect(bad.isError).toBe(true);
    expect(bad.output).toContain("datasetUrl");

    const result = await tool("model_train").execute(
      { baseModel: "llama-3-8b", datasetUrl: "https://data", gpuCount: 2 },
      { sessionId: "s", turnId: "t", workspaceRoot: "/" },
    );
    expect(service.startTrainingJob).toHaveBeenCalledWith({
      baseModel: "llama-3-8b",
      datasetUrl: "https://data",
      gpuCount: 2,
      durationHours: undefined,
    });
    expect(result.output).toContain("job-1");
  });

  it("converts service failures into error results", async () => {
    (service.listDeployments as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    const result = await tool("deploy_list").execute({}, { sessionId: "s", turnId: "t", workspaceRoot: "/" });
    expect(result).toEqual({ output: "boom", isError: true });
  });
});
