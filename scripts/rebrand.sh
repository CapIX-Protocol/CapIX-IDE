#!/usr/bin/env bash
# rebrand.sh — apply Capix branding to the cloned VS Code source.
#
# Strategy: ONLY change product-level identifiers (binary name, config dirs,
# env vars, product.json). Do NOT rename any individual source files or
# directories inside contrib — that breaks dozens of import paths.
# This is the same approach VSCodium uses.
set -uo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
VSCODE="${VSCODE_DIR:-$DIR/vscode}"

if [ ! -d "$VSCODE" ]; then
  echo "ERROR: No $VSCODE. Run ./scripts/bootstrap.sh first."
  exit 1
fi

echo "Rebranding in $VSCODE"

# 1. Copy our product.json over the stock one (sets nameShort, appId, marketplace, etc.)
cp "$DIR/product.json" "$VSCODE/product.json"
echo "  done: product.json"

# 2. Copy the Capix-llm extension into the built-in extensions dir.
if [ -d "$DIR/extensions/capix-llm" ]; then
  mkdir -p "$VSCODE/extensions/capix-llm"
  cp -R "$DIR/extensions/capix-llm/"* "$VSCODE/extensions/capix-llm/"
  echo "  done: capix-llm extension copied"
fi

# 3. Copy Capix logo/icons over the stock VS Code icons.
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

# 4. Fix the buildreact script path (contrib/void → stays as-is, but the
#    package.json script may reference it — leave it alone, it works).
# Do NOT rename contrib/void → contrib/capix. It breaks all imports.

# 5. Apply patches (add Capix as a provider, etc.)
echo "Applying patches..."
for patch in "$DIR"/patches/*.patch; do
  [ -e "$patch" ] || continue
  if (cd "$VSCODE" && git apply --check "$patch" 2>/dev/null); then
    (cd "$VSCODE" && git apply "$patch")
    echo "  done: $(basename "$patch")"
  else
    (cd "$VSCODE" && git apply --3way "$patch" 2>/dev/null || echo "  warn: $(basename "$patch") needs manual resolution")
  fi
done

# 6. Drop our default AI provider settings.
mkdir -p "$VSCODE/src/vs/workbench/contrib/void/browser/react/src/void-settings-tsx"
cp "$DIR/config/settings-defaults.json" "$VSCODE/src/vs/workbench/contrib/void/browser/react/src/void-settings-tsx/capixDefaults.json" 2>/dev/null || true
echo "  done: settings defaults"

echo "Rebrand complete. Source files and import paths are untouched — only product-level branding is applied."
