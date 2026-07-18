#!/bin/bash
set -euo pipefail

VERSION="v2.2.4"
NAME="CapixIDE"
ARCH=$(uname -m)
case "$ARCH" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|x64) ARCH="x64" ;;
  *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

PLATFORM="darwin"
FILE="CapixIDE-${VERSION#v}-${PLATFORM}-${ARCH}-unsigned"
URL="https://github.com/CapIX-Protocol/CapIX-IDE/releases/download/${VERSION}/${FILE}.tar.gz"

echo "Downloading ${NAME} ${VERSION} (${PLATFORM}-${ARCH})..."
TMPDIR=$(mktemp -d)
curl -fsSL -o "$TMPDIR/$FILE.tar.gz" "$URL"
curl -fsSL -o "$TMPDIR/$FILE.tar.gz.sha256" "$URL.sha256"

echo "Verifying checksum..."
EXPECTED=$(awk '{print $1}' "$TMPDIR/$FILE.tar.gz.sha256")
ACTUAL=$(shasum -a 256 "$TMPDIR/$FILE.tar.gz" | awk '{print $1}')
if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "Checksum mismatch! Expected: $EXPECTED Got: $ACTUAL"
  exit 1
fi
echo "Checksum OK"

echo "Installing..."
tar -xzf "$TMPDIR/$FILE.tar.gz" -C "$TMPDIR"

mkdir -p ~/Applications
rm -rf ~/Applications/CapixIDE.app
cp -R "$TMPDIR/CapixIDE.app" ~/Applications/
xattr -dr com.apple.quarantine ~/Applications/CapixIDE.app 2>/dev/null || true

rm -rf "$TMPDIR"
echo ""
echo "CapixIDE ${VERSION} installed to ~/Applications/CapixIDE.app"
echo "Opening..."
open ~/Applications/CapixIDE.app
