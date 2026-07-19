import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/capix-test", once: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (v: string) => Buffer.from(v), decryptString: (b: Buffer) => b.toString() },
  shell: { openExternal: vi.fn() },
}));

import { createControlPlaneSdk } from "../../../src/main/capix-runtime-bootstrap";

const ORIGIN = "https://www.capix.network";

function createAuth() {
  return {
    getAccessToken: vi.fn().mockResolvedValue({ token: "cpxs_native", expiresAt: Date.now() + 300_000 }),
    getProjectId: vi.fn(() => "proj-1"),
  } as any;
}

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

describe("createControlPlaneSdk (native cloud live data)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("lists real deployments from the control plane with cursor pagination", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ id: "dep_1", phase: "RUNNING" }], nextCursor: "cur_2" }));
    globalThis.fetch = fetchMock as any;

    const sdk = createControlPlaneSdk(ORIGIN, createAuth());
    const result = await sdk.deployment.list("cur_1") as any;

    const [url, init] = fetchMock.mock.calls[0] as any[];
    expect(String(url)).toBe(`${ORIGIN}/api/v1/deployments?limit=100&cursor=cur_1`);
    expect(init.headers.authorization).toBe("Bearer cpxs_native");
    expect(result.data).toHaveLength(1);
  });

  it("fetches a single deployment, a receipt and the balance from /api/v1 routes", async () => {
    const fetchMock = vi.fn(async (url: unknown) => jsonResponse({ url: String(url) }));
    globalThis.fetch = fetchMock as any;

    const sdk = createControlPlaneSdk(ORIGIN, createAuth());
    expect((await sdk.deployment.get("dep 9") as any).url).toBe(`${ORIGIN}/api/v1/deployments/dep%209`);
    expect((await sdk.receipt.get("cpxr_1") as any).url).toBe(`${ORIGIN}/api/v1/route-receipts/cpxr_1`);
    expect((await sdk.billing.getBalance() as any).url).toBe(`${ORIGIN}/api/v1/billing`);
  });

  it("derives invoice rows from settled debit ledger entries", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      ok: true,
      transactions: [
        { id: "e1", postingType: "debit", asset: "USDC", amount: "12500", createdAt: "2026-01-02T03:04:05.000Z" },
        { id: "e2", postingType: "credit", asset: "USDC", amount: "999999" },
        { id: "e3", postingType: "debit", asset: "SOL", amount: "42" },
      ],
    }));
    globalThis.fetch = fetchMock as any;

    const sdk = createControlPlaneSdk(ORIGIN, createAuth());
    const { invoices } = await sdk.billing.listInvoices() as any;

    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ id: "e1", totalMinor: "12500", currency: "USD", status: "paid" });
    expect(invoices[0].periodStart).toBe(Date.parse("2026-01-02T03:04:05.000Z"));
  });

  it("cancels operations through POST /api/v1/operations/{id}", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }, 202));
    globalThis.fetch = fetchMock as any;

    const sdk = createControlPlaneSdk(ORIGIN, createAuth());
    await sdk.operation.cancel("op_1");

    const [url, init] = fetchMock.mock.calls[0] as any[];
    expect(String(url)).toBe(`${ORIGIN}/api/v1/operations/op_1`);
    expect(init.method).toBe("POST");
  });

  it("sends If-Match with the current version when updating desired state", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: "dep_1", version: 7 }))
      .mockResolvedValueOnce(jsonResponse({ operationId: "op_9" }, 202));
    globalThis.fetch = fetchMock as any;

    const sdk = createControlPlaneSdk(ORIGIN, createAuth());
    await sdk.deployment.setDesired("dep_1", "STOPPED");

    const [patchUrl, patchInit] = fetchMock.mock.calls[1] as any[];
    expect(String(patchUrl)).toBe(`${ORIGIN}/api/v1/deployments/dep_1`);
    expect(patchInit.method).toBe("PATCH");
    expect(patchInit.headers["if-match"]).toBe("7");
    expect(JSON.parse(patchInit.body)).toEqual({ desiredState: "STOPPED" });
  });

  it("streams operation events as SSE", async () => {
    const body = 'event: progress\ndata: {"phase":"bootstrap","message":"booting"}\n\n';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close(); },
    });
    const fetchMock = vi.fn(async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }));
    globalThis.fetch = fetchMock as any;

    const sdk = createControlPlaneSdk(ORIGIN, createAuth());
    const events: unknown[] = [];
    for await (const event of await sdk.operation.subscribe("op_1") as AsyncIterable<unknown>) events.push(event);

    const [url] = fetchMock.mock.calls[0] as any[];
    expect(String(url)).toBe(`${ORIGIN}/api/v1/operations/op_1/events`);
    expect(events).toEqual([{ phase: "bootstrap", message: "booting" }]);
  });

  it("cancels inference locally without calling a non-existent route", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    globalThis.fetch = fetchMock as any;

    const sdk = createControlPlaneSdk(ORIGIN, createAuth());
    await expect(sdk.inference.cancel("inference-123")).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
