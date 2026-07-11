/**
 * Covenant — persistent memory + governance layer for the Capix IDE chat.
 *
 * "Spirit" = the system prompt + behavioral guidelines injected into every
 * LLM call, making the chat feel like a consistent autonomous coding
 * companion rather than a stateless query box.
 *
 * "Memory" = a persistent store of project context, past decisions, code
 * patterns, and conversation summaries that builds up over time and is
 * retrieved into the system prompt before each chat call.
 *
 * "Governance" = a set of rules the LLM must follow (no destructive
 * actions without confirmation, always explain changes, respect .gitignore,
 * etc.) that are enforced client-side by the chat provider integration.
 *
 * Storage: VS Code SecretStorage for sensitive items, globalState for
 * memory entries, and a user-editable `.capix/covenant.md` file for the
 * spirit prompt itself.
 */

import * as vscode from "vscode";

export interface MemoryEntry {
  id: string;
  timestamp: string;
  type: "decision" | "pattern" | "feedback" | "context";
  content: string;
  source: string;
}

export class CovenantManager {
  private readonly SPIRIT_DEFAULT = `You are the Capix coding companion — an autonomous AI pair programmer embedded in the Capix IDE.

## Your character
- You are direct, concise, and action-oriented. You write code, not essays.
- You explain WHAT you changed and WHY in one or two sentences, not paragraphs.
- You prefer to show the edit, not describe it.
- When you're unsure, you say so. You don't hallucinate APIs or configs.

## Governance (these are hard rules — never violate them)
1. NEVER delete a file the user didn't ask you to delete.
2. NEVER run a shell command that modifies the filesystem (rm, mv, chmod, etc.) without explaining what it does first.
3. NEVER commit to git without explicit user approval.
4. NEVER overwrite a file without reading it first and understanding the context.
5. When inserting code, always match the existing style, indentation, and conventions of the file.
6. If a task is ambiguous, ask one clarifying question — don't guess.
7. If you're about to make a change that could break something, warn the user first.

## Memory
- You have access to the Covenant Memory — past decisions and patterns from this project.
- Use memory entries as context for your current task, but don't blindly repeat old decisions if the situation changed.
- When you make a significant decision, suggest saving it to memory so future sessions benefit.

## Capix-native
- You are running inside the Capix IDE. The user may have a deployed LLM endpoint (check Settings → AI for the base URL).
- If the user asks about deploying code, you can suggest the Capix cloud panels (Instance, Agent, Serverless, LLM Deploy).
- You understand the Capix protocol: decentralized compute, GPU marketplace, SOL/USDC billing.`;

  private readonly STORAGE_KEY = "capix.covenant.memory";

  constructor(private context: vscode.ExtensionContext) {}

  /** Get the spirit prompt (system prompt for every chat call). */
  async getSpirit(): Promise<string> {
    // Check for a user-editable .capix/covenant.md in the workspace.
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (ws) {
      const covenantPath = vscode.Uri.joinPath(ws.uri, ".capix", "covenant.md");
      try {
        const doc = await vscode.workspace.fs.readFile(covenantPath);
        return new TextDecoder().decode(doc);
      } catch {
        // File doesn't exist — fall through to default.
      }
    }
    return this.SPIRIT_DEFAULT;
  }

  /** Load all memory entries from global state. */
  getMemory(): MemoryEntry[] {
    return this.context.globalState.get<MemoryEntry[]>(this.STORAGE_KEY) || [];
  }

  /** Add a memory entry (decision, pattern, feedback, or context). */
  async remember(entry: Omit<MemoryEntry, "id" | "timestamp">): Promise<void> {
    const memory = this.getMemory();
    const newEntry: MemoryEntry = {
      ...entry,
      id: `mem-${Date.now().toString(36)}`,
      timestamp: new Date().toISOString(),
    };
    memory.push(newEntry);
    // Cap at 200 entries — older ones fall off.
    if (memory.length > 200) memory.shift();
    await this.context.globalState.update(this.STORAGE_KEY, memory);
  }

  /** Forget a specific memory entry. */
  async forget(id: string): Promise<void> {
    const memory = this.getMemory().filter((m) => m.id !== id);
    await this.context.globalState.update(this.STORAGE_KEY, memory);
  }

  /** Clear all memory. */
  async clearMemory(): Promise<void> {
    await this.context.globalState.update(this.STORAGE_KEY, []);
  }

  /**
   * Build the full system prompt = spirit + relevant memory entries.
   * Called before every LLM chat call.
   */
  async buildSystemPrompt(currentContext?: string): Promise<string> {
    const spirit = await this.getSpirit();
    const memory = this.getMemory();

    if (memory.length === 0 && !currentContext) {
      return spirit;
    }

    let prompt = spirit + "\n\n## Memory (from past sessions)\n";

    // Include up to 20 most recent memory entries.
    const recent = memory.slice(-20);
    for (const m of recent) {
      prompt += `- [${m.type}] ${m.content} (source: ${m.source}, ${new Date(m.timestamp).toLocaleDateString()})\n`;
    }

    if (currentContext) {
      prompt += `\n## Current context\n${currentContext}\n`;
    }

    return prompt;
  }

  /** Save the spirit prompt to a user-editable file in the workspace. */
  async createSpiritFile(): Promise<void> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      vscode.window.showWarningMessage("Open a workspace to create a covenant file.");
      return;
    }

    const dir = vscode.Uri.joinPath(ws.uri, ".capix");
    const file = vscode.Uri.joinPath(dir, "covenant.md");

    try {
      await vscode.workspace.fs.stat(file);
      // File exists — open it.
      const doc = await vscode.workspace.openTextDocument(file);
      vscode.window.showTextDocument(doc);
    } catch {
      // Create it with the default spirit.
      await vscode.workspace.fs.createDirectory(dir);
      await vscode.workspace.fs.writeFile(file, Buffer.from(this.SPIRIT_DEFAULT, "utf-8"));
      const doc = await vscode.workspace.openTextDocument(file);
      vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage("Created .capix/covenant.md — edit this to customize your AI's personality and rules.");
    }
  }
}
