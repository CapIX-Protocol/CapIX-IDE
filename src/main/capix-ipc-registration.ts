import { randomUUID } from "node:crypto";
import type { RendererToMainMessage } from "../vs/workbench/contrib/capix-auth/ipc.js";
import type { CapixMainBroker } from "./capix-broker.js";
import { CapixChatChannels } from "../vs/workbench/contrib/capix-ai/index.js";
import { CapixAssistantChannels } from "../vs/workbench/contrib/capix-ai/assistant/channels.js";

// The assistant session-history channels are owned by the capix-ai contract
// (src/vs/workbench/contrib/capix-ai/assistant/channels.ts); alias them here
// so the registration code reads naturally.
const CapixAgentChannels = CapixAssistantChannels;

interface NativeAgentMessage { role: "user" | "assistant" | "system" | "tool"; content: string; createdAt: number; receiptId?: string }
interface NativeAgentSession {
	id: string; modelId: string; projectId: string; messages: NativeAgentMessage[];
	receiptId?: string; costMinor?: string; currency?: string;
}

export const CAPIX_BROKER_CHANNEL = "capix:broker:v1";

export interface ElectronIpcMainLike {
	handle(channel: string, listener: (event: ElectronInvokeEventLike, message: unknown) => Promise<unknown>): void;
	removeHandler(channel: string): void;
}

export interface ElectronInvokeEventLike {
	sender: { id: number; getURL(): string; send?(channel: string, ...args: unknown[]): void };
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 4096;
}

function hasTerminalStreamType(value: object): value is { type: "final" | "error" } {
	if (!("type" in value)) return false;
	return value.type === "final" || value.type === "error";
}

/**
 * Normalize a Capix usage cost (`{ amount, asset, scale }` integer minor
 * units, e.g. USD-credit at scale 6) into the micro-USD scale (4) the
 * workbench cost surfaces render. Money stays integer-only end to end.
 */
function usageCostToMicroUsd(cost: unknown): string {
	if (!cost || typeof cost !== "object") return "0";
	const { amount, scale } = cost as { amount?: unknown; scale?: unknown };
	const digits = typeof amount === "string" || typeof amount === "number" ? String(amount) : "";
	if (!/^\d+$/.test(digits)) return "0";
	const fromScale = typeof scale === "number" && Number.isInteger(scale) && scale >= 0 ? scale : 6;
	const value = BigInt(digits);
	if (fromScale === 4) return value.toString();
	if (fromScale > 4) return (value / 10n ** BigInt(fromScale - 4)).toString();
	return (value * 10n ** BigInt(4 - fromScale)).toString();
}

export function parseRendererMessage(value: unknown): RendererToMainMessage {
	if (!value || typeof value !== "object") throw new TypeError("Capix IPC message must be an object");
	const message = value as Record<string, unknown>;
	switch (message.type) {
		case "auth:login:start": case "auth:logout": case "auth:getToken": case "account:get": case "catalog:models":
		case "billing:balance": case "billing:invoices": case "workspace:disconnect":
			return { type: message.type } as RendererToMainMessage;
		case "auth:login:callback":
			if (nonEmpty(message.code) && nonEmpty(message.state)) return { type: message.type, code: message.code, state: message.state };
			break;
		case "deployment:get": case "operation:subscribe": case "operation:cancel": case "receipt:get":
			if (nonEmpty(message.id)) return { type: message.type, id: message.id } as RendererToMainMessage;
			break;
		case "inference:cancel":
			if (nonEmpty(message.sessionId)) return { type: message.type, sessionId: message.sessionId };
			break;
		case "workspace:connect":
			if (nonEmpty(message.workspaceId)) return { type: message.type, workspaceId: message.workspaceId };
			break;
		case "deployment:list":
			if (message.cursor === undefined || nonEmpty(message.cursor)) return message.cursor ? { type: message.type, cursor: message.cursor } : { type: message.type };
			break;
		case "quote:create": case "deployment:create": case "inference:stream":
			if (message.input !== undefined) return { type: message.type, input: message.input } as RendererToMainMessage;
			break;
	}
	throw new TypeError("Invalid or unsupported Capix IPC message");
}

export function registerCapixIpc(ipcMain: ElectronIpcMainLike, broker: CapixMainBroker): () => void {
	// Track renderer senders per stream handle so the broker's streamSink can
	// forward ChatStreamEvents back to the originating renderer via the
	// capix:chat:onStreamEvent channel.
	const streamSenders = new Map<string, (channel: string, ...args: unknown[]) => void>();
	const sessions = new Map<string, NativeAgentSession>();
	const streamSessions = new Map<string, string>();
	const activeSessionStreams = new Map<string, string>();

	const normalizeStreamEvent = (handleId: string, raw: unknown): Record<string, unknown> => {
		const session = sessions.get(streamSessions.get(handleId) ?? "");
		const event = raw && typeof raw === "object" ? raw as Record<string, any> : {};
		if (event.type === "error" || event.type === "capix.error") {
			const problem = event.error && typeof event.error === "object" ? event.error : event;
			return { type: "error", capixCode: String(problem.capixCode ?? problem.status ?? "inference_error"), message: String(problem.message ?? problem.detail ?? "Inference failed"), supportId: problem.supportId };
		}
		if (event.type === "route" || event.type === "usage") return event;
		// Canonical Capix stream contract (@capix/contracts inference-stream):
		// capix.route / content.delta / tool.delta / capix.usage / capix.final.
		if (event.type === "capix.route") {
			return { type: "route", receiptId: String(event.receiptId ?? ""), model: String(event.modelCapability ?? ""), region: String(event.region ?? "global"), privacy: event.privacyClass };
		}
		if (event.type === "content.delta") {
			return { type: "delta", content: typeof event.content === "string" ? event.content : "", toolCalls: undefined };
		}
		if (event.type === "tool.delta") {
			return { type: "delta", content: undefined, toolCalls: [{ id: event.toolCallId, function: event.function, index: event.index }] };
		}
		if (event.type === "capix.usage") {
			return { type: "usage", inputTokens: Number(event.inputUnits ?? 0), outputTokens: Number(event.outputUnits ?? 0), costMinor: usageCostToMicroUsd(event.provisionalCost), currency: "USD" };
		}
		if (event.type === "capix.final") {
			return { type: "final", finishReason: String(event.finishReason ?? "stop"), receiptId: String(event.receiptId ?? session?.receiptId ?? "") };
		}
		const choice = Array.isArray(event.choices) ? event.choices[0] : undefined;
		const delta = choice?.delta;
		if (delta?.content !== undefined || delta?.tool_calls !== undefined) {
			return { type: "delta", content: delta.content, toolCalls: delta.tool_calls };
		}
		if (event.usage) {
			return { type: "usage", inputTokens: Number(event.usage.prompt_tokens ?? event.usage.input_tokens ?? 0), outputTokens: Number(event.usage.completion_tokens ?? event.usage.output_tokens ?? 0), costMinor: String(event.usage.cost_minor ?? "0"), currency: String(event.usage.currency ?? "USD") };
		}
		if (event.type === "final" || choice?.finish_reason) {
			return { type: "final", finishReason: String(choice?.finish_reason ?? event.finishReason ?? "stop"), receiptId: String(event.receiptId ?? session?.receiptId ?? "") };
		}
		return event;
	};

	broker.setStreamSink((handleId, event) => {
		const send = streamSenders.get(handleId);
		if (!send) return;
		const normalized = normalizeStreamEvent(handleId, event);
		const sessionId = streamSessions.get(handleId);
		const session = sessionId ? sessions.get(sessionId) : undefined;
		if (session && normalized.type === "delta" && typeof normalized.content === "string") {
			const last = session.messages.at(-1);
			if (last?.role === "assistant") last.content += normalized.content;
			else session.messages.push({ role: "assistant", content: normalized.content, createdAt: Date.now() });
		}
		if (session && normalized.type === "route") session.receiptId = String(normalized.receiptId ?? "");
		if (session && normalized.type === "usage") { session.costMinor = String(normalized.costMinor ?? "0"); session.currency = String(normalized.currency ?? "USD"); }
		send(CapixChatChannels.onStreamEvent, { streamHandle: handleId, event: normalized });
		if (hasTerminalStreamType(normalized)) {
			streamSenders.delete(handleId);
			streamSessions.delete(handleId);
			if (sessionId) activeSessionStreams.delete(sessionId);
		}
	});

	const resolveOrigin = (event: ElectronInvokeEventLike): string => {
		const url = new URL(event.sender.getURL());
		// WHATWG reports `null` for custom-scheme origins in Node. Preserve the
		// exact privileged Code-OSS scheme+host without ever trusting generic null.
		return url.protocol === "vscode-file:" && url.hostname === "vscode-app"
			? "vscode-file://vscode-app"
			: url.origin;
	};

	const channels = [
		CAPIX_BROKER_CHANNEL,
		CapixChatChannels.startSession,
		CapixChatChannels.streamMessage,
		CapixChatChannels.cancel,
		CapixChatChannels.listModels,
		CapixAgentChannels.listSessions,
		CapixAgentChannels.resumeSession,
	];

	// --- Existing versioned broker channel ---

	ipcMain.removeHandler(CAPIX_BROKER_CHANNEL);
	ipcMain.handle(CAPIX_BROKER_CHANNEL, async (event, raw) => {
		const message = parseRendererMessage(raw);
		return broker.handleMessage(message, { origin: resolveOrigin(event), processId: event.sender.id });
	});

	// --- Canonical chat channels (delegate to the existing broker) ---

	ipcMain.removeHandler(CapixChatChannels.startSession);
	ipcMain.handle(CapixChatChannels.startSession, async (_event, raw) => {
		const req = raw as { modelId?: string; projectId?: string };
		if (!req?.modelId || !req?.projectId) throw new TypeError("startSession requires modelId and projectId");
		const session: NativeAgentSession = { id: `chat-${randomUUID()}`, modelId: req.modelId, projectId: req.projectId, messages: [] };
		sessions.set(session.id, session);
		return structuredClone(session);
	});

	ipcMain.removeHandler(CapixChatChannels.streamMessage);
	ipcMain.handle(CapixChatChannels.streamMessage, async (event, raw) => {
		const req = raw as { sessionId?: string; message?: string };
		if (!req?.sessionId || !req?.message) throw new TypeError("streamMessage requires sessionId and message");
		const session = sessions.get(req.sessionId);
		if (!session) throw new TypeError("Unknown Capix agent session");
		if (activeSessionStreams.has(session.id)) throw new TypeError("A stream is already active for this session");
		const senderSend = event.sender.send;
		if (typeof senderSend !== "function") throw new Error("Renderer sender does not support event forwarding");
		session.messages.push({ role: "user", content: req.message, createdAt: Date.now() });
		const streamHandle = `inference-${randomUUID()}`;
		streamSenders.set(streamHandle, (channel, ...args) => senderSend(channel, ...args));
		streamSessions.set(streamHandle, session.id);
		activeSessionStreams.set(session.id, streamHandle);
		try {
			await broker.handleMessage(
				{ type: "inference:stream", input: { capixStreamHandle: streamHandle, model: session.modelId, projectId: session.projectId, sessionId: session.id, stream: true, messages: session.messages.map(({ role, content }) => ({ role, content })) } },
				{ origin: resolveOrigin(event), processId: event.sender.id },
			);
			return { streamHandle };
		} catch (error) {
			streamSenders.delete(streamHandle); streamSessions.delete(streamHandle); activeSessionStreams.delete(session.id);
			throw error;
		}
	});

	ipcMain.removeHandler(CapixChatChannels.cancel);
	ipcMain.handle(CapixChatChannels.cancel, async (event, raw) => {
		const req = raw as { sessionId?: string };
		if (!req?.sessionId) throw new TypeError("cancel requires sessionId");
		const handle = activeSessionStreams.get(req.sessionId) ?? req.sessionId;
		await broker.handleMessage(
			{ type: "inference:cancel", sessionId: handle },
			{ origin: resolveOrigin(event), processId: event.sender.id },
		);
		streamSenders.delete(handle);
		streamSessions.delete(handle);
		activeSessionStreams.delete(req.sessionId);
	});

	ipcMain.removeHandler(CapixChatChannels.listModels);
	ipcMain.handle(CapixChatChannels.listModels, async (event) => {
		const models = await broker.handleMessage(
			{ type: "catalog:models" },
			{ origin: resolveOrigin(event), processId: event.sender.id },
		);
		return { models };
	});

	ipcMain.removeHandler(CapixAgentChannels.listSessions);
	ipcMain.handle(CapixAgentChannels.listSessions, async (event, raw) => {
		// Force authentication through the canonical broker before exposing state.
		await broker.handleMessage({ type: "auth:getToken" }, { origin: resolveOrigin(event), processId: event.sender.id });
		const projectId = (raw as { projectId?: string } | undefined)?.projectId;
		return { sessions: [...sessions.values()].filter(s => !projectId || s.projectId === projectId).map(s => structuredClone(s)) };
	});

	ipcMain.removeHandler(CapixAgentChannels.resumeSession);
	ipcMain.handle(CapixAgentChannels.resumeSession, async (event, raw) => {
		await broker.handleMessage({ type: "auth:getToken" }, { origin: resolveOrigin(event), processId: event.sender.id });
		const sessionId = (raw as { sessionId?: string } | undefined)?.sessionId;
		if (!sessionId) throw new TypeError("resumeSession requires sessionId");
		const session = sessions.get(sessionId);
		if (!session) throw new TypeError("Unknown Capix agent session");
		return structuredClone(session);
	});

	return () => {
		for (const ch of channels) ipcMain.removeHandler(ch);
		streamSenders.clear();
	};
}
