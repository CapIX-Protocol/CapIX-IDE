/**
 * Terminal Manager — opens native VS Code terminals connected to deployed
 * instances via SSH, and launches capix-code (the Capix CLI coding assistant)
 * pre-configured with the user's Capix endpoint + API key.
 *
 * Capix Code integration:
 *   When a user deploys an LLM (in the IDE or on the web), the auto-connect
 *   manager writes the base URL + API key to SecretStorage. This terminal
 *   manager reads those values and sets CAPIX_BASE_URL + CAPIX_API_KEY env
 *   vars before launching `capix-code` — so the CLI assistant is
 *   auto-configured with zero manual setup.
 *
 * SSH terminals:
 *   "Open Terminal" on any instance/agent/job in the tree opens a real VS
 *   Code integrated terminal running `ssh -p {port} root@{host}`.
 *
 * Host-key pinning (TOFU then strict):
 *   On first connect to a host, SSH auto-adds the server's host key to a
 *   persistent known_hosts file stored in the extension's global storage
 *   (StrictHostKeyChecking=accept-new — Trust On First Use). On every
 *   subsequent connect, StrictHostKeyChecking=yes is enforced: if the
 *   server's key has changed, SSH refuses to connect and the user is shown
 *   a warning. This prevents MITM attacks where a malicious backend
 *   redirects SSH to an attacker-controlled host.
 */

import * as crypto from "crypto";
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { Terminal, window } from "vscode";
import { logger } from "./logger";

interface SshTarget {
  host: string;
  port: number;
  user?: string;
  label: string;
  privateKey?: string;
  identityFile?: string;
}

export class TerminalManager {
  private terminals = new Map<string, Terminal>();
  // Paths to short-lived temp key files created by openCapixCode() that the
  // 30s sweep timer hasn't deleted yet. Tracked so disposeAll() can wipe any
  // stragglers on shutdown.
  private pendingKeyFiles = new Set<string>();
  // Persistent known_hosts file — survives across sessions so pinned host
  // keys can be verified on every connect after the initial TOFU add.
  private knownHostsPath: string;
  private bundledCapixCodePath: string;

  /**
   * @param globalStoragePath  The extension's global storage directory
   *                          (context.globalStorageUri.fsPath). The
   *                          known_hosts file is stored here so it persists
   *                          across sessions.
   */
  constructor(globalStoragePath: string, extensionPath?: string) {
    this.knownHostsPath = path.join(globalStoragePath, "known_hosts");
    this.bundledCapixCodePath = extensionPath
      ? path.join(extensionPath, "tools", "capix-code", "bin", "capix-code")
      : "capix-code";
    this.ensureKnownHostsFile();
  }

  /**
   * Launch capix-code (the Capix CLI coding assistant) in a new terminal,
   * pre-configured with the user's Capix endpoint + API key from
   * SecretStorage. If no endpoint is configured, launches with the global
   * gateway as the default.
   */
  async openCapixCode(capixBaseUrl: string, capixApiKey: string, capixModel?: string): Promise<void> {
    // SECURITY: do NOT pass the API key via the terminal's `env` option. Env
    // vars persist in the shell's /proc/<pid>/environ (or `ps eww`) for the
    // shell's entire lifetime, leaking the key to every same-user process.
    // Instead write it to a short-lived temp file (mode 0600) and point the
    // terminal at it via CAPIX_API_KEY_FILE. The launch command below reads
    // the file into CAPIX_API_KEY for the capix-code process only (inline
    // env assignment never enters the shell's own environ), and the file is
    // deleted ~30s later — long after capix-code has read it.
    const keyPath = path.join(
      os.tmpdir(),
      `capix-key-${Date.now()}-${crypto.randomBytes(6).toString("hex")}.key`,
    );
    fs.writeFileSync(keyPath, capixApiKey, { mode: 0o600 });

    const env: Record<string, string> = {
      CAPIX_BASE_URL: capixBaseUrl,
      CAPIX_API_KEY_FILE: keyPath,
    };
    if (capixModel) env.CAPIX_MODEL = capixModel;

    const terminal = vscode.window.createTerminal({
      name: "Capix Code",
      env,
      iconPath: new vscode.ThemeIcon("comment-discussion"),
    });
    this.pendingKeyFiles.add(keyPath);
    terminal.show();

    // Send the launch command after a brief delay (terminal needs to init).
    // Inline `VAR=$(...) command` scopes CAPIX_API_KEY to the capix-code
    // process only — it never lands in the shell's persistent environ, so
    // /proc/<shell_pid>/environ stays clean. capix-code reads
    // process.env.CAPIX_API_KEY itself (capix-code/src/plugin.ts:50).
    setTimeout(() => {
      const executable = this.bundledCapixCodePath === "capix-code"
        ? "capix-code"
        : `"${this.bundledCapixCodePath.replace(/(["\\$`])/g, "\\$1")}"`;
      terminal.sendText(`CAPIX_API_KEY="$(cat "$CAPIX_API_KEY_FILE")" ${executable}`);
    }, 500);

    // Sweep the temp key file shortly after launch. capix-code has long
    // since read it into its own environment by now.
    setTimeout(() => {
      this.deleteKeyFile(keyPath);
    }, 30_000);
  }

  /** Best-effort deletion of a temp key file; removes it from tracking. */
  private deleteKeyFile(keyPath: string): void {
    try {
      fs.unlinkSync(keyPath);
    } catch (err) {
      logger.error("deleteKeyFile failed", { error: String(err) });
    }
    this.pendingKeyFiles.delete(keyPath);
  }

  /** Ensure the persistent known_hosts file (and parent dir) exist with 0600 perms. */
  private ensureKnownHostsFile(): void {
    try {
      const dir = path.dirname(this.knownHostsPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (!fs.existsSync(this.knownHostsPath)) {
        fs.writeFileSync(this.knownHostsPath, "", { mode: 0o600 });
      }
    } catch (err) {
      logger.error("ensureKnownHostsFile failed", { error: String(err) });
    }
  }

  /** Check whether a host is already pinned in the persistent known_hosts file. */
  private isHostKnown(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const key = port !== 22 ? `[${host}]:${port}` : host;
      execFile("ssh-keygen", ["-F", key, "-f", this.knownHostsPath], (err, stdout) => {
        resolve(!err && stdout.trim().length > 0);
      });
    });
  }

  /**
   * Pre-flight check for a known host: connect non-interactively (BatchMode)
   * and detect whether the server's host key has changed since first connect.
   */
  private checkHostKeyChanged(target: SshTarget): Promise<boolean> {
    return new Promise((resolve) => {
      const user = target.user || "root";
      execFile("ssh", [
        "-o", "StrictHostKeyChecking=yes",
        "-o", `UserKnownHostsFile=${this.knownHostsPath}`,
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=5",
        "-o", "LogLevel=ERROR",
        "-p", String(target.port),
        `${user}@${target.host}`,
        "true",
      ], (err, _stdout, stderr) => {
        const output = `${err?.message ?? ""} ${stderr ?? ""}`;
        resolve(/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(output));
      });
    });
  }

  /**
   * Build SSH args with host-key pinning (TOFU on first connect, strict
   * afterwards). Returns null if the connection was aborted because the
   * host key changed — a user-facing warning is shown in that case.
   * `extraArgs` (e.g. tunnel flags) is inserted before the host operand.
   */
  private async resolveSshArgs(target: SshTarget, command?: string, extraArgs: string[] = []): Promise<string[] | null> {
    const user = target.user || "root";
    const hostKnown = await this.isHostKnown(target.host, target.port);

    if (hostKnown) {
      const changed = await this.checkHostKeyChanged(target);
      if (changed) {
        window.showWarningMessage(
          `Host key changed for ${target.host}. This could indicate a security issue. Contact support if unexpected.`,
        );
        return null;
      }
    }

    const strictMode = hostKnown ? "yes" : "accept-new";
    const args = [
      "-o", `StrictHostKeyChecking=${strictMode}`,
      "-o", `UserKnownHostsFile=${this.knownHostsPath}`,
      "-o", "ConnectTimeout=10",
      "-o", "LogLevel=ERROR",
      ...(target.identityFile ? ["-i", target.identityFile, "-o", "IdentitiesOnly=yes"] : []),
      ...extraArgs,
      "-p", String(target.port),
      `${user}@${target.host}`,
    ];
    if (command) args.push(command);
    return args;
  }

  /** Open (or focus) an SSH terminal for a deployed instance. */
  async openSshSession(target: SshTarget): Promise<void> {
    const key = `${target.user || "root"}@${target.host}:${target.port}`;

    // Reuse an existing terminal if one is already open for this host.
    const existing = this.terminals.get(key);
    if (existing && existing.exitStatus === undefined) {
      existing.show();
      return;
    }

    let identityFile: string | undefined;
    if (target.privateKey) {
      identityFile = path.join(os.tmpdir(), `capix-ssh-${Date.now()}-${crypto.randomBytes(6).toString("hex")}.pem`);
      fs.writeFileSync(identityFile, target.privateKey.endsWith("\n") ? target.privateKey : `${target.privateKey}\n`, { mode: 0o600 });
      this.pendingKeyFiles.add(identityFile);
    }
    const sshArgs = await this.resolveSshArgs({ ...target, identityFile });
    if (!sshArgs) {
      if (identityFile) this.deleteKeyFile(identityFile);
      return;
    }

    const terminal = window.createTerminal({
      name: `SSH: ${target.label}`,
      shellPath: "ssh",
      shellArgs: sshArgs,
      iconPath: new vscode.ThemeIcon("terminal"),
    });

    this.terminals.set(key, terminal);
    terminal.show();

    // Clean up closed terminals from the map.
    window.onDidCloseTerminal((t) => {
      if (t === terminal && identityFile) this.deleteKeyFile(identityFile);
      for (const [k, v] of this.terminals) {
        if (v === t) { this.terminals.delete(k); break; }
      }
    });
  }

  /** Open a remote exec terminal that runs a single command (read-only output). */
  async runRemoteCommand(target: SshTarget, command: string): Promise<void> {
    const sshArgs = await this.resolveSshArgs(target, command);
    if (!sshArgs) return; // Aborted — host key changed, warning shown.

    const terminal = window.createTerminal({
      name: `${target.label}: ${command.slice(0, 30)}`,
      shellPath: "ssh",
      shellArgs: sshArgs,
      iconPath: new vscode.ThemeIcon("terminal"),
    });
    terminal.show();
  }

  /**
   * Open a local port-forward tunnel (`ssh -L localPort:localhost:remotePort -N`)
   * into a deployed instance. Uses the same host-key pinning as interactive
   * sessions. Returns the backing terminal so callers (the infra stack
   * service) can tear the tunnel down later.
   */
  async openPortForward(target: SshTarget, localPort: number, remotePort: number): Promise<Terminal> {
    let identityFile: string | undefined;
    if (target.privateKey) {
      identityFile = path.join(os.tmpdir(), `capix-ssh-${Date.now()}-${crypto.randomBytes(6).toString("hex")}.pem`);
      fs.writeFileSync(identityFile, target.privateKey.endsWith("\n") ? target.privateKey : `${target.privateKey}\n`, { mode: 0o600 });
      this.pendingKeyFiles.add(identityFile);
    }
    const tunnelArgs = ["-N", "-L", `${localPort}:localhost:${remotePort}`];
    const sshArgs = await this.resolveSshArgs({ ...target, identityFile }, undefined, tunnelArgs);
    if (!sshArgs) {
      if (identityFile) this.deleteKeyFile(identityFile);
      throw new Error(`Port forward aborted: host key changed for ${target.host}`);
    }

    const terminal = window.createTerminal({
      name: `Tunnel: ${target.label} :${localPort} → :${remotePort}`,
      shellPath: "ssh",
      shellArgs: sshArgs,
      iconPath: new vscode.ThemeIcon("plug"),
    });

    terminal.show();
    window.onDidCloseTerminal((t) => {
      if (t === terminal && identityFile) this.deleteKeyFile(identityFile);
    });
    return terminal;
  }

  /** Close all managed terminals. */
  disposeAll(): void {
    for (const [, terminal] of this.terminals) {
      terminal.dispose();
    }
    this.terminals.clear();

    // Wipe any temp key files the 30s launch timer hasn't swept yet.
    for (const keyPath of this.pendingKeyFiles) {
      this.deleteKeyFile(keyPath);
    }
  }
}
