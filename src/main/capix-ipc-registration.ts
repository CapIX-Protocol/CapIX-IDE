import type { RendererToMainMessage } from "../vs/workbench/contrib/capix-auth/ipc.js";
import type { CapixMainBroker } from "./capix-broker.js";

export const CAPIX_BROKER_CHANNEL = "capix:broker:v1";

export interface ElectronIpcMainLike {
	handle(channel: string, listener: (event: ElectronInvokeEventLike, message: unknown) => Promise<unknown>): void;
	removeHandler(channel: string): void;
}

export interface ElectronInvokeEventLike {
	sender: { id: number; getURL(): string };
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 4096;
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
	ipcMain.removeHandler(CAPIX_BROKER_CHANNEL);
	ipcMain.handle(CAPIX_BROKER_CHANNEL, async (event, raw) => {
		const url = new URL(event.sender.getURL());
		const message = parseRendererMessage(raw);
		// WHATWG reports `null` for custom-scheme origins in Node. Preserve the
		// exact privileged Code-OSS scheme+host without ever trusting generic null.
		const origin = url.protocol === "vscode-file:" && url.hostname === "vscode-app"
			? "vscode-file://vscode-app"
			: url.origin;
		return broker.handleMessage(message, { origin, processId: event.sender.id });
	});
	return () => ipcMain.removeHandler(CAPIX_BROKER_CHANNEL);
}
