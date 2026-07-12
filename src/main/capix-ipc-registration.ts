import { randomUUID } from "node:crypto";
import type { RendererToMainMessage } from "../vs/workbench/contrib/capix-auth/ipc.js";
import type { CapixMainBroker } from "./capix-broker.js";
import { CapixChatChannels } from "../vs/workbench/contrib/capix-ai/index.js";

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

	broker.setStreamSink((handleId, event) => {
		const send = streamSenders.get(handleId);
		if (!send) return;
		send(CapixChatChannels.onStreamEvent, { streamHandle: handleId, event });
		if (event && typeof event === "object" && hasTerminalStreamType(event)) {
			streamSenders.delete(handleId);
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
		return { id: `chat-${randomUUID()}`, modelId: req.modelId, messages: [] };
	});

	ipcMain.removeHandler(CapixChatChannels.streamMessage);
	ipcMain.handle(CapixChatChannels.streamMessage, async (event, raw) => {
		const req = raw as { sessionId?: string; message?: string };
		if (!req?.sessionId || !req?.message) throw new TypeError("streamMessage requires sessionId and message");
		const senderSend = event.sender.send;
		if (typeof senderSend !== "function") throw new Error("Renderer sender does not support event forwarding");
		const result = await broker.handleMessage(
			{ type: "inference:stream", input: { sessionId: req.sessionId, message: req.message } },
			{ origin: resolveOrigin(event), processId: event.sender.id },
		) as { sessionId: string };
		const streamHandle = result.sessionId;
		streamSenders.set(streamHandle, (channel, ...args) => senderSend(channel, ...args));
		return { streamHandle };
	});

	ipcMain.removeHandler(CapixChatChannels.cancel);
	ipcMain.handle(CapixChatChannels.cancel, async (event, raw) => {
		const req = raw as { sessionId?: string };
		if (!req?.sessionId) throw new TypeError("cancel requires sessionId");
		await broker.handleMessage(
			{ type: "inference:cancel", sessionId: req.sessionId },
			{ origin: resolveOrigin(event), processId: event.sender.id },
		);
		streamSenders.delete(req.sessionId);
	});

	ipcMain.removeHandler(CapixChatChannels.listModels);
	ipcMain.handle(CapixChatChannels.listModels, async (event) => {
		return broker.handleMessage(
			{ type: "catalog:models" },
			{ origin: resolveOrigin(event), processId: event.sender.id },
		);
	});

	return () => {
		for (const ch of channels) ipcMain.removeHandler(ch);
		streamSenders.clear();
	};
}
