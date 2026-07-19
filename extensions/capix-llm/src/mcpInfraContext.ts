/**
 * Capix MCP Infra Context — read-only infra context for the assistant panel,
 * sourced through the Capix MCP server instead of direct API calls.
 *
 * The MCP server (registered in VS Code's `mcp.servers` config by
 * `McpAutoInstaller`) exposes five read-only infra-context tools:
 *
 *   capix_marketplace_browse   live GPU marketplace offers
 *   capix_node_status          per-node liveness / health
 *   capix_earnings_check       wallet + dev-token earnings
 *   capix_model_list           deployable model catalog
 *   capix_deployment_list      deployment inventory + health
 *
 * This module discovers those tools through the editor's language-model tool
 * surface (`vscode.lm`, the same registry VS Code's MCP host publishes into)
 * and aggregates their structured results into a single
 * {@link InfraContextSnapshot} the panel renders in its indicator row.
 *
 * The module is deliberately vscode-free so it is unit-testable: the caller
 * passes the `vscode.lm` object (or a test double) as {@link McpToolHost}.
 * Every tool call is individually fault-isolated — a missing or failing tool
 * simply leaves its slice of the snapshot unset, and when no Capix MCP tools
 * are registered at all the query resolves to `null` so the UI stays hidden.
 */

/** The infra-context MCP tools this module consumes. */
export const MCP_INFRA_TOOL_NAMES = [
  "capix_marketplace_browse",
  "capix_node_status",
  "capix_earnings_check",
  "capix_model_list",
  "capix_deployment_list",
] as const;

export type McpInfraToolName = (typeof MCP_INFRA_TOOL_NAMES)[number];

/**
 * Minimal surface of `vscode.lm` used for tool discovery + invocation.
 * Matches `typeof vscode.lm` on editors with MCP support (VS Code 1.99+).
 */
export interface McpToolHost {
  readonly tools: ReadonlyArray<{ readonly name: string }>;
  invokeTool(
    name: string,
    options: { input: object },
  ): Thenable<{ content: ReadonlyArray<unknown> }>;
}

/** Aggregated, panel-ready view over the five infra-context tool results. */
export interface InfraContextSnapshot {
  marketplaceOffers?: number;
  cheapestOfferUsdPerHr?: number;
  nodesTotal?: number;
  nodesOnline?: number;
  walletUsd?: string;
  devTokenBalance?: number;
  modelCount?: number;
  deploymentCount?: number;
  fetchedAt: string;
}

type ToolPayload = Record<string, unknown>;

/**
 * Resolve a registered tool name for a Capix MCP tool. VS Code's MCP host may
 * publish tools under a server-prefixed name, so accept an exact match or any
 * `<prefix>_<tool>` / `<prefix>:<tool>` variant.
 */
export function resolveMcpToolName(
  host: McpToolHost,
  tool: McpInfraToolName,
): string | undefined {
  for (const candidate of host.tools) {
    if (candidate.name === tool) return candidate.name;
  }
  for (const candidate of host.tools) {
    if (candidate.name.endsWith(`_${tool}`) || candidate.name.endsWith(`:${tool}`)) {
      return candidate.name;
    }
  }
  return undefined;
}

/** True when at least one Capix infra-context tool is registered. */
export function hasMcpInfraTools(host: McpToolHost): boolean {
  return MCP_INFRA_TOOL_NAMES.some((name) => resolveMcpToolName(host, name) !== undefined);
}

/**
 * Extract the JSON payload from an MCP tool result. The Capix MCP server
 * returns a single text part containing the pretty-printed structured
 * content; scan all text parts and return the first that parses as an object.
 */
export function parseToolPayload(result: { content: ReadonlyArray<unknown> }): ToolPayload | null {
  for (const part of result.content ?? []) {
    const text =
      part && typeof part === "object" && "value" in part && typeof (part as { value: unknown }).value === "string"
        ? (part as { value: string }).value
        : undefined;
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as ToolPayload;
      }
    } catch {
      // Not JSON — keep scanning the remaining parts.
    }
  }
  return null;
}

/** Entries array from a list-style tool payload (never throws). */
function entriesOf(payload: ToolPayload | null): Array<Record<string, unknown>> {
  const entries = payload?.entries;
  return Array.isArray(entries) ? (entries as Array<Record<string, unknown>>) : [];
}

/** Numeric field reader tolerant of string-serialized numbers. */
function num(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/** Cheapest hourly price across marketplace offer entries. */
function cheapestOffer(entries: Array<Record<string, unknown>>): number | undefined {
  let best: number | undefined;
  for (const entry of entries) {
    const price = num(entry.pricePerHr ?? entry.priceUsdPerHr ?? entry.price);
    if (price !== undefined && (best === undefined || price < best)) best = price;
  }
  return best;
}

/** Online/total node counts, preferring the server's aggregate summary. */
function nodeCounts(payload: ToolPayload | null): { total?: number; online?: number } {
  const summary = payload?.summary;
  if (summary && typeof summary === "object") {
    const s = summary as Record<string, unknown>;
    const total = num(s.total);
    const online = num(s.online);
    if (total !== undefined || online !== undefined) return { total, online };
  }
  const entries = entriesOf(payload);
  if (!entries.length) return {};
  const online = entries.filter(
    (n) => n.agentOnline === true || n.status === "online" || n.online === true,
  ).length;
  return { total: entries.length, online };
}

/** Wallet USD figure from an earnings payload (money object or plain field). */
function walletUsdOf(payload: ToolPayload | null): string | undefined {
  if (!payload) return undefined;
  const wallet = payload.wallet;
  if (wallet && typeof wallet === "object") {
    const w = wallet as { amount?: string; scale?: number };
    const amount = num(w.amount);
    if (amount !== undefined && typeof w.scale === "number") {
      return (amount / 10 ** w.scale).toFixed(2);
    }
  }
  const direct = payload.walletUsd ?? payload.balanceUsd;
  return typeof direct === "string" ? direct : direct !== undefined ? String(direct) : undefined;
}

/**
 * Query every registered Capix infra-context MCP tool and aggregate the
 * results. Resolves to `null` when no Capix MCP tools are registered (server
 * not installed / user signed out) so callers can hide the UI affordance.
 * Individual tool failures are logged and skipped — one failing tool never
 * blanks the rest of the snapshot.
 */
export async function queryMcpInfraContext(
  host: McpToolHost,
  log?: (message: string) => void,
): Promise<InfraContextSnapshot | null> {
  if (!hasMcpInfraTools(host)) return null;

  const call = async (name: McpInfraToolName): Promise<ToolPayload | null> => {
    const resolved = resolveMcpToolName(host, name);
    if (!resolved) return null;
    try {
      return parseToolPayload(await host.invokeTool(resolved, { input: {} }));
    } catch (err) {
      log?.(`${name} failed: ${String(err)}`);
      return null;
    }
  };

  const [marketplace, nodes, earnings, models, deployments] = await Promise.all([
    call("capix_marketplace_browse"),
    call("capix_node_status"),
    call("capix_earnings_check"),
    call("capix_model_list"),
    call("capix_deployment_list"),
  ]);

  const offerEntries = entriesOf(marketplace);
  const { total: nodesTotal, online: nodesOnline } = nodeCounts(nodes);

  return {
    marketplaceOffers: marketplace ? offerEntries.length : undefined,
    cheapestOfferUsdPerHr: cheapestOffer(offerEntries),
    nodesTotal,
    nodesOnline,
    walletUsd: walletUsdOf(earnings),
    devTokenBalance: earnings ? num(earnings.devTokenBalance) : undefined,
    modelCount: models ? entriesOf(models).length : undefined,
    deploymentCount: deployments ? entriesOf(deployments).length : undefined,
    fetchedAt: new Date().toISOString(),
  };
}
