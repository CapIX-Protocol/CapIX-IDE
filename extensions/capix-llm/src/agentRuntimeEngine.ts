/**
 * Agent Runtime Engine — the IDE's agent surface backed by the SHARED Capix
 * agent runtime (`@capix/agent-runtime`, vendored under `src/shared/`).
 *
 * This replaces the former external `capix-code` binary spawn
 * (`capixCodeEngine.ts`): one runtime, one durable session store
 * (`~/.capix-code/agent-runtime.db`), one event protocol and one permission
 * model are now shared by the CLI, the TUI and CapixIDE. Sessions created in
 * the IDE resume in the CLI and vice versa.
 *
 * The panel-facing surface intentionally mirrors the old engine's
 * (`start`, `sendMessage` → `EngineEvent` stream, approvals, diffs,
 * checkpoints, cancel) so the webview needed no protocol change.
 *
 * Semantics notes:
 * - Tools execute inside the runtime and write files directly; the diffs it
 *   persists are the audit record. "Accept" dismisses a change from the
 *   panel's outstanding list (it is already on disk); "revert" applies the
 *   reverse of the latest recorded patch through the runtime's
 *   permission-checked `applyPatch`.
 * - Checkpoints are engine-level snapshots of the outstanding diff state —
 *   the runtime's durable event/receipt store is the underlying record.
 * - Inference goes through the broker-backed `streamAgentChat` path (the
 *   same server-authoritative route as every other IDE call); credentials
 *   never enter a child process environment. Money stays integer minor
 *   units; customer-facing output never names upstream providers.
 */

import { randomBytes } from "node:crypto";
import { CapixClient } from "./apiClient";
import { logger } from "./logger";
import {
  CapixAgentRuntime,
  type AgentEvent,
  type AgentMode,
  type ModelChunk,
  type ModelInvoker,
  type Session,
  type ToolDefinition,
} from "./shared/agent-runtime/index";

export type EngineMode = "ask" | "plan" | "build" | "debug" | "review";

export type EngineEvent =
  | { type: "text"; content: string }
  | { type: "tool_call"; tool: string; args: unknown; callId: string }
  | { type: "tool_result"; callId: string; output: string }
  | {
      type: "file_changed";
      filePath: string;
      changeType: "created" | "modified" | "deleted";
    }
  | { type: "plan"; plan: unknown }
  | { type: "approval_request"; callId: string; tool: string; description: string }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      costMinor: string;
    }
  | { type: "error"; message: string; code?: string }
  | { type: "done"; summary?: string };

interface DiffEntry {
  filePath: string;
  diff: string;
}

interface CheckpointRecord {
  id: string;
  sessionId: string;
  createdAt: string;
  files: DiffEntry[];
}

export interface AgentRuntimeEngineOptions {
  /** Broker-backed API client used for the runtime's model stream. */
  client: CapixClient;
  /** Override the shared runtime database (defaults to ~/.capix-code/agent-runtime.db). */
  dbPath?: string;
  /**
   * Extra host tools (e.g. the web-control browser tools) registered on the
   * runtime at boot, on top of the built-in workspace tools.
   */
  extraTools?: ToolDefinition[];
}

/** Routing preferences captured from the composer and forwarded to the server-authoritative router. */
interface RoutePreferences {
  preferredProvider?: "auto" | "usepod" | "openrouter" | "surplus";
  preferredModel?: string;
}

/**
 * Reverse a unified diff (swap the before/after sides of every hunk) so a
 * recorded agent change can be reverted through `applyPatch`.
 */
export function reverseUnifiedDiff(patch: string): string {
  const out: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("---")) out.push(line.replace(/^---/, "+++"));
    else if (line.startsWith("+++")) out.push(line.replace(/^\+\+\+/, "---"));
    else if (line.startsWith("@@")) {
      out.push(
        line.replace(
          /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/,
          (_m, aStart, aCount, bStart, bCount) =>
            `@@ -${bStart}${bCount !== undefined ? `,${bCount}` : ""} +${aStart}${aCount !== undefined ? `,${aCount}` : ""} @@`,
        ),
      );
    } else if (line.startsWith("+")) out.push(`-${line.slice(1)}`);
    else if (line.startsWith("-")) out.push(`+${line.slice(1)}`);
    else out.push(line); // context lines and "\ No newline at end of file"
  }
  return out.join("\n");
}

export class AgentRuntimeEngine {
  private runtime: CapixAgentRuntime | null = null;
  private session: Session | null = null;
  private workspaceRoot = "";

  private readonly client: CapixClient;
  private readonly dbPath?: string;
  private readonly extraTools: ToolDefinition[];

  private streaming = false;
  private disposed = false;
  private starting: Promise<void> | null = null;

  /** Routing preferences from the last sendMessage call (server-authoritative hints). */
  private routePreferences: RoutePreferences = {};

  /** Files the operator accepted or reverted; hidden from the outstanding-diff list. */
  private readonly dismissedFiles = new Set<string>();
  /** Engine-level checkpoints (snapshot of the outstanding diff state). */
  private readonly checkpoints = new Map<string, CheckpointRecord>();

  constructor(options: AgentRuntimeEngineOptions) {
    this.client = options.client;
    this.dbPath = options.dbPath;
    this.extraTools = options.extraTools ?? [];
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Start the shared runtime and bind (or create) the workspace session.
   * Idempotent; safe to call on every turn.
   */
  async start(workspaceRoot: string): Promise<void> {
    if (this.disposed) throw new Error("engine_disposed");
    if (this.runtime && this.session) return;
    if (this.starting) return this.starting;

    this.workspaceRoot = workspaceRoot;
    this.starting = this.boot(workspaceRoot);
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async boot(workspaceRoot: string): Promise<void> {
    const runtime = new CapixAgentRuntime({
      dbPath: this.dbPath,
      workspaceRoot,
      modelInvoker: this.createModelInvoker(),
    });
    for (const tool of this.extraTools) runtime.registerTool(tool);

    // Resume the most recent session for this workspace when one exists —
    // the shared store is durable across IDE restarts AND across clients.
    let session: Session | null = null;
    try {
      const { sessions } = await runtime.listSessions({ limit: 20 });
      const match = sessions.find((s) => s.workspaceRoot === workspaceRoot && s.status !== "failed");
      if (match) session = await runtime.resumeSession(match.id);
    } catch (err) {
      logger.warn("AgentRuntimeEngine: session resume failed, starting fresh", { error: String(err) });
    }
    if (!session) {
      session = await runtime.createSession({
        workspaceRoot,
        modelId: "capix/auto",
        mode: "ask",
      });
    }

    this.runtime = runtime;
    this.session = session;
  }

  private requireRuntime(): { runtime: CapixAgentRuntime; session: Session } {
    if (this.disposed) throw new Error("engine_disposed");
    if (!this.runtime || !this.session) throw new Error("engine_not_started");
    return { runtime: this.runtime, session: this.session };
  }

  // ── Turn streaming ───────────────────────────────────────────────────────

  /**
   * Send a message and stream the turn as EngineEvents. The generator
   * completes on `turn.completed` / `turn.failed` (mapped to done/error) or
   * when the turn is cancelled.
   */
  async *sendMessage(
    message: string,
    options?: {
      mode?: EngineMode;
      model?: string;
      preferredProvider?: "auto" | "usepod" | "openrouter" | "surplus";
      preferredModel?: string;
      contextFiles?: string[];
    },
  ): AsyncGenerator<EngineEvent> {
    await this.ensureStarted();
    if (this.streaming) throw new Error("engine_busy");
    const { runtime, session } = this.requireRuntime();

    this.routePreferences = {
      preferredProvider: options?.preferredProvider,
      preferredModel: options?.preferredModel,
    };

    if (options?.mode) {
      await runtime.setMode(session.id, options.mode as AgentMode);
    }

    this.streaming = true;
    // Tools execute serially inside the runtime; the most recent
    // tool.requested id is the one its output belongs to.
    let currentToolCallId = "";
    // usage.updated is cumulative within the turn; the panel accumulates, so
    // emit per-event deltas.
    let lastUsage = { input: 0, output: 0, cost: 0n };

    try {
      const stream = runtime.sendMessage({
        sessionId: session.id,
        content: message,
        modelId: options?.model && options.model !== "auto" ? options.model : undefined,
      });

      for await (const event of stream) {
        const mapped = this.toEngineEvent(event, currentToolCallId, lastUsage);
        if (event.type === "tool.requested") {
          currentToolCallId = event.toolCallId;
        }
        if (event.type === "usage.updated") {
          lastUsage = {
            input: event.inputUnits,
            output: event.outputUnits,
            cost: BigInt(event.costMinor),
          };
        }
        for (const evt of mapped) {
          yield evt;
          if (evt.type === "done" || evt.type === "error") return;
        }
      }
      // The runtime always closes a turn with turn.completed/turn.failed;
      // reaching here means the stream ended early (e.g. disposal).
      yield { type: "done", summary: "Turn ended" };
    } finally {
      this.streaming = false;
    }
  }

  private toEngineEvent(
    event: AgentEvent,
    currentToolCallId: string,
    lastUsage: { input: number; output: number; cost: bigint },
  ): EngineEvent[] {
    switch (event.type) {
      case "content.delta":
        return [{ type: "text", content: event.content }];
      case "tool.requested": {
        const events: EngineEvent[] = [
          {
            type: "tool_call",
            tool: event.toolName,
            args: event.args,
            callId: event.toolCallId,
          },
        ];
        if (event.requiresApproval) {
          events.push({
            type: "approval_request",
            callId: event.toolCallId,
            tool: event.toolName,
            description: this.describeToolCall(event.toolName, event.args),
          });
        }
        return events;
      }
      case "tool.rejected":
        return [
          {
            type: "tool_result",
            callId: event.toolCallId,
            output: `denied: ${event.reason}`,
          },
        ];
      case "tool.output":
        return [
          {
            type: "tool_result",
            callId: currentToolCallId,
            output: event.isError ? `error: ${event.output}` : event.output,
          },
        ];
      case "file.diff": {
        this.dismissedFiles.delete(event.filePath); // a fresh change re-surfaces the file
        return [
          {
            type: "file_changed",
            filePath: event.filePath,
            changeType: event.before ? "modified" : "created",
          },
        ];
      }
      case "usage.updated": {
        const cost = BigInt(event.costMinor);
        return [
          {
            type: "usage",
            inputTokens: event.inputUnits - lastUsage.input,
            outputTokens: event.outputUnits - lastUsage.output,
            costMinor: (cost - lastUsage.cost).toString(),
          },
        ];
      }
      case "turn.failed":
        return [
          {
            type: "error",
            message: event.error.message,
            code: event.error.capixCode,
          },
        ];
      case "turn.completed":
        return [
          {
            type: "done",
            summary:
              event.finishReason === "cancelled"
                ? "Cancelled"
                : `Done (${event.totalInputUnits} in / ${event.totalOutputUnits} out)`,
          },
        ];
      default:
        // session.started, reasoning.delta, route.receipt, checkpoint.created,
        // settlement events… — rendered by their dedicated surfaces.
        return [];
    }
  }

  private describeToolCall(tool: string, args: Record<string, unknown>): string {
    const target = args.filePath ?? args.path ?? args.command ?? args.pattern ?? "";
    const summary = typeof target === "string" && target ? ` ${target}` : "";
    return `${tool}${summary}`.slice(0, 200);
  }

  /** Cancel the current agent turn. */
  async cancel(): Promise<void> {
    if (!this.runtime || !this.session) return;
    try {
      await this.runtime.cancelTurn(this.session.id);
    } catch (err) {
      logger.error("AgentRuntimeEngine cancel failed", { error: String(err) });
    }
  }

  /** Whether a turn is currently streaming. */
  getSessionState(): { active: boolean; sessionId?: string; messages: number } {
    let messages = 0;
    if (this.runtime && this.session) {
      try {
        messages = this.runtime.getHistory(this.session.id).length;
      } catch {
        messages = 0;
      }
    }
    return {
      active: this.streaming,
      sessionId: this.session?.id,
      messages,
    };
  }

  /** Approve (or deny) a pending tool call awaiting operator approval. */
  async approveTool(callId: string, approved: boolean): Promise<void> {
    const { runtime, session } = this.requireRuntime();
    await runtime.approveTool(session.id, callId, approved);
  }

  // ── Diffs ────────────────────────────────────────────────────────────────

  /** Outstanding (not accepted/reverted) agent changes. */
  async getDiff(): Promise<DiffEntry[]> {
    const { runtime, session } = this.requireRuntime();
    const diffs = await runtime.getDiff(session.id);
    return diffs.filter((d) => !this.dismissedFiles.has(d.filePath));
  }

  /** Accept an individual file change (already on disk; dismiss from the list). */
  async acceptFile(filePath: string): Promise<void> {
    this.requireRuntime();
    this.dismissedFiles.add(filePath);
  }

  /** Revert an individual file change by applying the reverse of its latest patch. */
  async revertFile(filePath: string): Promise<void> {
    const { runtime, session } = this.requireRuntime();
    const [latest] = await runtime.getDiff(session.id, filePath);
    if (!latest) {
      this.dismissedFiles.add(filePath);
      return;
    }
    await runtime.applyPatch(session.id, filePath, reverseUnifiedDiff(latest.diff));
    this.dismissedFiles.add(filePath);
  }

  /** Accept all outstanding agent file changes. */
  async acceptAll(): Promise<void> {
    const diffs = await this.getDiff();
    for (const d of diffs) this.dismissedFiles.add(d.filePath);
  }

  /** Revert all outstanding agent file changes. */
  async revertAll(): Promise<void> {
    const diffs = await this.getDiff();
    for (const d of diffs) {
      try {
        await this.revertFile(d.filePath);
      } catch (err) {
        logger.error("AgentRuntimeEngine revert failed", { file: d.filePath, error: String(err) });
      }
    }
  }

  /**
   * Create a checkpoint: an engine-level snapshot of the outstanding diff
   * state. The runtime's durable event/receipt store remains the underlying
   * audit record. Returns the checkpoint id.
   */
  async checkpoint(): Promise<string> {
    const { session } = this.requireRuntime();
    const files = await this.getDiff();
    const id = `ckpt_${randomBytes(6).toString("hex")}`;
    this.checkpoints.set(id, {
      id,
      sessionId: session.id,
      createdAt: new Date().toISOString(),
      files,
    });
    return id;
  }

  /** Dispose: release the runtime (its SQLite store) and engine state. */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.session && this.runtime) {
      try {
        await this.runtime.cancelTurn(this.session.id);
      } catch {
        // best-effort
      }
    }
    this.runtime?.close();
    this.runtime = null;
    this.session = null;
    this.checkpoints.clear();
    this.dismissedFiles.clear();
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private async ensureStarted(): Promise<void> {
    if (this.disposed) throw new Error("engine_disposed");
    if (this.runtime && this.session) return;
    if (!this.workspaceRoot) throw new Error("engine_not_started");
    if (this.starting) return this.starting;
    await this.start(this.workspaceRoot);
  }

  /**
   * Bridge the broker-backed Capix inference stream into the runtime's
   * ModelInvoker shape — the same server-authoritative route the rest of the
   * IDE uses. Route selection stays on the server; preferences are hints.
   */
  private createModelInvoker(): ModelInvoker {
    const invoker = async function* (
      this: AgentRuntimeEngine,
      req: Parameters<ModelInvoker>[0],
    ): AsyncGenerator<ModelChunk> {
      const queue: ModelChunk[] = [];
      const waiters: Array<() => void> = [];
      let failure: Error | null = null;
      let finished = false;
      let receivedModelPayload = false;

      const wake = () => {
        while (waiters.length) waiters.shift()!();
      };

      const input: Record<string, unknown> = {
        model: req.modelId === "capix/auto" ? "auto" : req.modelId,
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
      };
      if (this.routePreferences.preferredProvider && this.routePreferences.preferredProvider !== "auto") {
        input.preferredProvider = this.routePreferences.preferredProvider;
      }
      if (this.routePreferences.preferredModel) {
        input.preferredModel = this.routePreferences.preferredModel;
      }

      const streamPromise = this.client
        .streamAgentChat(input, req.signal ?? new AbortController().signal, async (event) => {
          if (event.type === "delta") {
            if (typeof event.content === "string" && event.content) {
              queue.push({ type: "text", delta: event.content });
              receivedModelPayload = true;
            }
            for (const toolCall of event.toolCalls ?? []) {
              const chunk = toToolCallChunk(toolCall);
              if (chunk) {
                queue.push(chunk);
                receivedModelPayload = true;
              }
            }
          } else if (event.type === "usage") {
            queue.push({
              type: "usage",
              inputUnits: Number(event.inputTokens ?? 0),
              outputUnits: Number(event.outputTokens ?? 0),
              costMinor: String(event.costMinor ?? "0"),
            });
          }
          wake();
        })
        .then(() => {
          finished = true;
          wake();
        })
        .catch((err: unknown) => {
          failure = err instanceof Error ? err : new Error(String(err));
          finished = true;
          wake();
        });

      req.signal?.addEventListener("abort", wake, { once: true });

      try {
        while (true) {
          if (queue.length) {
            yield queue.shift()!;
            continue;
          }
          if (failure) throw failure;
          if (finished) {
            if (!receivedModelPayload) {
              throw new Error(
                "empty_inference_stream: the selected route completed without text or tool output",
              );
            }
            return;
          }
          if (req.signal?.aborted) return;
          await new Promise<void>((resolve) => waiters.push(resolve));
        }
      } finally {
        // Detach so a late stream resolution cannot touch the generator.
        void streamPromise;
      }
    }.bind(this);
    return invoker as ModelInvoker;
  }
}

/** Map an OpenAI-style streamed tool call delta to a runtime tool_call chunk. */
function toToolCallChunk(raw: unknown): ModelChunk | null {
  const call = raw as {
    function?: { name?: string; arguments?: string };
    name?: string;
    arguments?: string;
  };
  const name = call.function?.name ?? call.name;
  if (!name) return null;
  let args: Record<string, unknown> = {};
  const rawArgs = call.function?.arguments ?? call.arguments;
  if (typeof rawArgs === "string" && rawArgs.trim()) {
    try {
      const parsed = JSON.parse(rawArgs);
      if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
    } catch {
      // Partial JSON (streamed argument deltas) — wait for a complete call.
      return null;
    }
  }
  return { type: "tool_call", toolName: name, args };
}
