#!/usr/bin/env bash
#
# dev.sh — launch the CapixIDE dev build (Electron + React watch loop).
#
# Prereqs (from HOW_TO_CONTRIBUTE): Node 20.18.2 (check .nvmrc), no spaces in
# the repo path, plus platform native deps:
#   mac:    Python, Xcode, GNU libtool (brew install libtool)
#   linux:  build-essential g++ libx11-dev libxkbfile-dev libsecret-1-dev python-is-python3
#   win:    VS 2022 Build Tools + MSVC v143 Spectre libs
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
VSCODE="${VSCODE_DIR:-$DIR/vscode}"

if [ ! -d "$VSCODE" ]; then
  echo "✗ No $VSCODE. Run ./scripts/bootstrap.sh first."
  exit 1
fi

cd "$VSCODE"

echo "▸ Installing dependencies (this is slow on first run)…"
npm install

echo "▸ Starting watch compilers (TypeScript + React) in the background…"
npm run watch &
WATCH_PID=$!
npm run watchreact &
REACT_PID=$!

# Compile the Capix LLM extension
echo "▸ Compiling capix-llm extension…"
(cd extensions/capix-llm && npm install --silent && npx tsc -p ./) || { echo "ERROR: extension compilation failed"; exit 1; } &

cleanup() {
  kill "$WATCH_PID" "$REACT_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Give the compilers a moment to warm up before launching the Electron shell.
sleep 5

echo "▸ Launching CapixIDE (dev)…"
if [ "$(uname)" = "Darwin" ]; then
  ./scripts/code.sh --user-data-dir ./.tmp/user-data --extensions-dir ./.tmp/extensions
elif [ "$(expr substr $(uname -s) 1 5)" = "Linux" ]; then
  ./scripts/code.sh --user-data-dir ./.tmp/user-data --extensions-dir ./.tmp/extensions
else
  ./scripts/code.bat --user-data-dir ./.tmp/user-data --extensions-dir ./.tmp/extensions
fi
