/**
 * Capix Code Engine — manages the local capix-code process.
 *
 * The IDE's Capix Code panel talks to the real Capix Code engine (OpenCode)
 * instead of the raw `/api/v1/chat/completions` SSE endpoint. That engine runs
 * in the terminal with full agentic capabilities: tools, file editing, agent
 * loops, plans, checkpoints, and diffs.
 *
 * This class spawns `capix-code` as a child process with `--json` for
 * structured I/O and communicates via newline-delimited JSON over stdin/stdout.
 * Each line the engine writes to stdout is one `EngineEvent`. Commands the IDE
 * sends to the engine are JSON objects written to stdin.
 *
 * Auth: the IDE sets `CAPIX_API_KEY` (and `CAPIX_BASE_URL`) in the extension
 * host environment before calling `start()`; the child inherits it. This
 * keeps the key out of any interactive shell's persistent environ.
 *
 * Design tokens (@capix/ui-tokens): the engine emits structured events; the
 * panel renders them with the dark foundation + cyan (#3DCED6) / green
 * (#14F195) accents.
 */

import * as childProcess from "child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { logger } from "./logger";

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

interface TurnState {
  /** Pending events not yet pulled by the async generator. */
  queue: EngineEvent[];
  /** Blocked consumers waiting for the next event. */
  waiters: Array<(value: EngineEvent | null) => void>;
  /** True once a terminal event (done/error) has been routed. */
  done: boolean;
}

interface PendingRequest<T = unknown> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface CapixCodeEngineOptions {
  /** Extension path — used to locate the bundled `capix-code` binary. */
  extensionPath?: string;
  /** Override the binary path entirely (defaults to bundled or PATH lookup). */
  binaryPath?: string;
}

export class CapixCodeEngine {
  private process: childProcess.ChildProcess | null = null;
  private readonly binaryPath: string;

  private stdoutBuffer = "";
  private stderrBuffer = "";

  /** Root captured at start() so a crashed engine can be lazily restarted. */
  private workspaceRoot = "";

  /** The active streaming turn (a sendMessage generator is consuming it). */
  private activeTurn: TurnState | null = null;

  /** Discrete request/response correlation (getDiff, acceptAll, …). */
  private pending = new Map<string, PendingRequest>();

  private sessionId: string | undefined;
  private messageCount = 0;
  private killed = false;
  private disposed = false;
  private starting: Promise<void> | null = null;

  constructor(options: CapixCodeEngineOptions = {}) {
    if (options.binaryPath) {
      this.binaryPath = options.binaryPath;
    } else if (options.extensionPath) {
      const bundled = path.join(
        options.extensionPath,
        "tools",
        "capix-code",
        "bin",
        "capix-code",
      );
      this.binaryPath = fs.existsSync(bundled) ? bundled : "capix-code";
    } else {
      this.binaryPath = "capix-code";
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Start the capix-code engine in the background. Resolves once the process
   * is spawned (and emits a ready/session line, or after a short timeout).
   * Safe to call multiple times — subsequent calls are no-ops once running.
   */
  async start(workspaceRoot: string): Promise<void> {
    if (this.disposed) throw new Error("engine_disposed");
    if (this.process && !this.killed) return;
    if (this.starting) return this.starting;

    this.workspaceRoot = workspaceRoot;
    this.starting = this.spawnProcess(workspaceRoot);
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private startResolver: (() => void) | null = null;
  private startRejecter: ((err: Error) => void) | null = null;

  private spawnProcess(workspaceRoot: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const args = ["--json", "--workspace", workspaceRoot];
      // Inherit the environment — the IDE has set CAPIX_API_KEY /
      // CAPIX_BASE_URL via the auth broker before calling start().
      const env = { ...process.env } as Record<string, string>;

      let child: childProcess.ChildProcess;
      try {
        child = childProcess.spawn(this.binaryPath, args, {
          env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (err) {
        reject(new Error(`engine_spawn_failed: ${String(err)}`));
        return;
      }

      this.process = child;
      this.killed = false;
      this.startResolver = resolve;
      this.startRejecter = reject;

      child.on("error", (err: Error) => {
        logger.error("CapixCodeEngine spawn error", { error: String(err) });
        if (!this.disposed && this.startRejecter) {
          this.startRejecter(new Error(`engine_spawn_error: ${err.message}`));
          this.startResolver = null;
          this.startRejecter = null;
        }
      });
      child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        const wasStarting = !!this.startRejecter;
        this.handleExit(code, signal);
        if (wasStarting && this.startRejecter) {
          this.startRejecter(
            new Error(`engine_exited_before_ready (signal=${signal ?? ""}, code=${code ?? "?"})`),
          );
          this.startResolver = null;
          this.startRejecter = null;
        }
      });

      if (child.stdout) {
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          this.stdoutBuffer += chunk;
          this.drainStdout();
        });
      }
      if (child.stderr) {
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          this.stderrBuffer += chunk;
          this.drainStderr();
        });
      }

      // Resolve once the engine signals readiness (see handleLine), or after
      // a grace period if it doesn't emit a ready/session line.
      setTimeout(() => this.resolveStart(), 1500);
    });
  }

  private resolveStart(): void {
    if (this.startResolver) {
      const r = this.startResolver;
      this.startResolver = null;
      this.startRejecter = null;
      r();
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const wasRunning = !!this.process;
    this.process = null;
    this.killed = true;
    const detail = signal ? `signal=${signal}` : `code=${code ?? "?"}`;
    logger.warn("CapixCodeEngine process exited", { detail });

    // Flush any remaining stdout lines.
    if (this.stdoutBuffer) {
      this.drainStdout(true);
    }

    // Fail every pending discrete request.
    for (const [reqId, req] of this.pending) {
      this.pending.delete(reqId);
      req.reject(new Error(`engine_exited: ${detail}`));
    }

    if (wasRunning && !this.disposed) {
      // The engine died mid-flight — surface an error and end any active turn.
      const evt: EngineEvent = {
        type: "error",
        message: `Capix Code engine exited unexpectedly (${detail}). Restarting…`,
        code: "engine_exited",
      };
      this.routeTurnEvent(evt);
      this.endTurn();
    } else {
      this.endTurn();
    }
  }

  // ── Turn streaming ───────────────────────────────────────────────────────

  /**
   * Send a message and stream the response as a sequence of EngineEvents.
   * The generator completes when a `done` (or `error`) event is emitted by
   * the engine, or when the engine process exits.
   */
  async *sendMessage(
    message: string,
    options?: {
      mode?: EngineMode;
      model?: string;
      contextFiles?: string[];
    },
  ): AsyncGenerator<EngineEvent> {
    await this.ensureStarted();
    if (this.activeTurn && !this.activeTurn.done) {
      throw new Error("engine_busy");
    }

    this.activeTurn = { queue: [], waiters: [], done: false };
    this.messageCount++;

    this.write({
      type: "send",
      message,
      mode: options?.mode,
      model: options?.model,
      contextFiles: options?.contextFiles,
    });

    try {
      while (true) {
        const evt = await this.dequeueTurn();
        if (evt === null) break;
        yield evt;
        if (evt.type === "done" || evt.type === "error") break;
      }
    } finally {
      this.activeTurn = null;
    }
  }

  /** Cancel the current agent turn. */
  async cancel(): Promise<void> {
    // Best-effort: ask the engine to abort; it should emit a `done` event.
    try {
      this.write({ type: "cancel" });
    } catch (err) {
      logger.error("CapixCodeEngine cancel write failed", { error: String(err) });
    }
    // Safety net: if the engine doesn't respond within 2s, force-end the turn.
    setTimeout(() => {
      const t = this.activeTurn;
      if (t) {
        this.routeTurnEvent({ type: "done", summary: "Cancelled" });
        this.endTurn();
      }
    }, 2000).unref?.();
  }

  /** Whether a turn is currently streaming. */
  getSessionState(): { active: boolean; sessionId?: string; messages: number } {
    return {
      active: !!this.activeTurn && !this.activeTurn.done,
      sessionId: this.sessionId,
      messages: this.messageCount,
    };
  }

  /** Approve (or deny) a pending tool call awaiting user approval. */
  async approveTool(callId: string, approved: boolean): Promise<void> {
    this.write({ type: "approve", callId, approved });
  }

  /** Get the current diff (files changed by the agent). */
  async getDiff(): Promise<DiffEntry[]> {
    return this.sendRequest<DiffEntry[]>({ type: "getDiff" });
  }

  /** Accept (stage) an individual file change. */
  async acceptFile(filePath: string): Promise<void> {
    await this.sendRequest({ type: "acceptFile", filePath });
  }

  /** Revert an individual file change. */
  async revertFile(filePath: string): Promise<void> {
    await this.sendRequest({ type: "revertFile", filePath });
  }

  /** Accept all outstanding agent file changes. */
  async acceptAll(): Promise<void> {
    await this.sendRequest({ type: "acceptAll" });
  }

  /** Revert all outstanding agent file changes. */
  async revertAll(): Promise<void> {
    await this.sendRequest({ type: "revertAll" });
  }

  /** Create a checkpoint; returns the checkpoint id. */
  async checkpoint(): Promise<string> {
    return this.sendRequest<string>({ type: "checkpoint" });
  }

  /** Dispose: kill the child process and free resources. */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const [reqId, req] of this.pending) {
      this.pending.delete(reqId);
      clearTimeout(req.timer);
      req.reject(new Error("engine_disposed"));
    }
    this.endTurn();
    this.killProcess();
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private async ensureStarted(): Promise<void> {
    if (this.disposed) throw new Error("engine_disposed");
    if (this.process && !this.killed) return;
    if (!this.workspaceRoot) throw new Error("engine_not_started");
    if (this.starting) return this.starting;
    await this.start(this.workspaceRoot);
  }

  private killProcess(): void {
    const p = this.process;
    if (!p) return;
    this.killed = true;
    try {
      if (typeof p.kill === "function") p.kill("SIGTERM");
    } catch (err) {
      logger.error("CapixCodeEngine kill failed", { error: String(err) });
    }
    this.process = null;
  }

  private write(obj: Record<string, unknown>): void {
    const p = this.process;
    if (!p || !p.stdin) {
      throw new Error("engine_not_running");
    }
    p.stdin.write(JSON.stringify(obj) + "\n");
  }

  private drainStdout(finalFlush = false): void {
    let nl: number;
    while ((nl = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, nl).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      if (line.trim()) this.handleLine(line);
    }
    if (finalFlush && this.stdoutBuffer.trim()) {
      const tail = this.stdoutBuffer.trim();
      this.stdoutBuffer = "";
      this.handleLine(tail);
    }
  }

  private drainStderr(): void {
    let nl: number;
    while ((nl = this.stderrBuffer.indexOf("\n")) >= 0) {
      const line = this.stderrBuffer.slice(0, nl).replace(/\r$/, "");
      this.stderrBuffer = this.stderrBuffer.slice(nl + 1);
      if (line.trim()) {
        logger.warn("capix-code stderr", { line });
      }
    }
  }

  private handleLine(line: string): void {
    let obj: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        obj = parsed as Record<string, unknown>;
      } else {
        return;
      }
    } catch {
      // Non-JSON line — ignore (the engine may print a banner).
      return;
    }

    // Session readiness — capture the session id and resolve start().
    if (obj.type === "ready" || obj.type === "session") {
      const sid = obj.sessionId;
      if (typeof sid === "string") this.sessionId = sid;
      this.resolveStart();
      return;
    }

    // Discrete request/response correlation.
    const reqId = obj.reqId;
    if (typeof reqId === "string" && this.pending.has(reqId)) {
      const req = this.pending.get(reqId)!;
      this.pending.delete(reqId);
      clearTimeout(req.timer);
      this.resolvePending(req, obj);
      return;
    }

    // Streaming turn event.
    const evt = this.toEngineEvent(obj);
    if (evt) this.routeTurnEvent(evt);
  }

  private resolvePending(
    req: PendingRequest,
    obj: Record<string, unknown>,
  ): void {
    switch (obj.type) {
      case "diff_result":
        req.resolve((obj.files as DiffEntry[]) ?? []);
        return;
      case "checkpoint_result":
        req.resolve(String(obj.checkpointId ?? ""));
        return;
      case "ack":
        if (obj.ok) {
          req.resolve(undefined);
        } else {
          req.reject(new Error(String(obj.error ?? "engine_error")));
        }
        return;
      default:
        // Unknown response shape — resolve with the raw payload.
        req.resolve(obj as unknown);
    }
  }

  private toEngineEvent(
    obj: Record<string, unknown>,
  ): EngineEvent | null {
    switch (obj.type) {
      case "text":
        return { type: "text", content: String(obj.content ?? "") };
      case "tool_call":
        return {
          type: "tool_call",
          tool: String(obj.tool ?? "tool"),
          args: obj.args,
          callId: String(obj.callId ?? ""),
        };
      case "tool_result":
        return {
          type: "tool_result",
          callId: String(obj.callId ?? ""),
          output: String(obj.output ?? ""),
        };
      case "file_changed": {
        const ct = obj.changeType;
        const changeType: "created" | "modified" | "deleted" =
          ct === "created" || ct === "deleted" ? ct : "modified";
        return {
          type: "file_changed",
          filePath: String(obj.filePath ?? ""),
          changeType,
        };
      }
      case "plan":
        return { type: "plan", plan: obj.plan };
      case "approval_request":
        return {
          type: "approval_request",
          callId: String(obj.callId ?? ""),
          tool: String(obj.tool ?? ""),
          description: String(obj.description ?? ""),
        };
      case "usage":
        return {
          type: "usage",
          inputTokens: Number(obj.inputTokens ?? 0),
          outputTokens: Number(obj.outputTokens ?? 0),
          costMinor: String(obj.costMinor ?? "0"),
        };
      case "error":
        return {
          type: "error",
          message: String(obj.message ?? "Unknown error"),
          code: obj.code != null ? String(obj.code) : undefined,
        };
      case "done":
        return {
          type: "done",
          summary:
            obj.summary != null ? String(obj.summary) : undefined,
        };
      default:
        return null;
    }
  }

  private routeTurnEvent(evt: EngineEvent): void {
    const t = this.activeTurn;
    if (!t) return;
    if (t.waiters.length) {
      t.waiters.shift()!(evt);
    } else {
      t.queue.push(evt);
    }
    if (evt.type === "done" || evt.type === "error") {
      t.done = true;
    }
  }

  private endTurn(): void {
    const t = this.activeTurn;
    if (!t) return;
    t.done = true;
    if (t.queue.length === 0) {
      // Unblock any waiter with a null sentinel (generator will terminate).
      while (t.waiters.length) {
        t.waiters.shift()!(null);
      }
    }
  }

  private async dequeueTurn(): Promise<EngineEvent | null> {
    const t = this.activeTurn;
    if (!t) return null;
    if (t.queue.length) return t.queue.shift() ?? null;
    if (t.done) return null;
    return new Promise<EngineEvent | null>((resolve) => {
      t.waiters.push(resolve);
    });
  }

  private sendRequest<T>(payload: Record<string, unknown>, timeoutMs = 15000): Promise<T> {
    const reqId = randomBytes(8).toString("hex");
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(reqId)) {
          reject(new Error("engine_timeout"));
        }
      }, timeoutMs);
      this.pending.set(reqId, {
        resolve: (v: unknown) => resolve(v as T),
        reject,
        timer,
      });
      try {
        this.write({ ...payload, reqId });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(reqId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
}
