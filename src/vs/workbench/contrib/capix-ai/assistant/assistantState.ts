/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-ai/assistant/assistantState — framework-free view model for the
 *  resizable right-side Capix assistant.
 *
 *  The controller owns every piece of assistant UI state — panel width,
 *  session history, mode/model selection, context chips, the plan/tool/diff
 *  timeline and the compact composer — and talks to the privileged main
 *  process exclusively through the injected `CapixAssistantBridge` (typed IPC,
 *  architecture §11.5). It never holds a credential, a raw stream handle or a
 *  provider address, and it renders no DOM: `assistantView.ts` subscribes to
 *  `onDidChange` and paints the state.
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

/** A context chip pinned to the composer (file, selection, terminal output, docs). */
export interface CapixContextChip {
	id: string;
	kind: "file" | "selection" | "terminal" | "docs";
	label: string;
	/** Secondary text (path, line range, source). */
	detail?: string;
	/** Payload inlined into the next submitted message, then the chip clears. */
	snippet?: string;
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
}

export const CAPIX_ASSISTANT_DEFAULT_WIDTH = 360;
export const CAPIX_ASSISTANT_MIN_WIDTH = 280;
export const CAPIX_ASSISTANT_MAX_WIDTH = 720;

const WIDTH_STORAGE_KEY = "capix.assistant.width";
const MODE_STORAGE_KEY = "capix.assistant.mode";
const MODEL_STORAGE_KEY = "capix.assistant.model";

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
	private abort: AbortController | undefined;

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

	getSnapshot(): CapixAssistantSnapshot {
		return {
			width: this.width,
			minWidth: CAPIX_ASSISTANT_MIN_WIDTH,
			maxWidth: CAPIX_ASSISTANT_MAX_WIDTH,
			sessions: [...this.sessions],
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

	// ── Lifecycle ───────────────────────────────────────────────────────────

	/** Load history + model catalog. Safe to call repeatedly (re-entry). */
	async initialize(projectId: string): Promise<void> {
		this.projectId = projectId;
		const [sessions, models] = await Promise.all([
			this.bridge.listSessions(projectId).catch(() => [] as ChatSession[]),
			this.bridge.listModels().catch(() => [] as CapixModelCatalogEntry[]),
		]);
		this.sessions = sessions.map(toSummary);
		this.models = models;
		if (this.modelId !== "auto" && models.length && !models.some((m) => m.id === this.modelId)) {
			this.modelId = "auto";
		}
		this.emit();
	}

	async newSession(): Promise<void> {
		this.abortActive();
		this.activeSessionId = undefined;
		this.entries = [];
		this.costMinor = "0";
		this.streaming = false;
		this.emit();
	}

	async selectSession(sessionId: string): Promise<void> {
		if (this.streaming) this.abortActive();
		const session = await this.bridge.resumeSession(sessionId);
		this.activeSessionId = session.id;
		this.modelId = session.modelId || this.modelId;
		this.entries = session.messages.map((m) => ({
			id: entryId(),
			kind: "message" as const,
			role: m.role === "tool" ? "system" as const : m.role,
			content: m.content,
		}));
		this.costMinor = session.costMinor !== undefined ? String(session.costMinor) : "0";
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
		this.emit();
	}

	/**
	 * Submit the composer draft. Pinned context chips are inlined into the
	 * outbound message and cleared. Streams broker events into the timeline
	 * until the `final`/`error` event closes the turn.
	 */
	async submit(): Promise<void> {
		const text = this.draft.trim();
		if (!text || this.streaming) return;

		let content = text;
		if (this.chips.length) {
			const blocks = this.chips.map((chip) => {
				const body = chip.snippet ?? chip.detail ?? "";
				return `<context kind="${chip.kind}" name="${chip.label}">\n${body}\n</context>`;
			});
			content = `${text}\n\n${blocks.join("\n")}`;
		}

		this.draft = "";
		this.chips = [];
		this.streaming = true;
		this.entries = [
			...this.entries,
			{ id: entryId(), kind: "message", role: "user", content: text },
		];
		this.emit();

		try {
			if (!this.activeSessionId) {
				const session = await this.bridge.startSession({
					modelId: this.modelId,
					projectId: this.projectId,
				});
				this.activeSessionId = session.id;
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
			this.patchEntry(assistantId, (e) =>
				e.kind === "message" ? { ...e, streaming: false } : e,
			);
		} catch (err) {
			this.entries = [
				...this.entries,
				{
					id: entryId(),
					kind: "error",
					message: err instanceof Error ? err.message : String(err),
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
		await this.bridge.cancel(this.activeSessionId).catch(() => undefined);
		this.streaming = false;
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
					this.patchEntry(assistantId, (e) =>
						e.kind === "message" ? { ...e, content: e.content + event.content } : e,
					);
				}
				break;
			case "tool":
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
				this.patchEntry(assistantId, (e) =>
					e.kind === "message" ? { ...e, streaming: false } : e,
				);
				break;
			case "error":
				this.entries = [
					...this.entries,
					{
						id: entryId(),
						kind: "error",
						message: event.error ?? "Capix inference was interrupted.",
					},
				];
				this.emit();
				break;
			case "route":
				// The route receipt is rendered by the receipt surfaces; the
				// assistant timeline stays provider-neutral.
				break;
		}
	}
}
