#!/usr/bin/env bash
# build.sh — produce packaged Capix IDE binaries.
# Must run with Node 20.18.2 (the ansi-colors / gulp tooling is incompatible with Node 24).
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
VSCODE="${VSCODE_DIR:-$DIR/vscode}"

if [ ! -d "$VSCODE" ]; then
  echo "ERROR: No $VSCODE. Run ./scripts/bootstrap.sh first."
  exit 1
fi

cd "$VSCODE"
export NODE_OPTIONS="--max-old-space-size=8192"

# Capture the exact source commit being built from. This is the Capix
# overlay tree, NOT an upstream clone — build.sh never fetches anything.
SOURCE_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo 'unknown')"
echo "=== Capix IDE build (UNSIGNED) ==="
echo "  source dir:   $VSCODE"
echo "  source commit: $SOURCE_COMMIT"
echo "  NOTE: artifacts are UNSIGNED. Run scripts/package.sh to create the DMG."

# Detect platform and arch.
RAW_ARCH=${VSCODE_ARCH:-$(uname -m)}
if [ "$RAW_ARCH" = "arm64" ] || [ "$RAW_ARCH" = "aarch64" ]; then
  ARCH="arm64"
elif [ "$RAW_ARCH" = "x86_64" ] || [ "$RAW_ARCH" = "amd64" ]; then
  ARCH="x64"
else
  ARCH="$RAW_ARCH"
fi

RAW_OS=$(uname -s)
if [ "$RAW_OS" = "Darwin" ]; then
  PLATFORM="darwin"
elif [ "$RAW_OS" = "Linux" ]; then
  PLATFORM="linux"
else
  PLATFORM="win32"
fi

echo "Building Capix IDE for ${PLATFORM}-${ARCH}..."

# Refresh the owned overlay before every package so local and CI builds cannot
# accidentally ship a stale bootstrap checkout.
VSCODE_DIR="$VSCODE" bash "$DIR/scripts/rebrand.sh"
VSCODE_DIR="$VSCODE" node "$DIR/scripts/verify-runtime-registration.mjs"

for required in \
  extensions/capix-llm/package.json \
  extensions/capix-cloud/package.json \
  extensions/capix-workspace/package.json \
  extensions/capix-agent-ui/package.json \
  extensions/capix-intelligence/package.json \
  src/main/capix-broker.ts \
  src/main/capix-desktop-instance.ts \
  src/main/capix-ipc-registration.ts \
  src/main/capix-native-auth.ts \
  src/main/capix-runtime-bootstrap.ts \
  src/vs/workbench/contrib/capix-auth/index.ts \
  src/vs/workbench/contrib/capix-ai/index.ts \
  src/vs/workbench/contrib/capix-remote/index.ts \
  src/vs/workbench/contrib/capix-onboarding/index.ts \
  src/vs/workbench/contrib/capix-layout/index.ts \
  remote/capix-server/package.json; do
  if [ ! -f "$required" ]; then
    echo "ERROR: packaged Capix module missing after overlay: $required"
    exit 1
  fi
done

# Compile the Capix LLM extension.
for extension in capix-llm capix-cloud capix-workspace capix-agent-ui capix-intelligence; do
  echo "  compiling $extension extension..."
  (cd "extensions/$extension" && npm install --silent && npx tsc -p ./)
done

# capix-llm persists shared Capix Code sessions through better-sqlite3. Native
# addons installed by the host Node runtime cannot be loaded by Electron when
# their ABIs differ, and an omitted binding makes the entire agent runtime fail
# at first message. Rebuild against the exact Electron shipped by Code OSS and
# fail the release before packaging if no native module was produced.
ELECTRON_VERSION="$(node -p "require('./package.json').devDependencies.electron")"
if [ -z "$ELECTRON_VERSION" ] || [ "$ELECTRON_VERSION" = "undefined" ]; then
  echo "ERROR: could not determine the packaged Electron version."
  exit 1
fi
echo "  rebuilding capix-llm native modules for Electron ${ELECTRON_VERSION}..."
(
  cd extensions/capix-llm
  npm rebuild better-sqlite3 \
    --runtime=electron \
    --target="$ELECTRON_VERSION" \
    --dist-url=https://electronjs.org/headers
)
SQLITE_BINDING="$(find extensions/capix-llm/node_modules/better-sqlite3 -type f -name 'better_sqlite3.node' -print -quit)"
if [ -z "$SQLITE_BINDING" ]; then
  echo "ERROR: Electron-compatible better-sqlite3 binding was not produced."
  exit 1
fi
echo "  native session-store binding verified: $SQLITE_BINDING"

VSCODE_DIR="$VSCODE" node "$DIR/scripts/verify-runtime-registration.mjs" --compiled

# React must build FIRST.
echo "  compiling React..."
npm run buildreact

# Main TypeScript compilation.
echo "  compiling VS Code core..."
npm run gulp compile-build-without-mangling

echo "  compiling extensions..."
npm run gulp compile-extension-media
npm run gulp compile-extensions-build

echo "  minifying..."
npm run gulp minify-vscode

# Verify the PTY deadlock fix is present in compiled output (patch 0008).
# If getResolvedShellEnv still appears in the compiled JS, the build will
# deadlock the terminal on startup.
PTY_JS="$VSCODE/out/vs/platform/terminal/node/ptyHostService.js"
if [ -f "$PTY_JS" ]; then
  if grep -q "getResolvedShellEnv" "$PTY_JS" 2>/dev/null; then
    echo "FATAL: ptyHostService.js still contains getResolvedShellEnv after compilation."
    echo "The PTY deadlock patch (0008) was not applied to compiled output."
    exit 1
  else
    echo "  PTY deadlock fix verified in compiled output."
  fi
fi

echo "  packaging (${PLATFORM}-${ARCH})..."
npm run gulp "vscode-${PLATFORM}-${ARCH}-min-ci"

if [ "$PLATFORM" = "darwin" ]; then
  APP_PATH="$VSCODE/../VSCode-darwin-${ARCH}/CapixIDE.app"
  if [ ! -d "$APP_PATH" ]; then
    APP_PATH="$(find "$VSCODE/.." -maxdepth 3 -type d -name 'CapixIDE.app' -print -quit)"
  fi
  if [ ! -d "$APP_PATH" ]; then echo "ERROR: packaged CapixIDE.app not found"; exit 1; fi
  node "$DIR/scripts/scan-customer-branding.mjs" "$APP_PATH"
  echo ""
  echo "  UNSIGNED build: $APP_PATH"
  echo "  source commit:  $SOURCE_COMMIT"
  echo "  Next: scripts/package.sh to create DMG + checksums"
fi

echo "Build complete (UNSIGNED)."
