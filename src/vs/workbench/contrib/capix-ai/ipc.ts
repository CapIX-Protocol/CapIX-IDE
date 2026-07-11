/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-ai/ipc — the IPC contract for Capix AI chat streaming between the
 *  workbench renderer and the privileged main-process broker (architecture
 *  §11.5).
 *
 *  The renderer never issues authenticated inference HTTP itself. It requests a
 *  chat session through `chat:start`, streams deltas through `chat:message`, and
 *  cancels through `chat:cancel`. The broker owns the generated-SDK call, route
 *  receipt correlation, usage/cost attribution and the AbortSignal lifecycle.
 *
 *  Stream semantics:
 *    - Disconnect fails pending permissions closed. Any in-flight permission
 *      prompt that did not complete is treated as denied.
 *    - Cancellation stops the stream immediately and finalizes it under the
 *      documented partial-delivery rule (no duplicated output or charge after
 *      the first delivered token).
 *    - `chat:route`, `chat:usage` and `chat:final` mirror the server-side
 *      `capix.route` / `capix.usage` / `capix.final` stream extensions so that
 *      placement, privacy, usage and final cost render identically in web, IDE
 *      and Capix Code.
 *    - `chat:error` carries a typed Capix error code (and optional support id);
 *      it is never a raw fetch rejection.
 *--------------------------------------------------------------------------------------------*/

/**
 * Renderer → Main chat operations. Each is a narrow, audited request; there is
 * no generic model HTTP call surface. `chat:models` lists the server catalog
 * (stable model ID, capabilities, availability, privacy/region/price).
 */
export type ChatIpcMessage =
	| { type: "chat:start"; modelId: string; projectId: string }
	| { type: "chat:message"; sessionId: string; content: string }
	| { type: "chat:cancel"; sessionId: string }
	| { type: "chat:models" };

/**
 * Main → Renderer chat stream responses. The broker fans these out for the
 * active session. `chat:started` returns the session id; deltas stream content
 * and tool calls; cost/usage and the final receipt close the stream; typed
 * errors never leak provider credentials or raw transport details.
 */
export type ChatIpcResponse =
	| { type: "chat:started"; sessionId: string }
	| { type: "chat:delta"; sessionId: string; content?: string; toolCalls?: unknown[] }
	| { type: "chat:route"; sessionId: string; receiptId: string; model: string; region: string }
	| { type: "chat:usage"; sessionId: string; inputTokens: number; outputTokens: number; costMinor: string }
	| { type: "chat:final"; sessionId: string; finishReason: string; receiptId: string }
	| { type: "chat:error"; sessionId: string; capixCode: string; message: string; supportId?: string };
