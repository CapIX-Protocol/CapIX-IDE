/**
 * intelligencePanelActions — command flows for the Intelligence surface.
 * Each function is invoked from the provider's message switch with the
 * provider as host.
 */

import * as vscode from "vscode";
import type { CapixClient } from "./apiClient";
import type { MemoryNode, CovenantRule, WorkspaceSnapshot } from "./intelligencePanelAssets";
import { COVENANT_TEMPLATES, fmtCost } from "./intelligencePanelAssets";

/** Structural view of the panel provider the flows operate on. */
export interface IntelligencePanelHost {
  readonly client: CapixClient;
  snapshot: WorkspaceSnapshot;
  refresh(): Promise<void>;
  rerender(): void;
  post(msg: unknown): void;
}

const API = "/api/v1";

export async function searchMemory(host: IntelligencePanelHost, query: string): Promise<void> {
  if (!query.trim()) return;
  host.post({ type: "loading", value: true });
  try {
    const res = await host.client.post<{ results: Array<{ node: MemoryNode; score: number }> }>(
      `${API}/memory/retrieve`,
      { query, topK: 25 },
    );
    host.snapshot.memory = res.results.map((r) => r.node);
    host.post({ type: "searchResults", count: res.results.length });
    host.rerender();
  } catch (err) {
    vscode.window.showErrorMessage(`Capix memory search failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    host.post({ type: "loading", value: false });
  }
}

export async function rememberThis(host: IntelligencePanelHost): Promise<void> {
  const content = await vscode.window.showInputBox({
    prompt: "What should be remembered?",
    placeHolder: "Enter a fact, decision, observation, or constraint…",
  });
  if (!content) return;
  const type = await vscode.window.showQuickPick(
    ["decision", "fact", "observation", "plan", "constraint"],
    { placeHolder: "Memory type", title: "Capix: Remember This" },
  );
  try {
    await host.client.post(`${API}/memory`, {
      type: type ?? "fact",
      content,
      source: "user",
      metadata: { confidence: 1.0 },
    });
    await host.refresh();
    vscode.window.showInformationMessage("Capix: memory written.");
  } catch (err) {
    vscode.window.showErrorMessage(`Capix write memory failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function forgetMemory(host: IntelligencePanelHost, id: string | undefined): Promise<void> {
  if (!id) return;
  const node = host.snapshot.memory.find((n) => n.id === id);
  if (!node) return;
  const choice = await vscode.window.showWarningMessage(
    node.anchorTx
      ? `Memory ${node.id.slice(0, 8)} is anchored and immutable. Supersede with corrected content?`
      : `Forget memory ${node.id.slice(0, 8)}? It will be superseded (memory is append-only).`,
    { modal: true },
    "Forget",
  );
  if (choice !== "Forget") return;
  try {
    await host.client.post(`${API}/memory`, {
      type: node.type,
      content: `[forgotten] ${node.content}`,
      source: `${node.source ?? "agent"} (forget)`,
      metadata: { ...(node.metadata ?? {}), supersedes: node.id, forgotten: true },
    });
    host.snapshot.pinnedMemory = host.snapshot.pinnedMemory.filter((pid) => pid !== id);
    await host.refresh();
    vscode.window.showInformationMessage("Capix: memory superseded.");
  } catch (err) {
    vscode.window.showErrorMessage(`Capix forget memory failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function pinMemory(host: IntelligencePanelHost, id: string | undefined): Promise<void> {
  if (!id) return;
  if (host.snapshot.pinnedMemory.includes(id)) {
    host.snapshot.pinnedMemory = host.snapshot.pinnedMemory.filter((pid) => pid !== id);
  } else {
    host.snapshot.pinnedMemory.push(id);
  }
  host.rerender();
}

export async function editMemory(host: IntelligencePanelHost, id: string | undefined): Promise<void> {
  if (!id) return;
  const node = host.snapshot.memory.find((n) => n.id === id);
  if (!node) return;
  const content = await vscode.window.showInputBox({
    prompt: `Update memory (${node.type})`,
    value: node.content,
    placeHolder: "What should be remembered?",
  });
  if (!content) return;
  try {
    await host.client.post(`${API}/memory`, {
      type: node.type,
      content,
      source: node.source ? `${node.source} (edit)` : "user-edit",
      metadata: { ...(node.metadata ?? {}), supersedes: node.id },
    });
    await host.refresh();
    vscode.window.showInformationMessage("Capix: memory updated.");
  } catch (err) {
    vscode.window.showErrorMessage(`Capix edit memory failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function anchorMemory(host: IntelligencePanelHost, id: string | undefined): Promise<void> {
  if (!id) return;
  try {
    const res = await host.client.post<{ txSignature: string; slot: number }>(`${API}/memory/anchor`, {
      memoryId: id,
    });
    vscode.window.showInformationMessage(
      `Capix: memory anchored (tx ${res.txSignature.slice(0, 12)}… slot ${res.slot}).`,
    );
    await host.refresh();
  } catch (err) {
    vscode.window.showErrorMessage(`Capix anchor memory failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function installSkill(host: IntelligencePanelHost): Promise<void> {
  const source = await vscode.window.showInputBox({
    prompt: "Install skill from URL, registry:name@version, first-party:name, or JSON manifest",
    placeHolder: "https://capix.network/skills/my-skill.json",
  });
  if (!source) return;
  try {
    await host.client.post(`${API}/skills`, { source });
    await host.refresh();
    vscode.window.showInformationMessage(`Capix: skill installed from ${source}.`);
  } catch (err) {
    vscode.window.showErrorMessage(`Capix install skill failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function toggleSkill(host: IntelligencePanelHost, id: string | undefined, action: "enable" | "disable"): Promise<void> {
  if (!id) return;
  try {
    await host.client.post(`${API}/skills/${encodeURIComponent(id)}`, { action });
    await host.refresh();
  } catch (err) {
    vscode.window.showErrorMessage(`Capix ${action} skill failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function completeAgent(host: IntelligencePanelHost, id: string | undefined): Promise<void> {
  if (!id) return;
  try {
    await host.client.post(`${API}/agents/${encodeURIComponent(id)}`, { status: "completed" });
    await host.refresh();
    vscode.window.showInformationMessage("Capix: agent completed.");
  } catch (err) {
    vscode.window.showErrorMessage(`Capix complete agent failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function ratifyCovenant(host: IntelligencePanelHost): Promise<void> {
  const activeCovenant = host.snapshot.covenants[0];
  if (!activeCovenant) return;
  const rulesJson = await vscode.window.showInputBox({
    prompt: `Ratify new covenant (v${activeCovenant.version}): paste rules as JSON array`,
    placeHolder: JSON.stringify([{ id: "r1", rule: "no-breaking-changes-after-release", severity: "error" }]),
  });
  if (!rulesJson) return;
  let rules: CovenantRule[];
  try {
    rules = JSON.parse(rulesJson);
  } catch {
    vscode.window.showErrorMessage("Capix: invalid JSON.");
    return;
  }
  try {
    await host.client.post(`${API}/covenants`, { rules });
    await host.refresh();
    vscode.window.showInformationMessage("Capix: covenant ratified.");
  } catch (err) {
    vscode.window.showErrorMessage(`Capix ratify covenant failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function editCovenantRule(host: IntelligencePanelHost, id: string | undefined): Promise<void> {
  if (!id) return;
  const covenant = host.snapshot.covenants[0];
  const rule = covenant?.rules.find((r) => r.id === id);
  if (!rule) return;
  const newRule = await vscode.window.showInputBox({
    prompt: `Edit covenant rule ${rule.id}`,
    value: rule.rule,
  });
  if (!newRule) return;
  const newRules = covenant.rules.map((r) => (r.id === id ? { ...r, rule: newRule } : r));
  try {
    await host.client.post(`${API}/covenants`, { rules: newRules });
    await host.refresh();
    vscode.window.showInformationMessage("Capix: covenant rule updated (new version ratified).");
  } catch (err) {
    vscode.window.showErrorMessage(`Capix edit covenant rule failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function applyTemplate(host: IntelligencePanelHost, templateName: string): Promise<void> {
  const template = COVENANT_TEMPLATES[templateName];
  if (!template) return;
  try {
    await host.client.post(`${API}/covenants`, { rules: template });
    await host.refresh();
    vscode.window.showInformationMessage(`Capix: applied covenant template "${templateName}".`);
  } catch (err) {
    vscode.window.showErrorMessage(`Capix apply template failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function verifyReceipt(host: IntelligencePanelHost, id: string | undefined): Promise<void> {
  if (!id) return;
  const r = host.snapshot.receipts.find((x) => x.id === id);
  if (!r) return;
  const settled = r.status === "confirmed" || r.status === "distributed";
  const v: string[] = [
    `receipt ${r.id.slice(0, 8)}`,
    `status=${r.status}`,
    `cost=${fmtCost(Number(r.costMinor ?? 0), r.currency ?? "usd")}`,
    `devTokens=${r.devTokens ?? 0}`,
    `merkle=${settled ? "root-anchored" : "pending"}`,
    `on-chain=${settled ? "settled" : "not-settled"}`,
  ];
  vscode.window.showInformationMessage(`Capix local verification: ${v.join(" · ")}`);
  host.post({ type: "receipt:verified", id, anchored: settled });
}
