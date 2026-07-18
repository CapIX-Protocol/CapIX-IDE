import { describe, expect, it, vi } from "vitest";
import { CapixMainBroker } from "../../../src/main/capix-broker";
import { registerCapixIpc } from "../../../src/main/capix-ipc-registration";
import { CapixChatChannels } from "../../../src/vs/workbench/contrib/capix-ai/index";

const TRUSTED = "vscode-file://vscode-app/out/vs/workbench/workbench.html";

function createHarness(streamEvents: unknown[]) {
  const handlers = new Map<string, (event: any, input: unknown) => Promise<unknown>>();
  const sentEvents: Array<{ channel: string; args: unknown[] }> = [];
  const ipc = { removeHandler: vi.fn(), handle: vi.fn((channel: string, fn: any) => { handlers.set(channel, fn); }) };
  const sdk = {
    inference: {
      stream: vi.fn().mockImplementation(async () => (async function* () { for (const event of streamEvents) yield event; })()),
      cancel: vi.fn().mockResolvedValue(undefined),
    } as any,
  };
  const auth = { startLogin: vi.fn(), completeLogin: vi.fn(), logout: vi.fn(), getAccessToken: vi.fn().mockResolvedValue({ token: "oauth", expiresAt: Date.now() + 60_000 }) };
  registerCapixIpc(ipc, new CapixMainBroker({ sdk, auth }));
  const sender = { id: 1, getURL: () => TRUSTED, send: (channel: string, ...args: unknown[]) => { sentEvents.push({ channel, args }); } };
  return { handlers, sentEvents, sender, sdk };
}

async function startAndStream(harness: ReturnType<typeof createHarness>, message: string) {
  const event = { sender: harness.sender };
  const session = await harness.handlers.get(CapixChatChannels.startSession)!(event, { modelId: "auto", projectId: "proj-1" });
  const result = await harness.handlers.get(CapixChatChannels.streamMessage)!(event, { sessionId: session.id, message });
  return { session, streamHandle: result.streamHandle };
}

const renderedEvents = (sentEvents: Array<{ channel: string; args: unknown[] }>) =>
  sentEvents.filter(({ channel }) => channel === CapixChatChannels.onStreamEvent).map(({ args }) => (args[0] as any).event);

describe("native chat stream normalization (canonical Capix events)", () => {
  it("renders deltas, route, usage and final from the canonical stream contract", async () => {
    const harness = createHarness([
      { type: "capix.route", receiptId: "cpxr_native_1", modelCapability: "auto", region: "routed", privacyClass: "authenticated-gateway" },
      { type: "content.delta", content: "Capix " },
      { type: "content.delta", content: "IDE." },
      { type: "capix.usage", inputUnits: 12, outputUnits: 7, provisionalCost: { amount: "1500000", asset: "USD-credit", scale: 6 } },
      { type: "capix.final", finishReason: "stop", receiptId: "cpxr_native_1" },
    ]);
    const { session } = await startAndStream(harness, "hello");

    await vi.waitFor(() => {
      expect(renderedEvents(harness.sentEvents).some((event) => event.type === "final")).toBe(true);
    });

    const events = renderedEvents(harness.sentEvents);
    expect(events[0]).toMatchObject({ type: "route", receiptId: "cpxr_native_1", region: "routed", privacy: "authenticated-gateway" });
    expect(events.filter((event) => event.type === "delta").map((event) => event.content ?? "").join("")).toBe("Capix IDE.");
    // Scale-6 USD-credit minor units normalize to the micro-USD (scale 4) surface.
    expect(events.find((event) => event.type === "usage")).toMatchObject({ inputTokens: 12, outputTokens: 7, costMinor: "15000", currency: "USD" });
    expect(events.at(-1)).toMatchObject({ type: "final", finishReason: "stop", receiptId: "cpxr_native_1" });

    // Session history carries the assembled reply, the receipt and the real cost.
    const resumed = await harness.handlers.get("capix:agent:resumeSession")!({ sender: harness.sender }, { sessionId: session.id });
    expect(resumed.receiptId).toBe("cpxr_native_1");
    expect(resumed.costMinor).toBe("15000");
    expect(resumed.currency).toBe("USD");
    expect(resumed.messages).toEqual([
      { role: "user", content: "hello", createdAt: expect.any(Number) },
      { role: "assistant", content: "Capix IDE.", createdAt: expect.any(Number) },
    ]);
  });

  it("maps capix.error to a terminal error event the renderer understands", async () => {
    const harness = createHarness([
      { type: "content.delta", content: "partial" },
      { type: "capix.error", capixCode: "insufficient_funds", message: "Top up your balance", supportId: "sup_1" },
    ]);
    await startAndStream(harness, "hello");

    await vi.waitFor(() => {
      expect(renderedEvents(harness.sentEvents).some((event) => event.type === "error")).toBe(true);
    });

    const events = renderedEvents(harness.sentEvents);
    expect(events.at(-1)).toMatchObject({ type: "error", capixCode: "insufficient_funds", message: "Top up your balance", supportId: "sup_1" });
  });

  it("keeps tool.delta calls visible to the workbench", async () => {
    const harness = createHarness([
      { type: "tool.delta", toolCallId: "call_1", function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" }, index: 0 },
      { type: "capix.final", finishReason: "tool_calls", receiptId: "cpxr_tools" },
    ]);
    await startAndStream(harness, "use a tool");

    await vi.waitFor(() => {
      expect(renderedEvents(harness.sentEvents).some((event) => event.type === "final")).toBe(true);
    });

    const toolEvent = renderedEvents(harness.sentEvents).find((event) => event.type === "delta" && event.toolCalls);
    expect(toolEvent?.toolCalls).toEqual([{ id: "call_1", function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" }, index: 0 }]);
  });
});
