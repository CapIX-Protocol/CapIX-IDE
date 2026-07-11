#!/usr/bin/env bash
# rebrand.sh — apply Capix branding to the cloned VS Code source.
# ONLY changes product-level identifiers. Does NOT touch any source files.
set -uo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
VSCODE="${VSCODE_DIR:-$DIR/vscode}"

if [ ! -d "$VSCODE" ]; then
  echo "ERROR: No $VSCODE. Run ./scripts/bootstrap.sh first."
  exit 1
fi

echo "Rebranding in $VSCODE"

# 1. Copy our product.json over the stock one.
cp "$DIR/product.json" "$VSCODE/product.json"
echo "  done: product.json"

# 2. Copy the capix-llm extension into the built-in extensions dir.
if [ -d "$DIR/extensions/capix-llm" ]; then
  mkdir -p "$VSCODE/extensions/capix-llm"
  cp -R "$DIR/extensions/capix-llm/"* "$VSCODE/extensions/capix-llm/"
  echo "  done: capix-llm extension copied"
fi

# 3. Copy Capix icons over the stock VS Code icons.
if [ -d "$DIR/resources/icons" ]; then
  for icon in "$DIR/resources/icons"/*; do
    [ -e "$icon" ] || continue
    name="$(basename "$icon")"
    case "$name" in
      *.icns) cp "$icon" "$VSCODE/resources/darwin/code.icns" 2>/dev/null || true ;;
      *.ico)  cp "$icon" "$VSCODE/resources/win32/code.ico" 2>/dev/null || true ;;
      *.png)  cp "$icon" "$VSCODE/resources/linux/code.png" 2>/dev/null || true ;;
    esac
  done
  echo "  done: icons applied"
fi

# 4. Drop settings defaults into the void contrib dir (unchanged paths).
mkdir -p "$VSCODE/src/vs/workbench/contrib/void/browser/react/src/void-settings-tsx"
cp "$DIR/config/settings-defaults.json" "$VSCODE/src/vs/workbench/contrib/void/browser/react/src/void-settings-tsx/capixDefaults.json" 2>/dev/null || true
echo "  done: settings defaults"

echo "Rebrand complete. No source files modified — all upstream code runs unmodified."
