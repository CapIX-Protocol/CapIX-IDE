import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockGetConfiguration,
  mockExecuteCommand,
  mockRegisterCommand,
  mockRegisterInlineProvider,
  mockOnDidChangeTextDocument,
  mockShowInfoMsg,
  configStore,
} = vi.hoisted(() => {
  const configStore: Record<string, unknown> = {};
  return {
    configStore,
    mockGetConfiguration: vi.fn(() => ({
      get: vi.fn((key: string, defaultValue?: unknown) =>
        key in configStore ? configStore[key] : defaultValue
      ),
      update: vi.fn((key: string, value: unknown) => {
        configStore[key] = value;
        return Promise.resolve();
      }),
    })),
    mockExecuteCommand: vi.fn().mockResolvedValue(undefined),
    mockRegisterCommand: vi.fn(() => ({ dispose: vi.fn() })),
    mockRegisterInlineProvider: vi.fn(() => ({ dispose: vi.fn() })),
    mockOnDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
    mockShowInfoMsg: vi.fn(),
  };
});

vi.mock('vscode', () => ({
  EventEmitter: class {
    readonly event = vi.fn();
    readonly fire = vi.fn();
    readonly dispose = vi.fn();
  },
  workspace: {
    getConfiguration: mockGetConfiguration,
    onDidChangeTextDocument: mockOnDidChangeTextDocument,
  },
  languages: {
    registerInlineCompletionItemProvider: mockRegisterInlineProvider,
    registerCodeLensProvider: vi.fn(() => ({ dispose: vi.fn() })),
  },
  commands: {
    registerCommand: mockRegisterCommand,
    executeCommand: mockExecuteCommand,
  },
  window: {
    showInformationMessage: mockShowInfoMsg,
    createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })),
  },
  ConfigurationTarget: { Global: 1 },
  Disposable: class {
    constructor(private readonly callback: () => void) {}
    dispose() {
      this.callback();
    }
  },
  InlineCompletionItem: class {
    constructor(
      public insertText: string,
      public range: unknown
    ) {}
  },
  Range: class {
    constructor(
      public start: unknown,
      public end: unknown
    ) {}
  },
}));

import {
  CapixInlineCompletionProvider,
  postProcessCompletion,
  registerInlineCompletions,
} from '../src/inlineCompletionProvider';

interface FakeToken {
  isCancellationRequested: boolean;
  cancel(): void;
  onCancellationRequested(cb: () => void): { dispose(): void };
}

function makeToken(): FakeToken {
  const listeners = new Set<() => void>();
  return {
    isCancellationRequested: false,
    cancel() {
      this.isCancellationRequested = true;
      for (const cb of listeners) cb();
    },
    onCancellationRequested(cb: () => void) {
      listeners.add(cb);
      return { dispose: () => listeners.delete(cb) };
    },
  };
}

function makeDocument(content: string, offset = content.length) {
  return {
    getText: () => content,
    offsetAt: (position: { offset: number }) => position.offset,
    languageId: 'typescript',
    fileName: '/workspace/src/app.ts',
    __position: { line: 0, character: offset, offset },
  };
}

function makeClient(text: string) {
  return {
    streamAgentChat: vi.fn(
      async (
        _input: unknown,
        _signal: AbortSignal,
        onEvent: (e: Record<string, unknown>) => Promise<void>
      ) => {
        await onEvent({ type: 'delta', content: text });
        await onEvent({ type: 'final', finishReason: 'stop' });
      }
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(configStore)) delete configStore[key];
});

describe('postProcessCompletion', () => {
  it('strips a markdown fence wrapper', () => {
    expect(postProcessCompletion('```ts\nreturn a + b;\n```', 12)).toBe('return a + b;');
  });

  it('bounds multi-line output and drops trailing blanks', () => {
    const raw = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n\n';
    const result = postProcessCompletion(raw, 5);
    expect(result?.split('\n')).toHaveLength(5);
  });

  it('rejects whitespace-only output', () => {
    expect(postProcessCompletion('  \n\n', 12)).toBeNull();
  });
});

describe('CapixInlineCompletionProvider', () => {
  it('returns undefined when disabled', async () => {
    configStore['inlineCompletion.enabled'] = false;
    const client = makeClient('return a + b;');
    const provider = new CapixInlineCompletionProvider(client, { debounceMs: 0 });
    const doc = makeDocument('const x = ');

    const items = await provider.provideInlineCompletionItems(
      doc as never,
      doc.__position as never,
      {} as never,
      makeToken() as never
    );

    expect(items).toBeUndefined();
    expect(client.streamAgentChat).not.toHaveBeenCalled();
  });

  it('returns undefined for an empty document', async () => {
    const client = makeClient('x');
    const provider = new CapixInlineCompletionProvider(client, { debounceMs: 0 });
    const doc = makeDocument('   \n  ');

    const items = await provider.provideInlineCompletionItems(
      doc as never,
      doc.__position as never,
      {} as never,
      makeToken() as never
    );

    expect(items).toBeUndefined();
    expect(client.streamAgentChat).not.toHaveBeenCalled();
  });

  it('streams a multi-line completion through the smart router', async () => {
    const client = makeClient('return a + b;\n}');
    const provider = new CapixInlineCompletionProvider(client, { debounceMs: 0 });
    const doc = makeDocument('function add(a, b) {\n  ');

    const items = await provider.provideInlineCompletionItems(
      doc as never,
      doc.__position as never,
      {} as never,
      makeToken() as never
    );

    expect(items).toHaveLength(1);
    expect(items?.[0]?.insertText).toBe('return a + b;\n}');
    expect(client.streamAgentChat).toHaveBeenCalledTimes(1);
    const input = client.streamAgentChat.mock.calls[0]?.[0] as {
      model: string;
      stream: boolean;
      messages: Array<{ role: string; content: string }>;
    };
    expect(input.model).toBe('capix/auto');
    expect(input.stream).toBe(true);
    expect(input.messages[1]?.content).toContain('<CURSOR>');
    expect(input.messages[1]?.content).toContain('language="typescript"');
  });

  it('honors the configured preferred model', async () => {
    configStore['ai.preferredModel'] = 'my-code-model';
    const client = makeClient('x = 1;');
    const provider = new CapixInlineCompletionProvider(client, { debounceMs: 0 });
    const doc = makeDocument('const ');

    await provider.provideInlineCompletionItems(
      doc as never,
      doc.__position as never,
      {} as never,
      makeToken() as never
    );

    const input = client.streamAgentChat.mock.calls[0]?.[0] as { model: string };
    expect(input.model).toBe('my-code-model');
  });

  it('serves repeat contexts from cache without a second request', async () => {
    const client = makeClient('return a + b;');
    const provider = new CapixInlineCompletionProvider(client, { debounceMs: 0 });
    const doc = makeDocument('function add(a, b) {\n  ');

    const first = await provider.provideInlineCompletionItems(
      doc as never,
      doc.__position as never,
      {} as never,
      makeToken() as never
    );
    const second = await provider.provideInlineCompletionItems(
      doc as never,
      doc.__position as never,
      {} as never,
      makeToken() as never
    );

    expect(first?.[0]?.insertText).toBe('return a + b;');
    expect(second?.[0]?.insertText).toBe('return a + b;');
    expect(client.streamAgentChat).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when cancelled during the debounce window', async () => {
    const client = makeClient('return a + b;');
    const provider = new CapixInlineCompletionProvider(client, { debounceMs: 50 });
    const doc = makeDocument('const x = ');
    const token = makeToken();

    const pending = provider.provideInlineCompletionItems(
      doc as never,
      doc.__position as never,
      {} as never,
      token as never
    );
    token.cancel();

    await expect(pending).resolves.toBeUndefined();
    expect(client.streamAgentChat).not.toHaveBeenCalled();
  });

  it('aborts the in-flight stream when the token cancels mid-request', async () => {
    let seenSignal: AbortSignal | undefined;
    const client = {
      streamAgentChat: vi.fn(
        async (
          _input: unknown,
          signal: AbortSignal,
          onEvent: (e: Record<string, unknown>) => Promise<void>
        ) => {
          seenSignal = signal;
          await onEvent({ type: 'delta', content: 'partial' });
          // Simulate a long stream that the caller cancels part-way through.
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve());
          });
          throw new Error('aborted');
        }
      ),
    };
    const provider = new CapixInlineCompletionProvider(client, { debounceMs: 0 });
    const doc = makeDocument('const x = ');
    const token = makeToken();

    const pending = provider.provideInlineCompletionItems(
      doc as never,
      doc.__position as never,
      {} as never,
      token as never
    );
    await new Promise((r) => setTimeout(r, 10));
    token.cancel();

    await expect(pending).resolves.toBeUndefined();
    expect(seenSignal?.aborted).toBe(true);
  });

  it('toggle flips state, persists config, and updates the context key', async () => {
    const provider = new CapixInlineCompletionProvider(makeClient('x'), { debounceMs: 0 });
    expect(provider.isEnabled()).toBe(true);

    await provider.toggle();

    expect(provider.isEnabled()).toBe(false);
    expect(configStore['inlineCompletion.enabled']).toBe(false);
    expect(mockExecuteCommand).toHaveBeenCalledWith(
      'setContext',
      'capix.inlineCompletion.enabled',
      false
    );
    expect(mockShowInfoMsg).toHaveBeenCalledWith('Capix: inline completion disabled.');
  });

  it('feeds recent edits into the completion prompt, bounded to the last 10', async () => {
    const client = makeClient('return a + b;');
    const provider = new CapixInlineCompletionProvider(client, { debounceMs: 0 });
    for (let i = 0; i < 15; i++) {
      provider.trackEdit({
        document: { fileName: `/workspace/f${i}.ts` },
        contentChanges: [{ text: 'abc', range: { start: { line: i } } }],
      } as never);
    }
    const doc = makeDocument('const x = ');

    await provider.provideInlineCompletionItems(
      doc as never,
      doc.__position as never,
      {} as never,
      makeToken() as never
    );

    const input = client.streamAgentChat.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const prompt = input.messages[1]?.content ?? '';
    const editSections = prompt.match(/<recent-edit>/g) ?? [];
    expect(editSections).toHaveLength(5);
    // Oldest edits fell off the bounded buffer; the newest are present.
    expect(prompt).toContain('f14.ts');
    expect(prompt).not.toContain('f0.ts');
  });
});

describe('registerInlineCompletions', () => {
  it('registers the provider, commands, edit tracker, and context key', () => {
    const subscriptions: Array<{ dispose(): void }> = [];
    const context = {
      subscriptions,
      globalState: {
        get: vi.fn(() => true),
        update: vi.fn().mockResolvedValue(undefined),
      },
    } as never;
    const client = makeClient('x');

    const provider = registerInlineCompletions(context, client);

    expect(provider).toBeInstanceOf(CapixInlineCompletionProvider);
    expect(mockRegisterInlineProvider).toHaveBeenCalledWith({ pattern: '**' }, provider);
    const registered = mockRegisterCommand.mock.calls.map(([id]) => id);
    expect(registered).toEqual(
      expect.arrayContaining([
        'capix.inlineCompletion.toggle',
        'capix.inlineCompletion.accept',
        'capix.inlineCompletion.reject',
      ])
    );
    expect(mockOnDidChangeTextDocument).toHaveBeenCalled();
    expect(mockExecuteCommand).toHaveBeenCalledWith(
      'setContext',
      'capix.inlineCompletion.enabled',
      true
    );
    // Five inline-completion registrations, five inline-edit registrations,
    // and the first-run migration command are all owned by the context.
    expect(subscriptions).toHaveLength(11);
  });
});
