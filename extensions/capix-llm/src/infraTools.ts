/**
 * Capix Infra Tools — agent-runtime tool definitions for the full infra
 * stack.
 *
 * These are registered on the shared `ToolRegistry` so the assistant can
 * inspect and drive the customer's Capix infrastructure with the same
 * permission model as every other tool:
 *
 *   deploy_list        live deployment inventory + health      (read)
 *   deploy_status      single-deployment status                (read)
 *   deploy_logs        tail of a deployment's logs             (read)
 *   deploy_ssh         open an SSH terminal on a deployment    (execute)
 *   deploy_scale       scale a deployment's replicas           (billing)
 *   marketplace_browse live GPU marketplace offers             (network)
 *   node_status        per-node liveness across deployments    (read)
 *   earnings_check     wallet + dev-token earnings             (read)
 *   model_list         deployable model catalog                (read)
 *   model_deploy       deploy a catalog model on a GPU offer   (billing)
 *   model_train        launch a fine-tuning job                (billing)
 *
 * Every tool authenticates through the shared auth broker (`checkConfigured`
 * on the broker-backed client) and returns real-time data — nothing is
 * cached between calls. Side-effectful tools (`deploy_ssh`, `deploy_scale`,
 * `model_deploy`, `model_train`) set `alwaysRequiresApproval` so the runtime
 * asks the user explicitly even in permissive modes.
 */

import type { CapixClient } from "./apiClient";
import type { InfraStackService } from "./infraStack";
import type { ToolDefinition, ToolResult } from "./shared/agent-runtime/index";

export const INFRA_TOOL_NAMES = [
  "deploy_list",
  "deploy_status",
  "deploy_logs",
  "deploy_ssh",
  "deploy_scale",
  "marketplace_browse",
  "node_status",
  "earnings_check",
  "model_list",
  "model_deploy",
  "model_train",
] as const;

export type InfraToolName = (typeof INFRA_TOOL_NAMES)[number];

function ok(output: string, metadata?: Record<string, unknown>): ToolResult {
  return { output, metadata };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value) throw new Error(`Missing required argument: ${key}`);
  return value;
}

function requireNumber(args: Record<string, unknown>, key: string): number {
  const value = Number(args[key]);
  if (!Number.isFinite(value)) throw new Error(`Missing or invalid numeric argument: ${key}`);
  return value;
}

/**
 * Build the infra tool set bound to a broker-backed client + infra service.
 *
 *   const registry = new ToolRegistry();
 *   for (const tool of createInfraTools(client, service)) registry.register(tool);
 */
export function createInfraTools(client: CapixClient, service: InfraStackService): ToolDefinition[] {
  /**
   * Auth + error guard shared by every tool: a signed-out session fails fast
   * with a clear message instead of a stray 401, and thrown errors become
   * tool-level error results rather than runtime exceptions.
   */
  const guarded = (
    run: (args: Record<string, unknown>) => Promise<ToolResult>,
  ): ((args: Record<string, unknown>) => Promise<ToolResult>) => {
    return async (args) => {
      try {
        if (!(await client.checkConfigured())) {
          return { output: "Capix sign-in is required to use infra tools", isError: true };
        }
        return await run(args);
      } catch (err) {
        return { output: err instanceof Error ? err.message : String(err), isError: true };
      }
    };
  };

  return [
    {
      name: "deploy_list",
      description:
        "List all Capix deployments with live status, health, hourly cost and node count.",
      riskClass: "read",
      execute: guarded(async () => {
        const deployments = await service.listDeployments();
        if (deployments.length === 0) return ok("No deployments found.");
        const lines = deployments.map(
          (d) =>
            `${d.id} — ${d.name} [${d.status}/${d.health}] $${d.costUsdPerHour.toFixed(4)}/hr, ${d.nodes.length} node(s), since ${d.startedAt}`,
        );
        return ok(lines.join("\n"), { count: deployments.length });
      }),
    },
    {
      name: "deploy_status",
      description:
        "Get the live status and per-node health of one deployment. Args: deploymentId.",
      riskClass: "read",
      execute: guarded(async (args) => {
        const deployment = await service.getDeploymentStatus(requireString(args, "deploymentId"));
        const nodes = deployment.nodes
          .map((n) => `  ${n.nodeId} — ${n.agentOnline ? "online" : "offline"}${n.gpu ? `, ${n.gpu}` : ""}, ${n.location}`)
          .join("\n");
        return ok(
          `${deployment.name} (${deployment.id})\nstatus: ${deployment.status}\nhealth: ${deployment.health}\ncost: $${deployment.costUsdPerHour.toFixed(4)}/hr\nnodes:\n${nodes || "  (none)"}`,
        );
      }),
    },
    {
      name: "deploy_logs",
      description:
        "Fetch the tail of a deployment's logs. Args: deploymentId, optional tailLines (default 200).",
      riskClass: "read",
      execute: guarded(async (args) => {
        const deploymentId = requireString(args, "deploymentId");
        const tail = args.tailLines === undefined ? 200 : requireNumber(args, "tailLines");
        const lines = await service.fetchLogs(deploymentId, tail);
        return ok(lines.length ? lines.join("\n") : "(no logs yet)", { count: lines.length });
      }),
    },
    {
      name: "deploy_ssh",
      description:
        "Open an SSH terminal on a deployment's node in the IDE. Args: deploymentId.",
      riskClass: "execute",
      alwaysRequiresApproval: true,
      execute: guarded(async (args) => {
        const deploymentId = requireString(args, "deploymentId");
        await service.openSshTerminal(deploymentId);
        return ok(`SSH terminal opened for ${deploymentId}.`);
      }),
    },
    {
      name: "deploy_scale",
      description:
        "Scale a deployment to N replicas (1–16). Changes billing. Args: deploymentId, replicas.",
      riskClass: "billing",
      alwaysRequiresApproval: true,
      execute: guarded(async (args) => {
        const deploymentId = requireString(args, "deploymentId");
        const replicas = requireNumber(args, "replicas");
        await service.scaleDeployment(deploymentId, replicas);
        return ok(`${deploymentId} scaled to ${replicas} replica(s).`);
      }),
    },
    {
      name: "marketplace_browse",
      description: "Browse live GPU marketplace offers, cheapest first.",
      riskClass: "network",
      execute: guarded(async () => {
        const listings = await service.browseMarketplace();
        if (listings.length === 0) return ok("No marketplace offers available right now.");
        const lines = listings.map(
          (l) =>
            `ask ${l.askId} — ${l.numGpus}× ${l.gpu} (${l.vramGb} GB VRAM) $${l.pricePerHr.toFixed(4)}/hr in ${l.location}, reliability ${(l.reliability * 100).toFixed(1)}%`,
        );
        return ok(lines.join("\n"), { count: listings.length });
      }),
    },
    {
      name: "node_status",
      description: "Show liveness for every node across all deployments.",
      riskClass: "read",
      execute: guarded(async () => {
        const nodes = await service.getNodeStatuses();
        if (nodes.length === 0) return ok("No nodes allocated.");
        const lines = nodes.map(
          (n) =>
            `${n.nodeId} (${n.deploymentName}) — ${n.agentOnline ? "online" : "offline"}${n.gpu ? `, ${n.gpu}` : ""}, ${n.location}${n.sshAvailable ? ", ssh ready" : ""}`,
        );
        return ok(lines.join("\n"), { count: nodes.length });
      }),
    },
    {
      name: "earnings_check",
      description: "Check wallet balance, total spend and dev-token earnings.",
      riskClass: "read",
      execute: guarded(async () => {
        const earnings = await service.getEarnings();
        return ok(
          [
            `Wallet balance: $${earnings.walletUsd}`,
            `Total spent: $${earnings.totalSpentUsd}`,
            `Active deployments: ${earnings.activeInstances}`,
            `Dev tokens: ${earnings.devTokenBalance} (lifetime earned: ${earnings.devTokenTotalEarned})`,
          ].join("\n"),
        );
      }),
    },
    {
      name: "model_list",
      description: "List deployable models from the Capix catalog.",
      riskClass: "read",
      execute: guarded(async () => {
        const models = await service.listModels();
        if (models.length === 0) return ok("Model catalog is empty.");
        const lines = models.map(
          (m) => `${m.id} — ${m.label} (${m.category}, ${m.paramB}B params, min ${m.minVramGb} GB VRAM)`,
        );
        return ok(lines.join("\n"), { count: models.length });
      }),
    },
    {
      name: "model_deploy",
      description:
        "Deploy a catalog model onto a marketplace GPU offer. Bills the wallet. Args: modelId, askId, durationHours.",
      riskClass: "billing",
      alwaysRequiresApproval: true,
      execute: guarded(async (args) => {
        const modelId = requireString(args, "modelId");
        const askId = requireNumber(args, "askId");
        const durationHours = requireNumber(args, "durationHours");
        const result = await service.deployModel(modelId, askId, durationHours);
        return ok(
          `Deployed ${result.label} (instance ${result.instanceId}) on ${result.gpu} in ${result.location} — $${result.pricePerHr.toFixed(4)}/hr, charged $${result.chargedUsd.toFixed(2)}.${result.endpoint ? ` Endpoint: ${result.endpoint}` : ""}`,
        );
      }),
    },
    {
      name: "model_train",
      description:
        "Launch a fine-tuning job. Args: baseModel, datasetUrl, optional gpuCount, durationHours.",
      riskClass: "billing",
      alwaysRequiresApproval: true,
      execute: guarded(async (args) => {
        const result = await service.startTrainingJob({
          baseModel: requireString(args, "baseModel"),
          datasetUrl: requireString(args, "datasetUrl"),
          gpuCount: args.gpuCount === undefined ? undefined : requireNumber(args, "gpuCount"),
          durationHours: args.durationHours === undefined ? undefined : requireNumber(args, "durationHours"),
        });
        return ok(`Training job started${result.jobId ? ` (job ${result.jobId})` : ""}.`);
      }),
    },
  ];
}
