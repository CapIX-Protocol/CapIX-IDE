import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  EventEmitter: class {
    readonly event = vi.fn();
    readonly fire = vi.fn();
    readonly dispose = vi.fn();
  },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }),
  },
}));
vi.mock("../src/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import {
  AgentRuntimeEngine,
  INFERENCE_FIRST_EVENT_TIMEOUT_MS,
} from "../src/agentRuntimeEngine";
import type { CapixClient } from "../src/apiClient";

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Capix Code inference watchdog", () => {
  it("terminates a route that never emits its first event", async () => {
    const root = await mkdtemp(join(tmpdir(), "capix-agent-timeout-"));
    roots.push(root);
    const client = {
      streamAgentChat: async (_input: unknown, signal: AbortSignal): Promise<void> =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")),
            { once: true },
          );
        }),
    } as unknown as CapixClient;
    const engine = new AgentRuntimeEngine({
      client,
      dbPath: join(root, "runtime.db"),
    });

    try {
      await engine.start(root);
      vi.useFakeTimers();
      const events: Array<{ type: string; message?: string }> = [];
      const turn = (async () => {
        for await (const event of engine.sendMessage("Plan a pizza shop demo.", { mode: "plan" })) {
          events.push(event);
        }
      })();

      await vi.advanceTimersByTimeAsync(INFERENCE_FIRST_EVENT_TIMEOUT_MS + 1);
      await turn;

      expect(events.find((event) => event.type === "error")?.message).toContain(
        "inference_first_event_timeout",
      );
    } finally {
      await engine.dispose();
    }
  });
});
