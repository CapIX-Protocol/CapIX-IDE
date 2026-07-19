/**
 * Tests for the CapixIDE agent debugger panel (`src/agentDebuggerPanel.ts`).
 *
 * Covers the pure helpers (escapeHtml, matchesBreakpoint, toDebuggerViewState,
 * inspectStepAt) and the provider's host-side behavior: recording runtime
 * events into the shared timeline/profiler, interactive breakpoints (add,
 * toggle, remove, hit → pause), the continue/step/pause controls, and the
 * variable-inspection message path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { mockShowErrorMsg, mockLoggerError } = vi.hoisted(() => ({
  mockShowErrorMsg: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock('vscode', () => ({
  window: {
    showInformationMessage: vi.fn(),
    showErrorMessage: mockShowErrorMsg,
  },
  Uri: { file: (p: string) => ({ fsPath: p }) },
}));

vi.mock('../src/logger', () => ({
  logger: { error: mockLoggerError, warn: vi.fn(), info: vi.fn() },
}));

import {
  CapixAgentDebuggerViewProvider,
  escapeHtml,
  inspectStepAt,
  matchesBreakpoint,
  toDebuggerViewState,
} from '../src/agentDebuggerPanel';
import {
  AGENT_EVENT_VERSION,
  AgentProfiler,
  AgentTimeline,
  type AgentEvent,
} from '../src/shared/agent-runtime/index';

// ── Helpers ─────────────────────────────────────────────────────────────────

let workDir: string;
let seq = 0;

function makeEvent(type: string, data: object): AgentEvent {
  seq += 1;
  return {
    version: AGENT_EVENT_VERSION,
    eventId: `evt_${seq}`,
    sessionId: 'ses_test',
    turnId: 'turn_1',
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    correlationId: 'corr_1',
    redaction: 'public',
    type,
    ...data,
  } as unknown as AgentEvent;
}

function toolRequestEvent(): AgentEvent {
  return makeEvent('tool.requested', {
    toolCallId: 'tc_1',
    toolName: 'write_file',
    args: { path: 'note.txt', content: 'hello' },
    requiresApproval: false,
  });
}

/** A fake WebviewView capturing the message handler and posted states. */
function makeFakeView() {
  const posted: unknown[] = [];
  let messageHandler: ((msg: unknown) => void) | null = null;
  const view = {
    webview: {
      options: undefined as unknown,
      html: '',
      onDidReceiveMessage: (handler: (msg: unknown) => void) => {
        messageHandler = handler;
      },
      postMessage: (msg: unknown) => {
        posted.push(msg);
        return Promise.resolve(true);
      },
    },
    show: vi.fn(),
  };
  return {
    view,
    posted,
    send: (msg: unknown) => messageHandler?.(msg),
    lastState: () =>
      (posted.filter((m) => (m as { type: string }).type === 'state').at(-1) as {
        state: ReturnType<typeof toDebuggerViewState>;
      })?.state,
  };
}

function makeProvider() {
  const provider = new CapixAgentDebuggerViewProvider(
    { fsPath: '/ext' } as never,
    { workspaceRoot: workDir }
  );
  const fake = makeFakeView();
  provider.resolveWebviewView(fake.view as never);
  return { provider, fake };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'capix-debugger-panel-test-'));
  seq = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ── Pure helpers ────────────────────────────────────────────────────────────

describe('view helpers', () => {
  it('escapes HTML for webview interpolation', () => {
    expect(escapeHtml('<b>"x" & \'</b>')).toBe('&lt;b&gt;&quot;x&quot; &amp; &#39;&lt;/b&gt;');
  });

  it('matches breakpoints with the CLI debugger semantics', () => {
    const timeline = new AgentTimeline();
    timeline.record(toolRequestEvent());
    timeline.record(
      makeEvent('file.diff', { filePath: 'note.txt', before: '', after: 'hello', diff: '+hello' })
    );
    const steps = timeline.getSteps();
    const toolStep = steps.find((s) => s.kind === 'tool_call')!;
    const fileStep = steps.find((s) => s.kind === 'file_change')!;

    const bp = { id: 'bp_1', toolName: 'write_file', enabled: true, hits: 0 };
    expect(matchesBreakpoint(toolStep, bp)).toBe(true);
    expect(matchesBreakpoint(fileStep, { ...bp, toolName: 'bash' })).toBe(false);
    expect(matchesBreakpoint(fileStep, { id: 'bp_2', filePath: 'note.txt', enabled: true, hits: 0 })).toBe(
      true
    );
    expect(matchesBreakpoint(toolStep, { id: 'bp_3', enabled: true, hits: 0 })).toBe(false);
  });

  it('builds the serializable view state', () => {
    const timeline = new AgentTimeline();
    const profiler = new AgentProfiler();
    timeline.record(makeEvent('turn.started', { promptLength: 8, modelId: 'capix/auto' }));

    const state = toDebuggerViewState(timeline, profiler, [], 'running', null);
    expect(state.steps).toHaveLength(1);
    expect(state.breakpoints).toEqual([]);
    expect(state.execution).toBe('running');
    expect(state.pausedAtStepId).toBeNull();
    expect(typeof state.updatedAt).toBe('string');
  });

  it('inspects a step with the state accumulated up to it', () => {
    const timeline = new AgentTimeline();
    timeline.record(makeEvent('reasoning.delta', { delta: 'thinking ' }));
    timeline.record(toolRequestEvent());
    timeline.record(
      makeEvent('tool.output', { toolName: 'write_file', output: 'wrote note.txt', isError: false })
    );
    timeline.record(
      makeEvent('file.diff', { filePath: 'note.txt', before: '', after: 'hello', diff: '+hello' })
    );
    timeline.record(makeEvent('content.delta', { content: 'done' }));

    const steps = timeline.getSteps();
    const fileStep = steps.find((s) => s.kind === 'file_change')!;
    const inspection = inspectStepAt(steps, fileStep.stepId)!;

    expect(inspection.stepId).toBe(fileStep.stepId);
    expect(inspection.reasoning).toBe('thinking ');
    expect(inspection.toolCalls).toHaveLength(1);
    expect(inspection.toolCalls[0]).toMatchObject({
      toolName: 'write_file',
      status: 'completed',
      filePath: 'note.txt',
    });
    expect(inspection.filesChanged).toEqual(['note.txt']);
    // Content arrived after the inspected step — excluded from its state.
    expect(inspection.content).toBe('');

    expect(inspectStepAt(steps, 'missing')).toBeNull();
  });
});

// ── Provider ────────────────────────────────────────────────────────────────

describe('CapixAgentDebuggerViewProvider', () => {
  it('records events into the shared engine and pushes state', () => {
    const { provider, fake } = makeProvider();
    expect(fake.view.webview.html).toContain('Debugger');
    expect(fake.posted).toHaveLength(1); // initial state on resolve

    provider.recordEvent(makeEvent('turn.started', { promptLength: 8, modelId: 'capix/auto' }));
    provider.recordEvent(toolRequestEvent());

    const state = fake.lastState();
    expect(state.steps).toHaveLength(2);
    expect(provider.getProfiler().getReport().toolCalls).toBe(1);
    expect(provider.getExecution()).toBe('idle'); // not armed — no pausing
  });

  it('adds, toggles, and removes breakpoints via webview messages', () => {
    const { provider, fake } = makeProvider();

    fake.send({ type: 'addBreakpoint', toolName: 'write_file' });
    expect(provider.getBreakpoints()).toHaveLength(1);
    expect(provider.getBreakpoints()[0]).toMatchObject({ toolName: 'write_file', enabled: true });

    const id = provider.getBreakpoints()[0]!.id;
    fake.send({ type: 'toggleBreakpoint', id });
    expect(provider.getBreakpoints()[0]!.enabled).toBe(false);
    fake.send({ type: 'toggleBreakpoint', id });
    expect(provider.getBreakpoints()[0]!.enabled).toBe(true);

    fake.send({ type: 'removeBreakpoint', id });
    expect(provider.getBreakpoints()).toHaveLength(0);
    // Removing an unknown id must not drop other breakpoints.
    fake.send({ type: 'addBreakpoint', onError: true });
    fake.send({ type: 'removeBreakpoint', id: 'bp_unknown' });
    expect(provider.getBreakpoints()).toHaveLength(1);
  });

  it('pauses execution when a breakpoint hits while armed', () => {
    const { provider, fake } = makeProvider();
    fake.send({ type: 'addBreakpoint', toolName: 'write_file' });
    fake.send({ type: 'start' });
    expect(provider.getExecution()).toBe('running');

    provider.recordEvent(makeEvent('turn.started', { promptLength: 8, modelId: 'capix/auto' }));
    expect(provider.getExecution()).toBe('running'); // no hit yet

    provider.recordEvent(toolRequestEvent());
    expect(provider.getExecution()).toBe('paused');
    expect(provider.getBreakpoints()[0]!.hits).toBe(1);

    const state = fake.lastState();
    expect(state.execution).toBe('paused');
    expect(state.pausedAtStepId).toBe(
      provider.getTimeline().getSteps().find((s) => s.kind === 'tool_call')!.stepId
    );
  });

  it('continue resumes to the next hit; step pauses at the next step', () => {
    const { provider, fake } = makeProvider();
    fake.send({ type: 'addBreakpoint', filePath: 'note.txt' });
    fake.send({ type: 'start' });

    provider.recordEvent(toolRequestEvent()); // hits file=note.txt via tool arg
    expect(provider.getExecution()).toBe('paused');

    fake.send({ type: 'step' });
    expect(provider.getExecution()).toBe('running');
    provider.recordEvent(
      makeEvent('tool.output', { toolName: 'write_file', output: 'ok', isError: false })
    );
    // Step mode pauses at the next step-producing event even without a hit.
    expect(provider.getExecution()).toBe('paused');

    fake.send({ type: 'continue' });
    expect(provider.getExecution()).toBe('running');
    provider.recordEvent(makeEvent('content.delta', { content: 'done' }));
    expect(provider.getExecution()).toBe('running'); // no breakpoint on content

    fake.send({ type: 'pause' });
    expect(provider.getExecution()).toBe('paused');
  });

  it('answers variable-inspection requests with an inspection message', () => {
    const { provider, fake } = makeProvider();
    provider.recordEvent(toolRequestEvent());
    provider.recordEvent(
      makeEvent('tool.output', { toolName: 'write_file', output: 'ok', isError: false })
    );

    const step = provider.getTimeline().getSteps().find((s) => s.kind === 'tool_call')!;
    fake.send({ type: 'inspect', stepId: step.stepId });

    const inspectionMsg = fake.posted
      .filter((m) => (m as { type: string }).type === 'inspection')
      .at(-1) as { inspection: ReturnType<typeof inspectStepAt> };
    expect(inspectionMsg.inspection!.stepId).toBe(step.stepId);
    expect(inspectionMsg.inspection!.toolCalls[0]).toMatchObject({
      toolName: 'write_file',
      status: 'completed',
    });
  });

  it('ignores malformed messages', async () => {
    const { provider, fake } = makeProvider();
    fake.send({ type: 'removeBreakpoint' }); // no id
    fake.send({ type: 'toggleBreakpoint' }); // no id
    fake.send({ type: 'inspect' }); // no stepId
    fake.send({ type: 'unknown' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(provider.getBreakpoints()).toHaveLength(0);
    expect(mockShowErrorMsg).not.toHaveBeenCalled();
  });
});
