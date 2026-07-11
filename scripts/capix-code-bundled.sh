#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_HOME="${CAPIX_CODE_RUNTIME_HOME:-$HOME/.capix-code/runtime}"
if [ ! -f "$RUNTIME_HOME/package.json" ]; then
  mkdir -p "$RUNTIME_HOME"
  tar -xzf "$ROOT/runtime.tar.gz" -C "$RUNTIME_HOME"
fi
export CAPIX_CODE_HOME="$ROOT"
export CAPIX_CODE_RUNTIME="$RUNTIME_HOME"
export CAPIX_CODE_CONFIG="${CAPIX_CODE_CONFIG:-$ROOT/config/capix-defaults.json}"
exec "$ROOT/engine/capix-engine" "$@"
