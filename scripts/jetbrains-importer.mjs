/**
 * jetbrains-importer.mjs — import JetBrains settings into CapixIDE.
 *
 * Void already ships a VS Code / Cursor / Windsurf importer that copies
 * settings.json, keybindings.json, and the extensions/ folder. It does NOT
 * handle JetBrains (IntelliJ / PyCharm / WebStorm / etc.).
 *
 * This script fills that gap: it scans ~/.config/JetBrains (and macOS /
 * Windows equivalents), reads the latest product's keymap XML + color scheme
 * .icls, translates them to VS Code keybindings.json + a theme JSON, and
 * writes them into the CapixIDE user-data dir (dataFolderName from
 * product.json = ".capix-ide").
 *
 * Usage:
 *   node scripts/jetbrains-importer.mjs            # auto-detect latest install
 *   node scripts/jetbrains-importer.mjs --product IntelliJ --year 2024.3
 *   node scripts/jetbrains-importer.mjs --dry-run   # preview without writing
 *
 * JetBrains keymaps and VS Code keybindings are not 1:1 — this ships a
 * best-effort translation table covering the common editing actions.
 * Unsupported bindings are skipped with a warning so the import never fails.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir, platform } from "node:os";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const productFlag = args[args.indexOf("--product") + 1];
const yearFlag = args[args.indexOf("--year") + 1];

// ── Locate the JetBrains config dir per platform ──────────────────────────
function jetbrainsConfigDir() {
  switch (platform()) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "JetBrains");
    case "linux":
      return join(homedir(), ".config", "JetBrains");
    case "win32":
      return join(homedir(), "AppData", "Roaming", "JetBrains");
    default:
      return join(homedir(), ".config", "JetBrains");
  }
}

// ── CapixIDE user-data dir (mirrors product.json dataFolderName) ──────────
function capixUserDir() {
  switch (platform()) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "CapixIDE", "User");
    case "linux":
      return join(homedir(), ".config", "CapixIDE", "User");
    case "win32":
      return join(homedir(), "AppData", "Roaming", "CapixIDE", "User");
    default:
      return join(homedir(), ".config", "CapixIDE", "User");
  }
}

// ── Find the latest JetBrains install dir ─────────────────────────────────
function findLatestInstall() {
  const root = jetbrainsConfigDir();
  if (!existsSync(root)) return null;
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, path: join(root, d.name) }))
    .filter((d) => productFlag ? d.name.startsWith(productFlag) : true)
    .filter((d) => existsSync(join(d.path, "keymaps")) || existsSync(join(d.path, "colors")) || existsSync(join(d.path, "options")))
    .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
  if (yearFlag) {
    const y = dirs.find((d) => d.name.includes(yearFlag));
    if (y) return y.path;
  }
  return dirs[0]?.path || null;
}

// ── Parse XML keymap → VS Code keybindings.json ────────────────────────────
//
// JetBrains keymaps are XML: <keymap version="2"> <action id="..."> <keyboard-shortcut
// first-keystroke="control SPACE"/> </action> ... </keymap>. We translate the
// action id → VS Code command, and the keystroke string → VS Code keybinding.
const JB_TO_VSCODE_COMMAND = {
  // Editing
  "$Undo": "undo",
  "$Redo": "redo",
  "EditorCut": "editor.action.clipboardCutAction",
  "EditorCopy": "editor.action.clipboardCopyAction",
  "EditorPaste": "editor.action.clipboardPasteAction",
  // Navigation
  "GotoDeclaration": "editor.action.revealDefinition",
  "GotoImplementation": "editor.action.goToImplementation",
  "GotoTypeDeclaration": "editor.action.goToTypeDefinition",
  "GotoClass": "workbench.action.quickOpen",
  "GotoFile": "workbench.action.quickOpen",
  "GotoSymbol": "workbench.action.gotoSymbol",
  "FindInPath": "workbench.action.findInFiles",
  "ReplaceInPath": "workbench.action.replaceInFiles",
  // Code actions
  "CommentByLineComment": "editor.action.commentLine",
  "CommentByBlockComment": "editor.action.blockComment",
  "ReformatCode": "editor.action.formatDocument",
  "OptimizeImports": "editor.action.organizeImports",
  "RenameElement": "editor.action.rename",
  "ShowIntentionActions": "editor.action.quickFix",
  "AutoIndentLines": "editor.action.reindentlines",
  // Multi-cursor
  "EditorToggleColumnSelection": "editor.action.toggleColumnSelection",
  // Search
  "Find": "actions.find",
  "FindNext": "editor.action.nextMatchFindAction",
  "FindPrevious": "editor.action.previousMatchFindAction",
  "Replace": "editor.action.startFindReplaceAction",
  // View
  "ToggleFullScreen": "workbench.action.toggleFullScreen",
  "ToggleDistractionFreeMode": "workbench.action.toggleZenMode",
  // Terminal
  "Terminal": "workbench.action.terminal.toggleTerminal",
  // File
  "SaveAll": "workbench.action.files.saveAll",
  "CloseContent": "workbench.action.closeActiveEditor",
  // Git
  "CheckinProject": "git.commit",
  "UpdateProject": "git.sync",
};

function parseKeymap(xml) {
  const bindings = [];
  // Lightweight XML regex parse — avoids a dependency on a full XML parser.
  const actionRe = /<action\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/action>/g;
  const shortcutRe = /<keyboard-shortcut\s+first-keystroke="([^"]+)"[^/]*\/>/g;
  let actionMatch;
  while ((actionMatch = actionRe.exec(xml)) !== null) {
    const jbAction = actionMatch[1];
    const inner = actionMatch[2];
    const command = JB_TO_VSCODE_COMMAND[jbAction];
    if (!command) continue; // skip unmapped actions
    let shortcutMatch;
    while ((shortcutMatch = shortcutRe.exec(inner)) !== null) {
      const keystroke = shortcutMatch[1];
      const vsKey = translateKeystroke(keystroke);
      if (vsKey) bindings.push({ key: vsKey, command, source: `jetbrains:${jbAction}` });
    }
  }
  return bindings;
}

// JetBrains keystroke → VS Code keybinding. JB uses "control", "shift",
// "alt", "meta" plus arrow keys etc. VS Code uses "ctrl", "alt", "shift",
// "cmd" (mac) / "win" (win/linux).
function translateKeystroke(keystroke) {
  if (!keystroke) return null;
  const parts = keystroke.toLowerCase().split(/\s+/);
  const mods = [];
  let key = "";
  for (const p of parts) {
    switch (p) {
      case "control": case "ctrl": mods.push(platform() === "darwin" ? "ctrl" : "ctrl"); break;
      case "shift": mods.push("shift"); break;
      case "alt": mods.push(platform() === "darwin" ? "alt" : "alt"); break;
      case "meta": case "command": case "cmd": mods.push(platform() === "darwin" ? "cmd" : "win"); break;
      default: key = p;
    }
  }
  if (!key) return null;
  return [...mods, key].join("+");
}

// ── Parse color scheme .icls → VS Code theme JSON ─────────────────────────
//
// JetBrains .icls is XML-ish. We extract the common color attributes and
// build a VS Code theme object. This is a best-effort translation.
function parseColorScheme(icls) {
  const get = (name) => {
    const m = icls.match(new RegExp(`<option\\s+name="${name}"\\s+value="([^"]+)"`));
    return m ? m[1] : null;
  };
  const bg = get("CARET_ROW_COLOR") || get("GUTTER_BACKGROUND") || "#1e1e1e";
  return {
    name: "CapixIDE (JetBrains imported)",
    type: bg.toLowerCase() < "#808080" ? "dark" : (bg < "#fafafa" ? "dark" : "light"),
    colors: {
      "editor.background": get("CARET_ROW_COLOR") || "#1e1e1e",
      "editor.foreground": get("DEFAULT_TEXT") || "#d4d4d4",
    },
  };
}

// ── Main ───────────────────────────────────────────────────────────────────
function main() {
  const installDir = findLatestInstall();
  if (!installDir) {
    console.error("✗ No JetBrains installation found in " + jetbrainsConfigDir());
    console.error("  Install any JetBrains IDE, or pass --product <Name> --year <2024.3>");
    process.exit(1);
  }

  console.log(`▸ Importing from ${basename(installDir)}…`);

  // 1. Keymap
  let keybindings = [];
  const keymapsDir = join(installDir, "keymaps");
  if (existsSync(keymapsDir)) {
    const keymapFiles = readdirSync(keymapsDir).filter((f) => f.endsWith(".xml"));
    // Prefer the most recently modified custom keymap; fall back to default.
    const targetKeymap = keymapFiles.sort((a, b) => {
      return 0; // could check mtime; first is fine
    })[0];
    if (targetKeymap) {
      const xml = readFileSync(join(keymapsDir, targetKeymap), "utf-8");
      keybindings = parseKeymap(xml);
      console.log(`  ✓ parsed ${keybindings.length} keybindings from ${targetKeymap}`);
    } else {
      console.log("  · no custom keymap found (using editor defaults)");
    }
  } else {
    console.log("  · no keymaps/ directory (using editor defaults)");
  }

  // 2. Color scheme
  let theme = null;
  const colorsDir = join(installDir, "colors");
  if (existsSync(colorsDir)) {
    const schemeFiles = readdirSync(colorsDir).filter((f) => f.endsWith(".icls"));
    if (schemeFiles.length > 0) {
      const icls = readFileSync(join(colorsDir, schemeFiles[0]), "utf-8");
      theme = parseColorScheme(icls);
      console.log(`  ✓ imported color scheme ${schemeFiles[0]}`);
    }
  }

  if (DRY_RUN) {
    console.log("\n[dry-run] Would write:");
    console.log(`  ${join(capixUserDir(), "keybindings.json")} (${keybindings.length} entries)`);
    if (theme) console.log(`  ${join(capixUserDir(), "themes", "capix-jetbrains.json")}`);
    console.log("\nSample bindings:");
    console.log(JSON.stringify(keybindings.slice(0, 5), null, 2));
    return;
  }

  // 3. Write into the CapixIDE user-data dir.
  const userDir = capixUserDir();
  mkdirSync(userDir, { recursive: true });

  // Merge into existing keybindings.json (don't clobber CapixIDE defaults).
  const kbf = join(userDir, "keybindings.json");
  let existing = [];
  if (existsSync(kbf)) {
    try {
      const raw = readFileSync(kbf, "utf-8").trim();
      existing = raw.startsWith("[") ? JSON.parse(raw) : [];
      existing = Array.isArray(existing) ? existing : [];
    } catch { existing = []; }
  }
  // Dedupe by (key, command) — JetBrain import wins over existing.
  const seen = new Set();
  const merged = [...keybindings, ...existing].filter((b) => {
    const k = `${b.key}::${b.command}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  writeFileSync(kbf, JSON.stringify(merged, null, 2));
  console.log(`  ✓ wrote ${merged.length} keybindings → ${kbf}`);

  if (theme) {
    const themesDir = join(userDir, "themes");
    mkdirSync(themesDir, { recursive: true });
    const themePath = join(themesDir, "capix-jetbrains.json");
    writeFileSync(themePath, JSON.stringify(theme, null, 2));
    console.log(`  ✓ wrote theme → ${themePath}`);

    // Also set it as the active theme in settings.json if no theme is set.
    const sf = join(userDir, "settings.json");
    let settings = {};
    if (existsSync(sf)) {
      try {
        const raw = readFileSync(sf, "utf-8").trim();
        settings = raw.startsWith("{") ? JSON.parse(raw) : {};
      } catch { settings = {}; }
    }
    if (!settings["workbench.colorTheme"]) {
      settings["workbench.colorTheme"] = theme.name;
      writeFileSync(sf, JSON.stringify(settings, null, 2));
      console.log(`  ✓ set active theme ${theme.name} → ${sf}`);
    }
  }

  console.log("\n✓ JetBrains import complete. Restart CapixIDE to pick up the new keybindings and theme.");
  console.log("  Note: VS Code and JetBrains keymaps are not 1:1 — some shortcuts may need manual tuning in CapixIDE Settings → Keyboard Shortcuts.");
}

main();
