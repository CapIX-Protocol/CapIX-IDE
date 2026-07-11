/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-ai — real Capix chat service.
 *
 *  This module connects the CapixIDE graphitor/agent UI to the real Capix inference
 *  provider through the generated Capix SDK and the bundled Capix Agent Runtime. It does
 *  NOT use Void's provider path, a handwritten `fetch`, or an OpenAI-compatible shim that
 *  would lose tool-call streaming, cancellation, typed errors, receipt metadata or usage
 *  (architecture §11.5, §6.5; master prompt I5).
 *
 *  Process model:
 *    - The main process brokers inference/auth so the runtime and its tool subprocesses
 *      never receive long-lived credentials. Inference is requested through the privileged
 *      broker; the shared hosted vLLM key is never revealed or copied to a client.
 *    - The streamed chat comes from the Capix inference gateway, which owns route
 *      selection, private endpoint routing and the route receipt.
 *--------------------------------------------------------------------------------------------*/

/** A single message in a Capix chat session. */
export interface ChatMessage {
	role: "user" | "assistant" | "system" | "tool";
	content: string;
	/** Tool calls requested by the assistant, streamed as deltas by the gateway. */
	toolCalls?: unknown[];
}

/**
 * A Capix chat session. The server-side route receipt (`receiptId`) and the validated
 * cost in native minor units (`costMinor`) travel with the session so the UI can show
 * placement, privacy, usage and final cost consistently with web and Capix Code
 * (architecture §6.5, §7.5; master prompt I5).
 */
export interface ChatSession {
	id: string;
	modelId: string;
	messages: ChatMessage[];
	/** Immutable route receipt from the smart router (rendered identically in web/IDE/Code). */
	receiptId?: string;
	/** Validated usage cost in native minor units, from the `capix.usage`/`capix.final` events. */
	costMinor?: bigint;
}

/**
 * A single streamed chunk from the inference gateway. Maps the Capix stream extensions
 * (architecture §6.5): content/tool deltas, `capix.route`, `capix.usage`, `capix.final`
 * and `capix.error`.
 */
export interface ChatStreamEvent {
	type: "content" | "tool" | "route" | "usage" | "final" | "error";
	content?: string;
	toolCalls?: unknown[];
	receiptId?: string;
	costMinor?: bigint;
	error?: string;
}

/** A model entry from the server catalog. */
export interface CapixModelCatalogEntry {
	id: string;
	name: string;
	capabilities: string[];
}

/**
 * The canonical AI chat service. Implemented in the main process and exposed to the
 * renderer as typed IPC; the renderer never issues authenticated inference calls itself.
 */
export interface CapixChatService {
	/**
	 * Start a streaming chat session bound to a model and project. The server router
	 * remains authoritative: the client may pass `auto`, an explicit stable model ID, or
	 * an owned private-resource ID plus a saved policy ID.
	 */
	startSession(params: { modelId: string; projectId: string }): Promise<ChatSession>;

	/**
	 * Stream a user message through the Capix provider using the generated SDK — never a
	 * raw `fetch`. Yields `content`/`tool`/`route`/`usage`/`final`/`error` events. The
	 * `signal` cancels an in-flight stream and finalizes it under the documented
	 * partial-delivery rule (no duplicated output or charge after the first token).
	 */
	streamMessage(
		sessionId: string,
		message: string,
		signal: AbortSignal,
	): AsyncGenerator<ChatStreamEvent>;

	/** Cancel an in-flight stream for a session. Idempotent. */
	cancel(sessionId: string): Promise<void>;

	/** List available models from the server catalog (stable ID, capabilities, availability). */
	listModels(): Promise<CapixModelCatalogEntry[]>;
}
