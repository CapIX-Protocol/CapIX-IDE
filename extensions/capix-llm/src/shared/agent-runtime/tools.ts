// GENERATED FILE — vendored from @capix/agent-runtime (shared Capix package).
// Do not edit. Refresh with: node scripts/sync-shared-packages.mjs
/**
 * @capix/agent-runtime — tool registry and built-in tools.
 *
 * Tools are the runtime's only way to cause side effects. Every tool
 * declares a risk class; the runtime checks the session's mode permission
 * profile before executing (see modes.ts). Hosts (the TUI plugin, CapixIDE)
 * register their own tools — codebase search, MCP tools, deploy verbs — on
 * top of the built-in file/shell tools provided here.
 *
 * Built-in tools are workspace-rooted: paths are resolved against the
 * session's workspace root and rejected if they escape it.
 */

import { execFile } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ToolRiskClass } from './modes.js';

export interface ToolContext {
  sessionId: string;
  turnId: string;
  workspaceRoot: string;
  signal?: AbortSignal;
}

export interface ToolResult {
  output: string;
  isError?: boolean;
  /** Files the tool created or modified (relative to the workspace root). */
  filesChanged?: string[];
  /** Extra detail surfaced in the tool.output event metadata. */
  metadata?: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  riskClass: ToolRiskClass;
  /**
   * When true, the runtime asks for approval even in modes whose risk-class
   * policy is `allow` (used for side-effectful host tools like deploy).
   */
  alwaysRequiresApproval?: boolean;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | null {
    return this.tools.get(name) ?? null;
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }
}

/** Resolve `filePath` inside `workspaceRoot`; throw if it escapes. */
export function resolveWorkspacePath(workspaceRoot: string, filePath: string): string {
  const root = resolve(workspaceRoot);
  const resolved = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`path escapes workspace root: ${filePath}`);
  }
  return resolved;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_DISCOVERY_FILES = 500;
const MAX_SEARCH_MATCHES = 100;
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'out',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
]);

async function discoverWorkspaceFiles(
  workspaceRoot: string,
  startPath = '.',
  maxFiles = MAX_DISCOVERY_FILES
): Promise<string[]> {
  const root = resolve(workspaceRoot);
  const start = resolveWorkspacePath(root, startPath);
  const files: string[] = [];
  const pending = [start];

  while (pending.length > 0 && files.length < maxFiles) {
    const directory = pending.shift()!;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
      } else if (entry.isFile()) {
        files.push(relative(root, absolute));
        if (files.length >= maxFiles) break;
      }
    }
  }

  return files;
}

function runShell(command: string, cwd: string, timeoutMs: number): Promise<ToolResult> {
  return new Promise((resolvePromise) => {
    execFile(
      '/bin/bash',
      ['-c', command],
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
          resolvePromise({
            output: `exit ${typeof code === 'number' ? code : 1}: ${stderr || error.message}`,
            isError: true,
          });
        } else {
          resolvePromise({ output: stdout + (stderr ? `\n${stderr}` : '') });
        }
      }
    );
  });
}

/** The built-in workspace tools every runtime starts with. */
export function createBuiltinTools(): ToolDefinition[] {
  return [
    {
      name: 'list_files',
      description:
        'List workspace files recursively from an optional directory. Build artifacts and dependency directories are excluded.',
      riskClass: 'read',
      async execute(args, ctx) {
        const startPath = String(args.path ?? '.');
        const requestedLimit = Number(args.limit ?? MAX_DISCOVERY_FILES);
        const limit = Number.isFinite(requestedLimit)
          ? Math.max(1, Math.min(MAX_DISCOVERY_FILES, Math.floor(requestedLimit)))
          : MAX_DISCOVERY_FILES;
        const files = await discoverWorkspaceFiles(ctx.workspaceRoot, startPath, limit);
        return {
          output: files.length
            ? files.join('\n')
            : `no files found under ${startPath}`,
          metadata: { count: files.length, truncated: files.length >= limit },
        };
      },
    },
    {
      name: 'read_file',
      description: 'Read a file from the workspace.',
      riskClass: 'read',
      async execute(args, ctx) {
        const path = resolveWorkspacePath(ctx.workspaceRoot, String(args.path ?? ''));
        const content = await readFile(path, 'utf8');
        return { output: content };
      },
    },
    {
      name: 'capix_search_codebase',
      description:
        'Search text across workspace source files and return matching file paths and line numbers.',
      riskClass: 'read',
      async execute(args, ctx) {
        const query = String(args.query ?? '').trim();
        if (!query) return { output: 'query is required', isError: true };
        const files = await discoverWorkspaceFiles(ctx.workspaceRoot);
        const matches: string[] = [];
        for (const file of files) {
          if (matches.length >= MAX_SEARCH_MATCHES) break;
          try {
            const content = await readFile(resolveWorkspacePath(ctx.workspaceRoot, file), 'utf8');
            const lines = content.split(/\r?\n/);
            for (let index = 0; index < lines.length; index++) {
              if (lines[index].toLocaleLowerCase().includes(query.toLocaleLowerCase())) {
                matches.push(`${file}:${index + 1}: ${lines[index].trim().slice(0, 240)}`);
                if (matches.length >= MAX_SEARCH_MATCHES) break;
              }
            }
          } catch {
            // Binary, unreadable, and transient files are skipped.
          }
        }
        return {
          output: matches.length ? matches.join('\n') : `no matches for ${query}`,
          metadata: { count: matches.length, truncated: matches.length >= MAX_SEARCH_MATCHES },
        };
      },
    },
    {
      name: 'capix_find_references',
      description:
        'Find textual references to a symbol or identifier throughout the workspace.',
      riskClass: 'read',
      async execute(args, ctx) {
        const symbol = String(args.symbol ?? args.query ?? '').trim();
        if (!symbol) return { output: 'symbol is required', isError: true };
        const searchTool = createBuiltinTools().find(
          (tool) => tool.name === 'capix_search_codebase'
        )!;
        return searchTool.execute({ query: symbol }, ctx);
      },
    },
    {
      name: 'capix_get_orientation',
      description:
        'Get an initial evidence-backed map of the workspace, including manifests, documentation, source roots, tests, entry points, and bounded excerpts from key files.',
      riskClass: 'read',
      async execute(_args, ctx) {
        const files = await discoverWorkspaceFiles(ctx.workspaceRoot, '.', 250);
        const important = files.filter((file) =>
          /(^|\/)(readme[^/]*|package\.json|cargo\.toml|pyproject\.toml|go\.mod|makefile|dockerfile|compose[^/]*|[^/]*config\.[^/]+)$/i.test(
            file
          )
        );
        const excerpts: string[] = [];
        let excerptCharacters = 0;
        for (const file of important.slice(0, 10)) {
          if (excerptCharacters >= 16_000) break;
          try {
            const content = await readFile(resolveWorkspacePath(ctx.workspaceRoot, file), 'utf8');
            const excerpt = content.slice(0, Math.min(3_000, 16_000 - excerptCharacters));
            excerpts.push(`--- ${file} ---\n${excerpt}`);
            excerptCharacters += excerpt.length;
          } catch {
            // A transient or non-text key file should not block orientation.
          }
        }
        return {
          output: [
            `Workspace: ${ctx.workspaceRoot}`,
            'Important files:',
            ...(important.length ? important.slice(0, 60) : ['(none detected)']),
            '',
            'Workspace file sample:',
            ...files.slice(0, 190),
            '',
            'Key file excerpts:',
            ...(excerpts.length ? excerpts : ['(no readable key files detected)']),
          ].join('\n'),
          metadata: {
            filesScanned: files.length,
            importantFiles: important.length,
            excerptCharacters,
          },
        };
      },
    },
    {
      name: 'write_file',
      description: 'Write (create or overwrite) a file in the workspace.',
      riskClass: 'write',
      async execute(args, ctx) {
        const path = resolveWorkspacePath(ctx.workspaceRoot, String(args.path ?? ''));
        const content = String(args.content ?? '');
        await writeFile(path, content, 'utf8');
        return { output: `wrote ${path}`, filesChanged: [String(args.path ?? '')] };
      },
    },
    {
      name: 'edit_file',
      description: 'Replace an exact string in a workspace file.',
      riskClass: 'write',
      async execute(args, ctx) {
        const path = resolveWorkspacePath(ctx.workspaceRoot, String(args.path ?? ''));
        const before = await readFile(path, 'utf8');
        const oldString = String(args.old_string ?? '');
        const newString = String(args.new_string ?? '');
        if (!oldString || !before.includes(oldString)) {
          return { output: `old_string not found in ${args.path}`, isError: true };
        }
        await writeFile(path, before.replace(oldString, newString), 'utf8');
        return { output: `edited ${path}`, filesChanged: [String(args.path ?? '')] };
      },
    },
    {
      name: 'bash',
      description: 'Run a shell command in the workspace.',
      riskClass: 'execute',
      async execute(args, ctx) {
        const command = String(args.command ?? '');
        if (!command.trim()) return { output: 'empty command', isError: true };
        const timeoutMs = Number(args.timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS);
        return runShell(command, ctx.workspaceRoot, timeoutMs);
      },
    },
  ];
}
