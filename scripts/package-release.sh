#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:?version required}"
PLATFORM="${2:?platform required}"
ARCH="${3:?architecture required}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_ROOT="$ROOT/VSCode-${PLATFORM}-${ARCH}"
OUT="$ROOT/release-artifacts"
NAME="CapixIDE-${VERSION}-${PLATFORM}-${ARCH}-unsigned"

test -d "$BUILD_ROOT" || { echo "ERROR: missing build root $BUILD_ROOT"; exit 1; }

if [ "$PLATFORM" = darwin ]; then
  APP="$BUILD_ROOT/CapixIDE.app"
  test -x "$APP/Contents/MacOS/Electron" || { echo "ERROR: missing macOS executable"; exit 1; }
  CONTENT="$APP"
elif [ "$PLATFORM" = win32 ]; then
  CONTENT="$BUILD_ROOT"
  find "$CONTENT" -maxdepth 2 -type f -iname 'CapixIDE.exe' -print -quit | grep -q . || {
    echo "ERROR: missing Windows executable"; exit 1;
  }
else
  CONTENT="$BUILD_ROOT"
  find "$CONTENT" -maxdepth 2 -type f -name 'capixide' -perm -111 -print -quit | grep -q . || {
    echo "ERROR: missing Linux executable"; exit 1;
  }
fi

for extension in capix-llm capix-cloud capix-workspace capix-agent-ui; do
  MANIFEST="$(find "$CONTENT" -type f -path "*/extensions/$extension/package.json" -print -quit)"
  test -n "$MANIFEST" || { echo "ERROR: missing built-in $extension manifest"; exit 1; }
  test -f "$(dirname "$MANIFEST")/out/extension.js" || {
    echo "ERROR: missing compiled built-in $extension/out/extension.js"; exit 1;
  }
done

node "$ROOT/scripts/scan-customer-branding.mjs" "$CONTENT"
mkdir -p "$OUT"
if [ "$PLATFORM" = win32 ]; then
  ARCHIVE="$OUT/$NAME.zip"
  (cd "$(dirname "$CONTENT")" && 7z a -tzip "$ARCHIVE" "$(basename "$CONTENT")")
else
  ARCHIVE="$OUT/$NAME.tar.gz"
  tar -C "$(dirname "$CONTENT")" -czf "$ARCHIVE" "$(basename "$CONTENT")"
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$ARCHIVE" > "$ARCHIVE.sha256"
else
  shasum -a 256 "$ARCHIVE" > "$ARCHIVE.sha256"
fi
printf '%s\n' "$(git -C "$ROOT" rev-parse HEAD)" > "$OUT/$NAME.source-commit.txt"
echo "Verified release artifact: $ARCHIVE"
