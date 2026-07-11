"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TerminalManager = void 0;
const crypto = __importStar(require("crypto"));
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const vscode_1 = require("vscode");
const logger_1 = require("./logger");
class TerminalManager {
    terminals = new Map();
    // Paths to short-lived temp key files created by openCapixCode() that the
    // 30s sweep timer hasn't deleted yet. Tracked so disposeAll() can wipe any
    // stragglers on shutdown.
    pendingKeyFiles = new Set();
    // Persistent known_hosts file — survives across sessions so pinned host
    // keys can be verified on every connect after the initial TOFU add.
    knownHostsPath;
    bundledCapixCodePath;
    /**
     * @param globalStoragePath  The extension's global storage directory
     *                          (context.globalStorageUri.fsPath). The
     *                          known_hosts file is stored here so it persists
     *                          across sessions.
     */
    constructor(globalStoragePath, extensionPath) {
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
    async openCapixCode(capixBaseUrl, capixApiKey, capixModel) {
        // SECURITY: do NOT pass the API key via the terminal's `env` option. Env
        // vars persist in the shell's /proc/<pid>/environ (or `ps eww`) for the
        // shell's entire lifetime, leaking the key to every same-user process.
        // Instead write it to a short-lived temp file (mode 0600) and point the
        // terminal at it via CAPIX_API_KEY_FILE. The launch command below reads
        // the file into CAPIX_API_KEY for the capix-code process only (inline
        // env assignment never enters the shell's own environ), and the file is
        // deleted ~30s later — long after capix-code has read it.
        const keyPath = path.join(os.tmpdir(), `capix-key-${Date.now()}-${crypto.randomBytes(6).toString("hex")}.key`);
        fs.writeFileSync(keyPath, capixApiKey, { mode: 0o600 });
        const env = {
            CAPIX_BASE_URL: capixBaseUrl,
            CAPIX_API_KEY_FILE: keyPath,
        };
        if (capixModel)
            env.CAPIX_MODEL = capixModel;
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
    deleteKeyFile(keyPath) {
        try {
            fs.unlinkSync(keyPath);
        }
        catch (err) {
            logger_1.logger.error("deleteKeyFile failed", { error: String(err) });
        }
        this.pendingKeyFiles.delete(keyPath);
    }
    /** Ensure the persistent known_hosts file (and parent dir) exist with 0600 perms. */
    ensureKnownHostsFile() {
        try {
            const dir = path.dirname(this.knownHostsPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            if (!fs.existsSync(this.knownHostsPath)) {
                fs.writeFileSync(this.knownHostsPath, "", { mode: 0o600 });
            }
        }
        catch (err) {
            logger_1.logger.error("ensureKnownHostsFile failed", { error: String(err) });
        }
    }
    /** Check whether a host is already pinned in the persistent known_hosts file. */
    isHostKnown(host, port) {
        return new Promise((resolve) => {
            const key = port !== 22 ? `[${host}]:${port}` : host;
            (0, child_process_1.execFile)("ssh-keygen", ["-F", key, "-f", this.knownHostsPath], (err, stdout) => {
                resolve(!err && stdout.trim().length > 0);
            });
        });
    }
    /**
     * Pre-flight check for a known host: connect non-interactively (BatchMode)
     * and detect whether the server's host key has changed since first connect.
     */
    checkHostKeyChanged(target) {
        return new Promise((resolve) => {
            const user = target.user || "root";
            (0, child_process_1.execFile)("ssh", [
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
     */
    async resolveSshArgs(target, command) {
        const user = target.user || "root";
        const hostKnown = await this.isHostKnown(target.host, target.port);
        if (hostKnown) {
            const changed = await this.checkHostKeyChanged(target);
            if (changed) {
                vscode_1.window.showWarningMessage(`Host key changed for ${target.host}. This could indicate a security issue. Contact support if unexpected.`);
                return null;
            }
        }
        const strictMode = hostKnown ? "yes" : "accept-new";
        const args = [
            "-o", `StrictHostKeyChecking=${strictMode}`,
            "-o", `UserKnownHostsFile=${this.knownHostsPath}`,
            "-o", "ConnectTimeout=10",
            "-o", "LogLevel=ERROR",
            "-p", String(target.port),
            `${user}@${target.host}`,
        ];
        if (command)
            args.push(command);
        return args;
    }
    /** Open (or focus) an SSH terminal for a deployed instance. */
    async openSshSession(target) {
        const key = `${target.user || "root"}@${target.host}:${target.port}`;
        // Reuse an existing terminal if one is already open for this host.
        const existing = this.terminals.get(key);
        if (existing && existing.exitStatus === undefined) {
            existing.show();
            return;
        }
        const sshArgs = await this.resolveSshArgs(target);
        if (!sshArgs)
            return; // Aborted — host key changed, warning shown.
        const terminal = vscode_1.window.createTerminal({
            name: `SSH: ${target.label}`,
            shellPath: "ssh",
            shellArgs: sshArgs,
            iconPath: new vscode.ThemeIcon("terminal"),
        });
        this.terminals.set(key, terminal);
        terminal.show();
        // Clean up closed terminals from the map.
        vscode_1.window.onDidCloseTerminal((t) => {
            for (const [k, v] of this.terminals) {
                if (v === t) {
                    this.terminals.delete(k);
                    break;
                }
            }
        });
    }
    /** Open a remote exec terminal that runs a single command (read-only output). */
    async runRemoteCommand(target, command) {
        const sshArgs = await this.resolveSshArgs(target, command);
        if (!sshArgs)
            return; // Aborted — host key changed, warning shown.
        const terminal = vscode_1.window.createTerminal({
            name: `${target.label}: ${command.slice(0, 30)}`,
            shellPath: "ssh",
            shellArgs: sshArgs,
            iconPath: new vscode.ThemeIcon("terminal"),
        });
        terminal.show();
    }
    /** Close all managed terminals. */
    disposeAll() {
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
exports.TerminalManager = TerminalManager;
//# sourceMappingURL=terminalManager.js.map