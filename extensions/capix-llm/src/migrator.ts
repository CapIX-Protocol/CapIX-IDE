/**
 * Capix migrator — zero-cost switching from VS Code / Cursor.
 *
 * One command (`capix.migrate.import`, also offered once on first run when a
 * source IDE is detected) imports the pieces that make an editor feel like
 * home:
 *   1. settings.json    — merged key-by-key (JSONC-tolerant), capix.* keys
 *                         and machine-specific keys are never overwritten by
 *                         the source; the existing file is backed up first.
 *   2. keybindings.json — arrays merged and de-duplicated by key+command.
 *   3. extensions       — marketplace ids harvested from ~/.vscode/extensions
 *                         and ~/.cursor/extensions and installed via the
 *                         workbench command, best-effort per extension.
 *
 * The destination User directory is derived from `context.globalStorageUri`
 * (<User>/globalStorage/<publisher.name>), so it tracks the actual product
 * data folder (.capix-ide) on every platform. Nothing is read outside the
 * two well-known source config roots; nothing leaves the machine.
 */

import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { logger } from "./logger";

interface SourceIde {
  id: "vscode" | "cursor";
  label: string;
  userDir: string;
  extensionsDir: string;
}

const PROMPTED_KEY = "capix.migrate.prompted.v1";
const DONE_KEY = "capix.migrate.completed.v1";
const THEME_ENFORCED_KEY = "capix.theme.enforced.v1";

/**
 * Theme values we may replace exactly once — the stock VS Code / Void themes
 * an install typically carries over. Anything else counts as a deliberate
 * user choice and is left alone.
 */
const STOCK_THEMES = new Set([
  "",
  "Default Dark Modern",
  "Default Dark+",
  "Default Light Modern",
  "Default Light+",
  "Default High Contrast",
  "Default High Contrast Light",
  "Visual Studio Dark",
  "Visual Studio Light",
  "Abyss",
  "Kimbie Dark",
  "Monokai",
  "Monokai Dimmed",
  "Quiet Light",
  "Red",
  "Solarized Dark",
  "Solarized Light",
  "Tomorrow Night Blue",
  "Void Dark",
  "Void Light",
]);

/** Keys the source must not clobber in the Capix settings file. */
function isProtectedKey(key: string): boolean {
  return (
    key.startsWith("capix.") ||
    key === "workbench.colorTheme" || // Capix Dark is the product default
    key.startsWith("update.") ||
    key.startsWith("telemetry.")
  );
}

function sourceIdes(): SourceIde[] {
  const home = os.homedir();
  const platform = process.platform;
  const roots: SourceIde[] = [];
  if (platform === "darwin") {
    const base = path.join(home, "Library", "Application Support");
    roots.push(
      { id: "vscode", label: "VS Code", userDir: path.join(base, "Code", "User"), extensionsDir: path.join(home, ".vscode", "extensions") },
      { id: "cursor", label: "Cursor", userDir: path.join(base, "Cursor", "User"), extensionsDir: path.join(home, ".cursor", "extensions") },
    );
  } else if (platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    roots.push(
      { id: "vscode", label: "VS Code", userDir: path.join(appData, "Code", "User"), extensionsDir: path.join(home, ".vscode", "extensions") },
      { id: "cursor", label: "Cursor", userDir: path.join(appData, "Cursor", "User"), extensionsDir: path.join(home, ".cursor", "extensions") },
    );
  } else {
    const base = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
    roots.push(
      { id: "vscode", label: "VS Code", userDir: path.join(base, "Code", "User"), extensionsDir: path.join(home, ".vscode", "extensions") },
      { id: "cursor", label: "Cursor", userDir: path.join(base, "Cursor", "User"), extensionsDir: path.join(home, ".cursor", "extensions") },
    );
  }
  return roots;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function detectSources(): Promise<SourceIde[]> {
  const out: SourceIde[] = [];
  for (const ide of sourceIdes()) {
    if (await pathExists(ide.userDir)) out.push(ide);
  }
  return out;
}

/** The Capix User directory, derived from the live storage path. */
function capixUserDir(context: vscode.ExtensionContext): string {
  // <User>/globalStorage/<publisher.name> → <User>
  return path.dirname(path.dirname(context.globalStorageUri.fsPath));
}

// ── JSONC ───────────────────────────────────────────────────────────────────

/** Strip // and block comments while respecting string literals. */
function stripJsoncComments(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    const next = input[i + 1];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

function stripTrailingCommas(input: string): string {
  return input.replace(/,(\s*[}\]])/g, "$1");
}

function parseJsonc<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(stripTrailingCommas(stripJsoncComments(raw))) as T;
  } catch {
    return fallback;
  }
}

// ── settings + keybindings merge ────────────────────────────────────────────

async function mergeSettings(source: SourceIde, destUserDir: string): Promise<number> {
  const srcPath = path.join(source.userDir, "settings.json");
  if (!(await pathExists(srcPath))) return 0;
  const src = parseJsonc<Record<string, unknown>>(await fs.readFile(srcPath, "utf8"), {});
  const entries = Object.entries(src).filter(([k]) => !isProtectedKey(k));
  if (!entries.length) return 0;

  const destPath = path.join(destUserDir, "settings.json");
  await fs.mkdir(destUserDir, { recursive: true });
  const dest = (await pathExists(destPath))
    ? parseJsonc<Record<string, unknown>>(await fs.readFile(destPath, "utf8"), {})
    : {};
  await fs.writeFile(destPath + ".capix-backup", JSON.stringify(dest, null, 2));

  let applied = 0;
  for (const [k, v] of entries) {
    if (dest[k] === undefined || JSON.stringify(dest[k]) !== JSON.stringify(v)) {
      dest[k] = v;
      applied++;
    }
  }
  await fs.writeFile(destPath, JSON.stringify(dest, null, 2) + "\n");
  return applied;
}

async function mergeKeybindings(source: SourceIde, destUserDir: string): Promise<number> {
  const srcPath = path.join(source.userDir, "keybindings.json");
  if (!(await pathExists(srcPath))) return 0;
  const src = parseJsonc<Array<Record<string, unknown>>>(await fs.readFile(srcPath, "utf8"), []);
  if (!Array.isArray(src) || !src.length) return 0;

  const destPath = path.join(destUserDir, "keybindings.json");
  await fs.mkdir(destUserDir, { recursive: true });
  const dest = (await pathExists(destPath))
    ? parseJsonc<Array<Record<string, unknown>>>(await fs.readFile(destPath, "utf8"), [])
    : [];
  await fs.writeFile(destPath + ".capix-backup", JSON.stringify(dest, null, 2));

  const seen = new Set(dest.map((b) => `${String(b.key ?? "")}|${String(b.command ?? "")}|${String(b.when ?? "")}`));
  let applied = 0;
  for (const binding of src) {
    const key = `${String(binding.key ?? "")}|${String(binding.command ?? "")}|${String(binding.when ?? "")}`;
    if (!seen.has(key)) {
      seen.add(key);
      dest.push(binding);
      applied++;
    }
  }
  await fs.writeFile(destPath, JSON.stringify(dest, null, 2) + "\n");
  return applied;
}

// ── extensions ──────────────────────────────────────────────────────────────

async function harvestExtensionIds(extensionsDir: string): Promise<string[]> {
  if (!(await pathExists(extensionsDir))) return [];
  const ids: string[] = [];
  for (const entry of await fs.readdir(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(extensionsDir, entry.name, "package.json"), "utf8")) as {
        publisher?: string;
        name?: string;
      };
      if (pkg.publisher && pkg.name && !pkg.publisher.startsWith("vscode")) {
        ids.push(`${pkg.publisher}.${pkg.name}`.toLowerCase());
      }
    } catch {
      // Skip malformed extension folders individually.
    }
  }
  return ids;
}

async function importExtensions(
  source: SourceIde,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
): Promise<{ installed: number; skipped: number; failed: number }> {
  const ids = await harvestExtensionIds(source.extensionsDir);
  const already = new Set(vscode.extensions.all.map((e) => e.id.toLowerCase()));
  const wanted = [...new Set(ids)].filter((id) => !already.has(id)).slice(0, 60);
  let installed = 0;
  let failed = 0;
  for (const id of wanted) {
    progress.report({ message: `${source.label}: ${id}`, increment: 100 / Math.max(1, wanted.length) });
    try {
      await vscode.commands.executeCommand("workbench.extensions.installExtension", id);
      installed++;
    } catch (err) {
      failed++;
      logger.warn("migrate: extension install failed", { id, error: String(err) });
    }
  }
  return { installed, skipped: ids.length - wanted.length, failed };
}

// ── command flow ────────────────────────────────────────────────────────────

async function runMigration(context: vscode.ExtensionContext): Promise<void> {
  const sources = await detectSources();
  if (!sources.length) {
    vscode.window.showInformationMessage("Capix: no VS Code or Cursor configuration found on this machine.");
    return;
  }

  const picked = await vscode.window.showQuickPick(
    sources.map((s) => ({ label: s.label, description: s.userDir, source: s })),
    { title: "Import settings from…", placeHolder: "Choose the editor to migrate from" },
  );
  if (!picked) return;

  const what = await vscode.window.showQuickPick(
    [
      { label: "Everything", description: "settings + keybindings + extensions", value: ["settings", "keys", "exts"] },
      { label: "Settings + keybindings only", value: ["settings", "keys"] },
      { label: "Extensions only", value: ["exts"] },
    ],
    { title: `Import from ${picked.label}` },
  );
  if (!what) return;

  const destUserDir = capixUserDir(context);
  let settingsCount = 0;
  let keysCount = 0;
  let extResult = { installed: 0, skipped: 0, failed: 0 };

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Capix: importing…", cancellable: false },
    async (progress) => {
      if (what.value.includes("settings")) {
        progress.report({ message: "settings.json" });
        settingsCount = await mergeSettings(picked.source, destUserDir);
      }
      if (what.value.includes("keys")) {
        progress.report({ message: "keybindings.json" });
        keysCount = await mergeKeybindings(picked.source, destUserDir);
      }
      if (what.value.includes("exts")) {
        extResult = await importExtensions(picked.source, progress);
      }
    },
  );

  await context.globalState.update(DONE_KEY, new Date().toISOString());
  const parts: string[] = [];
  if (what.value.includes("settings")) parts.push(`${settingsCount} settings`);
  if (what.value.includes("keys")) parts.push(`${keysCount} keybindings`);
  if (what.value.includes("exts")) {
    parts.push(`${extResult.installed} extensions installed (${extResult.skipped} already present${extResult.failed ? `, ${extResult.failed} failed` : ""})`);
  }
  const choice = await vscode.window.showInformationMessage(
    `Capix: imported ${parts.join(" · ")} from ${picked.label}.`,
    "Reload to apply",
    "Later",
  );
  if (choice === "Reload to apply") {
    void vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

/** One-time nudge on first run when a source IDE is present. */
async function maybePromptMigration(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<string>(DONE_KEY)) return;
  if (context.globalState.get<string>(PROMPTED_KEY)) return;
  const sources = await detectSources();
  if (!sources.length) return;
  await context.globalState.update(PROMPTED_KEY, new Date().toISOString());
  const choice = await vscode.window.showInformationMessage(
    `Welcome to CapixIDE — import your settings, keybindings and extensions from ${sources.map((s) => s.label).join(" / ")}?`,
    "Import",
    "Not now",
  );
  if (choice === "Import") await runMigration(context);
}

/**
 * One-time brand theme enforcement. `configurationDefaults` only apply when
 * the user has no explicit `workbench.colorTheme` setting, so installs that
 * upgraded from stock VS Code/Void settings keep their old theme (stock
 * purple status bar and all) forever. On first activation we move stock
 * themes to Capix Dark; a deliberate non-stock choice is respected, and the
 * guard key guarantees this never runs twice.
 */
async function enforceBrandTheme(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<string>(THEME_ENFORCED_KEY)) return;
  await context.globalState.update(THEME_ENFORCED_KEY, new Date().toISOString());
  try {
    const config = vscode.workspace.getConfiguration("workbench");
    const current = config.get<string>("colorTheme", "");
    if (current === "capix-dark" || current === "Capix Dark") return;
    const explicit = config.inspect<string>("colorTheme")?.globalValue;
    if (explicit !== undefined && !STOCK_THEMES.has(explicit)) return;
    await config.update("colorTheme", "capix-dark", vscode.ConfigurationTarget.Global);
  } catch (err) {
    logger.warn("theme enforcement failed", { error: String(err) });
  }
}

/**
 * Register the import command and schedule the first-run nudge. Hosted from
 * `registerInlineCompletions` (activation plumbing lives there so extension.ts
 * stays untouched).
 */
export function registerMigration(context: vscode.ExtensionContext): void {
  void enforceBrandTheme(context);
  context.subscriptions.push(
    vscode.commands.registerCommand("capix.migrate.import", () => runMigration(context)),
  );
  setTimeout(() => {
    void maybePromptMigration(context).catch((err) =>
      logger.warn("migrate prompt failed", { error: String(err) }),
    );
  }, 6000);
}
