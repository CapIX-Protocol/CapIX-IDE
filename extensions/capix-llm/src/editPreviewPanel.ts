/**
 * Edit preview — native VS Code diff review for atomic multi-file edits.
 *
 * Same review flow as the CLI atomic-edit planner (`src/editing/` in
 * capix-code): every proposed change is previewed in a native side-by-side
 * diff editor before anything is written; each file is accepted or rejected
 * individually (or in bulk), accepted files are applied as one atomic batch,
 * and if ANY write fails everything applied so far is rolled back — the
 * working tree is never left half-edited.
 *
 * Registered as the `capix.edits.preview` command; the agent runtime invokes
 * it programmatically with the pending `PreviewChange[]` for a turn.
 */

import * as vscode from 'vscode';
import { logger } from './logger';

/** A single proposed change. `newContent: null` deletes the file. */
export interface PreviewChange {
  path: string;
  newContent: string | null;
}

export interface PreviewResult {
  applied: string[];
  rejected: string[];
  /** True when an apply error forced a rollback of earlier writes. */
  rolledBack: boolean;
  error?: string;
}

/** URI scheme serving the in-memory "proposed" side of each diff. */
const SCHEME = 'capix-edit-preview';

const REVIEW_FILE_BY_FILE = 'Review file by file';
const ACCEPT_ALL = 'Accept all';
const REJECT_ALL = 'Reject all';

class EditPreviewContentProvider implements vscode.TextDocumentContentProvider {
  private readonly docs = new Map<string, string>();

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? '';
  }

  set(uri: vscode.Uri, content: string): void {
    this.docs.set(uri.toString(), content);
  }

  remove(uri: vscode.Uri): void {
    this.docs.delete(uri.toString());
  }

  clear(): void {
    this.docs.clear();
  }
}

interface PendingFile {
  change: PreviewChange;
  uri: vscode.Uri;
  /** Original bytes, or null when the file does not exist yet. */
  originalContent: Uint8Array | null;
  decision: 'pending' | 'accepted' | 'rejected';
}

export class EditPreviewPanel {
  private static counter = 0;
  private readonly provider = new EditPreviewContentProvider();

  constructor(context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, this.provider)
    );
  }

  /**
   * Reviews the proposed changes and applies the accepted ones atomically.
   * Returns which paths were applied/rejected and whether a rollback ran.
   */
  async preview(changes: PreviewChange[]): Promise<PreviewResult> {
    const result: PreviewResult = { applied: [], rejected: [], rolledBack: false };
    if (changes.length === 0) return result;

    const batch = ++EditPreviewPanel.counter;
    const files: PendingFile[] = [];
    for (const change of changes) {
      files.push({
        change,
        uri: vscode.Uri.file(change.path),
        originalContent: await this.readOriginal(change.path),
        decision: 'pending',
      });
    }

    const choice = await vscode.window.showQuickPick(
      [REVIEW_FILE_BY_FILE, ACCEPT_ALL, REJECT_ALL],
      {
        title: `Capix: preview ${files.length} pending edit${files.length === 1 ? '' : 's'}`,
        placeHolder: 'Review each diff, or accept/reject the whole batch',
      }
    );
    if (!choice || choice === REJECT_ALL) {
      for (const file of files) file.decision = 'rejected';
      result.rejected = files.map((f) => f.change.path);
      this.cleanup();
      return result;
    }
    if (choice === ACCEPT_ALL) {
      for (const file of files) file.decision = 'accepted';
    } else {
      for (const file of files) {
        file.decision = (await this.reviewFile(file, batch)) ? 'accepted' : 'rejected';
      }
    }

    const accepted = files.filter((f) => f.decision === 'accepted');
    result.rejected = files.filter((f) => f.decision === 'rejected').map((f) => f.change.path);
    for (const file of accepted) {
      try {
        await this.writeChange(file);
        result.applied.push(file.change.path);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.error = message;
        logger.error('edit preview apply failed — rolling back', {
          path: file.change.path,
          error: message,
        });
        await this.rollback(files, result.applied);
        result.applied = [];
        result.rolledBack = true;
        void vscode.window.showErrorMessage(
          `Capix edits rolled back: failed to write ${file.change.path} (${message})`
        );
        this.cleanup();
        return result;
      }
    }
    if (result.applied.length > 0) {
      void vscode.window.showInformationMessage(
        `Capix: applied ${result.applied.length} edit${result.applied.length === 1 ? '' : 's'}` +
          (result.rejected.length > 0 ? `, rejected ${result.rejected.length}` : '')
      );
    }
    this.cleanup();
    return result;
  }

  /** Opens the native diff editor for one file and asks Accept / Reject. */
  private async reviewFile(file: PendingFile, batch: number): Promise<boolean> {
    const name = file.change.path.split('/').pop() ?? file.change.path;
    const originalUri =
      file.originalContent === null ? this.virtualUri(batch, file, 'original', '') : file.uri;
    const proposedUri = this.virtualUri(batch, file, 'proposed', file.change.newContent ?? '');
    const kind =
      file.originalContent === null
        ? 'new file'
        : file.change.newContent === null
          ? 'delete'
          : 'edit';
    try {
      await vscode.commands.executeCommand(
        'vscode.diff',
        originalUri,
        proposedUri,
        `${name} (${kind}) — Capix edit preview`
      );
      const answer = await vscode.window.showInformationMessage(
        `Apply ${kind} to ${name}?`,
        { modal: false },
        'Accept',
        'Reject'
      );
      return answer === 'Accept';
    } finally {
      void vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
  }

  private virtualUri(batch: number, file: PendingFile, side: string, content: string): vscode.Uri {
    const uri = vscode.Uri.parse(`${SCHEME}:/${batch}/${side}${file.uri.path}`);
    this.provider.set(uri, content);
    return uri;
  }

  private async readOriginal(path: string): Promise<Uint8Array | null> {
    try {
      return await vscode.workspace.fs.readFile(vscode.Uri.file(path));
    } catch {
      return null;
    }
  }

  private async writeChange(file: PendingFile): Promise<void> {
    if (file.change.newContent === null) {
      await vscode.workspace.fs.delete(file.uri);
      return;
    }
    const parent = file.change.path.split('/').slice(0, -1).join('/');
    if (parent) await vscode.workspace.fs.createDirectory(vscode.Uri.file(parent));
    await vscode.workspace.fs.writeFile(file.uri, Buffer.from(file.change.newContent, 'utf8'));
  }

  /** Restores every applied path to its original bytes (or removes created files). */
  private async rollback(files: PendingFile[], appliedPaths: string[]): Promise<void> {
    for (const path of [...appliedPaths].reverse()) {
      const file = files.find((f) => f.change.path === path);
      if (!file) continue;
      try {
        if (file.originalContent === null) await vscode.workspace.fs.delete(file.uri);
        else await vscode.workspace.fs.writeFile(file.uri, file.originalContent);
      } catch (err) {
        logger.error('edit preview rollback failed', { path, error: String(err) });
      }
    }
  }

  private cleanup(): void {
    this.provider.clear();
  }
}
