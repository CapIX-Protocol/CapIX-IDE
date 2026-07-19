import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockShowQuickPick,
  mockShowInfoMsg,
  mockShowErrorMsg,
  mockExecuteCommand,
  mockReadFile,
  mockWriteFile,
  mockDelete,
  mockCreateDirectory,
  mockRegisterProvider,
} = vi.hoisted(() => ({
  mockShowQuickPick: vi.fn(),
  mockShowInfoMsg: vi.fn(),
  mockShowErrorMsg: vi.fn(),
  mockExecuteCommand: vi.fn(),
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
  mockDelete: vi.fn(),
  mockCreateDirectory: vi.fn(),
  mockRegisterProvider: vi.fn(() => ({ dispose: vi.fn() })),
}));

vi.mock('vscode', () => ({
  window: {
    showQuickPick: mockShowQuickPick,
    showInformationMessage: mockShowInfoMsg,
    showErrorMessage: mockShowErrorMsg,
    createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })),
  },
  workspace: {
    registerTextDocumentContentProvider: mockRegisterProvider,
    fs: {
      readFile: mockReadFile,
      writeFile: mockWriteFile,
      delete: mockDelete,
      createDirectory: mockCreateDirectory,
    },
  },
  commands: { executeCommand: mockExecuteCommand },
  Uri: {
    file: vi.fn((p: string) => ({ scheme: 'file', path: p, toString: () => `file://${p}` })),
    parse: vi.fn((s: string) => ({ scheme: s.split(':')[0], path: s, toString: () => s })),
  },
}));

import { EditPreviewPanel } from '../src/editPreviewPanel';

const context = { subscriptions: [] as Array<{ dispose(): void }> } as never;

describe('EditPreviewPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile.mockRejectedValue(new Error('FileNotFound'));
    mockExecuteCommand.mockResolvedValue(undefined);
  });

  it('registers its content provider on construction', () => {
    new EditPreviewPanel(context);
    expect(mockRegisterProvider).toHaveBeenCalledWith('capix-edit-preview', expect.anything());
  });

  it('returns an empty result for no changes', async () => {
    const panel = new EditPreviewPanel(context);
    const result = await panel.preview([]);
    expect(result).toEqual({ applied: [], rejected: [], rolledBack: false });
    expect(mockShowQuickPick).not.toHaveBeenCalled();
  });

  it('accept all writes every file without opening diffs', async () => {
    mockShowQuickPick.mockResolvedValue('Accept all');
    const panel = new EditPreviewPanel(context);
    const result = await panel.preview([
      { path: '/w/a.ts', newContent: 'a' },
      { path: '/w/b.ts', newContent: 'b' },
    ]);
    expect(result.applied).toEqual(['/w/a.ts', '/w/b.ts']);
    expect(result.rolledBack).toBe(false);
    expect(mockWriteFile).toHaveBeenCalledTimes(2);
    const diffCalls = mockExecuteCommand.mock.calls.filter((c) => c[0] === 'vscode.diff');
    expect(diffCalls).toHaveLength(0);
  });

  it('reject all writes nothing', async () => {
    mockShowQuickPick.mockResolvedValue('Reject all');
    const panel = new EditPreviewPanel(context);
    const result = await panel.preview([{ path: '/w/a.ts', newContent: 'a' }]);
    expect(result).toEqual({ applied: [], rejected: ['/w/a.ts'], rolledBack: false });
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('cancelling the picker rejects everything', async () => {
    mockShowQuickPick.mockResolvedValue(undefined);
    const panel = new EditPreviewPanel(context);
    const result = await panel.preview([{ path: '/w/a.ts', newContent: 'a' }]);
    expect(result.applied).toEqual([]);
    expect(result.rejected).toEqual(['/w/a.ts']);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('review file by file opens a native diff and honors per-file decisions', async () => {
    mockShowQuickPick.mockResolvedValue('Review file by file');
    mockShowInfoMsg
      .mockResolvedValueOnce('Accept') // a.ts accepted
      .mockResolvedValueOnce('Reject') // b.ts rejected
      .mockResolvedValueOnce(undefined); // summary message
    const panel = new EditPreviewPanel(context);
    const result = await panel.preview([
      { path: '/w/a.ts', newContent: 'a' },
      { path: '/w/b.ts', newContent: 'b' },
    ]);
    expect(result.applied).toEqual(['/w/a.ts']);
    expect(result.rejected).toEqual(['/w/b.ts']);
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const diffCalls = mockExecuteCommand.mock.calls.filter((c) => c[0] === 'vscode.diff');
    expect(diffCalls).toHaveLength(2);
    expect(String(diffCalls[0][3])).toContain('a.ts (new file)');
  });

  it('deletes files whose newContent is null', async () => {
    mockShowQuickPick.mockResolvedValue('Accept all');
    const panel = new EditPreviewPanel(context);
    const result = await panel.preview([{ path: '/w/gone.ts', newContent: null }]);
    expect(result.applied).toEqual(['/w/gone.ts']);
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('rolls back earlier writes when a later write fails', async () => {
    mockShowQuickPick.mockResolvedValue('Accept all');
    // first.ts already exists on disk with original bytes.
    mockReadFile.mockImplementation(async (uri: { path: string }) =>
      uri.path === '/w/first.ts'
        ? Buffer.from('original')
        : Promise.reject(new Error('FileNotFound'))
    );
    mockWriteFile.mockImplementation(async (uri: { path: string }) => {
      if (uri.path === '/w/boom.ts') throw new Error('disk full');
    });
    const panel = new EditPreviewPanel(context);
    const result = await panel.preview([
      { path: '/w/first.ts', newContent: 'changed' },
      { path: '/w/boom.ts', newContent: 'never' },
    ]);
    expect(result.rolledBack).toBe(true);
    expect(result.applied).toEqual([]);
    expect(result.error).toBe('disk full');
    // first.ts written once (apply) then restored once (rollback) = 2 writes.
    const restoreWrites = mockWriteFile.mock.calls.filter(
      (c) => (c[0] as { path: string }).path === '/w/first.ts'
    );
    expect(restoreWrites).toHaveLength(2);
    expect(String(restoreWrites[1][1])).toBe('original');
    expect(mockShowErrorMsg).toHaveBeenCalled();
  });

  it('rollback removes files that were created during apply', async () => {
    mockShowQuickPick.mockResolvedValue('Accept all');
    mockDelete.mockImplementation(async (uri: { path: string }) => {
      if (uri.path === '/w/boom.ts') throw new Error('nope');
    });
    const panel = new EditPreviewPanel(context);
    const result = await panel.preview([
      { path: '/w/created.ts', newContent: 'new' },
      { path: '/w/boom.ts', newContent: null }, // delete fails
    ]);
    expect(result.rolledBack).toBe(true);
    // created.ts was written, then removed by rollback (delete called for it too).
    const deletePaths = mockDelete.mock.calls.map((c) => (c[0] as { path: string }).path);
    expect(deletePaths).toContain('/w/boom.ts');
    expect(deletePaths).toContain('/w/created.ts');
  });
});
