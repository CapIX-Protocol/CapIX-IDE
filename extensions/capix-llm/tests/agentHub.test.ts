/**
 * Tests for the Agent hub (`src/agentHub.ts`) — the tabbed webview hosting
 * the orchestration, agent timeline and agent debugger panels as tab bodies.
 *
 * Covers the tab list, the id-prefixing that lets the three embedded panels
 * coexist in one document, the script embedding (acquireVsCodeApi may only be
 * called once per webview), and the state-sink / message-routing plumbing
 * that connects each tab body to its own panel provider.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => ({}));
vi.mock('../src/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import {
  AGENT_HUB_TABS,
  AGENT_HUB_ID_PREFIX,
  CapixAgentHubProvider,
  embeddableScript,
  isAgentHubTab,
  prefixIds,
  type AgentHubPanels,
} from '../src/agentHub';
import { ORCHESTRATION_SCRIPT } from '../src/orchestrationView';
import { AGENT_TIMELINE_BODY, AGENT_TIMELINE_SCRIPT } from '../src/agentTimelinePanel';
import { AGENT_DEBUGGER_BODY, AGENT_DEBUGGER_SCRIPT } from '../src/agentDebuggerPanel';

// ── Tabs ────────────────────────────────────────────────────────────────────

describe('agent hub tabs', () => {
  it('hosts exactly Orchestration, Timeline and Debugger', () => {
    expect(AGENT_HUB_TABS.map((t) => t.id)).toEqual(['orchestration', 'timeline', 'debugger']);
  });

  it('guards canonical tab ids', () => {
    expect(isAgentHubTab('timeline')).toBe(true);
    expect(isAgentHubTab('capix.agentTimeline.view')).toBe(false);
    expect(isAgentHubTab(undefined)).toBe(false);
  });

  it('assigns a distinct id prefix per tab', () => {
    const prefixes = AGENT_HUB_TABS.map((t) => AGENT_HUB_ID_PREFIX[t.id]);
    expect(new Set(prefixes).size).toBe(AGENT_HUB_TABS.length);
  });
});

// ── Id prefixing ────────────────────────────────────────────────────────────

describe('prefixIds', () => {
  it('re-prefixes every element id in an embedded body', () => {
    expect(prefixIds('<div id="steps"></div><input id="bp-tool">', 'dbg-')).toBe(
      '<div id="dbg-steps"></div><input id="dbg-bp-tool">'
    );
  });

  it('eliminates the id collisions between the timeline and debugger bodies', () => {
    const tl = prefixIds(AGENT_TIMELINE_BODY, AGENT_HUB_ID_PREFIX.timeline);
    const dbg = prefixIds(AGENT_DEBUGGER_BODY, AGENT_HUB_ID_PREFIX.debugger);
    const ids = (html: string) => [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    const shared = ids(tl).filter((id) => ids(dbg).includes(id));
    expect(shared).toEqual([]);
  });

  it('leaves bodies without ids untouched', () => {
    expect(prefixIds('<div class="x">hi</div>', 'orch-')).toBe('<div class="x">hi</div>');
  });
});

// ── Script embedding ────────────────────────────────────────────────────────

describe('embeddableScript', () => {
  it('strips the standalone acquireVsCodeApi bootstrap (single-acquire rule)', () => {
    for (const script of [ORCHESTRATION_SCRIPT, AGENT_TIMELINE_SCRIPT, AGENT_DEBUGGER_SCRIPT]) {
      expect(script).toContain('acquireVsCodeApi()');
      expect(embeddableScript(script)).not.toContain('acquireVsCodeApi');
    }
  });

  it('keeps the rest of the panel script intact', () => {
    const embedded = embeddableScript(AGENT_TIMELINE_SCRIPT);
    expect(embedded).toContain('vscode.postMessage({ type: "ready" })');
    expect(embedded).toContain('window.addEventListener("message"');
  });
});

// ── Hub provider plumbing ───────────────────────────────────────────────────

function makePanels() {
  const sinks: Record<string, ((state: unknown) => void) | null> = {
    orchestration: null,
    timeline: null,
    debugger: null,
  };
  let inspectionSink: ((inspection: unknown) => void) | null = null;
  const calls: Array<{ tab: string; msg: unknown }> = [];
  const panels: AgentHubPanels = {
    orchestration: {
      setStateSink: vi.fn((s) => {
        sinks.orchestration = s;
      }),
      handleMessage: vi.fn((m) => calls.push({ tab: 'orchestration', msg: m })),
    },
    timeline: {
      setStateSink: vi.fn((s) => {
        sinks.timeline = s;
      }),
      handleMessage: vi.fn((m) => calls.push({ tab: 'timeline', msg: m })),
    },
    debugger: {
      setStateSink: vi.fn((s) => {
        sinks.debugger = s;
      }),
      setInspectionSink: vi.fn((s) => {
        inspectionSink = s;
      }),
      handleMessage: vi.fn((m) => calls.push({ tab: 'debugger', msg: m })),
    },
  } as unknown as AgentHubPanels;
  return { panels, sinks, calls, getInspectionSink: () => inspectionSink };
}

function makeView() {
  const posted: unknown[] = [];
  let messageHandler: ((msg: unknown) => void) | undefined;
  const view = {
    webview: {
      options: {},
      html: '',
      postMessage: vi.fn((m: unknown) => {
        posted.push(m);
      }),
      onDidReceiveMessage: vi.fn((fn: (msg: unknown) => void) => {
        messageHandler = fn;
      }),
    },
    show: vi.fn(),
  };
  return {
    view,
    posted,
    fire: (msg: unknown) => messageHandler?.(msg),
  };
}

describe('CapixAgentHubProvider', () => {
  let uri: never;

  beforeEach(() => {
    uri = undefined as never;
  });

  it('wires a state sink per embedded panel plus the debugger inspection sink', () => {
    const { panels, sinks, getInspectionSink } = makePanels();
    new CapixAgentHubProvider(panels, uri);
    expect(sinks.orchestration).toBeTypeOf('function');
    expect(sinks.timeline).toBeTypeOf('function');
    expect(sinks.debugger).toBeTypeOf('function');
    expect(getInspectionSink()).toBeTypeOf('function');
  });

  it('routes tab-tagged webview messages to the owning panel only', () => {
    const { panels, calls } = makePanels();
    const hub = new CapixAgentHubProvider(panels, uri);
    const { view, fire } = makeView();
    hub.resolveWebviewView(view as never);

    fire({ tab: 'timeline', type: 'rollback', stepId: 'st_1' });
    fire({ tab: 'debugger', type: 'pause' });
    fire({ tab: 'orchestration', type: 'ready' });
    fire({ tab: 'nope', type: 'ready' });

    expect(calls).toEqual([
      { tab: 'timeline', msg: { type: 'rollback', stepId: 'st_1' } },
      { tab: 'debugger', msg: { type: 'pause' } },
      { tab: 'orchestration', msg: { type: 'ready' } },
    ]);
  });

  it('delivers panel state snapshots back to the correct tab body', () => {
    const { panels, sinks } = makePanels();
    const hub = new CapixAgentHubProvider(panels, uri);
    const { view, posted } = makeView();
    hub.resolveWebviewView(view as never);

    sinks.timeline!({ steps: [] });
    sinks.debugger!({ execution: 'paused' });

    expect(posted).toEqual([
      { tab: 'timeline', payload: { type: 'state', state: { steps: [] } } },
      { tab: 'debugger', payload: { type: 'state', state: { execution: 'paused' } } },
    ]);
  });

  it('renders one tab bar and three embedded, id-prefixed tab bodies', () => {
    const { panels } = makePanels();
    const hub = new CapixAgentHubProvider(panels, uri);
    const { view } = makeView();
    hub.resolveWebviewView(view as never);
    const html = view.webview.html;

    expect(html).toContain('data-tab="orchestration"');
    expect(html).toContain('data-tab="timeline"');
    expect(html).toContain('data-tab="debugger"');
    expect(html).toContain('data-panel="timeline"');
    // Embedded bodies are id-prefixed (no raw collisions in the document).
    expect(html).toContain('id="tl-steps"');
    expect(html).toContain('id="dbg-steps"');
    expect(html).not.toContain('id="steps"');
    // The hub acquires the vscode API exactly once; embedded scripts never do.
    expect(html.match(/acquireVsCodeApi/g)).toHaveLength(1);
    // Strict CSP: no eval escape hatch — panel scripts ship in nonce'd blocks.
    expect(html).not.toContain('unsafe-eval');
    expect(html).toContain('__capixHubEmbed');
  });
});
