import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {
    createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })),
    showErrorMessage: vi.fn(),
  },
}));

import {
  InfraStackService,
  computeDeploymentHealth,
  normalizeLogLine,
  type InfraTerminalAdapter,
} from "../src/infraStack";
import type { CapixClient } from "../src/apiClient";

function makeClient(overrides: Record<string, unknown> = {}): CapixClient {
  return {
    checkConfigured: vi.fn(async () => true),
    listInstances: vi.fn(async () => ({
      ok: true as const,
      instances: [
        {
          id: "dep-1",
          tier: "LLM · llama-3-8b",
          status: "running",
          startedAt: "2026-07-01T00:00:00.000Z",
          costUsdPerHour: 1.5,
          nodes: [
            { nodeId: "n1", location: "us-east", sshHost: "1.2.3.4", sshPort: 22, gpu: "A100", agentOnline: true, sshAvailable: true },
          ],
        },
        {
          id: "dep-2",
          tier: "Dedicated GPU",
          status: "running",
          startedAt: "2026-07-02T00:00:00.000Z",
          costUsdPerHour: 0.5,
          nodes: [
            { nodeId: "n2", location: "eu-west", sshHost: null, sshPort: null, gpu: "H100", agentOnline: false },
          ],
        },
      ],
    })),
    getPodLogs: vi.fn(async () => ({ ok: true, logs: ["line1", "line2", "line3"] })),
    getStoredSshCredential: vi.fn(async () => ({
      host: "1.2.3.4",
      port: 22,
      privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
      filename: "dep-1.pem",
    })),
    post: vi.fn(async () => ({ ok: true })),
    controlInstance: vi.fn(async () => ({ ok: true })),
    getGpuOffers: vi.fn(async () => ({
      ok: true,
      offers: [
        { askId: 2, gpu: "H100", numGpus: 1, vramGb: 80, totalVramGb: 80, pricePerHr: 2.0, location: "eu", reliability: 0.99 },
        { askId: 1, gpu: "A100", numGpus: 1, vramGb: 40, totalVramGb: 40, pricePerHr: 1.0, location: "us", reliability: 0.95 },
      ],
    })),
    getBalance: vi.fn(async () => ({
      ok: true,
      balance: { usd: "10.00", sol: "0.0", usdc: "10.00" },
      totalSpent: "5.00",
      activeInstances: 2,
    })),
    getDevTokenBalance: vi.fn(async () => ({ ok: true, balance: 7, totalEarned: 42 })),
    getCatalog: vi.fn(async () => ({ ok: true, models: [] })),
    deployModel: vi.fn(async () => ({
      ok: true,
      instanceId: 9,
      label: "llama-3-8b",
      apiKey: "key",
      model: { id: "llama-3-8b", label: "llama-3-8b", maxModelLen: 8192 },
      gpu: "A100",
      location: "us",
      pricePerHr: 1.0,
      chargedUsd: 1.0,
      endpoint: "https://endpoint",
    })),
    ...overrides,
  } as unknown as CapixClient;
}

function makeTerminals(): InfraTerminalAdapter & {
  openSshSession: ReturnType<typeof vi.fn>;
  openPortForward: ReturnType<typeof vi.fn>;
  disposed: ReturnType<typeof vi.fn>;
} {
  const disposed = vi.fn();
  return {
    disposed,
    openSshSession: vi.fn(async () => undefined),
    openPortForward: vi.fn(async () => ({ dispose: disposed })),
  };
}

describe("computeDeploymentHealth", () => {
  it("marks failed phases unhealthy", () => {
    expect(computeDeploymentHealth("failed", [])).toBe("unhealthy");
    expect(computeDeploymentHealth("ERROR", [])).toBe("unhealthy");
  });
  it("marks non-running phases unknown", () => {
    expect(computeDeploymentHealth("loading", [])).toBe("unknown");
    expect(computeDeploymentHealth("stopped", [{ agentOnline: true }])).toBe("unknown");
  });
  it("requires all nodes online for healthy", () => {
    expect(computeDeploymentHealth("running", [{ agentOnline: true }])).toBe("healthy");
    expect(computeDeploymentHealth("active", [{ agentOnline: true }, { agentOnline: false }])).toBe("degraded");
    expect(computeDeploymentHealth("running", [])).toBe("unknown");
  });
});

describe("normalizeLogLine", () => {
  it("passes strings through", () => {
    expect(normalizeLogLine("hello")).toBe("hello");
  });
  it("extracts message + timestamp from structured rows", () => {
    expect(normalizeLogLine({ ts: "2026-07-18T00:00:00Z", message: "boot" })).toBe("2026-07-18T00:00:00Z boot");
    expect(normalizeLogLine({ line: "raw" })).toBe("raw");
  });
  it("serializes other shapes", () => {
    expect(normalizeLogLine(42)).toBe("42");
  });
});

describe("InfraStackService", () => {
  let client: CapixClient;
  let terminals: ReturnType<typeof makeTerminals>;
  let service: InfraStackService;

  beforeEach(() => {
    client = makeClient();
    terminals = makeTerminals();
    service = new InfraStackService(client, terminals, { statusPollMs: 10, logPollMs: 1 });
  });

  afterEach(() => {
    service.dispose();
  });

  it("lists deployments with normalized health", async () => {
    const deployments = await service.listDeployments();
    expect(deployments).toHaveLength(2);
    expect(deployments[0]).toMatchObject({ id: "dep-1", health: "healthy", costUsdPerHour: 1.5 });
    expect(deployments[1].health).toBe("degraded");
    expect(deployments[1].nodes[0].sshAvailable).toBe(false);
  });

  it("gets a single deployment status and rejects unknown ids", async () => {
    const status = await service.getDeploymentStatus("dep-1");
    expect(status.name).toContain("llama-3-8b");
    await expect(service.getDeploymentStatus("nope")).rejects.toThrow("Unknown deployment");
  });

  it("tails logs", async () => {
    const lines = await service.fetchLogs("dep-1", 2);
    expect(lines).toEqual(["line2", "line3"]);
  });

  it("streams only newly appended log lines until aborted", async () => {
    const batches = [["a"], ["a", "b"], ["a", "b", "c"]];
    let call = 0;
    (client.getPodLogs as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      ok: true,
      logs: batches[Math.min(call++, batches.length - 1)],
    }));

    const events: Array<{ type: string; lines?: string[] }> = [];
    const controller = new AbortController();
    const done = service.streamLogs(
      "dep-1",
      (event) => {
        events.push(event);
        const appends = events.filter((e) => e.type === "append").length;
        if (appends === 3) controller.abort();
      },
      controller.signal,
    );
    await done;

    const appended = events.filter((e) => e.type === "append").flatMap((e) => e.lines ?? []);
    expect(appended).toEqual(["a", "b", "c"]);
    expect(events[events.length - 1].type).toBe("end");
  });

  it("emits status change events from the watcher", async () => {
    vi.useFakeTimers();
    try {
      const statuses = ["loading", "running"];
      let call = 0;
      (client.listInstances as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
        ok: true,
        instances: [
          {
            id: "dep-1",
            tier: "LLM",
            status: statuses[Math.min(call++, statuses.length - 1)],
            startedAt: "2026-07-01T00:00:00.000Z",
            costUsdPerHour: 1,
            nodes: [],
          },
        ],
      }));

      const events: Array<{ previous: string; current: string }> = [];
      service.onDidChangeStatus((event) => events.push(event));
      const stop = service.startWatching();
      await vi.advanceTimersByTimeAsync(0); // initial tick
      await vi.advanceTimersByTimeAsync(20); // second + third tick
      stop();

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ previous: "loading", current: "running", deploymentId: "dep-1" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens an SSH terminal with the stored credential", async () => {
    await service.openSshTerminal("dep-1");
    expect(terminals.openSshSession).toHaveBeenCalledWith(
      expect.objectContaining({ host: "1.2.3.4", port: 22, label: "dep-1" }),
    );
  });

  it("manages port-forward sessions end to end", async () => {
    const session = await service.openPortForward("dep-1", 8080, 18080);
    expect(terminals.openPortForward).toHaveBeenCalledWith(
      expect.objectContaining({ host: "1.2.3.4" }),
      18080,
      8080,
    );
    expect(session).toMatchObject({ deploymentId: "dep-1", localPort: 18080, remotePort: 8080, active: true });
    expect(service.listPortForwards()).toHaveLength(1);

    expect(service.closePortForward(session.id)).toBe(true);
    expect(terminals.disposed).toHaveBeenCalled();
    expect(service.listPortForwards()[0].active).toBe(false);
    expect(service.closePortForward(session.id)).toBe(false);
  });

  it("validates tunnel ports", async () => {
    await expect(service.openPortForward("dep-1", 0)).rejects.toThrow("remotePort");
    await expect(service.openPortForward("dep-1", 80, 70000)).rejects.toThrow("localPort");
  });

  it("requires a terminal adapter for SSH and tunnels", async () => {
    const bare = new InfraStackService(client);
    await expect(bare.openSshTerminal("dep-1")).rejects.toThrow("unavailable");
    await expect(bare.openPortForward("dep-1", 8080)).rejects.toThrow("unavailable");
  });

  it("scales deployments through the control plane", async () => {
    await service.scaleDeployment("dep-1", 3);
    expect(client.post).toHaveBeenCalledWith("/api/v1/deployments/dep-1/scale", { replicas: 3 });
    await expect(service.scaleDeployment("dep-1", 0)).rejects.toThrow("replicas");
    await expect(service.scaleDeployment("dep-1", 17)).rejects.toThrow("replicas");
  });

  it("surfaces control-plane scale failures", async () => {
    (client.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: "quota_exceeded" });
    await expect(service.scaleDeployment("dep-1", 2)).rejects.toThrow("quota_exceeded");
  });

  it("runs lifecycle actions", async () => {
    await service.controlDeployment("dep-1", "stop");
    expect(client.controlInstance).toHaveBeenCalledWith("dep-1", "stop");
  });

  it("browses the marketplace cheapest-first", async () => {
    const listings = await service.browseMarketplace();
    expect(listings.map((l) => l.askId)).toEqual([1, 2]);
    expect(listings[0]).toMatchObject({ gpu: "A100", vramGb: 40, pricePerHr: 1.0 });
  });

  it("flattens node statuses across deployments", async () => {
    const nodes = await service.getNodeStatuses();
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({ nodeId: "n1", deploymentId: "dep-1", deploymentName: "LLM · llama-3-8b" });
  });

  it("combines wallet and dev-token earnings", async () => {
    const earnings = await service.getEarnings();
    expect(earnings).toEqual({
      devTokenBalance: 7,
      devTokenTotalEarned: 42,
      walletUsd: "10.00",
      totalSpentUsd: "5.00",
      activeInstances: 2,
    });
  });

  it("tolerates dev-token endpoint failures", async () => {
    (client.getDevTokenBalance as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("down"));
    const earnings = await service.getEarnings();
    expect(earnings.devTokenBalance).toBe(0);
    expect(earnings.walletUsd).toBe("10.00");
  });

  it("deploys catalog models with validation", async () => {
    const result = await service.deployModel("llama-3-8b", 1, 4);
    expect(client.deployModel).toHaveBeenCalledWith("llama-3-8b", 1, 4);
    expect(result.instanceId).toBe(9);
    await expect(service.deployModel("m", 1, 0)).rejects.toThrow("durationHours");
  });

  it("starts training jobs with validation", async () => {
    (client.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, jobId: "job-1" });
    const result = await service.startTrainingJob({ baseModel: "llama-3-8b", datasetUrl: "https://data" });
    expect(result.jobId).toBe("job-1");
    await expect(service.startTrainingJob({ baseModel: "", datasetUrl: "x" })).rejects.toThrow("baseModel");
  });

  it("aggregates the cost overview with integer hourly burn", async () => {
    const overview = await service.getCostOverview();
    expect(overview.balanceUsd).toBe("10.00");
    expect(overview.totalSpentUsd).toBe("5.00");
    // 1.5 + 0.5 $/hr → 20000 micro-USD (scale 4)
    expect(overview.hourlyBurnMicro).toBe(20000);
    expect(service.formatHourlyBurn(overview)).toBe("$2.0000/hr");
    expect(overview.entries).toHaveLength(2);
  });
});
