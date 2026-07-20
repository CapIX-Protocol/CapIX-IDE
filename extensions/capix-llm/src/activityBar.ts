/**
 * Activity bar destinations — the five top-level places a Capix user can be.
 *
 * Instead of balance / deployments / instances / agent / jobs / api-keys all
 * competing in one narrow sidebar stack, the sidebar now has clear
 * destinations. Each destination owns a set of views; switching a destination
 * sets context keys (consumed by view `when` clauses) and focuses the primary
 * surface for that destination.
 *
 * `workspace` and `capix-code` map to built-in / auxiliary surfaces; `cloud`,
 * `intelligence`, and `account` are sub-surfaces rendered inside the single
 * Capix activity-bar container.
 */

import * as vscode from "vscode";

export type CapixDestination =
  | "workspace"
  | "capix-code"
  | "cloud"
  | "intelligence"
  | "account";

export interface DestinationConfig {
  id: CapixDestination;
  label: string;
  icon: string; // ThemeIcon (codicon) name
  views: string[]; // View IDs to show when this destination is active
  order: number;
}

export const DESTINATIONS: DestinationConfig[] = [
  {
    id: "workspace",
    label: "Workspace",
    icon: "files",
    views: ["workbench.view.explorer"],
    order: 0,
  },
  {
    id: "capix-code",
    label: "Capix Code",
    icon: "comment-discussion",
    views: ["capix.code.chat"],
    order: 1,
  },
  {
    id: "cloud",
    label: "Cloud",
    icon: "cloud",
    views: ["capix.cloud.hub"],
    order: 2,
  },
  {
    id: "intelligence",
    label: "Intelligence",
    icon: "database",
    views: [
      "capix.intelligence.panel",
    ],
    order: 3,
  },
  {
    id: "account",
    label: "Account",
    icon: "account",
    views: ["capix.account.balance", "capix.account.apikeys", "capix.account.settings"],
    order: 4,
  },
];

const DEFAULT_DESTINATION: CapixDestination = "cloud";

/** Look up a destination config by id. */
export function getDestination(
  destination: CapixDestination,
): DestinationConfig | undefined {
  return DESTINATIONS.find((d) => d.id === destination);
}

/** Encode a destination id as a ThemeIcon id (for statuses / quick picks). */
export function destinationIcon(destination: CapixDestination): string {
  return getDestination(destination)?.icon ?? "capix";
}

async function tryCmd(command: string, ...rest: unknown[]): Promise<unknown> {
  try {
    return await vscode.commands.executeCommand(command, ...rest);
  } catch {
    return undefined;
  }
}

/**
 * Switch the active destination: set context keys so view `when` clauses show
 * only the relevant views, then focus the destination's primary surface.
 */
export async function switchDestination(
  destination: CapixDestination,
): Promise<void> {
  const target = getDestination(destination);
  if (!target) return;

  // Canonical context key + one per destination (handy for granular `when` rules).
  await tryCmd("setContext", "capix.destination", destination);
  for (const d of DESTINATIONS) {
    await tryCmd("setContext", `capix.dest.${d.id}`, d.id === destination);
  }

  // Focus the destination's primary surface.
  const primary = target.views[0];
  if (primary === "workbench.view.explorer") {
    await tryCmd("workbench.view.explorer");
  } else if (primary === "capix.code.chat") {
    await tryCmd("workbench.view.extension.capix-code");
  } else {
    // cloud / intelligence / account live inside the Capix activity-bar container.
    await tryCmd("workbench.view.extension.capix-llm");
  }
}

/** Show a quick pick of destinations and switch to the selection. */
export async function pickDestination(): Promise<CapixDestination | undefined> {
  const items = DESTINATIONS.map((d) => ({
    label: `$(${d.icon}) ${d.label}`,
    description: d.views.join(", "),
    id: d.id,
  }));
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: "Switch Capix destination",
    title: "Capix Activity Bar",
  });
  if (!pick) return undefined;
  await switchDestination(pick.id);
  return pick.id;
}

/** The destination the workspace should open into by default. */
export function defaultDestination(): CapixDestination {
  return DEFAULT_DESTINATION;
}
