import { describe, it, expect, vi } from "vitest";

import {
  MCP_INFRA_TOOL_NAMES,
  hasMcpInfraTools,
  parseToolPayload,
  queryMcpInfraContext,
  resolveMcpToolName,
  type McpToolHost,
} from "../src/mcpInfraContext";

/** Build a fake vscode.lm surface with the given tool name → payload map. */
function makeHost(
  tools: Record<string, unknown>,
  opts: { fail?: string[] } = {},
): { host: McpToolHost; invoked: Array<{ name: string; input: object }> } {
  const invoked: Array<{ name: string; input: object }> = [];
  const host: McpToolHost = {
    tools: Object.keys(tools).map((name) => ({ name })),
    invokeTool: async (name: string, options: { input: object }) => {
      invoked.push({ name, input: options.input });
      if (opts.fail?.includes(name)) throw new Error(`tool ${name} exploded`);
      const payload = tools[name];
      return {
        content: [{ type: "text", value: JSON.stringify(payload) }],
      } as { content: ReadonlyArray<unknown> };
    },
  };
  return { host, invoked };
}

const FULL_PAYLOADS: Record<string, unknown> = {
  capix_marketplace_browse: {
    entries: [
      { askId: 1, gpu: "A100", pricePerHr: 1.5 },
      { askId: 2, gpu: "H100", pricePerHr: 0.9 },
    ],
  },
  capix_node_status: {
    entries: [
      { nodeId: "n1", agentOnline: true },
      { nodeId: "n2", agentOnline: false },
      { nodeId: "n3", status: "online" },
    ],
  },
  capix_earnings_check: {
    wallet: { amount: "1250", asset: "USD-credit", scale: 2 },
    devTokenBalance: 7,
  },
  capix_model_list: { entries: [{ id: "llama-3-8b" }, { id: "qwen-7b" }] },
  capix_deployment_list: { entries: [{ id: "dep_1" }] },
};

describe("resolveMcpToolName", () => {
  it("matches exact tool names", () => {
    const { host } = makeHost({ capix_node_status: {} });
    expect(resolveMcpToolName(host, "capix_node_status")).toBe("capix_node_status");
  });

  it("matches server-prefixed names", () => {
    const { host } = makeHost({ mcp_capix_capix_model_list: {} });
    expect(resolveMcpToolName(host, "capix_model_list")).toBe("mcp_capix_capix_model_list");
  });

  it("returns undefined when the tool is not registered", () => {
    const { host } = makeHost({});
    expect(resolveMcpToolName(host, "capix_earnings_check")).toBeUndefined();
  });

  it("does not match unrelated tools that merely contain the words", () => {
    const { host } = makeHost({ capix_node_status_extended: {} });
    expect(resolveMcpToolName(host, "capix_node_status")).toBeUndefined();
  });
});

describe("hasMcpInfraTools", () => {
  it("is false when no Capix tools are registered", () => {
    const { host } = makeHost({ some_other_tool: {} });
    expect(hasMcpInfraTools(host)).toBe(false);
  });

  it("is true when any infra-context tool is registered", () => {
    const { host } = makeHost({ capix_deployment_list: {} });
    expect(hasMcpInfraTools(host)).toBe(true);
  });
});

describe("parseToolPayload", () => {
  it("parses the first JSON object text part", () => {
    const payload = parseToolPayload({
      content: [
        { type: "text", value: "not json" },
        { type: "text", value: '{"ok":true}' },
      ],
    });
    expect(payload).toEqual({ ok: true });
  });

  it("ignores non-text parts and arrays", () => {
    expect(parseToolPayload({ content: [{ type: "image", data: "…" }] })).toBeNull();
    expect(parseToolPayload({ content: [{ value: "[1,2]" }] })).toBeNull();
    expect(parseToolPayload({ content: [] })).toBeNull();
  });
});

describe("queryMcpInfraContext", () => {
  it("returns null when no Capix MCP tools are registered", async () => {
    const { host, invoked } = makeHost({});
    expect(await queryMcpInfraContext(host)).toBeNull();
    expect(invoked).toEqual([]);
  });

  it("aggregates all five tool results into a snapshot", async () => {
    const { host, invoked } = makeHost(FULL_PAYLOADS);
    const snapshot = await queryMcpInfraContext(host);
    expect(snapshot).not.toBeNull();
    expect(snapshot).toMatchObject({
      marketplaceOffers: 2,
      cheapestOfferUsdPerHr: 0.9,
      nodesTotal: 3,
      nodesOnline: 2,
      walletUsd: "12.50",
      devTokenBalance: 7,
      modelCount: 2,
      deploymentCount: 1,
    });
    expect(typeof snapshot?.fetchedAt).toBe("string");
    // Every documented tool was invoked exactly once with an empty input.
    expect(invoked.map((c) => c.name).sort()).toEqual([...MCP_INFRA_TOOL_NAMES].sort());
    for (const call of invoked) expect(call.input).toEqual({});
  });

  it("prefers the server-provided node summary over entry scanning", async () => {
    const { host } = makeHost({
      capix_node_status: { summary: { total: 10, online: 8 }, entries: [] },
    });
    const snapshot = await queryMcpInfraContext(host);
    expect(snapshot?.nodesTotal).toBe(10);
    expect(snapshot?.nodesOnline).toBe(8);
  });

  it("invokes prefixed registrations under their resolved names", async () => {
    const { host, invoked } = makeHost({ "mcp_capix_capix_earnings_check": FULL_PAYLOADS.capix_earnings_check });
    const snapshot = await queryMcpInfraContext(host);
    expect(snapshot?.walletUsd).toBe("12.50");
    expect(invoked).toEqual([{ name: "mcp_capix_capix_earnings_check", input: {} }]);
  });

  it("isolates individual tool failures and keeps the rest", async () => {
    const log = vi.fn();
    const { host } = makeHost(FULL_PAYLOADS, { fail: ["capix_earnings_check"] });
    const snapshot = await queryMcpInfraContext(host, log);
    expect(snapshot?.walletUsd).toBeUndefined();
    expect(snapshot?.devTokenBalance).toBeUndefined();
    expect(snapshot?.deploymentCount).toBe(1);
    expect(snapshot?.nodesTotal).toBe(3);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toContain("capix_earnings_check");
  });

  it("treats a tool that returns unparseable content as unset", async () => {
    const host: McpToolHost = {
      tools: [{ name: "capix_model_list" }],
      invokeTool: async () => ({ content: [{ type: "text", value: "garbage" }] }),
    };
    const snapshot = await queryMcpInfraContext(host);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.modelCount).toBeUndefined();
  });
});
