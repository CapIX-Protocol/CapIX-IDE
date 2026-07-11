#!/usr/bin/env bash
#
# bootstrap.sh — clone the Void editor source (a VS Code fork) into ./vscode/
# and apply the CapixIDE rebrand on top.
#
# Void is an archived (read-only) snapshot, which makes it a stable fork base.
# See README.md for the rationale.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
VSCODE="${VSCODE_DIR:-$DIR/vscode}"
VOID_COMMIT="b3166e7ef2aefbdfeb139445fdf248a561b85d4d"

if [ -d "$VSCODE/.git" ]; then
  echo "OK: $VSCODE already cloned. Run ./scripts/rebrand.sh to refresh the rebrand."
  exit 0
fi

echo "Cloning Void editor into $VSCODE (commit: $VOID_COMMIT)..."
git clone --depth 1 https://github.com/voideditor/void.git "$VSCODE"
cd "$VSCODE" && git checkout "$VOID_COMMIT"

echo "Applying CapixIDE rebrand..."
bash "$DIR/scripts/rebrand.sh"

echo "Bootstrap complete. Next: ./scripts/dev.sh to launch, or ./scripts/build.sh to package."
