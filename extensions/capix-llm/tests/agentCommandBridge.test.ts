import { beforeEach, describe, expect, it, vi } from "vitest";

const commands = new Map<string, (...args: any[]) => any>();
vi.mock("vscode", () => ({ commands: {
  registerCommand: vi.fn((id: string, fn: (...args: any[]) => any) => { commands.set(id, fn); return { dispose: () => commands.delete(id) }; }),
  executeCommand: vi.fn(async (id: string, ...args: any[]) => commands.get(id)?.(...args)),
} }));

import { AgentCommandBridge } from "../src/agentCommandBridge";

describe("AgentCommandBridge command boundary", () => {
  beforeEach(() => commands.clear());

  it("is reachable via command ids and streams canonical authenticated chat", async () => {
    const client = {
      checkConfigured: vi.fn().mockResolvedValue(true),
      get: vi.fn().mockResolvedValue({ models: [{ id: "auto", name: "Auto" }] }),
      streamAgentChat: vi.fn(async (_input: unknown, _signal: AbortSignal, emit: (event: any) => Promise<void>) => {
        await emit({ type: "delta", content: "answer" });
        await emit({ type: "usage", inputTokens: 1, outputTokens: 2, costMinor: "3", currency: "USD" });
      }),
    };
    const bridge = new AgentCommandBridge(client as any).register();
    expect(commands.has("capix:chat:startSession")).toBe(true);
    expect(commands.has("capix:agent:listSessions")).toBe(true);

    const session = await commands.get("capix:chat:startSession")!({ modelId: "auto", projectId: "p1" });
    const events: any[] = [];
    commands.set("capix:chat:onStreamEvent", ({ event }) => events.push(event));
    const result = await commands.get("capix:chat:streamMessage")!({ sessionId: session.id, message: "question" });
    expect(result.streamHandle).toMatch(/^inference-/);
    await vi.waitFor(() => expect(events.some(e => e.type === "final")).toBe(true));
    expect(client.streamAgentChat).toHaveBeenCalledWith(expect.objectContaining({ model: "auto", projectId: "p1", messages: [{ role: "user", content: "question" }] }), expect.any(AbortSignal), expect.any(Function));
    await expect(commands.get("capix:agent:resumeSession")!({ sessionId: session.id })).resolves.toMatchObject({ messages: [{ content: "question" }, { content: "answer" }], costMinor: "3" });
    bridge.dispose();
  });

  it("rejects commands when SecretStorage has no valid OAuth session", async () => {
    const bridge = new AgentCommandBridge({ checkConfigured: vi.fn().mockResolvedValue(false) } as any).register();
    await expect(commands.get("capix:chat:startSession")!({ modelId: "auto", projectId: "p1" })).rejects.toMatchObject({ capixCode: "401" });
    bridge.dispose();
  });
});
