/**
 * MCP Auto-Install — zero-config MCP server registration.
 *
 * When the user authenticates, this module:
 * 1. Checks if @capix/mcp is installed (via npx resolution)
 * 2. If not, installs it globally (npm install -g @capix/mcp)
 * 3. Registers the MCP server in VS Code's MCP configuration
 * 4. The MCP server runs as a stdio child process with auth inherited
 * 5. All 59 tools become available to the Capix Code agent
 *
 * The user never has to run `npx @capix/mcp` or edit config files.
 *
 * Auth strategy: the OAuth access token stored in VS Code SecretStorage is
 * injected into the MCP server `env.CAPIX_API_KEY` at registration time. It
 * is re-injected whenever the token rotates (ensureInstalled is idempotent
 * and coalesces concurrent calls). On logout, unregister() strips the entry
 * so no stale credential lingers in settings.
 *
 * Crash isolation: this module never owns a long-lived child process. The
 * MCP server is spawned and supervised by VS Code's MCP host, which restarts
 * it on crash — a server crash can never propagate into the IDE. The only
 * short-lived spawn here is the `npm install`/`npm ls` probe, which is fully
 * awaited and wrapped in try/catch.
 */

import * as vscode from "vscode";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { CapixClient } from "./apiClient";
import { logger } from "./logger";

const execAsync = promisify(exec);

export type McpStatus = "installed" | "installing" | "failed" | "not-installed";

/** VS Code setting section that hosts MCP servers (VS Code 1.100+ MCP support). */
const MCP_CONFIG_SECTION = "mcp";
/** Identifier under the `mcp.servers` object. */
const MCP_SERVER_ID = "capix";
/** The Capix network origin used as CAPIX_BASE_URL. */
const MCP_BASE_URL = "https://www.capix.network";
/** The launcher command + args used to start the stdio MCP server. */
const MCP_SERVER_COMMAND = "npx";
const MCP_SERVER_ARGS = ["-y", "@capix/mcp", "server", "--stdio"];
/** Suppresses the "Capix MCP connected" toast after the first run. */
const NOTIFY_ONCE_KEY = "capix.mcp.notifiedConnected";

export class McpAutoInstaller {
  private status: McpStatus = "not-installed";
  private readonly statusHandlers = new Set<(status: McpStatus) => void>();
  private readonly statusBarItem: vscode.StatusBarItem;
  /** Guards against overlapping ensureInstalled runs (token-rotation churn). */
  private ensurePromise: Promise<void> | null = null;

  constructor(
    private readonly client: CapixClient,
    private readonly context: vscode.ExtensionContext,
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 48);
    this.statusBarItem.name = "Capix MCP";
    this.statusBarItem.text = "$(circle-slash) MCP: Not Connected";
    this.statusBarItem.tooltip = "Capix MCP — not connected. Sign in to enable.";
    this.statusBarItem.command = "capix.connectWallet";
    this.statusBarItem.show();
    context.subscriptions.push(this.statusBarItem);
  }

  /**
   * Called on extension activation after auth (idempotent; safe to call
   * repeatedly). Coalesces concurrent invocations so a burst of activation
   * events or token rotations never spawns overlapping installs/writes.
   */
  async ensureInstalled(): Promise<void> {
    if (this.ensurePromise) return this.ensurePromise;
    this.ensurePromise = this.doEnsureInstalled().finally(() => { this.ensurePromise = null; });
    return this.ensurePromise;
  }

  private async doEnsureInstalled(): Promise<void> {
    try {
      const token = await this.client.getStoredToken();
      if (!token) {
        // Not signed in — surface the not-connected state, but do not error.
        this.setStatus("not-installed");
        this.renderStatusBar(false);
        return;
      }
      this.setStatus("installing");
      // Steps 1 + 2: best-effort global install so `npx -y` does not cold-start.
      await this.ensureMcpInstalled();
      // Step 3: (re)register the MCP server with the latest token.
      await this.register(token);
      this.setStatus("installed");
      this.renderStatusBar(true);
      await this.maybeNotifyConnected();
    } catch (err) {
      // MCP setup must NEVER crash the IDE or block the activation flow.
      logger.error("Capix MCP auto-install failed", { error: String(err) });
      this.setStatus("failed");
      this.renderStatusBar(false);
    }
  }

  /** Register the MCP server in VS Code's MCP configuration. */
  async register(accessToken?: string): Promise<void> {
    const token = accessToken ?? (await this.client.getStoredToken());
    const config = vscode.workspace.getConfiguration(MCP_CONFIG_SECTION);
    const servers = config.get<Record<string, unknown>>("servers") ?? {};
    servers[MCP_SERVER_ID] = {
      command: MCP_SERVER_COMMAND,
      args: MCP_SERVER_ARGS,
      env: { CAPIX_API_KEY: token, CAPIX_BASE_URL: MCP_BASE_URL },
    };
    // Global scope so the MCP server is available in every workspace without a
    // per-folder mcp.json file the user has to maintain.
    await config.update("servers", servers, vscode.ConfigurationTarget.Global);
  }

  /** Check if the MCP server entry is registered (lightweight, no IPC). */
  async isHealthy(): Promise<boolean> {
    const config = vscode.workspace.getConfiguration(MCP_CONFIG_SECTION);
    const servers = config.get<Record<string, unknown>>("servers") ?? {};
    return Boolean(servers[MCP_SERVER_ID]);
  }

  /** Get the MCP server command (npx or global binary). */
  getServerCommand(): { command: string; args: string[] } {
    return { command: MCP_SERVER_COMMAND, args: MCP_SERVER_ARGS };
  }

  /** Strip the MCP server entry on logout (clears the inherited token). */
  async unregister(): Promise<void> {
    try {
      const config = vscode.workspace.getConfiguration(MCP_CONFIG_SECTION);
      const servers = config.get<Record<string, unknown>>("servers") ?? {};
      if (servers[MCP_SERVER_ID]) {
        delete servers[MCP_SERVER_ID];
        await config.update("servers", servers, vscode.ConfigurationTarget.Global);
      }
      this.setStatus("not-installed");
      this.renderStatusBar(false);
      logger.info("Capix MCP unregistered");
    } catch (err) {
      logger.error("Capix MCP unregister failed", { error: String(err) });
    }
  }

  /** Subscribe to status transitions (drives UI, telemetry, etc.). */
  onStatusChanged(handler: (status: McpStatus) => void): void {
    this.statusHandlers.add(handler);
    handler(this.status);
  }

  /** Release the status bar item. */
  dispose(): void {
    this.statusBarItem.dispose();
    this.statusHandlers.clear();
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private setStatus(status: McpStatus): void {
    this.status = status;
    for (const handler of this.statusHandlers) handler(status);
  }

  /** Pre-install @capix/mcp globally so `npx -y` is a no-op at launch. */
  private async ensureMcpInstalled(): Promise<void> {
    if (await this.isMcpInstalled()) return;
    logger.info("Installing @capix/mcp globally…");
    try {
      await execAsync("npm install -g @capix/mcp", { timeout: 120_000 });
      logger.info("@capix/mcp installed globally");
    } catch (err) {
      // Non-fatal: `npx -y @capix/mcp ...` will acquire the package on first
      // launch. We log and continue so registration still happens.
      logger.warn("Global @capix/mcp install failed — will rely on npx -y", { error: String(err) });
    }
  }

  private async isMcpInstalled(): Promise<boolean> {
    try {
      const { stdout } = await execAsync("npm ls -g @capix/mcp --depth=0 --json", { timeout: 15_000 });
      const parsed = JSON.parse(stdout || "{}") as { dependencies?: Record<string, unknown> };
      return Boolean(parsed.dependencies?.["@capix/mcp"]);
    } catch {
      return false;
    }
  }

  /** Show the "Capix MCP connected" toast once (not on every restart). */
  private async maybeNotifyConnected(): Promise<void> {
    if (this.context.globalState.get<boolean>(NOTIFY_ONCE_KEY)) return;
    await this.context.globalState.update(NOTIFY_ONCE_KEY, true);
    vscode.window.showInformationMessage("Capix MCP connected");
  }

  private renderStatusBar(connected: boolean): void {
    if (connected) {
      // Green debug-start icon signals "live"; no background (reserved for
      // urgent states) per VS Code status-bar conventions.
      this.statusBarItem.text = "$(debug-start) MCP: Connected";
      this.statusBarItem.tooltip = "Capix MCP — all 64 tools available to Capix Code";
      this.statusBarItem.command = "capix.mcp.health";
    } else {
      this.statusBarItem.text = "$(circle-slash) MCP: Not Connected";
      this.statusBarItem.tooltip = "Capix MCP — not connected. Sign in to enable.";
      this.statusBarItem.command = "capix.connectWallet";
    }
    this.statusBarItem.show();
  }
}
