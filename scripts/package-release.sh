#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:?version required}"
PLATFORM="${2:?platform required}"
ARCH="${3:?architecture required}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_ROOT="$ROOT/VSCode-${PLATFORM}-${ARCH}"
OUT="$ROOT/release-artifacts"
NAME="CapixIDE-${VERSION}-${PLATFORM}-${ARCH}-unsigned"

NORMALIZED_VERSION="${VERSION#v}"
json_capix_version() {
  local json_path="$1"
  if command -v cygpath >/dev/null 2>&1; then
    json_path="$(cygpath -w "$json_path")"
  fi
  node -e "const fs=require('fs'); console.log(JSON.parse(fs.readFileSync(process.argv[1], 'utf8')).capixVersion)" "$json_path"
}
PRODUCT_VERSION="$(json_capix_version "$ROOT/product.json")"
test "$NORMALIZED_VERSION" = "$PRODUCT_VERSION" || {
  echo "ERROR: release version $NORMALIZED_VERSION does not match product version $PRODUCT_VERSION"
  exit 1
}

test -d "$BUILD_ROOT" || { echo "ERROR: missing build root $BUILD_ROOT"; exit 1; }

if [ "$PLATFORM" = darwin ]; then
  APP="$BUILD_ROOT/CapixIDE.app"
  test -x "$APP/Contents/MacOS/Electron" || { echo "ERROR: missing macOS executable"; exit 1; }
  APP_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
  test "$APP_VERSION" = "$PRODUCT_VERSION" || {
    echo "ERROR: packaged macOS version $APP_VERSION does not match $PRODUCT_VERSION"
    exit 1
  }
  CONTENT="$APP"
  APP_RESOURCES="$APP/Contents/Resources/app"
elif [ "$PLATFORM" = win32 ]; then
  CONTENT="$BUILD_ROOT"
  APP_RESOURCES="$CONTENT/resources/app"
  find "$CONTENT" -maxdepth 2 -type f -iname 'CapixIDE.exe' -print -quit | grep -q . || {
    echo "ERROR: missing Windows executable"; exit 1;
  }
else
  CONTENT="$BUILD_ROOT"
  APP_RESOURCES="$CONTENT/resources/app"
  find "$CONTENT" -maxdepth 3 -type f \( -name 'capix' -o -name 'capixide' \) -perm -111 -print -quit | grep -q . || {
    echo "ERROR: missing Linux executable"; exit 1;
  }
fi

PACKAGED_PRODUCT="$APP_RESOURCES/product.json"
test -f "$PACKAGED_PRODUCT" || { echo "ERROR: packaged product.json not found at $PACKAGED_PRODUCT"; exit 1; }
PACKAGED_VERSION="$(json_capix_version "$PACKAGED_PRODUCT")"
test "$PACKAGED_VERSION" = "$PRODUCT_VERSION" || {
  echo "ERROR: packaged CapixIDE version $PACKAGED_VERSION does not match $PRODUCT_VERSION"
  exit 1
}

for extension in capix-llm capix-cloud capix-workspace capix-agent-ui capix-intelligence; do
  MANIFEST="$APP_RESOURCES/extensions/$extension/package.json"
  test -f "$MANIFEST" || { echo "ERROR: missing built-in $extension manifest at $MANIFEST"; exit 1; }
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
