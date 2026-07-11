#!/usr/bin/env bash
# rebrand.sh — apply Capix branding to the cloned VS Code source.
# ONLY changes product-level identifiers. Does NOT touch any source files.
set -euo pipefail

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

# 2. Overlay every maintained Capix built-in extension. Keep this list explicit:
# a missing customer module must fail the build instead of silently disappearing.
CAPIX_EXTENSIONS=(capix-llm capix-cloud capix-workspace capix-agent-ui)
CODE_CUSTOMER_DIR="${CAPIX_CODE_CUSTOMER_DIR:-$DIR/../capix-code/dist/customer}"
if [ -d "$CODE_CUSTOMER_DIR" ]; then
  CODE_EXE_SUFFIX=""
  [ -f "$CODE_CUSTOMER_DIR/engine/capix-engine.exe" ] && CODE_EXE_SUFFIX=".exe"
  rm -rf "$DIR/extensions/capix-llm/tools/capix-code"
  mkdir -p "$DIR/extensions/capix-llm/tools/capix-code"
  cp -R "$CODE_CUSTOMER_DIR/." "$DIR/extensions/capix-llm/tools/capix-code/"
  if [ -x "$DIR/extensions/capix-llm/tools/capix-code/engine/opencode" ]; then
    mv "$DIR/extensions/capix-llm/tools/capix-code/engine/opencode" "$DIR/extensions/capix-llm/tools/capix-code/engine/capix-engine"
  elif [ ! -x "$DIR/extensions/capix-llm/tools/capix-code/engine/capix-engine$CODE_EXE_SUFFIX" ]; then
    echo "ERROR: Capix Code engine is missing"
    exit 1
  fi
  tar -czf "$DIR/extensions/capix-llm/tools/capix-code/runtime.tar.gz" -C "$DIR/extensions/capix-llm/tools/capix-code/runtime" .
  rm -rf "$DIR/extensions/capix-llm/tools/capix-code/runtime"
  if [ -z "$CODE_EXE_SUFFIX" ]; then
    cp "$DIR/scripts/capix-code-bundled.sh" "$DIR/extensions/capix-llm/tools/capix-code/bin/capix-code"
    chmod +x "$DIR/extensions/capix-llm/tools/capix-code/bin/capix-code" "$DIR/extensions/capix-llm/tools/capix-code/engine/capix-engine"
  else
    chmod +x "$DIR/extensions/capix-llm/tools/capix-code/bin/capix-code.exe" "$DIR/extensions/capix-llm/tools/capix-code/engine/capix-engine.exe"
  fi
  echo "  done: bundled Capix Code customer runtime staged"
else
  echo "ERROR: built Capix Code customer runtime missing: $CODE_CUSTOMER_DIR"
  exit 1
fi
for extension in "${CAPIX_EXTENSIONS[@]}"; do
  source_dir="$DIR/extensions/$extension"
  target_dir="$VSCODE/extensions/$extension"
  if [ ! -f "$source_dir/package.json" ]; then
    echo "ERROR: required built-in extension is missing: $source_dir/package.json"
    exit 1
  fi
  rm -rf "$target_dir"
  mkdir -p "$target_dir"
  cp -R "$source_dir/." "$target_dir/"
  echo "  done: $extension extension copied"
done

# 3. Overlay Capix-owned main-process/workbench modules and matching remote server.
if [ ! -d "$DIR/src/main" ] || [ ! -d "$DIR/src/vs/workbench/contrib" ]; then
  echo "ERROR: required Capix core modules are missing from $DIR/src"
  exit 1
fi
mkdir -p "$VSCODE/src/main" "$VSCODE/src/vs/workbench/contrib"
cp -R "$DIR/src/main/." "$VSCODE/src/main/"
if git -C "$VSCODE" apply --reverse --check "$DIR/patches/0002-register-capix-native-runtime.patch" >/dev/null 2>&1; then
  echo "  done: Capix native runtime already registered"
elif git -C "$VSCODE" apply --check "$DIR/patches/0002-register-capix-native-runtime.patch"; then
  git -C "$VSCODE" apply "$DIR/patches/0002-register-capix-native-runtime.patch"
  echo "  done: Capix native runtime registered"
else
  echo "ERROR: Code-OSS main-process registration patch no longer applies"
  exit 1
fi
if git -C "$VSCODE" apply --reverse --check "$DIR/patches/0003-disable-inherited-onboarding-telemetry.patch" >/dev/null 2>&1; then
  echo "  done: inherited onboarding and telemetry already disabled"
elif git -C "$VSCODE" apply --check "$DIR/patches/0003-disable-inherited-onboarding-telemetry.patch"; then
  git -C "$VSCODE" apply "$DIR/patches/0003-disable-inherited-onboarding-telemetry.patch"
  echo "  done: inherited onboarding and telemetry disabled"
else
  echo "ERROR: inherited onboarding/telemetry patch no longer applies"
  exit 1
fi
if git -C "$VSCODE" apply --reverse --check "$DIR/patches/0004-capix-routed-chat.patch" >/dev/null 2>&1; then
  echo "  done: Capix routed chat already registered"
elif git -C "$VSCODE" apply --check "$DIR/patches/0004-capix-routed-chat.patch"; then
  git -C "$VSCODE" apply "$DIR/patches/0004-capix-routed-chat.patch"
  echo "  done: Capix routed chat registered"
else
  echo "ERROR: Capix routed chat patch no longer applies"
  exit 1
fi
for module in capix-auth capix-ai capix-remote capix-onboarding; do
  source_dir="$DIR/src/vs/workbench/contrib/$module"
  if [ ! -d "$source_dir" ]; then
    echo "ERROR: required workbench module is missing: $source_dir"
    exit 1
  fi
  rm -rf "$VSCODE/src/vs/workbench/contrib/$module"
  cp -R "$source_dir" "$VSCODE/src/vs/workbench/contrib/$module"
done
if [ ! -d "$DIR/remote/capix-server" ]; then
  echo "ERROR: required remote server is missing: $DIR/remote/capix-server"
  exit 1
fi
rm -rf "$VSCODE/remote/capix-server"
mkdir -p "$VSCODE/remote"
cp -R "$DIR/remote/capix-server" "$VSCODE/remote/capix-server"
echo "  done: Capix core and remote modules copied"

# 4. Copy Capix icons over the stock VS Code icons.
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

# Replace inherited Void/Code workbench artwork, not only the platform icon.
for workbench_mark in \
  "$VSCODE/src/vs/workbench/browser/parts/editor/media/void_cube_noshadow.png" \
  "$VSCODE/src/vs/workbench/browser/media/void-icon-sm.png" \
  "$VSCODE/resources/win32/logo_cube_noshadow.png" \
  "$VSCODE/void_icons/logo_cube_noshadow.png" \
  "$VSCODE/void_icons/cubecircled.png"; do
  if [ -e "$workbench_mark" ]; then cp "$DIR/resources/icons/capix-ide.png" "$workbench_mark"; fi
done
echo "  done: workbench artwork replaced"

# 5. Drop settings defaults into the void contrib dir (unchanged paths).
mkdir -p "$VSCODE/src/vs/workbench/contrib/void/browser/react/src/void-settings-tsx"
cp "$DIR/config/settings-defaults.json" "$VSCODE/src/vs/workbench/contrib/void/browser/react/src/void-settings-tsx/capixDefaults.json"
echo "  done: settings defaults"

VSCODE_DIR="$VSCODE" node "$DIR/scripts/brand-workbench-text.mjs"

echo "Capix product overlay complete."
