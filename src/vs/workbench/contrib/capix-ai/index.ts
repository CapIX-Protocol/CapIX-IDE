/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-ai — barrel export + IPC registration contract for main↔renderer chat
 *  communication.
 *
 *  The renderer consumes streamed chat events through typed IPC only. It never obtains a
 *  provider/shared endpoint key, a generic `authenticatedFetch`, or raw model HTTP
 *  addresses (architecture §11.4–11.5).
 *--------------------------------------------------------------------------------------------*/

export type {
	ChatMessage,
	ChatSession,
	ChatStreamEvent,
	CapixModelCatalogEntry,
	CapixChatService,
} from "./chatService.js";

// Resizable right-side assistant (secondary sidebar): framework-free view
// model + DOM renderer + the session-history IPC contract.
export {
	CapixAssistantChannels,
	type CapixAssistantChannelName,
	type CapixAssistantIpcContract,
} from "./assistant/channels.js";
export {
	CapixAssistantController,
	CAPIX_ASSISTANT_MODES,
	CAPIX_ASSISTANT_DEFAULT_WIDTH,
	CAPIX_ASSISTANT_MIN_WIDTH,
	CAPIX_ASSISTANT_MAX_WIDTH,
	type CapixAssistantMode,
	type CapixAssistantStatus,
	type CapixAssistantError,
	type CapixAssistantBridge,
	type CapixAssistantStorage,
	type CapixAssistantSnapshot,
	type CapixAssistantSessionSummary,
	type CapixContextChip,
	type CapixTimelineEntry,
} from "./assistant/assistantState.js";
export {
	mountCapixAssistant,
	type CapixAssistantViewHandle,
	type CapixAssistantViewOptions,
} from "./assistant/assistantView.js";

/**
 * Channel names for the main↔renderer chat bridge. Streaming uses a single multiplexed
 * channel that fans out `ChatStreamEvent`s; cancel and listModels are request/response.
 */
export const CapixChatChannels = {
	/** Renderer → main: start a streaming session bound to model + project. */
	startSession: "capix:chat:startSession",
	/** Renderer → main: stream a message; main → renderer: `ChatStreamEvent` fan-out. */
	streamMessage: "capix:chat:streamMessage",
	/** Main → renderer: one streamed chunk for an active session. */
	onStreamEvent: "capix:chat:onStreamEvent",
	/** Renderer → main: cancel an in-flight stream (idempotent). */
	cancel: "capix:chat:cancel",
	/** Renderer → main: fetch the server model catalog. */
	listModels: "capix:chat:listModels",
} as const;

export type CapixChatChannelName =
	| (typeof CapixChatChannels)[keyof typeof CapixChatChannels];

/**
 * Typed IPC registration contract. `streamMessage` returns an opaque stream handle the
 * renderer subscribes to via `onStreamEvent`; the broker owns the generated-SDK call and
 * the AbortSignal lifecycle.
 */
export interface CapixChatIpcContract {
	[CapixChatChannels.startSession]: {
		request: { modelId: string; projectId: string };
		response: import("./chatService.js").ChatSession;
	};
	[CapixChatChannels.streamMessage]: {
		request: { sessionId: string; message: string };
		response: { streamHandle: string };
	};
	[CapixChatChannels.onStreamEvent]: {
		request: { streamHandle: string; event: import("./chatService.js").ChatStreamEvent };
		response: void;
	};
	[CapixChatChannels.cancel]: {
		request: { sessionId: string };
		response: void;
	};
	[CapixChatChannels.listModels]: {
		request: void;
		response: import("./chatService.js").CapixModelCatalogEntry[];
	};
}
