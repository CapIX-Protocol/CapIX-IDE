// GENERATED FILE — vendored from @capix/auth-broker (shared Capix package).
// Do not edit. Refresh with: node scripts/sync-shared-packages.mjs
/**
 * @capix/auth-broker — platform credential stores.
 *
 * Every store implements the same narrow {@link CredentialStore} surface
 * (get/set/delete of an opaque secret keyed by service + account). The broker
 * never falls back to plaintext: the file store enforces `0600` permissions on
 * POSIX and is only used when no OS keychain backend is reachable.
 *
 * Backends:
 *   - {@link KeytarCredentialStore}    — optional `keytar` native module
 *                                        (macOS Keychain / Windows Credential
 *                                        Manager / libsecret). Throws in the
 *                                        constructor when keytar is not
 *                                        installed so callers can fall back.
 *   - {@link PlatformCredentialStore}  — zero-dependency OS keychain via the
 *                                        platform CLI: `security` (macOS),
 *                                        Windows Credential Manager through
 *                                        PowerShell PasswordVault (win32),
 *                                        `secret-tool` (Linux Secret Service).
 *   - {@link FileCredentialStore}      — atomic `0600` JSON file fallback.
 *
 * Use {@link createDefaultCredentialStore} to pick the best available backend.
 */

import { execFile, execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Run a CLI, optionally piping `input` to its stdin (keeps secrets off argv). */
async function runCli(
  file: string,
  args: string[],
  input?: string,
): Promise<{ stdout: string; stderr: string }> {
  const promise = execFileAsync(file, args);
  if (input !== undefined) {
    promise.child.stdin?.end(input);
  }
  const { stdout, stderr } = await promise;
  return { stdout: String(stdout), stderr: String(stderr) };
}

// ===========================================================================
// Store contract
// ===========================================================================

/**
 * Minimal credential-store contract consumed by the auth broker. `service`
 * namespaces the credential (the broker passes the OAuth client id); `account`
 * names the slot (e.g. `refresh-token:active`).
 */
export interface CredentialStore {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, secret: string): Promise<void>;
  delete(service: string, account: string): Promise<void>;
}

/**
 * Optional synchronous-read capability. Stores that can read synchronously
 * (the file store) let the broker prime its auth state in the constructor, so
 * `getState()` is accurate before the first await.
 */
export interface SyncReadableCredentialStore extends CredentialStore {
  getSync(service: string, account: string): string | null;
}

// ===========================================================================
// FileCredentialStore — atomic 0600 JSON file (fallback, never plaintext-world-readable)
// ===========================================================================

type StoreData = Record<string, Record<string, string>>;

/**
 * JSON-file credential store. Writes are atomic (tmp + rename) so a crash
 * mid-rotation cannot corrupt stored tokens, and the file is locked to the
 * current user (`0600`, parent dir `0700`). This is the last-resort backend —
 * NOT a plaintext convenience store.
 */
export class FileCredentialStore implements SyncReadableCredentialStore {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath =
      filePath ?? join(homedir(), ".capix", "credentials.json");
  }

  get(service: string, account: string): Promise<string | null> {
    return Promise.resolve(this.getSync(service, account));
  }

  getSync(service: string, account: string): string | null {
    return this.readAll()[service]?.[account] ?? null;
  }

  async set(service: string, account: string, secret: string): Promise<void> {
    const data = this.readAll();
    (data[service] ??= {})[account] = secret;
    this.writeAll(data);
  }

  async delete(service: string, account: string): Promise<void> {
    const data = this.readAll();
    if (data[service]) {
      delete data[service][account];
      if (Object.keys(data[service]).length === 0) delete data[service];
      this.writeAll(data);
    }
  }

  private readAll(): StoreData {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (parsed && typeof parsed === "object") return parsed as StoreData;
      return {};
    } catch {
      return {};
    }
  }

  private writeAll(data: StoreData): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.filePath);
    // renameSync preserves the tmp file's mode, but enforce in case the file
    // pre-existed with looser permissions.
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      // best-effort on non-POSIX filesystems
    }
  }
}

// ===========================================================================
// KeytarCredentialStore — optional keytar native module
// ===========================================================================

interface KeytarModule {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

/**
 * Credential store backed by the optional `keytar` native module (macOS
 * Keychain / Windows Credential Manager / libsecret). The constructor resolves
 * keytar eagerly and throws when it is not installed, so callers can fall
 * back to another store inside a single try/catch.
 */
export class KeytarCredentialStore implements CredentialStore {
  private readonly keytar: Promise<KeytarModule>;

  constructor(private readonly defaultService: string) {
    const require = createRequire(__filename);
    try {
      require.resolve("keytar");
    } catch {
      throw new Error(
        "@capix/auth-broker: keytar is not installed — use PlatformCredentialStore or FileCredentialStore",
      );
    }
    // Indirect specifier so TypeScript does not require keytar's types.
    const specifier = "keytar";
    this.keytar = import(specifier) as Promise<KeytarModule>;
  }

  private service(service: string): string {
    return service || this.defaultService;
  }

  async get(service: string, account: string): Promise<string | null> {
    const keytar = await this.keytar;
    return keytar.getPassword(this.service(service), account);
  }

  async set(service: string, account: string, secret: string): Promise<void> {
    const keytar = await this.keytar;
    await keytar.setPassword(this.service(service), account, secret);
  }

  async delete(service: string, account: string): Promise<void> {
    const keytar = await this.keytar;
    await keytar.deletePassword(this.service(service), account);
  }
}

// ===========================================================================
// PlatformCredentialStore — zero-dependency OS keychain via platform CLIs
// ===========================================================================

export type PlatformBackend =
  | "macos-keychain"
  | "windows-credential-manager"
  | "linux-secret-service";

function detectBackend(
  platform: NodeJS.Platform = process.platform,
): PlatformBackend | null {
  switch (platform) {
    case "darwin":
      // `security` ships with macOS.
      return "macos-keychain";
    case "win32":
      // Windows Credential Manager via PowerShell PasswordVault; powershell
      // ships with Windows.
      return "windows-credential-manager";
    case "linux":
    case "freebsd":
    case "openbsd":
      // Secret Service requires secret-tool (libsecret CLI).
      try {
        execFileSync("secret-tool", ["--version"], { stdio: "ignore" });
        return "linux-secret-service";
      } catch {
        return null;
      }
    default:
      return null;
  }
}

/**
 * Zero-dependency OS keychain store:
 *
 *   - macOS  → Keychain via `/usr/bin/security` (generic-password items).
 *   - Windows → Credential Manager via PowerShell's PasswordVault WinRT API.
 *   - Linux  → Secret Service via `secret-tool` (libsecret), secret on stdin.
 *
 * Item names are namespaced `capix:<service>` so entries from multiple Capix
 * clients never collide inside the user's keychain.
 */
export class PlatformCredentialStore implements CredentialStore {
  private readonly backend: PlatformBackend;

  constructor(backend?: PlatformBackend) {
    const resolved = backend ?? detectBackend();
    if (!resolved) {
      throw new Error(
        "@capix/auth-broker: no OS keychain CLI available on this platform — use FileCredentialStore",
      );
    }
    this.backend = resolved;
  }

  /** True when a usable OS keychain CLI exists on this machine. */
  static isSupported(platform: NodeJS.Platform = process.platform): boolean {
    return detectBackend(platform) !== null;
  }

  private item(service: string, account: string): string {
    return `capix:${service}:${account}`;
  }

  async get(service: string, account: string): Promise<string | null> {
    const item = this.item(service, account);
    try {
      switch (this.backend) {
        case "macos-keychain": {
          const { stdout } = await runCli("security", [
            "find-generic-password",
            "-s",
            item,
            "-a",
            account,
            "-w",
          ]);
          return stdout.replace(/\n$/, "") || null;
        }
        case "linux-secret-service": {
          const { stdout } = await runCli("secret-tool", [
            "lookup",
            "service",
            item,
            "account",
            account,
          ]);
          return stdout || null;
        }
        case "windows-credential-manager": {
          const script = [
            `$res = '${item.replace(/'/g, "''")}'`,
            `$acc = '${account.replace(/'/g, "''")}'`,
            "[Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType=WindowsRuntime] | Out-Null",
            "$vault = New-Object Windows.Security.Credentials.PasswordVault",
            "try { $c = $vault.Retrieve($res, $acc); $c.RetrievePassword(); [Console]::Out.Write($c.Password) } catch {}",
          ].join("; ");
          const { stdout } = await runCli(
            "powershell",
            ["-NoProfile", "-NonInteractive", "-Command", script],
          );
          return stdout || null;
        }
      }
    } catch {
      // Item absent or keychain locked — treated as "no credential".
      return null;
    }
  }

  async set(service: string, account: string, secret: string): Promise<void> {
    const item = this.item(service, account);
    switch (this.backend) {
      case "macos-keychain":
        // -U updates an existing item. Note: `security` only accepts the
        // secret via argv; this matches git-credential-osxkeychain et al.
        await runCli("security", [
          "add-generic-password",
          "-U",
          "-s",
          item,
          "-a",
          account,
          "-w",
          secret,
        ]);
        return;
      case "linux-secret-service":
        // Secret travels on stdin, never argv.
        await runCli(
          "secret-tool",
          [
            "store",
            `--label=Capix ${service} ${account}`,
            "service",
            item,
            "account",
            account,
          ],
          secret,
        );
        return;
      case "windows-credential-manager": {
        const script = [
          "$sec = [Console]::In.ReadToEnd()",
          `$res = '${item.replace(/'/g, "''")}'`,
          `$acc = '${account.replace(/'/g, "''")}'`,
          "[Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType=WindowsRuntime] | Out-Null",
          "[Windows.Security.Credentials.PasswordCredential, Windows.Security.Credentials, ContentType=WindowsRuntime] | Out-Null",
          "$vault = New-Object Windows.Security.Credentials.PasswordVault",
          "try { $old = $vault.Retrieve($res, $acc); $vault.Remove($old) } catch {}",
          "$cred = New-Object Windows.Security.Credentials.PasswordCredential($res, $acc, $sec)",
          "$vault.Add($cred)",
        ].join("; ");
        await runCli(
          "powershell",
          ["-NoProfile", "-NonInteractive", "-Command", script],
          secret,
        );
        return;
      }
    }
  }

  async delete(service: string, account: string): Promise<void> {
    const item = this.item(service, account);
    try {
      switch (this.backend) {
        case "macos-keychain":
          await runCli("security", [
            "delete-generic-password",
            "-s",
            item,
            "-a",
            account,
          ]);
          return;
        case "linux-secret-service":
          await runCli("secret-tool", [
            "clear",
            "service",
            item,
            "account",
            account,
          ]);
          return;
        case "windows-credential-manager": {
          const script = [
            `$res = '${item.replace(/'/g, "''")}'`,
            `$acc = '${account.replace(/'/g, "''")}'`,
            "[Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType=WindowsRuntime] | Out-Null",
            "$vault = New-Object Windows.Security.Credentials.PasswordVault",
            "try { $c = $vault.Retrieve($res, $acc); $vault.Remove($c) } catch {}",
          ].join("; ");
          await runCli("powershell", [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
          ]);
          return;
        }
      }
    } catch {
      // Deleting an absent item is success (idempotent revoke/logout).
    }
  }
}

// ===========================================================================
// Default store selection
// ===========================================================================

/**
 * Pick the best available credential store for this machine:
 * keytar (if the native module is installed) → OS keychain CLI → 0600 file.
 * Never returns a plaintext store.
 */
export function createDefaultCredentialStore(service: string): CredentialStore {
  try {
    return new KeytarCredentialStore(service);
  } catch {
    // keytar not installed — fall through
  }
  if (PlatformCredentialStore.isSupported()) {
    try {
      return new PlatformCredentialStore();
    } catch {
      // fall through
    }
  }
  return new FileCredentialStore();
}
