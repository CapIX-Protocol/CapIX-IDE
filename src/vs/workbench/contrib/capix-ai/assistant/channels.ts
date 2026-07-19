/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-ai/assistant/channels — IPC registration contract for the assistant's
 *  session-history bridge (main ↔ renderer).
 *
 *  These channels back the assistant's history list and resume flow. They are
 *  read-only with respect to credentials: listing sessions forces an
 *  authenticated round-trip through the canonical broker first, and no
 *  response carries token material (architecture §11.4–11.5).
 *--------------------------------------------------------------------------------------------*/

/**
 * Channel names for the assistant session bridge. Streaming itself stays on
 * the `capix:chat:*` channels (see ../index.ts); these cover the durable
 * session surface the assistant timeline/history needs.
 */
export const CapixAssistantChannels = {
	/** Renderer → main: list durable agent sessions (optionally per project). */
	listSessions: "capix:agent:listSessions",
	/** Renderer → main: resume a session with its full message history. */
	resumeSession: "capix:agent:resumeSession",
} as const;

export type CapixAssistantChannelName =
	| (typeof CapixAssistantChannels)[keyof typeof CapixAssistantChannels];

/**
 * Typed IPC registration contract. The Electron main process registers exactly
 * these handlers; both require an authenticated broker round-trip before any
 * session state crosses the boundary.
 */
export interface CapixAssistantIpcContract {
	[CapixAssistantChannels.listSessions]: {
		request: { projectId?: string } | undefined;
		response: { sessions: import("../chatService.js").ChatSession[] };
	};
	[CapixAssistantChannels.resumeSession]: {
		request: { sessionId: string };
		response: import("../chatService.js").ChatSession;
	};
}
