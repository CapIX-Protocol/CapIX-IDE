import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })),
    showErrorMessage: vi.fn(),
  },
}));

import {
  CapixOrchestrationViewProvider,
  escapeHtml,
  formatUsdMinor,
  toViewState,
} from '../src/orchestrationView';
import {
  OrchestrationEngine,
  type Delegation,
  type DelegationResult,
} from '../src/shared/agent-runtime/index';

const okExecutor = async (d: Delegation): Promise<DelegationResult> => ({
  outcome: 'success',
  summary: `done: ${d.task}`,
});

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

interface FakeView {
  webview: {
    options: unknown;
    html: string;
    posted: unknown[];
    postMessage: ReturnType<typeof vi.fn>;
    onDidReceiveMessage: ReturnType<typeof vi.fn>;
  };
  show: ReturnType<typeof vi.fn>;
  messageHandler: (msg: Record<string, unknown>) => void;
}

function makeView(): FakeView {
  const view: FakeView = {
    webview: {
      options: undefined,
      html: '',
      posted: [],
      postMessage: vi.fn(function (this: FakeView, msg: unknown) {
        view.webview.posted.push(msg);
        return Promise.resolve(true);
      }),
      onDidReceiveMessage: vi.fn((handler: (msg: Record<string, unknown>) => void) => {
        view.messageHandler = handler;
      }),
    },
    show: vi.fn(),
    messageHandler: () => {},
  };
  return view;
}

function lastState(view: FakeView) {
  const messages = view.webview.posted as Array<{
    type: string;
    state?: ReturnType<typeof toViewState>;
  }>;
  const stateMsg = [...messages].reverse().find((m) => m.type === 'state');
  return stateMsg?.state;
}

// ── Pure helpers ────────────────────────────────────────────────────────────

describe('orchestrationView helpers', () => {
  it('escapeHtml neutralizes markup', () => {
    expect(escapeHtml(`<script>"x"&'y'`)).toBe('&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;');
  });

  it('formatUsdMinor renders integer cents without floats', () => {
    expect(formatUsdMinor('0')).toBe('0.00');
    expect(formatUsdMinor('5')).toBe('0.05');
    expect(formatUsdMinor('123')).toBe('1.23');
    expect(formatUsdMinor('100000')).toBe('1000.00');
  });

  it('toViewState mirrors engine state and scores the draft task', async () => {
    const engine = new OrchestrationEngine({ executor: okExecutor });
    const delegation = engine.delegate({ role: 'implement', task: 'add auth' });
    await flush();
    engine.recordUsage(delegation.id, { costMinor: '250' });

    const state = toViewState(engine, { task: 'deploy to production' });
    expect(state.specialists).toHaveLength(6);
    expect(state.history).toHaveLength(1);
    expect(state.suggestions[0].role).toBe('deploy');
    expect(state.estimate?.role).toBe('deploy');
    const implement = state.costs.find((c) => c.role === 'implement')!;
    expect(implement.costMinor).toBe('250');
  });

  it('toViewState without a draft has no suggestions or estimate', () => {
    const engine = new OrchestrationEngine();
    const state = toViewState(engine);
    expect(state.suggestions).toEqual([]);
    expect(state.estimate).toBeNull();
    expect(state.pipeline).toBeNull();
  });
});

// ── Provider ────────────────────────────────────────────────────────────────

describe('CapixOrchestrationViewProvider', () => {
  let engine: OrchestrationEngine;
  let provider: CapixOrchestrationViewProvider;
  let view: FakeView;

  beforeEach(() => {
    engine = new OrchestrationEngine({ executor: okExecutor });
    provider = new CapixOrchestrationViewProvider(engine, { fsPath: '/ext' } as never);
    view = makeView();
    provider.resolveWebviewView(view as never);
  });

  it('renders a strict-CSP webview shell and pushes initial state', () => {
    expect(view.webview.html).toContain('Content-Security-Policy');
    expect(view.webview.html).toContain("script-src 'nonce-");
    expect(view.webview.html).toContain('Run full pipeline');
    expect(lastState(view)).toBeDefined();
  });

  it('draft messages update suggestions and the cost estimate', () => {
    view.messageHandler({ type: 'draft', task: 'scan for injection vulnerabilities' });
    const state = lastState(view)!;
    expect(state.suggestions[0].role).toBe('security');
    expect(state.estimate?.role).toBe('security');
  });

  it('delegate messages queue a delegation and clear the draft', async () => {
    view.messageHandler({ type: 'draft', task: 'write tests for the parser' });
    view.messageHandler({ type: 'delegate', task: 'write tests for the parser', role: '' });
    await flush();

    const history = engine.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].role).toBe('test');
    expect(history[0].status).toBe('completed');

    const state = lastState(view)!;
    expect(state.suggestions).toEqual([]);
    expect(state.history[0].summary).toContain('write tests for the parser');
  });

  it('pushes state on every orchestration event', async () => {
    const before = view.webview.posted.length;
    engine.delegate({ role: 'explore', task: 'map the repo' });
    await flush();
    expect(view.webview.posted.length).toBeGreaterThan(before);
  });

  it('startPipeline creates and runs the full pipeline', async () => {
    view.messageHandler({ type: 'startPipeline', goal: 'ship auth' });
    await flush(30);

    const pipelines = engine.listPipelines();
    expect(pipelines).toHaveLength(1);
    expect(pipelines[0].goal).toBe('ship auth');
    expect(pipelines[0].status).toBe('completed');
    const state = lastState(view)!;
    expect(state.pipeline?.status).toBe('completed');
  });

  it('cancelDelegation cancels a queued delegation', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const gated = new OrchestrationEngine({
      maxParallel: 1,
      executor: async () => {
        await gate;
        return { outcome: 'success', summary: 'ok' };
      },
    });
    const gatedProvider = new CapixOrchestrationViewProvider(gated, { fsPath: '/ext' } as never);
    const gatedView = makeView();
    gatedProvider.resolveWebviewView(gatedView as never);

    const first = gated.delegate({ role: 'implement', task: 'first' });
    const second = gated.delegate({ role: 'test', task: 'second' });
    await flush(2);

    gatedView.messageHandler({ type: 'cancelDelegation', id: second.id });
    await flush(2);
    expect(gated.getDelegation(second.id)!.status).toBe('cancelled');
    expect(gated.getDelegation(first.id)!.status).toBe('running');
    release();
    await flush();
    gatedProvider.dispose();
  });

  it('dispose stops engine mirroring', async () => {
    provider.dispose();
    const before = view.webview.posted.length;
    engine.delegate({ role: 'explore', task: 'map' });
    await flush();
    expect(view.webview.posted.length).toBe(before);
  });
});
