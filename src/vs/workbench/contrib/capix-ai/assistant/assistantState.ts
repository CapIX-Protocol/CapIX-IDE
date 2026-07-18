/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-ai/assistant/assistantState — framework-free view model for the
 *  resizable right-side Capix assistant.
 *
 *  The controller owns every piece of assistant UI state — panel width,
 *  session history (with search), mode/model selection, context chips, the
 *  plan/tool/diff timeline, the compact composer, connectivity and the
 *  recoverable error surface — and talks to the privileged main process
 *  exclusively through the injected `CapixAssistantBridge` (typed IPC,
 *  architecture §11.5). It never holds a credential, a raw stream handle or a
 *  provider address, and it renders no DOM: `assistantView.ts` subscribes to
 *  `onDidChange` and paints the state.
 *
 *  Behaviours layered on top of the raw bridge:
 *    - real-time streaming: content deltas accumulate into the pending
 *      assistant message and are emitted on a batched (frame-aligned) tick so
 *      high-frequency gateway events never thrash the view;
 *    - optimistic UI: the user turn is appended before the broker round-trip
 *      and removed again only if session creation fails;
 *    - error recovery: failures surface as a typed `lastError` (retryable by
 *      default) and the failed turn is kept for one-tap `retryLastTurn()`;
 *    - session persistence: width, mode, model, the active session id and
 *      per-session composer drafts survive restarts via `CapixAssistantStorage`;
 *    - offline awareness: `setOffline(true)` parks the composer and replays
 *      cleanly when connectivity returns.
 *
 *  Money is integer minor units end-to-end (`costMinor` strings); display
 *  formatting happens at the edge. Customer-facing state never names upstream
 *  providers.
 *--------------------------------------------------------------------------------------------*/

import type {
	ChatSession,
	ChatStreamEvent,
	CapixModelCatalogEntry,
} from "../chatService.js";

/** Agent modes shared with the Capix agent runtime (ask/plan/build/debug/review). */
export type CapixAssistantMode = "ask" | "plan" | "build" | "debug" | "review";

export const CAPIX_ASSISTANT_MODES: readonly CapixAssistantMode[] = [
	"ask",
	"plan",
	"build",
	"debug",
	"review",
];

/** High-level lifecycle the view uses to pick empty/loading/error/offline states. */
export type CapixAssistantStatus = "idle" | "streaming" | "error" | "offline";

/** A context chip pinned to the composer (file, selection, project, terminal, docs). */
export interface CapixContextChip {
	id: string;
	kind: "file" | "selection" | "project" | "terminal" | "docs";
	label: string;
	/** Secondary text (path, line range, source). */
	detail?: string;
	/** Payload inlined into the next submitted message, then the chip clears. */
	snippet?: string;
}

/**
 * A recoverable assistant failure. `retryable` failures keep the failed turn's
 * payload so `retryLastTurn()` can resubmit it verbatim; `supportId` is the
 * broker-issued reference the user can quote to support.
 */
export interface CapixAssistantError {
	message: string;
	capixCode?: string;
	supportId?: string;
	retryable: boolean;
}

/**
 * One entry in the plan/tool/diff timeline. The assistant renders a single
 * chronological stream: chat messages interleaved with plan checklists, tool
 * cards (including approval gates), file-diff chips, usage ticks and typed
 * errors — the same shapes the shared agent runtime emits.
 */
export type CapixTimelineEntry =
	| {
			id: string;
			kind: "message";
			role: "user" | "assistant" | "system";
			content: string;
			streaming?: boolean;
	  }
	| {
			id: string;
			kind: "plan";
			title: string;
			steps: Array<{
				label: string;
				status: "pending" | "in-progress" | "completed" | "failed" | "skipped";
			}>;
	  }
	| {
			id: string;
			kind: "tool";
			tool: string;
			callId?: string;
			status: "running" | "awaiting-approval" | "completed" | "failed" | "denied";
			detail?: string;
			output?: string;
	  }
	| {
			id: string;
			kind: "diff";
			filePath: string;
			changeType: "created" | "modified" | "deleted";
			summary?: string;
	  }
	| {
			id: string;
			kind: "usage";
			inputTokens: number;
			outputTokens: number;
			/** Validated cost in integer minor units (native asset scale). */
			costMinor: string;
	  }
	| {
			id: string;
			kind: "error";
			message: string;
			capixCode?: string;
			supportId?: string;
	  };

/** A session row in the assistant history list. */
export interface CapixAssistantSessionSummary {
	id: string;
	modelId: string;
	title: string;
	updatedAt: string;
	costMinor?: string;
}

/**
 * The typed bridge to the privileged broker. Implemented in the renderer by
 * invoking the `capix:chat:*` / `capix:agent:*` IPC channels; implemented in
 * tests by an in-memory fake. Every method maps 1:1 to an audited IPC channel.
 */
export interface CapixAssistantBridge {
	startSession(params: { modelId: string; projectId: string }): Promise<ChatSession>;
	streamMessage(
		sessionId: string,
		message: string,
		signal: AbortSignal,
	): AsyncGenerator<ChatStreamEvent>;
	cancel(sessionId: string): Promise<void>;
	listModels(): Promise<CapixModelCatalogEntry[]>;
	listSessions(projectId?: string): Promise<ChatSession[]>;
	resumeSession(sessionId: string): Promise<ChatSession>;
}

/** Minimal key/value persistence for panel sizing and last-used selections. */
export interface CapixAssistantStorage {
	get(key: string): string | undefined;
	set(key: string, value: string): void;
}

export interface CapixAssistantSnapshot {
	width: number;
	minWidth: number;
	maxWidth: number;
	sessions: CapixAssistantSessionSummary[];
	/** Sessions after the history search filter has been applied. */
	visibleSessions: CapixAssistantSessionSummary[];
	activeSessionId: string | undefined;
	mode: CapixAssistantMode;
	modelId: string;
	models: CapixModelCatalogEntry[];
	chips: CapixContextChip[];
	entries: CapixTimelineEntry[];
	draft: string;
	streaming: boolean;
	projectId: string;
	/** Running total for the active session, integer minor units. */
	costMinor: string;
	/** Derived lifecycle state for empty/loading/error/offline rendering. */
	status: CapixAssistantStatus;
	offline: boolean;
	lastError: CapixAssistantError | undefined;
	sessionQuery: string;
	/** True while the first history/catalog load is in flight. */
	initializing: boolean;
}

export const CAPIX_ASSISTANT_DEFAULT_WIDTH = 360;
export const CAPIX_ASSISTANT_MIN_WIDTH = 280;
export const CAPIX_ASSISTANT_MAX_WIDTH = 720;

const WIDTH_STORAGE_KEY = "capix.assistant.width";
const MODE_STORAGE_KEY = "capix.assistant.mode";
const MODEL_STORAGE_KEY = "capix.assistant.model";
const ACTIVE_SESSION_STORAGE_KEY = "capix.assistant.activeSession";
const DRAFT_STORAGE_PREFIX = "capix.assistant.draft.";

/** Content deltas batch onto one emit per tick so the view repaints per frame, not per token. */
const STREAM_EMIT_INTERVAL_MS = 16;

let nextEntryId = 1;
function entryId(): string {
	return `entry-${nextEntryId++}`;
}

/** `Omit` distributes poorly over unions; this keeps each timeline variant intact. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function sessionTitle(session: ChatSession): string {
	const firstUser = session.messages.find((m) => m.role === "user");
	const text = firstUser?.content.trim().replace(/\s+/g, " ") ?? "";
	return text ? (text.length > 60 ? `${text.slice(0, 57)}…` : text) : "New session";
}

function toSummary(session: ChatSession): CapixAssistantSessionSummary {
	return {
		id: session.id,
		modelId: session.modelId,
		title: sessionTitle(session),
		updatedAt: new Date().toISOString(),
		costMinor: session.costMinor !== undefined ? String(session.costMinor) : undefined,
	};
}

/** Classify a thrown/streamed failure into the typed, recoverable error surface. */
function normalizeError(err: unknown): CapixAssistantError {
	if (err instanceof DOMException && err.name === "AbortError") {
		return { message: "Turn cancelled.", retryable: false };
	}
	const raw = err instanceof Error ? err.message : String(err);
	const supportMatch = /support[:#-]?\s*([A-Za-z0-9-]{6,})/i.exec(raw);
	const offline = /network|offline|econn|enotfound|timed? ?out|fetch failed/i.test(raw);
	return {
		message: raw || "Capix inference was interrupted.",
		supportId: supportMatch?.[1],
		retryable: true,
		capixCode: offline ? "capix.network.unreachable" : undefined,
	};
}

function sessionMatches(summary: CapixAssistantSessionSummary, query: string): boolean {
	if (!query) return true;
	const haystack = `${summary.title} ${summary.modelId}`.toLowerCase();
	return query
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean)
		.every((token) => haystack.includes(token));
}

/**
 * The assistant view model. All mutations go through methods that end by
 * notifying listeners; the view never mutates state directly.
 */
export class CapixAssistantController {
	private width = CAPIX_ASSISTANT_DEFAULT_WIDTH;
	private sessions: CapixAssistantSessionSummary[] = [];
	private activeSessionId: string | undefined;
	private mode: CapixAssistantMode = "ask";
	private modelId = "auto";
	private models: CapixModelCatalogEntry[] = [];
	private chips: CapixContextChip[] = [];
	private entries: CapixTimelineEntry[] = [];
	private draft = "";
	private streaming = false;
	private projectId = "";
	private costMinor = "0";
	private offline = false;
	private lastError: CapixAssistantError | undefined;
	private sessionQuery = "";
	private initializing = false;
	private abort: AbortController | undefined;

	/** Payload of the most recent failed turn, kept for one-tap retry. */
	private retryPayload: string | undefined;
	/** True when the failed turn never reached the timeline (offline) and retry must echo it. */
	private retryNeedsUserEcho = false;

	/** Batched streaming emission: one paint per interval regardless of token rate. */
	private streamEmitTimer: ReturnType<typeof setTimeout> | undefined;
	private streamEmitPending = false;

	private readonly listeners = new Set<() => void>();

	constructor(
		private readonly bridge: CapixAssistantBridge,
		private readonly storage?: CapixAssistantStorage,
	) {
		const persistedWidth = Number(this.storage?.get(WIDTH_STORAGE_KEY));
		if (Number.isFinite(persistedWidth) && persistedWidth > 0) {
			this.width = this.clampWidth(persistedWidth);
		}
		const persistedMode = this.storage?.get(MODE_STORAGE_KEY);
		if (persistedMode && (CAPIX_ASSISTANT_MODES as readonly string[]).includes(persistedMode)) {
			this.mode = persistedMode as CapixAssistantMode;
		}
		const persistedModel = this.storage?.get(MODEL_STORAGE_KEY);
		if (persistedModel) this.modelId = persistedModel;
		const persistedDraft = this.storage?.get(this.draftKey());
		if (persistedDraft) this.draft = persistedDraft;
	}

	// ── Subscription ────────────────────────────────────────────────────────

	onDidChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// A broken listener must not break the controller.
			}
		}
	}

	/** Frame-aligned emit for high-frequency streaming deltas. */
	private scheduleStreamEmit(): void {
		if (this.streamEmitTimer) {
			this.streamEmitPending = true;
			return;
		}
		this.streamEmitTimer = setTimeout(() => {
			this.streamEmitTimer = undefined;
			if (this.streamEmitPending) {
				this.streamEmitPending = false;
				this.emit();
			}
		}, STREAM_EMIT_INTERVAL_MS);
		this.streamEmitPending = true;
	}

	/** Flush any batched streaming paint before a structural state change. */
	private flushStreamEmit(): void {
		if (this.streamEmitTimer) {
			clearTimeout(this.streamEmitTimer);
			this.streamEmitTimer = undefined;
		}
		if (this.streamEmitPending) {
			this.streamEmitPending = false;
			this.emit();
		}
	}

	private deriveStatus(): CapixAssistantStatus {
		if (this.offline) return "offline";
		if (this.streaming) return "streaming";
		if (this.lastError) return "error";
		return "idle";
	}

	getSnapshot(): CapixAssistantSnapshot {
		return {
			width: this.width,
			minWidth: CAPIX_ASSISTANT_MIN_WIDTH,
			maxWidth: CAPIX_ASSISTANT_MAX_WIDTH,
			sessions: [...this.sessions],
			visibleSessions: this.sessions.filter((s) => sessionMatches(s, this.sessionQuery)),
			activeSessionId: this.activeSessionId,
			mode: this.mode,
			modelId: this.modelId,
			models: [...this.models],
			chips: [...this.chips],
			entries: [...this.entries],
			draft: this.draft,
			streaming: this.streaming,
			projectId: this.projectId,
			costMinor: this.costMinor,
			status: this.deriveStatus(),
			offline: this.offline,
			lastError: this.lastError ? { ...this.lastError } : undefined,
			sessionQuery: this.sessionQuery,
			initializing: this.initializing,
		};
	}

	// ── Panel sizing (right-side, drag-resizable) ───────────────────────────

	private clampWidth(width: number): number {
		return Math.min(CAPIX_ASSISTANT_MAX_WIDTH, Math.max(CAPIX_ASSISTANT_MIN_WIDTH, Math.round(width)));
	}

	setWidth(width: number): void {
		const clamped = this.clampWidth(width);
		if (clamped === this.width) return;
		this.width = clamped;
		this.storage?.set(WIDTH_STORAGE_KEY, String(clamped));
		this.emit();
	}

	/** Drag helper: the panel is anchored right, so dragging left widens it. */
	resizeBy(deltaPx: number): void {
		this.setWidth(this.width + deltaPx);
	}

	// ── Draft persistence ───────────────────────────────────────────────────

	private draftKey(): string {
		return `${DRAFT_STORAGE_PREFIX}${this.activeSessionId ?? "new"}`;
	}

	private persistDraft(): void {
		this.storage?.set(this.draftKey(), this.draft);
	}

	// ── Lifecycle ───────────────────────────────────────────────────────────

	/**
	 * Load history + model catalog and restore the persisted session selection.
	 * Safe to call repeatedly (re-entry).
	 */
	async initialize(projectId: string): Promise<void> {
		this.projectId = projectId;
		this.initializing = true;
		this.emit();
		try {
			const [sessions, models] = await Promise.all([
				this.bridge.listSessions(projectId).catch(() => [] as ChatSession[]),
				this.bridge.listModels().catch(() => [] as CapixModelCatalogEntry[]),
			]);
			this.sessions = sessions.map(toSummary);
			this.models = models;
			if (this.modelId !== "auto" && models.length && !models.some((m) => m.id === this.modelId)) {
				this.modelId = "auto";
			}

			// Resume the persisted session so the panel reopens where the user left
			// off. Failures are non-fatal: the history list is still usable.
			const persistedId = this.storage?.get(ACTIVE_SESSION_STORAGE_KEY);
			if (persistedId && persistedId !== this.activeSessionId && this.sessions.some((s) => s.id === persistedId)) {
				try {
					const session = await this.bridge.resumeSession(persistedId);
					this.hydrateSession(session);
				} catch {
					this.activeSessionId = persistedId;
				}
			}
		} finally {
			this.initializing = false;
			this.emit();
		}
	}

	private hydrateSession(session: ChatSession): void {
		this.activeSessionId = session.id;
		this.modelId = session.modelId || this.modelId;
		this.entries = session.messages.map((m) => ({
			id: entryId(),
			kind: "message" as const,
			role: m.role === "tool" ? ("system" as const) : m.role,
			content: m.content,
		}));
		this.costMinor = session.costMinor !== undefined ? String(session.costMinor) : "0";
		this.draft = this.storage?.get(this.draftKey()) ?? "";
	}

	async newSession(): Promise<void> {
		this.abortActive();
		this.flushStreamEmit();
		this.activeSessionId = undefined;
		this.entries = [];
		this.costMinor = "0";
		this.streaming = false;
		this.lastError = undefined;
		this.retryPayload = undefined;
		this.draft = this.storage?.get(this.draftKey()) ?? "";
		this.storage?.set(ACTIVE_SESSION_STORAGE_KEY, "");
		this.emit();
	}

	async selectSession(sessionId: string): Promise<void> {
		if (this.streaming) this.abortActive();
		this.flushStreamEmit();
		this.lastError = undefined;
		this.retryPayload = undefined;
		const session = await this.bridge.resumeSession(sessionId);
		this.hydrateSession(session);
		this.storage?.set(ACTIVE_SESSION_STORAGE_KEY, session.id);
		this.emit();
	}

	// ── Mode / model ────────────────────────────────────────────────────────

	setMode(mode: CapixAssistantMode): void {
		if (!(CAPIX_ASSISTANT_MODES as readonly string[]).includes(mode)) return;
		this.mode = mode;
		this.storage?.set(MODE_STORAGE_KEY, mode);
		this.emit();
	}

	setModel(modelId: string): void {
		this.modelId = modelId;
		this.storage?.set(MODEL_STORAGE_KEY, modelId);
		this.emit();
	}

	// ── Connectivity / error surface ────────────────────────────────────────

	/** Park or unpark the composer when the broker reports connectivity changes. */
	setOffline(offline: boolean): void {
		if (offline === this.offline) return;
		this.offline = offline;
		if (offline && this.streaming) this.abortActive();
		this.emit();
	}

	dismissError(): void {
		if (!this.lastError) return;
		this.lastError = undefined;
		this.emit();
	}

	// ── History search ──────────────────────────────────────────────────────

	setSessionQuery(query: string): void {
		if (query === this.sessionQuery) return;
		this.sessionQuery = query;
		this.emit();
	}

	// ── Context chips ───────────────────────────────────────────────────────

	addChip(chip: Omit<CapixContextChip, "id">): void {
		this.chips = [...this.chips, { ...chip, id: entryId() }];
		this.emit();
	}

	removeChip(chipId: string): void {
		this.chips = this.chips.filter((c) => c.id !== chipId);
		this.emit();
	}

	clearChips(): void {
		if (!this.chips.length) return;
		this.chips = [];
		this.emit();
	}

	// ── Composer ────────────────────────────────────────────────────────────

	setDraft(draft: string): void {
		this.draft = draft;
		this.persistDraft();
		this.emit();
	}

	/**
	 * Submit the composer draft. Pinned context chips are inlined into the
	 * outbound message and cleared. The user turn is appended optimistically —
	 * before the broker round-trip — and the turn payload is retained until the
	 * turn closes so a failure can be retried verbatim. Streams broker events
	 * into the timeline until the `final`/`error` event closes the turn.
	 */
	async submit(): Promise<void> {
		const text = this.draft.trim();
		if (!text || this.streaming) return;

		if (this.offline) {
			this.lastError = {
				message: "You're offline. The message will send when the connection returns.",
				capixCode: "capix.network.offline",
				retryable: true,
			};
			this.retryPayload = text;
			this.retryNeedsUserEcho = true;
			this.emit();
			return;
		}

		let content = text;
		if (this.chips.length) {
			const blocks = this.chips.map((chip) => {
				const body = chip.snippet ?? chip.detail ?? "";
				return `<context kind="${chip.kind}" name="${chip.label}">\n${body}\n</context>`;
			});
			content = `${text}\n\n${blocks.join("\n")}`;
		}

		this.draft = "";
		this.persistDraft();
		this.chips = [];
		this.streaming = true;
		this.lastError = undefined;
		this.retryPayload = content;
		this.retryNeedsUserEcho = false;
		this.entries = [
			...this.entries,
			{ id: entryId(), kind: "message", role: "user", content: text },
		];
		this.emit();

		await this.runTurn(content);
	}

	/** Resubmit the last failed turn (offline banner, stream error) verbatim. */
	async retryLastTurn(): Promise<void> {
		if (this.streaming || !this.retryPayload) return;
		if (this.offline) {
			this.emit();
			return;
		}
		const content = this.retryPayload;
		this.streaming = true;
		this.lastError = undefined;
		// A turn that failed mid-stream already echoed its user message; only the
		// offline path (which parked the draft before echoing) needs a fresh echo.
		if (this.retryNeedsUserEcho) {
			this.retryNeedsUserEcho = false;
			this.entries = [
				...this.entries,
				{ id: entryId(), kind: "message", role: "user", content },
			];
		}
		this.emit();
		await this.runTurn(content);
	}

	private async runTurn(content: string): Promise<void> {
		try {
			if (!this.activeSessionId) {
				const session = await this.bridge.startSession({
					modelId: this.modelId,
					projectId: this.projectId,
				});
				this.activeSessionId = session.id;
				this.storage?.set(ACTIVE_SESSION_STORAGE_KEY, session.id);
				this.sessions = [toSummary(session), ...this.sessions];
			}

			const assistantId = entryId();
			this.entries = [
				...this.entries,
				{ id: assistantId, kind: "message", role: "assistant", content: "", streaming: true },
			];
			this.emit();

			this.abort = new AbortController();
			const stream = this.bridge.streamMessage(this.activeSessionId, content, this.abort.signal);
			for await (const event of stream) {
				this.applyStreamEvent(assistantId, event);
			}
			this.flushStreamEmit();
			this.patchEntry(assistantId, (e) =>
				e.kind === "message" ? { ...e, streaming: false } : e,
			);
			// The turn closed cleanly — nothing left to retry.
			this.retryPayload = undefined;
		} catch (err) {
			this.flushStreamEmit();
			const failure = normalizeError(err);
			this.lastError = failure;
			this.entries = [
				...this.entries,
				{
					id: entryId(),
					kind: "error",
					message: failure.message,
					capixCode: failure.capixCode,
					supportId: failure.supportId,
				},
			];
		} finally {
			this.streaming = false;
			this.abort = undefined;
			this.emit();
		}
	}

	/** Cancel the in-flight turn. Idempotent. */
	async cancelStream(): Promise<void> {
		if (!this.activeSessionId) return;
		this.abortActive();
		this.flushStreamEmit();
		await this.bridge.cancel(this.activeSessionId).catch(() => undefined);
		this.streaming = false;
		this.entries = this.entries.map((e) =>
			e.kind === "message" && e.streaming ? { ...e, streaming: false } : e,
		);
		this.emit();
	}

	private abortActive(): void {
		const controller = this.abort;
		this.abort = undefined;
		controller?.abort();
	}

	// ── Timeline ────────────────────────────────────────────────────────────

	/** Append an external agent event (plan/tool/diff/approval) to the timeline. */
	appendEntry(entry: DistributiveOmit<CapixTimelineEntry, "id">): string {
		this.flushStreamEmit();
		const id = entryId();
		this.entries = [...this.entries, { ...entry, id } as CapixTimelineEntry];
		this.emit();
		return id;
	}

	updateEntry(id: string, patch: Partial<CapixTimelineEntry>): void {
		this.patchEntry(id, (e) => ({ ...e, ...patch }) as CapixTimelineEntry);
	}

	private patchEntry(id: string, patch: (e: CapixTimelineEntry) => CapixTimelineEntry): void {
		this.entries = this.entries.map((e) => (e.id === id ? patch(e) : e));
		this.emit();
	}

	private applyStreamEvent(assistantId: string, event: ChatStreamEvent): void {
		switch (event.type) {
			case "content":
				if (event.content) {
					// Mutate + batched emit: one repaint per frame, not per token.
					this.entries = this.entries.map((e) =>
						e.id === assistantId && e.kind === "message"
							? { ...e, content: e.content + event.content }
							: e,
					);
					this.scheduleStreamEmit();
				}
				break;
			case "tool":
				this.flushStreamEmit();
				for (const call of event.toolCalls ?? []) {
					const named = call as { function?: { name?: string }; name?: string };
					this.appendEntry({
						kind: "tool",
						tool: named.function?.name ?? named.name ?? "tool",
						status: "running",
					});
				}
				break;
			case "usage": {
				this.flushStreamEmit();
				const cost = event.costMinor !== undefined ? String(event.costMinor) : "0";
				this.costMinor = (BigInt(this.costMinor || "0") + BigInt(cost)).toString();
				this.entries = [
					...this.entries,
					{
						id: entryId(),
						kind: "usage",
						inputTokens: 0,
						outputTokens: 0,
						costMinor: cost,
					},
				];
				this.emit();
				break;
			}
			case "final":
				this.flushStreamEmit();
				this.patchEntry(assistantId, (e) =>
					e.kind === "message" ? { ...e, streaming: false } : e,
				);
				break;
			case "error": {
				this.flushStreamEmit();
				const failure = normalizeError(event.error ?? "Capix inference was interrupted.");
				this.lastError = failure;
				this.entries = [
					...this.entries,
					{
						id: entryId(),
						kind: "error",
						message: failure.message,
						capixCode: failure.capixCode,
						supportId: failure.supportId,
					},
				];
				this.emit();
				break;
			}
			case "route":
				// The route receipt is rendered by the receipt surfaces; the
				// assistant timeline stays provider-neutral.
				break;
		}
	}
}
