/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-ai/assistant/assistantView — DOM renderer for the resizable
 *  right-side Capix assistant.
 *
 *  Framework-free by design: the workbench shell mounts
 *  `mountCapixAssistant(container, controller)` into its secondary-sidebar
 *  host element and gets a fully wired panel — drag-resize handle, session
 *  history, mode/model selectors, context chips, plan/tool/diff timeline and
 *  a compact composer. All state lives in `CapixAssistantController`; this
 *  file only paints snapshots and forwards gestures. It never touches IPC or
 *  credentials directly (architecture §11.5).
 *
 *  Design tokens (@capix/ui-tokens): dark foundation, cyan #3DCED6 accents,
 *  green #14F195 primary, amber #FFAE00, red #FF6464.
 *--------------------------------------------------------------------------------------------*/

import type {
	CapixAssistantController,
	CapixAssistantSnapshot,
	CapixTimelineEntry,
} from "./assistantState.js";
import { CAPIX_ASSISTANT_MODES } from "./assistantState.js";

const CSS = `
.capix-assistant {
	position: relative;
	display: flex;
	flex-direction: column;
	height: 100%;
	background: #0b0e11;
	color: #d7dee4;
	font: 12px/1.5 -apple-system, "Segoe UI", sans-serif;
	border-left: 1px solid #1d2530;
	overflow: hidden;
}
.capix-assistant__resize {
	position: absolute;
	top: 0;
	left: -3px;
	width: 6px;
	height: 100%;
	cursor: col-resize;
	z-index: 10;
}
.capix-assistant__resize:hover,
.capix-assistant__resize--active { background: rgba(61, 206, 214, 0.35); }
.capix-assistant__header {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 8px 10px;
	border-bottom: 1px solid #1d2530;
}
.capix-assistant__title {
	font-weight: 600;
	color: #3dced6;
	margin-right: auto;
	white-space: nowrap;
}
.capix-assistant select {
	background: #11161c;
	color: #d7dee4;
	border: 1px solid #26303c;
	border-radius: 4px;
	font-size: 11px;
	max-width: 110px;
	padding: 2px 4px;
}
.capix-assistant__icon-btn {
	background: none;
	border: 1px solid #26303c;
	border-radius: 4px;
	color: #d7dee4;
	cursor: pointer;
	padding: 2px 7px;
	font-size: 11px;
}
.capix-assistant__icon-btn:hover { border-color: #3dced6; color: #3dced6; }
.capix-assistant__chips {
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
	padding: 6px 10px;
}
.capix-assistant__chips:empty { display: none; }
.capix-assistant__chip {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	background: #14202a;
	border: 1px solid #1f3a44;
	border-radius: 10px;
	padding: 1px 4px 1px 8px;
	font-size: 11px;
	color: #8fd9de;
}
.capix-assistant__chip button {
	background: none;
	border: none;
	color: #6b7b88;
	cursor: pointer;
	padding: 0 3px;
	font-size: 11px;
}
.capix-assistant__chip button:hover { color: #ff6464; }
.capix-assistant__timeline {
	flex: 1;
	overflow-y: auto;
	padding: 10px;
	display: flex;
	flex-direction: column;
	gap: 8px;
}
.capix-assistant__empty {
	color: #5b6b78;
	text-align: center;
	margin-top: 32px;
	font-size: 12px;
}
.capix-msg {
	border-radius: 6px;
	padding: 6px 9px;
	white-space: pre-wrap;
	word-break: break-word;
}
.capix-msg--user { background: #14202a; align-self: flex-end; max-width: 92%; }
.capix-msg--assistant { background: #10151b; border: 1px solid #1d2530; }
.capix-msg--system { background: none; color: #5b6b78; font-style: italic; }
.capix-msg__cursor {
	display: inline-block;
	width: 6px;
	height: 12px;
	background: #3dced6;
	vertical-align: text-bottom;
	animation: capix-blink 1s steps(2) infinite;
}
@keyframes capix-blink { 50% { opacity: 0; } }
.capix-plan {
	border: 1px solid #1f3a44;
	border-radius: 6px;
	padding: 6px 9px;
	background: #0e141a;
}
.capix-plan__title { color: #3dced6; font-weight: 600; margin-bottom: 4px; }
.capix-plan__step { display: flex; gap: 6px; align-items: baseline; }
.capix-plan__step--completed { color: #14f195; }
.capix-plan__step--failed { color: #ff6464; }
.capix-plan__step--in-progress { color: #ffae00; }
.capix-plan__step--pending, .capix-plan__step--skipped { color: #5b6b78; }
.capix-tool {
	border: 1px solid #26303c;
	border-left: 3px solid #3dced6;
	border-radius: 4px;
	padding: 5px 9px;
	background: #10151b;
	font-size: 11px;
}
.capix-tool--awaiting-approval { border-left-color: #ffae00; }
.capix-tool--failed, .capix-tool--denied { border-left-color: #ff6464; }
.capix-tool--completed { border-left-color: #14f195; }
.capix-tool__name { font-weight: 600; }
.capix-tool__status { color: #6b7b88; margin-left: 6px; }
.capix-tool__output {
	margin-top: 4px;
	max-height: 120px;
	overflow: auto;
	color: #8b98a3;
	white-space: pre-wrap;
}
.capix-diff {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	border: 1px solid #1f3a44;
	border-radius: 10px;
	padding: 2px 10px;
	font-size: 11px;
	color: #8fd9de;
	align-self: flex-start;
}
.capix-diff--created { border-color: #14f195; }
.capix-diff--deleted { border-color: #ff6464; }
.capix-usage { color: #5b6b78; font-size: 10px; align-self: flex-end; }
.capix-error {
	border: 1px solid #ff6464;
	border-radius: 6px;
	padding: 6px 9px;
	color: #ff9c9c;
	background: rgba(255, 100, 100, 0.08);
}
.capix-assistant__composer {
	display: flex;
	align-items: flex-end;
	gap: 6px;
	padding: 8px 10px;
	border-top: 1px solid #1d2530;
}
.capix-assistant__composer textarea {
	flex: 1;
	resize: none;
	background: #11161c;
	color: #d7dee4;
	border: 1px solid #26303c;
	border-radius: 6px;
	padding: 6px 8px;
	font: inherit;
	min-height: 30px;
	max-height: 84px;
	outline: none;
}
.capix-assistant__composer textarea:focus { border-color: #3dced6; }
.capix-assistant__send {
	background: #14f195;
	color: #06210f;
	border: none;
	border-radius: 6px;
	font-weight: 600;
	cursor: pointer;
	padding: 6px 12px;
}
.capix-assistant__send:disabled { background: #26303c; color: #5b6b78; cursor: default; }
.capix-assistant__stop {
	background: none;
	border: 1px solid #ff6464;
	color: #ff6464;
	border-radius: 6px;
	cursor: pointer;
	padding: 6px 12px;
}
.capix-assistant__cost {
	padding: 0 10px 6px;
	color: #5b6b78;
	font-size: 10px;
}
`;

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

/** Format integer micro-USD minor units for the cost line (display edge only). */
function formatCost(costMinor: string): string {
	try {
		const micro = BigInt(costMinor || "0");
		const whole = micro / 1_000_000n;
		const frac = (micro % 1_000_000n).toString().padStart(6, "0").slice(0, 4);
		return `$${whole}.${frac}`;
	} catch {
		return "$0.00";
	}
}

export interface CapixAssistantViewHandle {
	/** Tear down DOM listeners and the controller subscription. */
	dispose(): void;
	/** The root element (already attached to the container on mount). */
	readonly root: HTMLElement;
}

/**
 * Mount the assistant into a host element owned by the workbench shell.
 * The host controls placement (secondary sidebar / right aux bar); this view
 * controls its own width within the host's bounds via the drag handle.
 */
export function mountCapixAssistant(
	container: HTMLElement,
	controller: CapixAssistantController,
): CapixAssistantViewHandle {
	const style = document.createElement("style");
	style.textContent = CSS;

	const root = el("div", "capix-assistant");
	const resizeHandle = el("div", "capix-assistant__resize");
	resizeHandle.title = "Drag to resize";

	const header = el("div", "capix-assistant__header");
	const title = el("span", "capix-assistant__title", "Capix");
	const historySelect = el("select") as HTMLSelectElement;
	historySelect.title = "Session history";
	const newButton = el("button", "capix-assistant__icon-btn", "+ New");
	newButton.title = "New session";
	const modeSelect = el("select") as HTMLSelectElement;
	modeSelect.title = "Mode";
	const modelSelect = el("select") as HTMLSelectElement;
	modelSelect.title = "Model";
	header.append(title, historySelect, newButton, modeSelect, modelSelect);

	const chipsRow = el("div", "capix-assistant__chips");
	const timeline = el("div", "capix-assistant__timeline");
	const costLine = el("div", "capix-assistant__cost");

	const composer = el("div", "capix-assistant__composer");
	const textarea = el("textarea") as HTMLTextAreaElement;
	textarea.placeholder = "Ask Capix…  (Enter to send, Shift+Enter for a new line)";
	textarea.rows = 1;
	const sendButton = el("button", "capix-assistant__send", "Send");
	const stopButton = el("button", "capix-assistant__stop", "Stop");
	composer.append(textarea, sendButton, stopButton);

	root.append(resizeHandle, header, chipsRow, timeline, costLine, composer);
	container.append(style, root);

	// ── Rendering ───────────────────────────────────────────────────────────

	function renderEntry(entry: CapixTimelineEntry): HTMLElement {
		switch (entry.kind) {
			case "message": {
				const node = el("div", `capix-msg capix-msg--${entry.role}`);
				node.textContent = entry.content;
				if (entry.streaming) node.append(el("span", "capix-msg__cursor"));
				return node;
			}
			case "plan": {
				const node = el("div", "capix-plan");
				node.append(el("div", "capix-plan__title", entry.title));
				for (const step of entry.steps) {
					const row = el("div", `capix-plan__step capix-plan__step--${step.status}`);
					const marker =
						step.status === "completed" ? "✓"
						: step.status === "failed" ? "✗"
						: step.status === "in-progress" ? "◐"
						: step.status === "skipped" ? "–"
						: "○";
					row.append(el("span", undefined, marker), el("span", undefined, step.label));
					node.append(row);
				}
				return node;
			}
			case "tool": {
				const node = el("div", `capix-tool capix-tool--${entry.status}`);
				const head = el("div");
				head.append(
					el("span", "capix-tool__name", entry.tool),
					el(
						"span",
						"capix-tool__status",
						entry.status === "awaiting-approval" ? "awaiting approval" : entry.status,
					),
				);
				node.append(head);
				if (entry.detail) node.append(el("div", "capix-tool__output", entry.detail));
				if (entry.output) node.append(el("div", "capix-tool__output", entry.output));
				return node;
			}
			case "diff":
				return el(
					"div",
					`capix-diff capix-diff--${entry.changeType}`,
					`${entry.changeType === "created" ? "+" : entry.changeType === "deleted" ? "−" : "~"} ${entry.filePath}`,
				);
			case "usage":
				return el("div", "capix-usage", `turn cost ${formatCost(entry.costMinor)}`);
			case "error":
				return el("div", "capix-error", entry.message);
		}
	}

	function render(snapshot: CapixAssistantSnapshot): void {
		root.style.width = `${snapshot.width}px`;

		// Session history.
		historySelect.textContent = "";
		const placeholder = document.createElement("option");
		placeholder.value = "";
		placeholder.textContent = snapshot.activeSessionId ? "Current session" : "History…";
		historySelect.append(placeholder);
		for (const session of snapshot.sessions) {
			const option = document.createElement("option");
			option.value = session.id;
			option.textContent = session.title;
			if (session.id === snapshot.activeSessionId) option.selected = true;
			historySelect.append(option);
		}

		// Mode + model selectors.
		if (modeSelect.options.length !== CAPIX_ASSISTANT_MODES.length) {
			modeSelect.textContent = "";
			for (const mode of CAPIX_ASSISTANT_MODES) {
				const option = document.createElement("option");
				option.value = mode;
				option.textContent = mode[0].toUpperCase() + mode.slice(1);
				modeSelect.append(option);
			}
		}
		modeSelect.value = snapshot.mode;

		modelSelect.textContent = "";
		const autoOption = document.createElement("option");
		autoOption.value = "auto";
		autoOption.textContent = "Auto";
		modelSelect.append(autoOption);
		for (const model of snapshot.models) {
			const option = document.createElement("option");
			option.value = model.id;
			option.textContent = model.name;
			modelSelect.append(option);
		}
		modelSelect.value = snapshot.modelId;

		// Context chips.
		chipsRow.textContent = "";
		for (const chip of snapshot.chips) {
			const node = el("span", "capix-assistant__chip", chip.label);
			node.title = chip.detail ?? chip.kind;
			const remove = el("button", undefined, "×");
			remove.addEventListener("click", () => controller.removeChip(chip.id));
			node.append(remove);
			chipsRow.append(node);
		}

		// Timeline.
		timeline.textContent = "";
		if (!snapshot.entries.length) {
			timeline.append(
				el(
					"div",
					"capix-assistant__empty",
					"Ask anything, or pin context with the chip controls. Plans, tool calls and diffs appear here.",
				),
			);
		} else {
			for (const entry of snapshot.entries) timeline.append(renderEntry(entry));
			timeline.scrollTop = timeline.scrollHeight;
		}

		// Composer + cost.
		if (textarea.value !== snapshot.draft) textarea.value = snapshot.draft;
		sendButton.disabled = snapshot.streaming || !snapshot.draft.trim();
		sendButton.style.display = snapshot.streaming ? "none" : "";
		stopButton.style.display = snapshot.streaming ? "" : "none";
		costLine.textContent =
			snapshot.costMinor !== "0" ? `session spend ${formatCost(snapshot.costMinor)}` : "";
	}

	// ── Events ──────────────────────────────────────────────────────────────

	const unsubscribe = controller.onDidChange(() => render(controller.getSnapshot()));

	textarea.addEventListener("input", () => controller.setDraft(textarea.value));
	textarea.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			void controller.submit();
		}
	});
	sendButton.addEventListener("click", () => void controller.submit());
	stopButton.addEventListener("click", () => void controller.cancelStream());
	newButton.addEventListener("click", () => void controller.newSession());
	historySelect.addEventListener("change", () => {
		if (historySelect.value) void controller.selectSession(historySelect.value);
	});
	modeSelect.addEventListener("change", () =>
		controller.setMode(modeSelect.value as CapixAssistantSnapshot["mode"]),
	);
	modelSelect.addEventListener("change", () => controller.setModel(modelSelect.value));

	// Drag-to-resize: the panel is anchored to the right edge, so moving the
	// pointer left grows the width.
	let dragStart: { x: number; width: number } | undefined;
	const onMouseMove = (event: MouseEvent) => {
		if (!dragStart) return;
		controller.setWidth(dragStart.width + (dragStart.x - event.clientX));
	};
	const onMouseUp = () => {
		dragStart = undefined;
		resizeHandle.classList.remove("capix-assistant__resize--active");
		document.removeEventListener("mousemove", onMouseMove);
		document.removeEventListener("mouseup", onMouseUp);
	};
	resizeHandle.addEventListener("mousedown", (event) => {
		dragStart = { x: event.clientX, width: controller.getSnapshot().width };
		resizeHandle.classList.add("capix-assistant__resize--active");
		document.addEventListener("mousemove", onMouseMove);
		document.addEventListener("mouseup", onMouseUp);
		event.preventDefault();
	});

	render(controller.getSnapshot());

	return {
		root,
		dispose(): void {
			unsubscribe();
			onMouseUp();
			root.remove();
			style.remove();
		},
	};
}
