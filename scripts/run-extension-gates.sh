#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXTENSIONS=(capix-llm capix-cloud capix-workspace capix-agent-ui capix-intelligence)

node "$ROOT/scripts/scan-customer-branding.mjs" --source-only

for extension in "${EXTENSIONS[@]}"; do
  extension_root="$ROOT/extensions/$extension"
  test -f "$extension_root/package-lock.json" || {
    echo "ERROR: $extension has no package-lock.json"
    exit 1
  }
  echo "=== Installing and compiling $extension ==="
  npm ci --ignore-scripts --prefix "$extension_root"
  if [ "$extension" = "capix-llm" ]; then
    # Workspace-runtime integration tests open the real durable session
    # store. Hardened installs suppress native addon scripts above, so build
    # the host-Node binding explicitly before Vitest. Artifact packaging
    # separately rebuilds this dependency for the target Electron ABI.
    npm rebuild --prefix "$extension_root" better-sqlite3
  fi
  npm run compile --prefix "$extension_root"
done

echo "=== Running CapixIDE extension unit tests ==="
npm test --prefix "$ROOT/extensions/capix-llm"
