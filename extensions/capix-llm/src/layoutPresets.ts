/**
 * Layout presets — high-level workspace shapes for the CapixIDE.
 *
 * Each preset describes which workbench surfaces are visible and how dense
 * the right-hand Capix Code rail should render. `applyLayout` reconciles the
 * workbench to the preset using context keys (consumed by view `when` clauses)
 * and built-in workbench commands.
 *
 * The right-panel width is a *target* consumed by the Capix Code webview to
 * adapt its density (compact 48 px rail vs. full conversation). VS Code does not
 * expose a programmatic API to resize the auxiliary sidebar, so the webview
 * reads `capix.code.targetWidth` / `capix.code.compact` and renders accordingly.
 */

import * as vscode from "vscode";

export type LayoutPreset = "agent" | "editor" | "cloud" | "focus";

export interface LayoutConfig {
  id: LayoutPreset;
  label: string;
  description: string;
  // Which views to show/hide and where
  views: {
    "workbench.view.explorer": boolean; // Left: project explorer
    "capix.cloud.hub": boolean; // Left: cloud resources
    "capix.intelligence": boolean; // Left: intelligence
    "capix.code.chat": boolean; // Right: Capix Code
    "workbench.view.terminal": boolean; // Bottom: terminal
    "workbench.panel.output": boolean; // Bottom: output
    "workbench.panel.problems": boolean; // Bottom: problems
  };
  // Right panel width percentage (0 = hidden)
  rightPanelWidth: number;
  // Left sidebar visibility
  leftSidebarVisible: boolean;
  // Bottom panel visibility
  bottomPanelVisible: boolean;
}

export const LAYOUT_PRESETS: Record<LayoutPreset, LayoutConfig> = {
  // Explorer left, editor centre, Capix Code right (400 px), terminal available below.
  agent: {
    id: "agent",
    label: "Agent",
    description: "Explorer left, editor centre, Capix Code right (400px), terminal below",
    views: {
      "workbench.view.explorer": true,
      "capix.cloud.hub": false,
      "capix.intelligence": false,
      "capix.code.chat": true,
      "workbench.view.terminal": true,
      "workbench.panel.output": true,
      "workbench.panel.problems": true,
    },
    rightPanelWidth: 400,
    leftSidebarVisible: true,
    bottomPanelVisible: false,
  },
  // Wide editor, compact/collapsed Capix Code (48 px), explorer left.
  editor: {
    id: "editor",
    label: "Editor",
    description: "Wide editor, compact Capix Code rail (48px), explorer left",
    views: {
      "workbench.view.explorer": true,
      "capix.cloud.hub": false,
      "capix.intelligence": false,
      "capix.code.chat": true,
      "workbench.view.terminal": false,
      "workbench.panel.output": false,
      "workbench.panel.problems": true,
    },
    rightPanelWidth: 48,
    leftSidebarVisible: true,
    bottomPanelVisible: false,
  },
  // Cloud resources left, deployment details centre, Capix Code right (350 px).
  cloud: {
    id: "cloud",
    label: "Cloud",
    description: "Cloud resources left, deployment details centre, Capix Code right (350px)",
    views: {
      "workbench.view.explorer": false,
      "capix.cloud.hub": true,
      "capix.intelligence": false,
      "capix.code.chat": true,
      "workbench.view.terminal": false,
      "workbench.panel.output": true,
      "workbench.panel.problems": false,
    },
    rightPanelWidth: 350,
    leftSidebarVisible: true,
    bottomPanelVisible: false,
  },
  // One maximized editor/conversation, floating compact prompt composer, minimal chrome.
  focus: {
    id: "focus",
    label: "Focus",
    description: "Maximized conversation, minimal chrome, floating composer",
    views: {
      "workbench.view.explorer": false,
      "capix.cloud.hub": false,
      "capix.intelligence": false,
      "capix.code.chat": true,
      "workbench.view.terminal": false,
      "workbench.panel.output": false,
      "workbench.panel.problems": false,
    },
    rightPanelWidth: 520,
    leftSidebarVisible: false,
    bottomPanelVisible: false,
  },
};

const STORAGE_KEY = "capix.layout.preset";
const DEFAULT_PRESET: LayoutPreset = "agent";

// In-session cache keyed by workspace folder path (or "global").
const presetCache = new Map<string, LayoutPreset>();

function workspaceId(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "global";
}

/**
 * Persist the active preset for the current workspace and prime the in-memory
 * cache so `getLayoutPreset` reflects it.
 */
export function saveLayoutPreset(workspaceId: string, preset: LayoutPreset): void {
  presetCache.set(workspaceId, preset);
}

/** Return the active preset for a workspace (falls back to the agent layout). */
export function getLayoutPreset(workspaceId: string): LayoutPreset {
  return presetCache.get(workspaceId) ?? DEFAULT_PRESET;
}

/**
 * Re-apply whatever preset was persisted for this workspace. Called once during
 * activation so a restored window keeps its layout.
 */
export async function restorePersistedLayout(
  context: vscode.ExtensionContext,
): Promise<LayoutPreset> {
  const persisted = context.workspaceState.get<LayoutPreset>(STORAGE_KEY);
  const id = workspaceId();
  if (persisted && LAYOUT_PRESETS[persisted]) {
    saveLayoutPreset(id, persisted);
  }
  return getLayoutPreset(id);
}

/** Best-effort executeCommand that ignores failures (command may not exist). */
async function tryCmd(command: string, ...rest: unknown[]): Promise<unknown> {
  try {
    return await vscode.commands.executeCommand(command, ...rest);
  } catch {
    return undefined;
  }
}

/**
 * Reconcile the workbench to a preset: set context keys consumed by view
 * `when` clauses, toggle sidebars/panels, and focus the primary surface.
 */
export async function applyLayout(
  preset: LayoutPreset,
  context: vscode.ExtensionContext,
): Promise<void> {
  const config = LAYOUT_PRESETS[preset];
  if (!config) return;

  const id = workspaceId();
  saveLayoutPreset(id, preset);
  await context.workspaceState.update(STORAGE_KEY, preset);

  // Context keys drive view `when` clauses and the Capix Code webview density.
  await tryCmd("setContext", "capix.view.cloud", config.views["capix.cloud.hub"]);
  await tryCmd("setContext", "capix.view.intelligence", config.views["capix.intelligence"]);
  await tryCmd("setContext", "capix.view.capixCode", config.views["capix.code.chat"]);
  await tryCmd("setContext", "capix.code.compact", preset === "editor");
  await tryCmd("setContext", "capix.code.focus", preset === "focus");
  await tryCmd("setContext", "capix.code.targetWidth", config.rightPanelWidth);

  // Left sidebar visibility + focus the primary left surface.
  if (config.leftSidebarVisible) {
    if (config.views["workbench.view.explorer"]) {
      await tryCmd("workbench.view.explorer");
    } else if (config.views["capix.cloud.hub"]) {
      await tryCmd("workbench.view.extension.capix-llm");
    }
  } else {
    await tryCmd("workbench.action.toggleSidebarVisibility");
  }

  // Bottom panel.
  if (config.bottomPanelVisible) {
    if (config.views["workbench.view.terminal"]) await tryCmd("workbench.action.terminal.toggleTerminal");
    if (config.views["workbench.panel.output"]) await tryCmd("workbench.panel.output");
    if (config.views["workbench.panel.problems"]) await tryCmd("workbench.actions.view.problems");
  } else {
    await tryCmd("workbench.action.closePanel");
  }

  // Right auxiliary panel (Capix Code).
  if (config.views["capix.code.chat"] && config.rightPanelWidth > 0) {
    await tryCmd("workbench.view.extension.capix-code");
  }
}

/** Show a quick pick of the available presets and apply the selection. */
export async function pickAndApplyLayout(
  context: vscode.ExtensionContext,
): Promise<LayoutPreset | undefined> {
  const current = getLayoutPreset(workspaceId());
  const items = (Object.values(LAYOUT_PRESETS) as LayoutConfig[]).map((p) => ({
    label: `$(layout) ${p.label}`,
    description: p.description,
    id: p.id,
    picked: p.id === current,
  }));
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: "Choose a Capix workspace layout",
    title: "Capix Layout",
  });
  if (!pick) return undefined;
  await applyLayout(pick.id, context);
  return pick.id;
}
