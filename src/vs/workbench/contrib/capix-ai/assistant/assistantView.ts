/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-ai/assistant/assistantView — DOM renderer for the resizable
 *  right-side Capix assistant.
 *
 *  Framework-free by design: the workbench shell mounts
 *  `mountCapixAssistant(container, controller)` into its secondary-sidebar
 *  host element and gets a fully wired panel — drag-resize handle, searchable
 *  session history drawer, segmented mode selector, model picker, context
 *  chips, an expandable plan/tool/diff timeline and a compact composer with
 *  attachment support. All state lives in `CapixAssistantController`; this
 *  file only paints snapshots and forwards gestures. It never touches IPC or
 *  credentials directly (architecture §11.5).
 *
 *  Visual language (@capix/ui-tokens): deep neutral surfaces, crisp type,
 *  a restrained cyan signal color, consistent 8/10px radii, 1px hairline
 *  borders, generous whitespace and purposeful motion (honouring
 *  `prefers-reduced-motion`). Status semantics: cyan = active/streaming,
 *  green = success, amber = attention, red = failure.
 *--------------------------------------------------------------------------------------------*/

import type {
	CapixAssistantController,
	CapixAssistantSnapshot,
	CapixContextChip,
	CapixTimelineEntry,
} from "./assistantState.js";
import { CAPIX_ASSISTANT_MODES } from "./assistantState.js";

const CSS = `
/* ── Tokens ─────────────────────────────────────────────────────────────── */
.capix-assistant {
	--cx-bg: #0a0d10;
	--cx-surface: #10151b;
	--cx-surface-2: #151c24;
	--cx-surface-3: #1b242f;
	--cx-border: #1e2833;
	--cx-border-strong: #2a3745;
	--cx-fg: #e6edf2;
	--cx-fg-2: #9aa8b5;
	--cx-muted: #5c6b78;
	--cx-accent: #3dced6;
	--cx-accent-soft: rgba(61, 206, 214, 0.12);
	--cx-accent-line: rgba(61, 206, 214, 0.32);
	--cx-success: #14f195;
	--cx-success-soft: rgba(20, 241, 149, 0.10);
	--cx-warning: #ffae00;
	--cx-warning-soft: rgba(255, 174, 0, 0.10);
	--cx-danger: #ff6464;
	--cx-danger-soft: rgba(255, 100, 100, 0.10);
	--cx-radius-sm: 6px;
	--cx-radius: 10px;
	--cx-radius-pill: 999px;
	--cx-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
	--cx-font: 12.5px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", sans-serif;
	--cx-mono: 11px/1.5 "SF Mono", "Cascadia Code", Consolas, monospace;
	--cx-ease: cubic-bezier(0.2, 0, 0, 1);
}

.capix-assistant {
	position: relative;
	display: flex;
	flex-direction: column;
	height: 100%;
	background: var(--cx-bg);
	color: var(--cx-fg);
	font: var(--cx-font);
	border-left: 1px solid var(--cx-border);
	overflow: hidden;
	-webkit-font-smoothing: antialiased;
}
.capix-assistant * { box-sizing: border-box; }
.capix-assistant button { font: inherit; }
.capix-assistant ::-webkit-scrollbar { width: 8px; height: 8px; }
.capix-assistant ::-webkit-scrollbar-thumb {
	background: var(--cx-border-strong); border-radius: 4px;
	border: 2px solid var(--cx-bg);
}
.capix-assistant ::-webkit-scrollbar-thumb:hover { background: var(--cx-muted); }

/* ── Resize handle ──────────────────────────────────────────────────────── */
.capix-assistant__resize {
	position: absolute; top: 0; left: -3px; width: 6px; height: 100%;
	cursor: col-resize; z-index: 30;
	transition: background 120ms var(--cx-ease);
}
.capix-assistant__resize:hover,
.capix-assistant__resize--active { background: var(--cx-accent-line); }

/* ── Header ─────────────────────────────────────────────────────────────── */
.cx-header {
	display: flex; align-items: center; gap: 8px;
	padding: 10px 12px;
	border-bottom: 1px solid var(--cx-border);
	background: var(--cx-bg);
	flex: none;
}
.cx-brand { display: flex; align-items: center; gap: 8px; margin-right: auto; min-width: 0; }
.cx-brand__mark {
	width: 18px; height: 18px; border-radius: 5px; flex: none;
	background: linear-gradient(135deg, var(--cx-accent) 0%, #2aa8b0 100%);
	box-shadow: 0 0 12px rgba(61, 206, 214, 0.35);
	position: relative;
}
.cx-brand__mark::after {
	content: ""; position: absolute; inset: 4px;
	border-radius: 2px; background: var(--cx-bg); opacity: 0.85;
}
.cx-brand__name { font-weight: 650; font-size: 13px; letter-spacing: 0.01em; white-space: nowrap; }
.cx-status {
	display: inline-flex; align-items: center; gap: 5px;
	font-size: 10px; color: var(--cx-muted);
	padding: 2px 8px; border-radius: var(--cx-radius-pill);
	border: 1px solid var(--cx-border); background: var(--cx-surface);
	white-space: nowrap;
}
.cx-status__dot { width: 6px; height: 6px; border-radius: 50%; background: var(--cx-muted); flex: none; }
.cx-status--online .cx-status__dot { background: var(--cx-success); box-shadow: 0 0 6px rgba(20, 241, 149, 0.6); }
.cx-status--streaming .cx-status__dot { background: var(--cx-accent); animation: cx-pulse 1.1s ease-in-out infinite; }
.cx-status--offline .cx-status__dot { background: var(--cx-warning); }
.cx-status--error .cx-status__dot { background: var(--cx-danger); }
.cx-icon-btn {
	display: inline-flex; align-items: center; justify-content: center;
	width: 26px; height: 26px; flex: none;
	background: none; border: 1px solid transparent; border-radius: var(--cx-radius-sm);
	color: var(--cx-fg-2); cursor: pointer; font-size: 13px;
	transition: color 120ms var(--cx-ease), background 120ms var(--cx-ease), border-color 120ms var(--cx-ease);
}
.cx-icon-btn:hover { color: var(--cx-fg); background: var(--cx-surface-2); border-color: var(--cx-border); }
.cx-icon-btn--active { color: var(--cx-accent); background: var(--cx-accent-soft); border-color: var(--cx-accent-line); }

/* ── History drawer ─────────────────────────────────────────────────────── */
.cx-history {
	position: absolute; top: 47px; left: 0; right: 0; bottom: 0; z-index: 20;
	display: flex; flex-direction: column;
	background: var(--cx-surface);
	border-right: 1px solid var(--cx-border);
	transform: translateX(-102%);
	transition: transform 200ms var(--cx-ease);
	box-shadow: var(--cx-shadow);
}
.cx-history--open { transform: translateX(0); }
.cx-history__head { padding: 12px 12px 8px; border-bottom: 1px solid var(--cx-border); flex: none; }
.cx-history__title { font-size: 10px; font-weight: 650; text-transform: uppercase; letter-spacing: 0.08em; color: var(--cx-muted); margin-bottom: 8px; }
.cx-history__search {
	display: flex; align-items: center; gap: 6px;
	background: var(--cx-bg); border: 1px solid var(--cx-border);
	border-radius: var(--cx-radius-sm); padding: 5px 8px;
	transition: border-color 120ms var(--cx-ease);
}
.cx-history__search:focus-within { border-color: var(--cx-accent-line); }
.cx-history__search input {
	flex: 1; min-width: 0; background: none; border: none; outline: none;
	color: var(--cx-fg); font: inherit; font-size: 12px;
}
.cx-history__search input::placeholder { color: var(--cx-muted); }
.cx-history__search span { color: var(--cx-muted); font-size: 11px; }
.cx-history__list { flex: 1; overflow-y: auto; padding: 6px; }
.cx-session {
	display: block; width: 100%; text-align: left;
	background: none; border: 1px solid transparent; border-radius: var(--cx-radius-sm);
	padding: 8px 10px; cursor: pointer; color: var(--cx-fg);
	transition: background 120ms var(--cx-ease), border-color 120ms var(--cx-ease);
}
.cx-session:hover { background: var(--cx-surface-2); }
.cx-session--active { background: var(--cx-accent-soft); border-color: var(--cx-accent-line); }
.cx-session__title {
	display: block; font-size: 12px; font-weight: 550;
	white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.cx-session__meta {
	display: flex; gap: 8px; margin-top: 2px;
	font-size: 10px; color: var(--cx-muted);
}
.cx-history__empty { padding: 24px 12px; text-align: center; color: var(--cx-muted); font-size: 11px; }

/* ── Banners (offline / error) ──────────────────────────────────────────── */
.cx-banner {
	display: flex; align-items: center; gap: 8px;
	margin: 8px 12px 0; padding: 8px 10px;
	border-radius: var(--cx-radius-sm); font-size: 11.5px;
	flex: none; animation: cx-enter 180ms var(--cx-ease);
}
.cx-banner--offline { background: var(--cx-warning-soft); border: 1px solid rgba(255, 174, 0, 0.30); color: var(--cx-warning); }
.cx-banner--error { background: var(--cx-danger-soft); border: 1px solid rgba(255, 100, 100, 0.30); color: #ffb3b3; }
.cx-banner__text { flex: 1; min-width: 0; }
.cx-banner__support { display: block; font-size: 10px; opacity: 0.75; margin-top: 1px; }
.cx-banner__btn {
	background: none; border: 1px solid currentColor; border-radius: var(--cx-radius-sm);
	color: inherit; cursor: pointer; font-size: 10.5px; padding: 2px 8px; flex: none;
	opacity: 0.9; transition: opacity 120ms var(--cx-ease);
}
.cx-banner__btn:hover { opacity: 1; }

/* ── Context chips ──────────────────────────────────────────────────────── */
.cx-chips {
	display: flex; flex-wrap: wrap; gap: 5px;
	padding: 8px 12px 0; flex: none;
}
.cx-chips:empty { display: none; }
.cx-chip {
	display: inline-flex; align-items: center; gap: 5px;
	background: var(--cx-surface-2); border: 1px solid var(--cx-border);
	border-radius: var(--cx-radius-pill); padding: 2px 6px 2px 8px;
	font-size: 11px; color: var(--cx-fg-2); max-width: 100%;
	animation: cx-enter 160ms var(--cx-ease);
}
.cx-chip__icon { font-size: 10px; color: var(--cx-accent); }
.cx-chip__label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 180px; }
.cx-chip__x {
	background: none; border: none; color: var(--cx-muted); cursor: pointer;
	padding: 0 2px; font-size: 12px; line-height: 1; border-radius: 50%;
	transition: color 120ms var(--cx-ease);
}
.cx-chip__x:hover { color: var(--cx-danger); }

/* ── Timeline ───────────────────────────────────────────────────────────── */
.cx-timeline {
	flex: 1; overflow-y: auto; overscroll-behavior: contain;
	padding: 14px 12px;
	display: flex; flex-direction: column; gap: 10px;
	scroll-behavior: smooth;
}
.cx-entry { animation: cx-enter 200ms var(--cx-ease); }

@keyframes cx-enter {
	from { opacity: 0; transform: translateY(6px); }
	to { opacity: 1; transform: translateY(0); }
}
@keyframes cx-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
@keyframes cx-blink { 50% { opacity: 0; } }
@keyframes cx-spin { to { transform: rotate(360deg); } }
@keyframes cx-typing { 0%, 60%, 100% { transform: translateY(0); opacity: 0.4; } 30% { transform: translateY(-3px); opacity: 1; } }

/* Empty state */
.cx-empty {
	margin: auto; text-align: center; max-width: 260px;
	padding: 24px 8px; color: var(--cx-fg-2);
}
.cx-empty__glyph {
	width: 44px; height: 44px; margin: 0 auto 14px;
	border-radius: 12px; display: flex; align-items: center; justify-content: center;
	background: var(--cx-accent-soft); border: 1px solid var(--cx-accent-line);
	color: var(--cx-accent); font-size: 20px;
}
.cx-empty__title { font-size: 15px; font-weight: 650; color: var(--cx-fg); margin-bottom: 6px; }
.cx-empty__sub { font-size: 11.5px; color: var(--cx-muted); margin-bottom: 16px; line-height: 1.5; }
.cx-empty__starters { display: flex; flex-direction: column; gap: 6px; }
.cx-starter {
	background: var(--cx-surface); border: 1px solid var(--cx-border);
	border-radius: var(--cx-radius-sm); padding: 8px 10px;
	color: var(--cx-fg-2); cursor: pointer; font-size: 11.5px; text-align: left;
	display: flex; align-items: center; justify-content: space-between; gap: 8px;
	transition: border-color 140ms var(--cx-ease), color 140ms var(--cx-ease), background 140ms var(--cx-ease);
}
.cx-starter:hover { border-color: var(--cx-accent-line); color: var(--cx-fg); background: var(--cx-surface-2); }
.cx-starter__arrow { color: var(--cx-accent); flex: none; }
.cx-empty__hint { margin-top: 14px; font-size: 10px; color: var(--cx-muted); }
.cx-empty__hint kbd {
	background: var(--cx-surface-2); border: 1px solid var(--cx-border);
	border-radius: 4px; padding: 1px 4px; font: var(--cx-mono); font-size: 9px;
}

/* Loading skeleton (history/initial) */
.cx-skeleton { padding: 4px 2px; display: flex; flex-direction: column; gap: 10px; }
.cx-skeleton__row {
	height: 34px; border-radius: var(--cx-radius-sm);
	background: linear-gradient(90deg, var(--cx-surface) 25%, var(--cx-surface-2) 50%, var(--cx-surface) 75%);
	background-size: 200% 100%; animation: cx-shimmer 1.4s linear infinite;
}
@keyframes cx-shimmer { to { background-position: -200% 0; } }

/* Messages */
.cx-msg { max-width: 92%; border-radius: var(--cx-radius); padding: 8px 12px; white-space: pre-wrap; word-break: break-word; }
.cx-msg--user {
	align-self: flex-end;
	background: var(--cx-accent-soft); border: 1px solid var(--cx-accent-line);
	border-bottom-right-radius: 4px; color: var(--cx-fg);
}
.cx-msg--assistant {
	align-self: flex-start;
	background: var(--cx-surface); border: 1px solid var(--cx-border);
	border-bottom-left-radius: 4px;
}
.cx-msg--system { align-self: center; background: none; border: none; color: var(--cx-muted); font-style: italic; font-size: 11px; padding: 2px 8px; }
.cx-msg__cursor {
	display: inline-block; width: 7px; height: 13px; margin-left: 2px;
	background: var(--cx-accent); border-radius: 1px; vertical-align: text-bottom;
	animation: cx-blink 1s steps(2) infinite;
}
.cx-typing { display: inline-flex; gap: 3px; padding: 2px 0; }
.cx-typing i {
	width: 5px; height: 5px; border-radius: 50%; background: var(--cx-accent);
	animation: cx-typing 1.2s ease-in-out infinite;
}
.cx-typing i:nth-child(2) { animation-delay: 0.15s; }
.cx-typing i:nth-child(3) { animation-delay: 0.3s; }

/* Cards (plan / tool) — expandable */
.cx-card {
	align-self: stretch;
	background: var(--cx-surface); border: 1px solid var(--cx-border);
	border-radius: var(--cx-radius); overflow: hidden;
}
.cx-card__head {
	display: flex; align-items: center; gap: 8px;
	padding: 8px 10px; cursor: pointer; user-select: none;
	transition: background 120ms var(--cx-ease);
}
.cx-card__head:hover { background: var(--cx-surface-2); }
.cx-card__chev { color: var(--cx-muted); font-size: 9px; width: 10px; flex: none; transition: transform 160ms var(--cx-ease); }
.cx-card--open .cx-card__chev { transform: rotate(90deg); }
.cx-card__title { flex: 1; min-width: 0; font-size: 12px; font-weight: 550; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cx-card__body { border-top: 1px solid var(--cx-border); padding: 8px 10px; display: none; }
.cx-card--open .cx-card__body { display: block; animation: cx-enter 160ms var(--cx-ease); }

.cx-badge {
	font-size: 9px; font-weight: 650; text-transform: uppercase; letter-spacing: 0.06em;
	padding: 2px 7px; border-radius: var(--cx-radius-pill); flex: none;
}
.cx-badge--accent { background: var(--cx-accent-soft); color: var(--cx-accent); }
.cx-badge--success { background: var(--cx-success-soft); color: var(--cx-success); }
.cx-badge--warning { background: var(--cx-warning-soft); color: var(--cx-warning); }
.cx-badge--danger { background: var(--cx-danger-soft); color: var(--cx-danger); }
.cx-badge--muted { background: var(--cx-surface-2); color: var(--cx-muted); }

/* Plan */
.cx-plan__step { display: flex; gap: 8px; align-items: baseline; padding: 3px 0; font-size: 12px; }
.cx-plan__marker { flex: none; width: 14px; text-align: center; font-size: 11px; }
.cx-plan__step--completed { color: var(--cx-fg-2); }
.cx-plan__step--completed .cx-plan__marker { color: var(--cx-success); }
.cx-plan__step--failed { color: var(--cx-danger); }
.cx-plan__step--in-progress { color: var(--cx-fg); }
.cx-plan__step--in-progress .cx-plan__marker { color: var(--cx-warning); animation: cx-pulse 1.1s ease-in-out infinite; }
.cx-plan__step--pending, .cx-plan__step--skipped { color: var(--cx-muted); }
.cx-plan__progress { height: 3px; border-radius: 2px; background: var(--cx-surface-2); margin-top: 8px; overflow: hidden; }
.cx-plan__progress i { display: block; height: 100%; background: var(--cx-accent); border-radius: 2px; transition: width 240ms var(--cx-ease); }

/* Tool */
.cx-tool__name { font: var(--cx-mono); color: var(--cx-accent); }
.cx-tool__output {
	font: var(--cx-mono); color: var(--cx-fg-2);
	white-space: pre-wrap; word-break: break-word;
	max-height: 160px; overflow: auto;
}
.cx-tool__output + .cx-tool__output { margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--cx-border); }
.cx-tool__spinner {
	width: 10px; height: 10px; flex: none;
	border: 2px solid var(--cx-accent-soft); border-top-color: var(--cx-accent);
	border-radius: 50%; animation: cx-spin 0.8s linear infinite;
}

/* Diff chips */
.cx-diff {
	display: inline-flex; align-items: center; gap: 6px; align-self: flex-start;
	background: var(--cx-surface); border: 1px solid var(--cx-border);
	border-radius: var(--cx-radius-sm); padding: 4px 10px;
	font: var(--cx-mono); font-size: 10.5px; color: var(--cx-fg-2);
	max-width: 100%;
}
.cx-diff__sign { font-weight: 700; flex: none; }
.cx-diff--created { border-color: rgba(20, 241, 149, 0.35); } .cx-diff--created .cx-diff__sign { color: var(--cx-success); }
.cx-diff--deleted { border-color: rgba(255, 100, 100, 0.35); } .cx-diff--deleted .cx-diff__sign { color: var(--cx-danger); }
.cx-diff--modified { border-color: rgba(255, 174, 0, 0.35); } .cx-diff--modified .cx-diff__sign { color: var(--cx-warning); }
.cx-diff__path { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* Usage / error entries */
.cx-usage { align-self: flex-end; font-size: 10px; color: var(--cx-muted); font-family: "SF Mono", Consolas, monospace; }
.cx-error {
	align-self: stretch;
	border: 1px solid rgba(255, 100, 100, 0.35); border-radius: var(--cx-radius);
	padding: 8px 12px; color: #ffb3b3; background: var(--cx-danger-soft); font-size: 11.5px;
}

/* ── Composer ───────────────────────────────────────────────────────────── */
.cx-composer { flex: none; padding: 10px 12px 8px; border-top: 1px solid var(--cx-border); background: var(--cx-bg); }
.cx-composer__modes { display: flex; gap: 3px; margin-bottom: 8px; flex-wrap: wrap; }
.cx-mode {
	background: none; border: 1px solid transparent; border-radius: var(--cx-radius-pill);
	color: var(--cx-muted); cursor: pointer; font-size: 10.5px; font-weight: 550;
	padding: 3px 10px; display: inline-flex; align-items: center; gap: 5px;
	transition: color 120ms var(--cx-ease), background 120ms var(--cx-ease), border-color 120ms var(--cx-ease);
}
.cx-mode:hover { color: var(--cx-fg-2); }
.cx-mode--active { background: var(--cx-accent-soft); border-color: var(--cx-accent-line); color: var(--cx-accent); }
.cx-mode__dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; opacity: 0.7; }
.cx-composer__box {
	border: 1px solid var(--cx-border); border-radius: var(--cx-radius);
	background: var(--cx-surface);
	transition: border-color 140ms var(--cx-ease), box-shadow 140ms var(--cx-ease);
}
.cx-composer__box:focus-within {
	border-color: var(--cx-accent-line);
	box-shadow: 0 0 0 3px rgba(61, 206, 214, 0.08);
}
.cx-composer__box textarea {
	display: block; width: 100%; resize: none;
	background: none; border: none; outline: none;
	color: var(--cx-fg); font: inherit;
	padding: 9px 11px 4px; min-height: 34px; max-height: 120px;
}
.cx-composer__box textarea::placeholder { color: var(--cx-muted); }
.cx-composer__bar { display: flex; align-items: center; gap: 6px; padding: 4px 8px 7px; }
.cx-attach {
	background: none; border: none; color: var(--cx-muted); cursor: pointer;
	width: 26px; height: 26px; border-radius: var(--cx-radius-sm); font-size: 14px;
	display: inline-flex; align-items: center; justify-content: center;
	transition: color 120ms var(--cx-ease), background 120ms var(--cx-ease);
}
.cx-attach:hover { color: var(--cx-accent); background: var(--cx-surface-2); }
.cx-composer__model {
	margin-left: auto;
	background: none; border: none; outline: none;
	color: var(--cx-muted); font-size: 10.5px; cursor: pointer;
	max-width: 130px; text-overflow: ellipsis;
	padding: 3px 4px; border-radius: var(--cx-radius-sm);
	transition: color 120ms var(--cx-ease);
}
.cx-composer__model:hover { color: var(--cx-fg-2); }
.cx-composer__model option { background: var(--cx-surface-2); color: var(--cx-fg); }
.cx-send {
	display: inline-flex; align-items: center; justify-content: center;
	width: 28px; height: 28px; flex: none;
	background: var(--cx-accent); color: #062a2c;
	border: none; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 700;
	transition: opacity 120ms var(--cx-ease), transform 120ms var(--cx-ease);
}
.cx-send:hover:not(:disabled) { opacity: 0.9; transform: translateY(-1px); }
.cx-send:disabled { background: var(--cx-surface-3); color: var(--cx-muted); cursor: default; }
.cx-stop {
	display: inline-flex; align-items: center; gap: 6px;
	background: none; border: 1px solid rgba(255, 100, 100, 0.4); border-radius: 8px;
	color: var(--cx-danger); cursor: pointer; font-size: 10.5px; font-weight: 600;
	padding: 5px 10px; transition: background 120ms var(--cx-ease);
}
.cx-stop:hover { background: var(--cx-danger-soft); }
.cx-stop i {
	width: 8px; height: 8px; border: 2px solid var(--cx-danger-soft); border-top-color: var(--cx-danger);
	border-radius: 50%; animation: cx-spin 0.8s linear infinite;
}
.cx-composer__meta {
	display: flex; align-items: center; gap: 8px;
	padding: 7px 2px 0; font-size: 10px; color: var(--cx-muted);
}
.cx-composer__meta:empty { display: none; padding: 0; }
.cx-composer__cost { font-family: "SF Mono", Consolas, monospace; }
.cx-composer__hint { margin-left: auto; }
.cx-composer__hint kbd {
	background: var(--cx-surface-2); border: 1px solid var(--cx-border);
	border-radius: 4px; padding: 0 4px; font-size: 9px;
}

/* ── Motion preferences ─────────────────────────────────────────────────── */
@media (prefers-reduced-motion: reduce) {
	.capix-assistant *, .capix-assistant *::before, .capix-assistant *::after {
		animation-duration: 0.01ms !important;
		animation-iteration-count: 1 !important;
		transition-duration: 0.01ms !important;
		scroll-behavior: auto !important;
	}
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

/** Compact relative time ("just now", "4m", "2h", "3d") for session rows. */
function relativeTime(iso: string): string {
	const then = Date.parse(iso);
	if (!Number.isFinite(then)) return "";
	const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
	if (seconds < 45) return "just now";
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
	return `${Math.floor(seconds / 86400)}d`;
}

const CHIP_ICONS: Record<CapixContextChip["kind"], string> = {
	file: "◈",
	selection: "✂",
	project: "◆",
	terminal: "›_",
	docs: "❖",
};

const MODE_DOTS: Record<string, string> = {
	ask: "#3dced6",
	plan: "#8fd9de",
	build: "#14f195",
	debug: "#ffae00",
	review: "#b48cff",
};

const STARTER_PROMPTS = [
	"Map this codebase and tell me where to start",
	"Find the highest-impact bug and fix it",
	"Review the current changes for production risks",
];

export interface CapixAssistantViewHandle {
	/** Tear down DOM listeners and the controller subscription. */
	dispose(): void;
	/** The root element (already attached to the container on mount). */
	readonly root: HTMLElement;
}

/**
 * Optional attach gestures supplied by the workbench shell. The view renders
 * the composer's attach menu only for the gestures that are provided; the
 * shell fulfils them by pushing chips through `controller.addChip`.
 */
export interface CapixAssistantViewOptions {
	onAttachFile?: () => void;
	onAttachSelection?: () => void;
	onAttachTerminal?: () => void;
}

/**
 * Mount the assistant into a host element owned by the workbench shell.
 * The host controls placement (secondary sidebar / right aux bar); this view
 * controls its own width within the host's bounds via the drag handle.
 */
export function mountCapixAssistant(
	container: HTMLElement,
	controller: CapixAssistantController,
	options: CapixAssistantViewOptions = {},
): CapixAssistantViewHandle {
	const style = document.createElement("style");
	style.textContent = CSS;

	const root = el("div", "capix-assistant");
	const resizeHandle = el("div", "capix-assistant__resize");
	resizeHandle.title = "Drag to resize";

	// ── Header ─────────────────────────────────────────────────────────────
	const header = el("div", "cx-header");
	const brand = el("div", "cx-brand");
	brand.append(el("span", "cx-brand__mark"), el("span", "cx-brand__name", "Capix"));
	const statusPill = el("span", "cx-status");
	const statusDot = el("span", "cx-status__dot");
	const statusText = el("span", undefined, "Ready");
	statusPill.append(statusDot, statusText);
	const historyButton = el("button", "cx-icon-btn", "☰");
	historyButton.title = "Session history";
	historyButton.setAttribute("aria-label", "Toggle session history");
	const newButton = el("button", "cx-icon-btn", "＋");
	newButton.title = "New session";
	newButton.setAttribute("aria-label", "New session");
	header.append(brand, statusPill, historyButton, newButton);

	// ── History drawer ─────────────────────────────────────────────────────
	const history = el("div", "cx-history");
	const historyHead = el("div", "cx-history__head");
	historyHead.append(el("div", "cx-history__title", "Sessions"));
	const searchWrap = el("div", "cx-history__search");
	searchWrap.append(el("span", undefined, "⌕"));
	const searchInput = el("input") as HTMLInputElement;
	searchInput.placeholder = "Search sessions…";
	searchInput.setAttribute("aria-label", "Search sessions");
	searchWrap.append(searchInput);
	historyHead.append(searchWrap);
	const historyList = el("div", "cx-history__list");
	history.append(historyHead, historyList);

	// ── Banners / chips / timeline ─────────────────────────────────────────
	const bannerSlot = el("div");
	bannerSlot.style.display = "contents";
	const chipsRow = el("div", "cx-chips");
	const timeline = el("div", "cx-timeline");
	timeline.setAttribute("aria-live", "polite");

	// ── Composer ───────────────────────────────────────────────────────────
	const composer = el("div", "cx-composer");
	const modeRow = el("div", "cx-composer__modes");
	const modeButtons = new Map<string, HTMLButtonElement>();
	for (const mode of CAPIX_ASSISTANT_MODES) {
		const button = el("button", "cx-mode") as HTMLButtonElement;
		const dot = el("span", "cx-mode__dot");
		dot.style.background = MODE_DOTS[mode] ?? "";
		button.append(dot, el("span", undefined, mode[0].toUpperCase() + mode.slice(1)));
		button.addEventListener("click", () =>
			controller.setMode(mode as CapixAssistantSnapshot["mode"]),
		);
		modeButtons.set(mode, button);
		modeRow.append(button);
	}

	const box = el("div", "cx-composer__box");
	const textarea = el("textarea") as HTMLTextAreaElement;
	textarea.placeholder = "Ask, plan, build…";
	textarea.rows = 1;
	textarea.setAttribute("aria-label", "Message Capix");
	const bar = el("div", "cx-composer__bar");

	const attachButton = el("button", "cx-attach", "📎");
	attachButton.title = "Attach context";
	attachButton.setAttribute("aria-label", "Attach context");

	const modelSelect = el("select", "cx-composer__model") as HTMLSelectElement;
	modelSelect.title = "Model";
	modelSelect.setAttribute("aria-label", "Model");
	const sendButton = el("button", "cx-send", "↑") as HTMLButtonElement;
	sendButton.title = "Send (Enter)";
	sendButton.setAttribute("aria-label", "Send message");
	const stopButton = el("button", "cx-stop") as HTMLButtonElement;
	stopButton.append(el("i"), el("span", undefined, "Stop"));
	stopButton.title = "Cancel the current turn";

	bar.append(attachButton, modelSelect, sendButton, stopButton);
	box.append(textarea, bar);
	const metaRow = el("div", "cx-composer__meta");
	const costSpan = el("span", "cx-composer__cost");
	const hintSpan = el("span", "cx-composer__hint");
	hintSpan.innerHTML = "<kbd>⏎</kbd> send · <kbd>⇧⏎</kbd> newline";
	metaRow.append(costSpan, hintSpan);
	composer.append(modeRow, box, metaRow);

	root.append(resizeHandle, header, history, bannerSlot, chipsRow, timeline, composer);
	container.append(style, root);

	// ── View-local UI state ─────────────────────────────────────────────────
	let historyOpen = false;
	let attachOpen = false;
	const openCards = new Set<string>();
	let stickToBottom = true;

	const hasAttachGestures = Boolean(
		options.onAttachFile || options.onAttachSelection || options.onAttachTerminal,
	);
	if (!hasAttachGestures) attachButton.style.display = "none";

	// ── Rendering ───────────────────────────────────────────────────────────

	function renderBanner(snapshot: CapixAssistantSnapshot): void {
		bannerSlot.textContent = "";
		if (snapshot.offline) {
			const banner = el("div", "cx-banner cx-banner--offline");
			const text = el("div", "cx-banner__text", "You're offline — messages will send when the connection returns.");
			banner.append(text);
			if (snapshot.lastError?.retryable) {
				const retry = el("button", "cx-banner__btn", "Retry now");
				retry.addEventListener("click", () => void controller.retryLastTurn());
				banner.append(retry);
			}
			bannerSlot.append(banner);
			return;
		}
		if (snapshot.lastError && !snapshot.streaming) {
			const banner = el("div", "cx-banner cx-banner--error");
			const text = el("div", "cx-banner__text");
			text.append(el("span", undefined, snapshot.lastError.message));
			if (snapshot.lastError.supportId) {
				text.append(el("span", "cx-banner__support", `support ref ${snapshot.lastError.supportId}`));
			}
			banner.append(text);
			if (snapshot.lastError.retryable) {
				const retry = el("button", "cx-banner__btn", "Retry");
				retry.addEventListener("click", () => void controller.retryLastTurn());
				banner.append(retry);
			}
			const dismiss = el("button", "cx-banner__btn", "Dismiss");
			dismiss.addEventListener("click", () => controller.dismissError());
			banner.append(dismiss);
			bannerSlot.append(banner);
		}
	}

	function renderHistory(snapshot: CapixAssistantSnapshot): void {
		history.classList.toggle("cx-history--open", historyOpen);
		historyButton.classList.toggle("cx-icon-btn--active", historyOpen);
		if (searchInput.value !== snapshot.sessionQuery) searchInput.value = snapshot.sessionQuery;

		historyList.textContent = "";
		if (snapshot.initializing) {
			const skeleton = el("div", "cx-skeleton");
			for (let i = 0; i < 4; i++) skeleton.append(el("div", "cx-skeleton__row"));
			historyList.append(skeleton);
			return;
		}
		if (!snapshot.visibleSessions.length) {
			historyList.append(
				el(
					"div",
					"cx-history__empty",
					snapshot.sessionQuery
						? `No sessions match “${snapshot.sessionQuery}”.`
						: "No sessions yet. Start a conversation below.",
				),
			);
			return;
		}
		for (const session of snapshot.visibleSessions) {
			const row = el(
				"button",
				`cx-session${session.id === snapshot.activeSessionId ? " cx-session--active" : ""}`,
			) as HTMLButtonElement;
			row.append(el("span", "cx-session__title", session.title));
			const meta = el("span", "cx-session__meta");
			meta.append(el("span", undefined, relativeTime(session.updatedAt)));
			const model = snapshot.models.find((m) => m.id === session.modelId);
			meta.append(el("span", undefined, model?.name ?? session.modelId));
			if (session.costMinor && session.costMinor !== "0") {
				meta.append(el("span", undefined, formatCost(session.costMinor)));
			}
			row.append(meta);
			row.addEventListener("click", () => {
				historyOpen = false;
				void controller.selectSession(session.id);
			});
			historyList.append(row);
		}
	}

	function renderChips(snapshot: CapixAssistantSnapshot): void {
		chipsRow.textContent = "";
		for (const chip of snapshot.chips) {
			const node = el("span", "cx-chip");
			node.title = chip.detail ?? chip.kind;
			node.append(
				el("span", "cx-chip__icon", CHIP_ICONS[chip.kind] ?? "◈"),
				el("span", "cx-chip__label", chip.label),
			);
			const remove = el("button", "cx-chip__x", "×");
			remove.setAttribute("aria-label", `Remove ${chip.label}`);
			remove.addEventListener("click", () => controller.removeChip(chip.id));
			node.append(remove);
			chipsRow.append(node);
		}
	}

	function planBadge(steps: Extract<CapixTimelineEntry, { kind: "plan" }>["steps"]): HTMLElement {
		const done = steps.filter((s) => s.status === "completed").length;
		const failed = steps.some((s) => s.status === "failed");
		const running = steps.some((s) => s.status === "in-progress");
		const cls = failed ? "cx-badge--danger" : running ? "cx-badge--warning" : done === steps.length ? "cx-badge--success" : "cx-badge--muted";
		return el("span", `cx-badge ${cls}`, `${done}/${steps.length}`);
	}

	function renderEntry(entry: CapixTimelineEntry): HTMLElement {
		const wrap = el("div", "cx-entry");
		switch (entry.kind) {
			case "message": {
				const node = el("div", `cx-msg cx-msg--${entry.role}`);
				if (entry.streaming && !entry.content) {
					const typing = el("span", "cx-typing");
					typing.append(el("i"), el("i"), el("i"));
					node.append(typing);
				} else {
					node.textContent = entry.content;
					if (entry.streaming) node.append(el("span", "cx-msg__cursor"));
				}
				wrap.append(node);
				return wrap;
			}
			case "plan": {
				const open = openCards.has(entry.id);
				const card = el("div", `cx-card${open ? " cx-card--open" : ""}`);
				const head = el("div", "cx-card__head");
				head.append(
					el("span", "cx-card__chev", "▶"),
					el("span", "cx-card__title", entry.title),
					planBadge(entry.steps),
				);
				head.addEventListener("click", () => {
					if (openCards.has(entry.id)) openCards.delete(entry.id);
					else openCards.add(entry.id);
					render(controller.getSnapshot());
				});
				const body = el("div", "cx-card__body");
				for (const step of entry.steps) {
					const row = el("div", `cx-plan__step cx-plan__step--${step.status}`);
					const marker =
						step.status === "completed" ? "✓"
						: step.status === "failed" ? "✗"
						: step.status === "in-progress" ? "◐"
						: step.status === "skipped" ? "–"
						: "○";
					row.append(el("span", "cx-plan__marker", marker), el("span", undefined, step.label));
					body.append(row);
				}
				const completed = entry.steps.filter((s) => s.status === "completed").length;
				const progress = el("div", "cx-plan__progress");
				const fill = el("i");
				fill.style.width = `${entry.steps.length ? (completed / entry.steps.length) * 100 : 0}%`;
				progress.append(fill);
				body.append(progress);
				card.append(head, body);
				wrap.append(card);
				return wrap;
			}
			case "tool": {
				const hasBody = Boolean(entry.detail || entry.output);
				const open = hasBody && openCards.has(entry.id);
				const card = el("div", `cx-card${open ? " cx-card--open" : ""}`);
				const head = el("div", "cx-card__head");
				head.append(el("span", "cx-card__chev", hasBody ? "▶" : ""));
				head.append(el("span", "cx-tool__name", entry.tool));
				head.append(el("span", "cx-card__title"));
				const tone =
					entry.status === "completed" ? "cx-badge--success"
					: entry.status === "awaiting-approval" ? "cx-badge--warning"
					: entry.status === "failed" || entry.status === "denied" ? "cx-badge--danger"
					: "cx-badge--accent";
				head.append(
					el(
						"span",
						`cx-badge ${tone}`,
						entry.status === "awaiting-approval" ? "approval" : entry.status,
					),
				);
				if (entry.status === "running") head.append(el("span", "cx-tool__spinner"));
				if (hasBody) {
					head.addEventListener("click", () => {
						if (openCards.has(entry.id)) openCards.delete(entry.id);
						else openCards.add(entry.id);
						render(controller.getSnapshot());
					});
				}
				card.append(head);
				if (hasBody) {
					const body = el("div", "cx-card__body");
					if (entry.detail) body.append(el("div", "cx-tool__output", entry.detail));
					if (entry.output) body.append(el("div", "cx-tool__output", entry.output));
					card.append(body);
				}
				wrap.append(card);
				return wrap;
			}
			case "diff": {
				const sign = entry.changeType === "created" ? "+" : entry.changeType === "deleted" ? "−" : "~";
				const node = el("div", `cx-diff cx-diff--${entry.changeType}`);
				node.title = entry.summary ?? entry.filePath;
				node.append(
					el("span", "cx-diff__sign", sign),
					el("span", "cx-diff__path", entry.filePath),
				);
				wrap.append(node);
				return wrap;
			}
			case "usage":
				wrap.append(el("div", "cx-usage", `turn ${formatCost(entry.costMinor)}`));
				return wrap;
			case "error":
				wrap.append(el("div", "cx-error", entry.message));
				return wrap;
		}
	}

	function renderEmptyState(): void {
		const empty = el("div", "cx-empty");
		empty.append(el("div", "cx-empty__glyph", "✦"));
		empty.append(el("div", "cx-empty__title", "Build from here."));
		empty.append(
			el(
				"div",
				"cx-empty__sub",
				"Capix understands your project, edits files, runs commands and verifies the result.",
			),
		);
		const starters = el("div", "cx-empty__starters");
		for (const prompt of STARTER_PROMPTS) {
			const button = el("button", "cx-starter") as HTMLButtonElement;
			button.append(el("span", undefined, prompt), el("span", "cx-starter__arrow", "→"));
			button.addEventListener("click", () => {
				controller.setDraft(prompt);
				textarea.focus();
			});
			starters.append(button);
		}
		empty.append(starters);
		const hint = el("div", "cx-empty__hint");
		hint.innerHTML = "<kbd>@</kbd> pin context &nbsp;·&nbsp; <kbd>⏎</kbd> send";
		empty.append(hint);
		timeline.append(empty);
	}

	function renderStatus(snapshot: CapixAssistantSnapshot): void {
		const state = snapshot.offline
			? ("offline" as const)
			: snapshot.streaming
				? ("streaming" as const)
				: snapshot.status === "error"
					? ("error" as const)
					: ("online" as const);
		statusPill.className = `cx-status cx-status--${state}`;
		statusText.textContent =
			state === "offline" ? "Offline"
			: state === "streaming" ? "Working"
			: state === "error" ? "Attention"
			: "Ready";
	}

	function render(snapshot: CapixAssistantSnapshot): void {
		root.style.width = `${snapshot.width}px`;

		renderStatus(snapshot);
		renderBanner(snapshot);
		renderHistory(snapshot);
		renderChips(snapshot);

		// Mode pills.
		for (const [mode, button] of modeButtons) {
			button.classList.toggle("cx-mode--active", mode === snapshot.mode);
		}

		// Model picker.
		modelSelect.textContent = "";
		const autoOption = document.createElement("option");
		autoOption.value = "auto";
		autoOption.textContent = "Auto · task-aware";
		modelSelect.append(autoOption);
		for (const model of snapshot.models) {
			const option = document.createElement("option");
			option.value = model.id;
			option.textContent = model.name;
			modelSelect.append(option);
		}
		modelSelect.value = snapshot.modelId;

		// Timeline (autoscroll only when the user is already near the bottom).
		stickToBottom =
			timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 48;
		timeline.textContent = "";
		if (snapshot.initializing && !snapshot.entries.length) {
			const skeleton = el("div", "cx-skeleton");
			for (let i = 0; i < 3; i++) skeleton.append(el("div", "cx-skeleton__row"));
			timeline.append(skeleton);
		} else if (!snapshot.entries.length) {
			renderEmptyState();
		} else {
			for (const entry of snapshot.entries) timeline.append(renderEntry(entry));
		}
		if (stickToBottom) timeline.scrollTop = timeline.scrollHeight;

		// Composer.
		if (textarea.value !== snapshot.draft) {
			textarea.value = snapshot.draft;
			autosize();
		}
		const canSend = !snapshot.streaming && !snapshot.offline && Boolean(snapshot.draft.trim());
		sendButton.disabled = !canSend;
		sendButton.style.display = snapshot.streaming ? "none" : "";
		stopButton.style.display = snapshot.streaming ? "" : "none";
		textarea.disabled = snapshot.offline;

		costSpan.textContent =
			snapshot.costMinor !== "0" ? `session ${formatCost(snapshot.costMinor)}` : "";
	}

	function autosize(): void {
		textarea.style.height = "auto";
		textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
	}

	// ── Events ──────────────────────────────────────────────────────────────

	const unsubscribe = controller.onDidChange(() => render(controller.getSnapshot()));

	textarea.addEventListener("input", () => {
		controller.setDraft(textarea.value);
		autosize();
	});
	textarea.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			void controller.submit();
		}
	});
	sendButton.addEventListener("click", () => void controller.submit());
	stopButton.addEventListener("click", () => void controller.cancelStream());
	newButton.addEventListener("click", () => void controller.newSession());
	historyButton.addEventListener("click", () => {
		historyOpen = !historyOpen;
		render(controller.getSnapshot());
	});
	searchInput.addEventListener("input", () => controller.setSessionQuery(searchInput.value));
	modelSelect.addEventListener("change", () => controller.setModel(modelSelect.value));

	// Attach menu: lightweight popover listing the shell-provided gestures.
	function closeAttachMenu(): void {
		attachOpen = false;
		render(controller.getSnapshot());
	}
	attachButton.addEventListener("click", () => {
		attachOpen = !attachOpen;
		if (!attachOpen) {
			render(controller.getSnapshot());
			return;
		}
		const menu = el("div");
		menu.style.cssText =
			"position:absolute;bottom:96px;left:12px;z-index:40;background:var(--cx-surface-2);" +
			"border:1px solid var(--cx-border-strong);border-radius:10px;box-shadow:var(--cx-shadow);" +
			"padding:4px;min-width:180px;animation:cx-enter 160ms var(--cx-ease);";
		const gestures: Array<{ label: string; run?: () => void }> = [
			{ label: "◈ Active file", run: options.onAttachFile },
			{ label: "✂ Current selection", run: options.onAttachSelection },
			{ label: "›_ Terminal output", run: options.onAttachTerminal },
		];
		for (const gesture of gestures) {
			if (!gesture.run) continue;
			const item = el(
				"button",
				undefined,
				gesture.label,
			) as HTMLButtonElement;
			item.style.cssText =
				"display:block;width:100%;text-align:left;background:none;border:none;color:var(--cx-fg-2);" +
				"padding:7px 10px;border-radius:6px;cursor:pointer;font-size:12px;";
			item.addEventListener("mouseenter", () => (item.style.background = "var(--cx-surface-3)"));
			item.addEventListener("mouseleave", () => (item.style.background = "none"));
			item.addEventListener("click", () => {
				gesture.run!();
				closeAttachMenu();
			});
			menu.append(item);
		}
		const dismiss = () => {
			menu.remove();
			document.removeEventListener("mousedown", onDocDown);
			attachOpen = false;
		};
		const onDocDown = (event: MouseEvent) => {
			if (!menu.contains(event.target as Node) && event.target !== attachButton) dismiss();
		};
		document.addEventListener("mousedown", onDocDown);
		root.append(menu);
	});

	// Close the history drawer when the timeline is clicked.
	timeline.addEventListener("mousedown", () => {
		if (historyOpen) {
			historyOpen = false;
			render(controller.getSnapshot());
		}
	});

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
	autosize();

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
