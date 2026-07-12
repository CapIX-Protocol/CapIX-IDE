import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import type { CapixClient } from "./apiClient";

type Message = { role: "user" | "assistant" | "system" | "tool"; content: string; createdAt: number };
type Session = { id: string; modelId: string; projectId: string; messages: Message[]; receiptId?: string; costMinor?: string; currency?: string };

/** Extension-host bridge consumed by capix-agent-ui through vscode.commands. */
export class AgentCommandBridge implements vscode.Disposable {
  private readonly sessions = new Map<string, Session>();
  private readonly streams = new Map<string, { sessionId: string; abort: AbortController }>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly client: CapixClient) {}

  register(): vscode.Disposable {
    const command = (id: string, fn: (...args: any[]) => any) => this.disposables.push(vscode.commands.registerCommand(id, fn));
    command("capix:chat:startSession", (req) => this.start(req));
    command("capix:chat:streamMessage", (req) => this.stream(req));
    command("capix:chat:cancel", (req) => this.cancel(req));
    command("capix:chat:listModels", () => this.models());
    command("capix:agent:listSessions", (req) => this.list(req));
    command("capix:agent:resumeSession", (req) => this.resume(req));
    return this;
  }

  dispose(): void { for (const stream of this.streams.values()) stream.abort.abort(); this.streams.clear(); for (const item of this.disposables.splice(0)) item.dispose(); }

  private async requireAuth(): Promise<void> { if (!await this.client.checkConfigured()) throw Object.assign(new Error("Not signed in to Capix."), { capixCode: "401" }); }
  private clone(session: Session): Session { return structuredClone(session); }

  private async start(req: { modelId?: string; projectId?: string }): Promise<Session> {
    await this.requireAuth();
    if (!req?.modelId || !req?.projectId) throw new TypeError("startSession requires modelId and projectId");
    const session: Session = { id: `chat-${randomUUID()}`, modelId: req.modelId, projectId: req.projectId, messages: [] };
    this.sessions.set(session.id, session); return this.clone(session);
  }

  private async models(): Promise<{ models: unknown[] }> {
    await this.requireAuth();
    const result = await this.client.get<{ models?: unknown[] }>("/api/llm/models");
    return { models: result.models ?? [] };
  }

  private async list(req?: { projectId?: string }): Promise<{ sessions: Session[] }> {
    await this.requireAuth();
    return { sessions: [...this.sessions.values()].filter(s => !req?.projectId || s.projectId === req.projectId).map(s => this.clone(s)) };
  }

  private async resume(req: { sessionId?: string }): Promise<Session> {
    await this.requireAuth();
    const session = req?.sessionId ? this.sessions.get(req.sessionId) : undefined;
    if (!session) throw new TypeError("Unknown Capix agent session");
    return this.clone(session);
  }

  private async stream(req: { sessionId?: string; message?: string }): Promise<{ streamHandle: string }> {
    await this.requireAuth();
    const session = req?.sessionId ? this.sessions.get(req.sessionId) : undefined;
    if (!session || !req?.message) throw new TypeError("streamMessage requires a valid sessionId and message");
    if ([...this.streams.values()].some(s => s.sessionId === session.id)) throw new Error("A stream is already active for this session");
    session.messages.push({ role: "user", content: req.message, createdAt: Date.now() });
    const streamHandle = `inference-${randomUUID()}`;
    const abort = new AbortController(); this.streams.set(streamHandle, { sessionId: session.id, abort });
    setTimeout(() => void this.consume(streamHandle, session, abort.signal), 0);
    return { streamHandle };
  }

  private async consume(handle: string, session: Session, signal: AbortSignal): Promise<void> {
    try {
      await this.client.streamAgentChat({ model: session.modelId, projectId: session.projectId, sessionId: session.id, stream: true, messages: session.messages.map(({ role, content }) => ({ role, content })) }, signal, async event => {
        if (event.type === "delta" && typeof event.content === "string") {
          const last = session.messages.at(-1); if (last?.role === "assistant") last.content += event.content; else session.messages.push({ role: "assistant", content: event.content, createdAt: Date.now() });
        }
        if (event.type === "route") session.receiptId = String(event.receiptId ?? "");
        if (event.type === "usage") { session.costMinor = String(event.costMinor ?? "0"); session.currency = String(event.currency ?? "USD"); }
        await vscode.commands.executeCommand("capix:chat:onStreamEvent", { streamHandle: handle, event });
      });
      if (!signal.aborted) await vscode.commands.executeCommand("capix:chat:onStreamEvent", { streamHandle: handle, event: { type: "final", finishReason: "stop", receiptId: session.receiptId ?? "" } });
    } catch (error: any) {
      if (!signal.aborted) await vscode.commands.executeCommand("capix:chat:onStreamEvent", { streamHandle: handle, event: { type: "error", capixCode: String(error?.status ?? error?.capixCode ?? "inference_error"), message: error?.message ?? "Inference failed" } });
    } finally { this.streams.delete(handle); }
  }

  private async cancel(req: { sessionId?: string }): Promise<void> {
    const stream = [...this.streams.entries()].find(([handle, value]) => value.sessionId === req?.sessionId || handle === req?.sessionId);
    if (!stream) return;
    stream[1].abort.abort(); this.streams.delete(stream[0]);
  }
}
