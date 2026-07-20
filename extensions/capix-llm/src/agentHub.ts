/**
 * Agent Hub — the single agent-operations sidebar surface (`capix.agent.hub`).
 *
 * One tabbed webview that hosts the three agent surfaces that used to be
 * separate sidebar views (`capix.orchestration.view`,
 * `capix.agentTimeline.view`, `capix.agentDebugger.view`):
 *
 *     Orchestration | Timeline | Debugger
 *
 * The three existing panels keep their own HTML bodies, scripts, message
 * protocols and host-side providers — the hub embeds each body as a tab
 * (re-prefixing element ids so they cannot collide) and sandboxes each
 * panel script with per-tab `vscode` / `document` / `window` shims, so a
 * message from a tab is routed to its own provider and state snapshots flow
 * back only to that tab. All three tabs observe the same active runtime
 * session by construction: the providers they wrap are the same instances
 * the extension wires to the shared orchestration/observability engines.
 *
 * Tab selection persists across webview restore via getState/setState.
 *
 * Visual foundation matches the panels themselves (@capix/ui-tokens dark,
 * cyan #3DCED6). Tab bar: horizontal, top, 32px, cyan underline on the
 * active tab, compact mono labels.
 */

import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import {
  CapixOrchestrationViewProvider,
  ORCHESTRATION_BODY,
  ORCHESTRATION_SCRIPT,
  ORCHESTRATION_STYLES,
} from './orchestrationView';
import {
  CapixAgentTimelineViewProvider,
  AGENT_TIMELINE_BODY,
  AGENT_TIMELINE_SCRIPT,
  AGENT_TIMELINE_STYLES,
} from './agentTimelinePanel';
import {
  CapixAgentDebuggerViewProvider,
  AGENT_DEBUGGER_BODY,
  AGENT_DEBUGGER_SCRIPT,
  AGENT_DEBUGGER_STYLES,
} from './agentDebuggerPanel';
import { logger } from './logger';

// ── Tabs ────────────────────────────────────────────────────────────────────

export type AgentHubTab = 'orchestration' | 'timeline' | 'debugger';

export const AGENT_HUB_TABS: Array<{ id: AgentHubTab; label: string }> = [
  { id: 'orchestration', label: 'Orchestration' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'debugger', label: 'Debugger' },
];

/** Type guard — accepts only canonical agent hub tab ids. */
export function isAgentHubTab(value: unknown): value is AgentHubTab {
  return typeof value === 'string' && AGENT_HUB_TABS.some((t) => t.id === value);
}

/** Element-id prefix per tab — keeps the embedded panels' ids collision-free. */
export const AGENT_HUB_ID_PREFIX: Record<AgentHubTab, string> = {
  orchestration: 'orch-',
  timeline: 'tl-',
  debugger: 'dbg-',
};

/**
 * Re-prefix every element id in an embedded panel body so the three tab
 * bodies can coexist in one document (the timeline and debugger panels use
 * overlapping ids like `steps`, `tools`, `totals`).
 */
export function prefixIds(html: string, prefix: string): string {
  return html.replace(/id="([^"]+)"/g, (_match, id: string) => `id="${prefix}${id}"`);
}

/**
 * Strip the standalone `acquireVsCodeApi()` bootstrap from a panel script so
 * it can run inside the hub's per-tab sandbox (the API may only be acquired
 * once per webview — the hub acquires it and hands each tab a shim).
 */
export function embeddableScript(script: string): string {
  return script.replace(/^[ \t]*const vscode = acquireVsCodeApi\(\);[ \t]*$/m, '');
}

// ── Provider ────────────────────────────────────────────────────────────────

export interface AgentHubPanels {
  orchestration: CapixOrchestrationViewProvider;
  timeline: CapixAgentTimelineViewProvider;
  debugger: CapixAgentDebuggerViewProvider;
}

export class CapixAgentHubProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'capix.agent.hub';

  private view?: vscode.WebviewView;

  constructor(
    private readonly panels: AgentHubPanels,
    private readonly extensionUri: vscode.Uri
  ) {
    // Route each embedded panel's snapshots to its own tab body.
    this.panels.orchestration.setStateSink((state) =>
      this.post('orchestration', { type: 'state', state })
    );
    this.panels.timeline.setStateSink((state) => this.post('timeline', { type: 'state', state }));
    this.panels.debugger.setStateSink((state) => this.post('debugger', { type: 'state', state }));
    this.panels.debugger.setInspectionSink((inspection) =>
      this.post('debugger', { type: 'inspection', inspection })
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = this.getHtml();
    view.webview.onDidReceiveMessage((msg: { tab?: string } & Record<string, unknown>) =>
      this.route(msg)
    );
  }

  /** Expand/focus the view. */
  show(): void {
    this.view?.show?.(true);
  }

  dispose(): void {
    this.panels.orchestration.setStateSink(null);
    this.panels.timeline.setStateSink(null);
    this.panels.debugger.setStateSink(null);
    this.panels.debugger.setInspectionSink(null);
    this.view = undefined;
  }

  /** Deliver a payload to one tab body (the hub script fans it out there). */
  private post(tab: AgentHubTab, payload: Record<string, unknown>): void {
    if (!this.view) return;
    void this.view.webview.postMessage({ tab, payload });
  }

  /** Route a message from a tab body to its own panel provider. */
  private route(msg: { tab?: string } & Record<string, unknown>): void {
    const { tab, ...rest } = msg;
    try {
      switch (tab) {
        case 'orchestration':
          void this.panels.orchestration.handleMessage(
            rest as Parameters<CapixOrchestrationViewProvider['handleMessage']>[0]
          );
          return;
        case 'timeline':
          void this.panels.timeline.handleMessage(
            rest as Parameters<CapixAgentTimelineViewProvider['handleMessage']>[0]
          );
          return;
        case 'debugger':
          this.panels.debugger.handleMessage(
            rest as Parameters<CapixAgentDebuggerViewProvider['handleMessage']>[0]
          );
          return;
        default:
          return;
      }
    } catch (err) {
      logger.error('AgentHub message routing failed', { tab, error: String(err) });
    }
  }

  // ── HTML ────────────────────────────────────────────────────────────────

  private getHtml(): string {
    const nonce = randomBytes(16).toString('base64');
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">`;

    const tabs = AGENT_HUB_TABS.map(
      (t, i) =>
        `<button class="hub-tab${i === 0 ? ' active' : ''}" data-tab="${t.id}">${t.label}</button>`
    ).join('');

    const bodies: Array<{ tab: AgentHubTab; body: string; script: string }> = [
      { tab: 'orchestration', body: ORCHESTRATION_BODY, script: ORCHESTRATION_SCRIPT },
      { tab: 'timeline', body: AGENT_TIMELINE_BODY, script: AGENT_TIMELINE_SCRIPT },
      { tab: 'debugger', body: AGENT_DEBUGGER_BODY, script: AGENT_DEBUGGER_SCRIPT },
    ];
    const panels = bodies
      .map(
        (b, i) =>
          `<section class="hub-panel${i === 0 ? ' active' : ''}" data-panel="${b.tab}">${prefixIds(b.body, AGENT_HUB_ID_PREFIX[b.tab])}</section>`
      )
      .join('');
    const embeds = bodies
      .map(
        (b) => `<script nonce="${nonce}">
window.__capixHubEmbed(${JSON.stringify(b.tab)}, ${JSON.stringify(AGENT_HUB_ID_PREFIX[b.tab])}, function (vscode, document, window) {
${embeddableScript(b.script)}
});
</script>`
      )
      .join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
${csp}
<style>
${ORCHESTRATION_STYLES}
${AGENT_TIMELINE_STYLES}
${AGENT_DEBUGGER_STYLES}
  /* Tab bar: horizontal, top, 32px, cyan underline on the active tab. */
  body { padding: 0; overflow: hidden; display: flex; flex-direction: column; height: 100vh; }
  .hub-tabs {
    display: flex; align-items: stretch; height: 32px; flex: none;
    border-bottom: 1px solid var(--border);
    overflow-x: auto; scrollbar-width: none;
  }
  .hub-tabs::-webkit-scrollbar { display: none; }
  .hub-tab {
    flex: 0 0 auto;
    background: transparent; border: none; cursor: pointer;
    border-bottom: 2px solid transparent;
    color: var(--muted);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10px; text-transform: uppercase; letter-spacing: .08em;
    padding: 0 12px;
  }
  .hub-tab:hover { color: var(--text); }
  .hub-tab.active { color: var(--cyan); border-bottom-color: var(--cyan); }
  .hub-panel { display: none; flex: 1; overflow-y: auto; padding: 12px; }
  .hub-panel.active { display: block; }
</style>
</head>
<body>
  <nav class="hub-tabs">${tabs}</nav>
  ${panels}
  <script nonce="${nonce}">${HUB_SHELL_SCRIPT}</script>
${embeds}
</body>
</html>`;
  }
}

// ── Hub shell script: tab switching (persisted) + per-tab sandbox ───────────

const HUB_SHELL_SCRIPT = /* javascript */ `
const api = acquireVsCodeApi();
const tabListeners = {};

function selectTab(id) {
  api.setState({ tab: id });
  document.querySelectorAll(".hub-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === id));
  document.querySelectorAll(".hub-panel").forEach((p) => p.classList.toggle("active", p.dataset.panel === id));
}

document.querySelectorAll(".hub-tab").forEach((b) =>
  b.addEventListener("click", () => selectTab(b.dataset.tab))
);

// Run one panel script inside a per-tab sandbox: ids resolve within the tab's
// id prefix, outbound messages are tagged with the tab id, and inbound state
// messages arrive only from that tab's provider. (No eval/new Function — the
// strict CSP forbids them; each panel script ships inside its own nonce'd
// <script> block wrapped in a function that receives these shims.)
window.__capixHubEmbed = function (tabId, prefix, fn) {
  const container = document.querySelector('.hub-panel[data-panel="' + tabId + '"]');
  const listeners = [];
  const docShim = {
    getElementById: (id) => document.getElementById(prefix + id),
    createElement: (tag) => document.createElement(tag),
    body: container,
  };
  const winShim = {
    addEventListener: (type, handler) => {
      if (type === "message") listeners.push(handler);
      else window.addEventListener(type, handler);
    },
  };
  const vscodeShim = {
    postMessage: (msg) => api.postMessage(Object.assign({ tab: tabId }, msg)),
  };
  fn(vscodeShim, docShim, winShim);
  tabListeners[tabId] = listeners;
};

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg && msg.tab && tabListeners[msg.tab]) {
    for (const fn of tabListeners[msg.tab]) fn({ data: msg.payload });
  }
});

// Restore the persisted tab selection (getState/setState).
const savedTab = api.getState() && api.getState().tab;
if (savedTab) selectTab(savedTab);
`;
