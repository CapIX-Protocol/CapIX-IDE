#!/usr/bin/env node
/**
 * sync-shared-packages.mjs — vendor the shared Capix packages into this
 * extension so the IDE runs the SAME agent runtime and auth broker as the
 * other Capix clients (one identity, one balance, one agent runtime).
 *
 * Sources (sibling mission worktrees; override with env vars):
 *   agent runtime:  $CAPIX_CODE_WORKTREE/packages/agent-runtime/src
 *   auth broker:    $CAPIX_PROTOCOL_WORKTREE/packages/auth-broker/src
 *
 * Destinations (committed, regenerated — do not edit by hand):
 *   src/shared/agent-runtime/
 *   src/shared/auth-broker/
 *
 * Usage:  node scripts/sync-shared-packages.mjs [--check]
 *   --check   verify the vendored copies are up to date (CI)
 */

import { readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PACKAGES = [
  {
    name: "@capix/agent-runtime",
    src: join(process.env.CAPIX_CODE_WORKTREE ?? resolve(extensionRoot, "../../../code"), "packages/agent-runtime/src"),
    dest: join(extensionRoot, "src/shared/agent-runtime"),
    transform: (body) => body,
  },
  {
    name: "@capix/auth-broker",
    src: join(process.env.CAPIX_PROTOCOL_WORKTREE ?? resolve(extensionRoot, "../../../protocol"), "packages/auth-broker/src"),
    dest: join(extensionRoot, "src/shared/auth-broker"),
    // This extension compiles CommonJS (no `import.meta`); `__filename` is
    // the exact CJS equivalent as a createRequire base. This is the ONLY
    // sanctioned divergence from the upstream sources.
    transform: (body) => body.replaceAll("createRequire(import.meta.url)", "createRequire(__filename)"),
  },
];

const checkMode = process.argv.includes("--check");

const header = (pkg) => [
  `// GENERATED FILE — vendored from ${pkg.name} (shared Capix package).`,
  "// Do not edit. Refresh with: node scripts/sync-shared-packages.mjs",
  "",
].join("\n");

function syncPackage(pkg) {
  if (!existsSync(pkg.src)) {
    console.error(`✗ ${pkg.name}: source not found at ${pkg.src}`);
    console.error("  Set CAPIX_CODE_WORKTREE / CAPIX_PROTOCOL_WORKTREE to the mission worktrees.");
    process.exitCode = 1;
    return;
  }
  const files = readdirSync(pkg.src).filter((f) => f.endsWith(".ts")).sort();
  if (!files.length) {
    console.error(`✗ ${pkg.name}: no .ts sources in ${pkg.src}`);
    process.exitCode = 1;
    return;
  }

  if (checkMode) {
    let stale = false;
    for (const file of files) {
      const expected = header(pkg) + pkg.transform(readFileSync(join(pkg.src, file), "utf8"));
      const destPath = join(pkg.dest, file);
      if (!existsSync(destPath) || readFileSync(destPath, "utf8") !== expected) {
        console.error(`✗ ${pkg.name}: ${file} is stale — run scripts/sync-shared-packages.mjs`);
        stale = true;
      }
    }
    if (!stale) console.log(`✓ ${pkg.name}: up to date (${files.length} files)`);
    else process.exitCode = 1;
    return;
  }

  rmSync(pkg.dest, { recursive: true, force: true });
  mkdirSync(pkg.dest, { recursive: true });
  for (const file of files) {
    const body = pkg.transform(readFileSync(join(pkg.src, file), "utf8"));
    writeFileSync(join(pkg.dest, file), header(pkg) + body);
  }
  console.log(`✓ ${pkg.name}: vendored ${files.length} files → ${pkg.dest}`);
}

for (const pkg of PACKAGES) syncPackage(pkg);
