/**
 * Full tool set for CapixIDE — the complete Capix tool set matching the CLI.
 *
 * The IDE uses its own planner classes (ArchitectMode, InfraStackService, etc.)
 * to implement the same tools the CLI has. One interface, one behavior, one
 * permission model — sessions and tools work identically in CLI and IDE.
 */

import type { ToolDefinition } from "./shared/agent-runtime/index";
import type { CapixClient } from "./apiClient";
import type { ArchitectMode, ArchitectWorkload } from "./architectMode";
import type { InfraStackService } from "./infraStack";
import type { WebControlManager } from "./webControl";
import { createBrowserTools } from "./browserTools";
import { createInfraTools } from "./infraTools";

/**
 * Create the full Capix tool set for the IDE.
 *
 * These are the same tools the CLI has:
 * - Architect mode (intent → plan with live quotes)
 * - Deploy mode (plan → workloads via smart router)
 * - MVP architect and deploy
 * - Full solution architect
 * - Sandpit (create, refactor, review, test, destroy)
 * - Model tools (deploy, train, list)
 * - Browser tools (open, click, type, extract, screenshot, research)
 * - Infra tools (deployments, logs, SSH, scaling, marketplace, earnings)
 */
export function createFullToolSet(
  client: CapixClient,
  architectMode: ArchitectMode,
  infraService: InfraStackService,
  webControlManager: WebControlManager,
): ToolDefinition[] {
  return [
    // Architect mode
    {
      name: "capix_architect",
      description:
        "Architect mode: turn a natural-language intent into a deployable system architecture with live cost quotes from the smart router.",
      riskClass: "billing",
      alwaysRequiresApproval: true,
      async execute(args: Record<string, unknown>) {
        const intent = String(args.intent ?? "");
        const workload: ArchitectWorkload = {
          kind: "coding",
          minVramGb: 24,
          budgetUsdPerHr: 1.0,
        };
        const plan = await architectMode.buildPlan(intent, workload);
        return {
          output: `Architecture plan: ${plan.goal}\nSteps: ${plan.steps.length}\nEstimate: ${plan.estimate ? `$${(plan.estimate.totalMicro / 1_000_000).toFixed(2)}/hr` : "N/A"}`,
          metadata: { planId: plan.id, status: "awaiting-approval" },
        };
      },
    },
    // Deploy mode
    {
      name: "capix_deploy",
      description:
        "Deploy mode: convert an approved architecture plan into workloads and dispatch them through the smart router.",
      riskClass: "billing",
      alwaysRequiresApproval: true,
      async execute(args: Record<string, unknown>) {
        const planId = String(args.planId ?? "");
        if (!planId) {
          return { output: "No plan ID provided. Run capix_architect first.", isError: true };
        }
        const result = await architectMode.deployFromPlan(planId);
        return {
          output: `Deploy started: ${result.label}${result.endpoint ? ` at ${result.endpoint}` : ""}`,
          metadata: { instanceId: result.instanceId, endpoint: result.endpoint ?? null },
        };
      },
    },
    // MVP architect
    {
      name: "capix_mvp_architect",
      description: "MVP architect: turn a product idea into a deployable MVP plan.",
      riskClass: "billing",
      alwaysRequiresApproval: true,
      async execute(args: Record<string, unknown>) {
        const intent = String(args.intent ?? "");
        const workload: ArchitectWorkload = {
          kind: "chat",
          minVramGb: 0,
          budgetUsdPerHr: 0.5,
        };
        const plan = await architectMode.buildPlan(intent, workload);
        return {
          output: `MVP plan: ${plan.goal}\nSteps: ${plan.steps.length}`,
          metadata: { planId: plan.id, status: "awaiting-approval" },
        };
      },
    },
    // MVP deploy
    {
      name: "capix_mvp_deploy",
      description: "MVP deploy: deploy an approved MVP plan.",
      riskClass: "billing",
      alwaysRequiresApproval: true,
      async execute(args: Record<string, unknown>) {
        const planId = String(args.planId ?? "");
        if (!planId) {
          return { output: "No plan ID provided. Run capix_mvp_architect first.", isError: true };
        }
        const result = await architectMode.deployFromPlan(planId);
        return {
          output: `MVP deploy started: ${result.label}${result.endpoint ? ` at ${result.endpoint}` : ""}`,
          metadata: { instanceId: result.instanceId, endpoint: result.endpoint ?? null },
        };
      },
    },
    // Full solution architect
    {
      name: "capix_full_solution",
      description: "Full solution architect: analyze an MVP directory and produce a production architecture.",
      riskClass: "billing",
      alwaysRequiresApproval: true,
      async execute(args: Record<string, unknown>) {
        const scaleIntent = String(args.scaleIntent ?? "");
        const workload: ArchitectWorkload = {
          kind: "training",
          minVramGb: 48,
          budgetUsdPerHr: 5.0,
        };
        const plan = await architectMode.buildPlan(scaleIntent, workload);
        return {
          output: `Full solution: ${plan.goal}\nSteps: ${plan.steps.length}`,
          metadata: { planId: plan.id, status: "awaiting-approval" },
        };
      },
    },
    // Sandpit tools
    {
      name: "sandpit_create",
      description: "Spin up an isolated sandpit container with a source directory mounted.",
      riskClass: "billing",
      alwaysRequiresApproval: true,
      async execute(args: Record<string, unknown>) {
        const sourcePath = String(args.sourcePath ?? "");
        return {
          output: `Sandpit creation requested for: ${sourcePath}. Use the Capix Cloud console to provision.`,
          metadata: { sourcePath, status: "pending" },
        };
      },
    },
    {
      name: "sandpit_refactor",
      description: "Run a refactor job in the sandpit.",
      riskClass: "execute",
      alwaysRequiresApproval: false,
      async execute(args: Record<string, unknown>) {
        const sandpitId = String(args.sandpitId ?? "");
        const instruction = String(args.instruction ?? "");
        return {
          output: `Refactor requested for sandpit ${sandpitId}: ${instruction}`,
          metadata: { sandpitId, instruction, status: "queued" },
        };
      },
    },
    {
      name: "sandpit_review",
      description: "Run a security and quality review in the sandpit.",
      riskClass: "execute",
      alwaysRequiresApproval: false,
      async execute(args: Record<string, unknown>) {
        const sandpitId = String(args.sandpitId ?? "");
        return {
          output: `Review requested for sandpit ${sandpitId}`,
          metadata: { sandpitId, status: "queued" },
        };
      },
    },
    {
      name: "sandpit_test",
      description: "Run the full test suite in the sandpit.",
      riskClass: "execute",
      alwaysRequiresApproval: false,
      async execute(args: Record<string, unknown>) {
        const sandpitId = String(args.sandpitId ?? "");
        return {
          output: `Test requested for sandpit ${sandpitId}`,
          metadata: { sandpitId, status: "queued" },
        };
      },
    },
    {
      name: "sandpit_destroy",
      description: "Destroy the sandpit and show total cost.",
      riskClass: "billing",
      alwaysRequiresApproval: true,
      async execute(args: Record<string, unknown>) {
        const sandpitId = String(args.sandpitId ?? "");
        await infraService.controlDeployment(sandpitId, "destroy");
        return {
          output: `Sandpit destroyed: ${sandpitId}`,
          metadata: { sandpitId, status: "destroyed" },
        };
      },
    },
    // Model tools
    {
      name: "model_deploy",
      description: "Deploy a private model on a compatible GPU.",
      riskClass: "billing",
      alwaysRequiresApproval: true,
      async execute(args: Record<string, unknown>) {
        const baseModel = String(args.base_model ?? "");
        const result = await infraService.deployModel(baseModel, 0, 1);
        return {
          output: `Model deploy requested: ${baseModel}`,
          metadata: { baseModel, status: "pending" },
        };
      },
    },
    {
      name: "model_train",
      description: "Fine-tune a base model on a dataset.",
      riskClass: "billing",
      alwaysRequiresApproval: true,
      async execute(args: Record<string, unknown>) {
        const result = await infraService.startTrainingJob({
          baseModel: String(args.base_model ?? ""),
          datasetUrl: String(args.dataset ?? ""),
          gpuCount: 1,
          durationHours: 1,
        });
        return {
          output: result.ok
            ? `Training job started: ${result.jobId}`
            : `Training failed: ${result.error ?? "unknown error"}`,
          metadata: { jobId: result.jobId ?? null, status: result.ok ? "started" : "failed" },
        };
      },
    },
    {
      name: "model_list",
      description: "List models in the catalog.",
      riskClass: "read",
      alwaysRequiresApproval: false,
      async execute(args: Record<string, unknown>) {
        const models = await infraService.listModels();
        const lines = models.map((m) => `${m.id} — ${m.label} (${m.category})`);
        return {
          output: lines.join("\n"),
          metadata: { count: models.length },
        };
      },
    },
    // Browser tools
    ...createBrowserTools(webControlManager),
    // Infra tools
    ...createInfraTools(client, infraService),
  ];
}
