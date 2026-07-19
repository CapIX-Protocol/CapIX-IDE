/**
 * Tests for the CapixIDE agent timeline panel (`src/agentTimelinePanel.ts`).
 *
 * Covers the pure view helpers (escapeHtml, formatCostMinor, toViewState)
 * and the provider's host-side behavior: recording runtime events into the
 * shared timeline/profiler, pushing state to the webview, and the one-click
 * rollback message path (success + conflict error surfacing).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { mockShowInfoMsg, mockShowErrorMsg, mockLoggerError } = vi.hoisted(() => ({
  mockShowInfoMsg: vi.fn(),
  mockShowErrorMsg: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock('vscode', () => ({
  window: {
    showInformationMessage: mockShowInfoMsg,
    showErrorMessage: mockShowErrorMsg,
  },
  Uri: { file: (p: string) => ({ fsPath: p }) },
}));

vi.mock('../src/logger', () => ({
  logger: { error: mockLoggerError, warn: vi.fn(), info: vi.fn() },
}));

import {
  CapixAgentTimelineViewProvider,
  escapeHtml,
  formatCostMinor,
  toViewState,
} from '../src/agentTimelinePanel';
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
  };
}

function makeProvider() {
  const provider = new CapixAgentTimelineViewProvider(
    { fsPath: '/ext' } as never,
    { workspaceRoot: workDir }
  );
  const fake = makeFakeView();
  provider.resolveWebviewView(fake.view as never);
  return { provider, fake };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'capix-timeline-panel-test-'));
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

  it('formats integer minor units without floats', () => {
    expect(formatCostMinor('350000')).toBe('0.350000');
    expect(formatCostMinor('1')).toBe('0.000001');
    expect(formatCostMinor('123456789')).toBe('123.456789');
  });

  it('builds the serializable view state from the shared engine', () => {
    const timeline = new AgentTimeline();
    const profiler = new AgentProfiler();
    timeline.record(makeEvent('turn.started', { promptLength: 8, modelId: 'capix/auto' }));
    profiler.record(makeEvent('turn.started', { promptLength: 8, modelId: 'capix/auto' }));

    const state = toViewState(timeline, profiler);
    expect(state.steps).toHaveLength(1);
    expect(state.steps[0]!.kind).toBe('turn');
    expect(state.profile.toolCalls).toBe(0);
    expect(typeof state.updatedAt).toBe('string');
  });
});

// ── Provider ────────────────────────────────────────────────────────────────

describe('CapixAgentTimelineViewProvider', () => {
  it('records events into the shared engine and pushes state', () => {
    const { provider, fake } = makeProvider();
    expect(fake.view.webview.html).toContain('Timeline');
    expect(fake.posted).toHaveLength(1); // initial state on resolve

    provider.recordEvent(makeEvent('turn.started', { promptLength: 8, modelId: 'capix/auto' }));
    provider.recordEvent(
      makeEvent('tool.requested', {
        toolCallId: 'tc_1',
        toolName: 'write_file',
        args: { path: 'note.txt', content: 'hello' },
        requiresApproval: false,
      })
    );

    const last = fake.posted.at(-1) as { type: string; state: { steps: unknown[] } };
    expect(last.type).toBe('state');
    expect(last.state.steps).toHaveLength(2);

    const inspection = provider.getTimeline().inspectToolCall('tc_1')!;
    expect(inspection.filePath).toBe('note.txt');
    expect(provider.getProfiler().getReport().toolCalls).toBe(1);
  });

  it('rolls back a file change from a webview message', async () => {
    writeFileSync(join(workDir, 'note.txt'), 'agent wrote this', 'utf8');
    const { provider, fake } = makeProvider();

    provider.recordEvent(makeEvent('turn.started', { promptLength: 8, modelId: 'capix/auto' }));
    provider.recordEvent(
      makeEvent('tool.requested', {
        toolCallId: 'tc_1',
        toolName: 'write_file',
        args: { path: 'note.txt', content: 'agent wrote this' },
        requiresApproval: false,
      })
    );
    provider.recordEvent(
      makeEvent('file.diff', {
        filePath: 'note.txt',
        before: 'original',
        after: 'agent wrote this',
        diff: '-original\n+agent wrote this',
      })
    );

    const step = provider.getTimeline().getSteps().find((s) => s.kind === 'file_change')!;
    fake.send({ type: 'rollback', stepId: step.stepId });
    await vi.waitFor(() => {
      expect(readFileSync(join(workDir, 'note.txt'), 'utf8')).toBe('original');
    });
    expect(mockShowInfoMsg).toHaveBeenCalledWith(expect.stringContaining('note.txt'));
  });

  it('removes a file the agent created when rolling back', async () => {
    const { provider, fake } = makeProvider();
    writeFileSync(join(workDir, 'created.txt'), 'new file', 'utf8');

    provider.recordEvent(
      makeEvent('file.diff', {
        filePath: 'created.txt',
        before: '',
        after: 'new file',
        diff: '+new file',
      })
    );

    const step = provider.getTimeline().getSteps().find((s) => s.kind === 'file_change')!;
    fake.send({ type: 'rollback', stepId: step.stepId });
    await vi.waitFor(() => {
      expect(existsSync(join(workDir, 'created.txt'))).toBe(false);
    });
  });

  it('surfaces rollback conflicts as error messages, not crashes', async () => {
    const { provider, fake } = makeProvider();
    provider.recordEvent(
      makeEvent('file.diff', { filePath: 'f.txt', before: '', after: 'a', diff: '+a' })
    );
    // Same-millisecond timestamps must not confuse the conflict check.
    provider.recordEvent(
      makeEvent('file.diff', { filePath: 'f.txt', before: 'a', after: 'b', diff: '-a\n+b' })
    );

    const first = provider.getTimeline().getSteps().find((s) => s.kind === 'file_change')!;
    fake.send({ type: 'rollback', stepId: first.stepId });
    await vi.waitFor(() => {
      expect(mockShowErrorMsg).toHaveBeenCalledWith(expect.stringContaining('later change'));
    });
    expect(first.rolledBack).toBe(false);
  });

  it('ignores malformed messages', async () => {
    const { fake } = makeProvider();
    fake.send({ type: 'rollback' }); // no stepId
    fake.send({ type: 'unknown' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockShowErrorMsg).not.toHaveBeenCalled();
  });
});
