import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("vscode", () => ({
  EventEmitter: class {
    event = vi.fn();
    fire = vi.fn();
    dispose = vi.fn();
  },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, def?: unknown) => def, update: vi.fn() }),
  },
}));

import { CapixApiError, CapixClient } from "../src/apiClient";

const CANONICAL_SSE = [
  'event: capix.route',
  'data: {"type":"capix.route","receiptId":"cpxr_stream_1","modelCapability":"auto","region":"routed","privacyClass":"authenticated-gateway"}',
  '',
  'event: content.delta',
  'data: {"type":"content.delta","content":"Capix "}',
  '',
  'event: content.delta',
  'data: {"type":"content.delta","content":"IDE."}',
  '',
  'event: capix.usage',
  'data: {"type":"capix.usage","inputUnits":12,"outputUnits":7,"provisionalCost":{"amount":"1500000","asset":"USD-credit","scale":6}}',
  '',
  'event: capix.final',
  'data: {"type":"capix.final","finishReason":"stop","receiptId":"cpxr_stream_1"}',
  '',
  '',
].join("\n");

function sseResponse(body: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("CapixClient.streamAgentChat (canonical inference stream)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("streams from the canonical inference route, not the non-streaming compatibility surface", async () => {
    const fetchMock = vi.fn(async () => sseResponse(CANONICAL_SSE));
    globalThis.fetch = fetchMock as any;

    const client = new CapixClient();
    const events: Array<Record<string, any>> = [];
    await client.streamAgentChat({ model: "auto", messages: [{ role: "user", content: "hi" }], stream: true }, new AbortController().signal, async (event) => { events.push(event); });

    const url = String((fetchMock.mock.calls[0] as any[])[0]);
    const init = (fetchMock.mock.calls[0] as any[])[1] as RequestInit;
    expect(url).toBe("https://www.capix.network/api/v1/inference/chat/completions");
    expect(url).not.toContain("/api/v1/chat/completions");
    const headers = new Headers(init.headers);
    expect(headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("maps capix.route/content.delta/capix.usage/capix.final into client stream events", async () => {
    globalThis.fetch = vi.fn(async () => sseResponse(CANONICAL_SSE)) as any;

    const client = new CapixClient();
    const events: Array<Record<string, any>> = [];
    await client.streamAgentChat({ model: "auto", messages: [], stream: true }, new AbortController().signal, async (event) => { events.push(event); });

    expect(events[0]).toMatchObject({ type: "route", receiptId: "cpxr_stream_1", region: "routed", privacy: "authenticated-gateway" });
    const text = events.filter((e) => e.type === "delta").map((e) => e.content ?? "").join("");
    expect(text).toBe("Capix IDE.");
    const usage = events.find((e) => e.type === "usage");
    expect(usage).toMatchObject({ inputTokens: 12, outputTokens: 7, currency: "USD" });
    // Scale-6 USD-credit minor units normalize to the micro-USD (scale 4) surface.
    expect(usage!.costMinor).toBe("15000");
    expect(events.at(-1)).toMatchObject({ type: "final", finishReason: "stop", receiptId: "cpxr_stream_1" });
  });

  it("rejects with a typed error when the gateway streams capix.error", async () => {
    const body = [
      'event: content.delta',
      'data: {"type":"content.delta","content":"partial"}',
      '',
      'event: capix.error',
      'data: {"type":"capix.error","capixCode":"insufficient_funds","message":"Top up your balance"}',
      '',
      '',
    ].join("\n");
    globalThis.fetch = vi.fn(async () => sseResponse(body)) as any;

    const client = new CapixClient();
    await expect(
      client.streamAgentChat({ model: "auto", messages: [] }, new AbortController().signal, async () => {}),
    ).rejects.toMatchObject({ name: "CapixApiError", code: "insufficient_funds" });
  });

  it("still parses OpenAI-compatible delta chunks from older gateways", async () => {
    const body = 'data: {"choices":[{"delta":{"content":"legacy chunk"}}]}\n\ndata: [DONE]\n\n';
    globalThis.fetch = vi.fn(async () => sseResponse(body)) as any;

    const client = new CapixClient();
    const events: Array<Record<string, any>> = [];
    await client.streamAgentChat({ model: "auto", messages: [] }, new AbortController().signal, async (event) => { events.push(event); });

    expect(events).toEqual([{ type: "delta", content: "legacy chunk", toolCalls: undefined }]);
  });

  it("raises a typed error on a non-2xx inference response", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "content-type": "application/json" } })) as any;

    const client = new CapixClient();
    await expect(
      client.streamAgentChat({ model: "auto", messages: [] }, new AbortController().signal, async () => {}),
    ).rejects.toBeInstanceOf(CapixApiError);
  });
});
