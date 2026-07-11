import { describe, it, expect } from "vitest";
import { SECURITY_CONFIG } from "../src/main/security-config";
import type { RendererToMainMessage } from "../src/vs/workbench/contrib/capix-auth/ipc";

// Compile-time proof: no variant of RendererToMainMessage has a `type` whose
// literal contains "fetch", "http" or "request". If one were ever added, this
// assignment would fail to type-check (enforced under `tsc` / `vitest typecheck`).
type _ForbiddenMessageType = Extract<
  RendererToMainMessage,
  { type: `${string}fetch${string}` | `${string}http${string}` | `${string}request${string}` }
>;
type _AssertNever<T extends never> = T;
const _noForbiddenMessageType: _AssertNever<_ForbiddenMessageType> = undefined as never;
void _noForbiddenMessageType;

// One valid sample per variant, typed against the contract so the test stays
// tied to the real `RendererToMainMessage` union.
const SAMPLE_RENDERER_MESSAGES: RendererToMainMessage[] = [
  { type: "auth:login:start" },
  { type: "auth:login:callback", code: "c", state: "s" },
  { type: "auth:logout" },
  { type: "auth:getToken" },
  { type: "account:get" },
  { type: "catalog:models" },
  { type: "quote:create", input: {} },
  { type: "deployment:create", input: {} },
  { type: "deployment:get", id: "d" },
  { type: "deployment:list" },
  { type: "deployment:list", cursor: "c" },
  { type: "operation:subscribe", id: "o" },
  { type: "operation:cancel", id: "o" },
  { type: "inference:stream", input: {} },
  { type: "inference:cancel", sessionId: "s" },
  { type: "billing:balance" },
  { type: "billing:invoices" },
  { type: "receipt:get", id: "r" },
  { type: "workspace:connect", workspaceId: "w" },
  { type: "workspace:disconnect" },
];

describe("CapixIDE security boundary", () => {
  it("renderer IPC has no generic fetch message type", () => {
    // Verify that RendererToMainMessage union does not include any "fetch" or
    // generic authenticated request. The renderer can ONLY call these typed
    // operations; the main process validates origin and schema on every message.
    const typeStrings = SAMPLE_RENDERER_MESSAGES.map((m) => m.type);
    expect(typeStrings.length).toBeGreaterThan(0);

    const forbidden = typeStrings.filter((t) => /fetch|http|request|authenticated/i.test(t));
    expect(forbidden).toEqual([]);

    // Sanity: the typed operations we expect are actually present.
    expect(typeStrings).toContain("auth:login:start");
    expect(typeStrings).toContain("catalog:models");
    expect(typeStrings).toContain("inference:stream");
    expect(typeStrings).toContain("workspace:connect");
  });

  it("security config enforces context isolation", () => {
    expect(SECURITY_CONFIG.contextIsolation).toBe(true);
    expect(SECURITY_CONFIG.nodeIntegration).toBe(false);
    expect(SECURITY_CONFIG.sandbox).toBe(true);
  });

  it("workspace settings cannot override trusted origins", () => {
    // Trusted origins come from product/admin config only. The config exposes a
    // single, fixed `trustedOrigins` list with no workspace-mergeable override,
    // so a malicious `.vscode/settings.json` cannot redirect a wallet bearer
    // token or inject an attacker origin.
    expect([...SECURITY_CONFIG.trustedOrigins]).toEqual([
      "vscode-file://vscode-app",
      "https://www.capix.network",
      "https://api.capix.network",
      "http://localhost:3000",
    ]);

    // No workspace-controlled origin override is plumbed through the config.
    expect(SECURITY_CONFIG).not.toHaveProperty("workspaceTrustedOrigins");
    expect(SECURITY_CONFIG).not.toHaveProperty("trustedOriginsOverride");
    expect(SECURITY_CONFIG).not.toHaveProperty("workspaceOrigins");

    // IPC origin/schema validation is itself a product default, not relaxable.
    expect(SECURITY_CONFIG.ipcValidateOrigin).toBe(true);
    expect(SECURITY_CONFIG.ipcValidateSchema).toBe(true);
  });

  it("agent runtime launches by absolute path, no shell", () => {
    expect(SECURITY_CONFIG.agentLaunchByAbsolutePath).toBe(true);
    expect(SECURITY_CONFIG.agentNoShell).toBe(true);
    expect(SECURITY_CONFIG.agentScrubEnvironment).toBe(true);
  });

  it("update requires signature and compatibility", () => {
    expect(SECURITY_CONFIG.updateRequiresSignature).toBe(true);
    expect(SECURITY_CONFIG.updateRequiresCompatibility).toBe(true);
  });
});
