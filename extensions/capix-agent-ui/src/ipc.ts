/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-agent-ui/ipc - typed IPC contract for the capix-agent-ui built-in
 *  extension: chat view, agent sessions and tool approval (architecture S10.3,
 *  S11.5; target ownership: extensions/capix-agent-ui/).
 *
 *  The extension is the graphical client of the bundled Capix Agent Runtime. It
 *  connects to the runtime through the Capix agent protocol owned by the
 *  main-process broker - never a fake onMessage interface and never a raw model
 *  HTTP call. The runtime requests inference through the privileged broker, so
 *  short-lived gateway credentials need not enter the model engine or its tool
 *  subprocesses (architecture S11.5).
 *
 *  Tool policy is enforced by the broker, not merely written in a prompt. Approval
 *  prompts alone are not a sandbox: every deferred tool call carries exact
 *  executable/args/cwd/network/timeout/side-effect detail for human confirmation.
 *--------------------------------------------------------------------------------------------*/

/** A model entry from the server catalog (stable ID, capabilities, availability). */
export interface AgentCatalogEntry {
	id: string;
	name: string;
	capabilities: string[];
	/** Privacy class for the actual route; 'private' describes the exact path. */
	privacy?: "public" | "private" | "dedicated";
	region?: string;
	/** Indicative price in native minor units per 1M tokens. */
	priceMinorPerMTokens?: string;
	currency?: string;
	available: boolean;
}

/** A single message in a Capix chat session. */
export interface AgentMessage {
	role: "user" | "assistant" | "system" | "tool";
	content: string;
	toolCalls?: unknown[];
	/** ReceiptId for the route that produced this assistant message. */
	receiptId?: string;
	createdAt: number;
}

/** A Capix agent/chat session. */
export interface AgentSession {
	id: string;
	modelId: string;
	projectId: string;
	messages: AgentMessage[];
	receiptId?: string;
	/** Validated usage cost in native minor units from capix.usage/capix.final. */
	costMinor?: string;
	currency?: string;
}

/** Streamed chunk from the inference gateway (maps capix route/usage/final/error). */
export type AgentStreamEvent =
	| { type: "delta"; content?: string; toolCalls?: unknown[] }
	| { type: "route"; receiptId: string; model: string; region: string; privacy?: string }
	| { type: "usage"; inputTokens: number; outputTokens: number; costMinor: string; currency: string }
	| { type: "final"; finishReason: string; receiptId: string }
	| { type: "error"; capixCode: string; message: string; supportId?: string };

/**
 * A deferred tool call awaiting human approval. The broker enforces the tool
 * policy; the UI only renders the exact, non-redacted proposal for confirmation.
 * Disconnect fails pending permissions closed (any in-flight prompt is denied).
 */
export interface ToolApprovalRequest {
	/** Unique id for this approval; the broker correlates approve/deny to it. */
	approvalId: string;
	sessionId: string;
	tool: string;
	/** Exact executable and resolved args (never a shell string, never a glob). */
	executable?: string;
	args?: string[];
	cwd?: string;
	/** Environment delta over the scrubbed allowlisted base (shown before approval). */
	envDelta?: Record<string, string>;
	network?: boolean;
	timeoutMs?: number;
	sideEffect?: string;
	/** One-shot, operation-specific, cost-bound commit token if billable. */
	billable?: { description: string; costMinor: string; currency: string };
}

/** Channel names for the main <-> agent-extension bridge (mirrors core capix-ai). */
export const CapixAgentChannels = {
	/** chat:start / catalog:models over the broker. */
	startSession: "capix:chat:startSession",
	/** chat:message; main -> renderer streams ChatStreamEvent via onStreamEvent. */
	streamMessage: "capix:chat:streamMessage",
	/** Main -> renderer: one streamed chunk for an active session. */
	onStreamEvent: "capix:chat:onStreamEvent",
	/** chat:cancel: idempotent cancel; finalizes under the partial-delivery rule. */
	cancel: "capix:chat:cancel",
	/** chat:models: server model catalog. */
	listModels: "capix:chat:listModels",
	/** List the caller's agent sessions (resume). */
	listSessions: "capix:agent:listSessions",
	/** Resume an existing session by id. */
	resumeSession: "capix:agent:resumeSession",
	/** Runtime requests deferred tool approval; main -> renderer fan-out. */
	onToolApproval: "capix:agent:onToolApproval",
	/** Human approves a deferred tool call (separate from the prompt). */
	approveTool: "capix:agent:approveTool",
	/** Human denies a deferred tool call; pending permission treated as denied. */
	denyTool: "capix:agent:denyTool",
} as const;

export type CapixAgentChannelName =
	| (typeof CapixAgentChannels)[keyof typeof CapixAgentChannels];

/** Typed request/response pairs for every agent bridge operation. */
export interface CapixAgentIpcContract {
	[CapixAgentChannels.startSession]: {
		request: { modelId: string; projectId: string };
		response: AgentSession;
	};
	[CapixAgentChannels.streamMessage]: {
		request: { sessionId: string; message: string };
		/** Opaque stream handle; subscribe via onStreamEvent. */
		response: { streamHandle: string };
	};
	[CapixAgentChannels.onStreamEvent]: {
		request: { streamHandle: string; event: AgentStreamEvent };
		response: void;
	};
	[CapixAgentChannels.cancel]: {
		request: { sessionId: string };
		response: void;
	};
	[CapixAgentChannels.listModels]: {
		request: void;
		response: { models: AgentCatalogEntry[] };
	};
	[CapixAgentChannels.listSessions]: {
		request: { projectId?: string };
		response: { sessions: AgentSession[] };
	};
	[CapixAgentChannels.resumeSession]: {
		request: { sessionId: string };
		response: AgentSession;
	};
	[CapixAgentChannels.onToolApproval]: {
		request: ToolApprovalRequest;
		response: void;
	};
	[CapixAgentChannels.approveTool]: {
		request: { approvalId: string };
		response: void;
	};
	[CapixAgentChannels.denyTool]: {
		request: { approvalId: string };
		response: void;
	};
}
