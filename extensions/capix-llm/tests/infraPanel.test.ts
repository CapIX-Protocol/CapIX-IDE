import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockCreateWebviewPanel, mockShowWarningMessage } = vi.hoisted(() => ({
  mockCreateWebviewPanel: vi.fn(),
  mockShowWarningMessage: vi.fn(),
}));

vi.mock("vscode", () => ({
  window: {
    createWebviewPanel: mockCreateWebviewPanel,
    showWarningMessage: mockShowWarningMessage,
    createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })),
    showErrorMessage: vi.fn(),
  },
  ViewColumn: { One: 1 },
}));

import { InfraPanel } from "../src/infraPanel";
import type { InfraStackService } from "../src/infraStack";

function makeService(overrides: Record<string, unknown> = {}) {
  const listeners = new Set<(event: unknown) => void>();
  return {
    listeners,
    listDeployments: vi.fn(async () => [
      {
        id: "dep-1",
        name: "LLM · llama-3-8b",
        status: "running",
        health: "healthy" as const,
        startedAt: "2026-07-01T00:00:00.000Z",
        costUsdPerHour: 1.5,
        nodes: [],
      },
    ]),
    getCostOverview: vi.fn(async () => ({
      balanceUsd: "10.00",
      totalSpentUsd: "5.00",
      hourlyBurnMicro: 15000,
      entries: [{ id: "dep-1", name: "LLM · llama-3-8b", status: "running", costUsdPerHour: 1.5, startedAt: "2026-07-01T00:00:00.000Z" }],
    })),
    browseMarketplace: vi.fn(async () => [
      { askId: 1, gpu: "A100", numGpus: 1, vramGb: 40, pricePerHr: 1.0, location: "us", reliability: 0.95 },
    ]),
    controlDeployment: vi.fn(async () => undefined),
    scaleDeployment: vi.fn(async () => undefined),
    openSshTerminal: vi.fn(async () => undefined),
    streamLogs: vi.fn(async () => undefined),
    onDidChangeStatus: vi.fn((handler: (event: unknown) => void) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    }),
    ...overrides,
  } as unknown as InfraStackService & { listeners: Set<(event: unknown) => void> };
}

interface FakePanel {
  webview: {
    html: string;
    onDidReceiveMessage: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
  };
  reveal: ReturnType<typeof vi.fn>;
  onDidDispose: ReturnType<typeof vi.fn>;
}

function makePanel(): FakePanel {
  return {
    webview: { html: "", onDidReceiveMessage: vi.fn(), postMessage: vi.fn(async () => true) },
    reveal: vi.fn(),
    onDidDispose: vi.fn(),
  };
}

describe("InfraPanel", () => {
  let service: ReturnType<typeof makeService>;
  let fakePanel: FakePanel;

  beforeEach(() => {
    vi.clearAllMocks();
    service = makeService();
    fakePanel = makePanel();
    mockCreateWebviewPanel.mockReturnValue(fakePanel);
    // Reset the singleton between tests.
    (InfraPanel as unknown as { current: InfraPanel | null }).current = null;
  });

  function open(): InfraPanel {
    return InfraPanel.createOrShow(
      { fsPath: "/ext" } as unknown as import("vscode").Uri,
      service,
    );
  }

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it("renders the dashboard inside a strict CSP", async () => {
    open();
    await flush();
    const html = fakePanel.webview.html;
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("default-src 'none'");
    expect(html).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]+'/);
    expect(html).toContain("Capix Infrastructure");
    expect(html).toContain("LLM · llama-3-8b");
    expect(html).toContain("page-dashboard");
    expect(html).toContain("page-marketplace");
  });

  it("is a singleton that reveals the existing panel", async () => {
    const first = open();
    await flush();
    const second = open();
    expect(second).toBe(first);
    expect(mockCreateWebviewPanel).toHaveBeenCalledTimes(1);
    expect(fakePanel.reveal).toHaveBeenCalled();
  });

  it("refreshes when the service reports a status change", async () => {
    open();
    await flush();
    const calls = (service.listDeployments as ReturnType<typeof vi.fn>).mock.calls.length;
    for (const listener of service.listeners) listener({ deploymentId: "dep-1" });
    await flush();
    expect((service.listDeployments as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(calls);
  });

  it("runs one-click scale and SSH actions from webview messages", async () => {
    open();
    await flush();
    const onMessage = fakePanel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: unknown) => Promise<void>;

    await onMessage({ type: "scale", id: "dep-1", replicas: 3 });
    expect(service.scaleDeployment).toHaveBeenCalledWith("dep-1", 3);

    await onMessage({ type: "ssh", id: "dep-1" });
    expect(service.openSshTerminal).toHaveBeenCalledWith("dep-1");
  });

  it("confirms destroy before running it", async () => {
    open();
    await flush();
    const onMessage = fakePanel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: unknown) => Promise<void>;

    mockShowWarningMessage.mockResolvedValueOnce(undefined);
    await onMessage({ type: "action", action: "destroy", id: "dep-1" });
    expect(service.controlDeployment).not.toHaveBeenCalled();

    mockShowWarningMessage.mockResolvedValueOnce("Destroy");
    await onMessage({ type: "action", action: "destroy", id: "dep-1" });
    expect(service.controlDeployment).toHaveBeenCalledWith("dep-1", "destroy");
  });

  it("starts and stops the log stream from messages", async () => {
    open();
    await flush();
    const onMessage = fakePanel.webview.onDidReceiveMessage.mock.calls[0][0] as (msg: unknown) => Promise<void>;

    let onEvent: ((event: { type: string; lines?: string[] }) => void) | null = null;
    (service.streamLogs as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_id: string, handler: typeof onEvent) => {
        onEvent = handler;
      },
    );

    await onMessage({ type: "logs", id: "dep-1" });
    expect(service.streamLogs).toHaveBeenCalledWith("dep-1", expect.any(Function), expect.any(AbortSignal));

    onEvent?.({ type: "append", lines: ["hello"] });
    expect(fakePanel.webview.postMessage).toHaveBeenCalledWith({
      type: "log:append",
      deploymentId: "dep-1",
      lines: ["hello"],
    });

    await onMessage({ type: "stopLogs" });
    await onMessage({ type: "refresh" });
  });

  it("unsubscribes and stops streaming on dispose", async () => {
    open();
    await flush();
    const dispose = fakePanel.onDidDispose.mock.calls[0][0] as () => void;
    dispose();
    expect(service.listeners.size).toBe(0);
    expect(InfraPanel.currentInstance).toBeNull();
  });
});
