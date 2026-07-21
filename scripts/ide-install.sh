#!/usr/bin/env bash
# ide-install.sh — one-line CapixIDE installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/CapIX-Protocol/CapIX-IDE/main/scripts/ide-install.sh | bash
#
# Resolves the latest GitHub release, downloads the matching unsigned archive,
# verifies the published SHA-256 checksum, installs, and launches CapixIDE.
set -euo pipefail

REPO="CapIX-Protocol/CapIX-IDE"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin) PLATFORM="darwin" ;;
  Linux)  PLATFORM="linux" ;;
  *) die "unsupported OS: $OS (on Windows use scripts/ide-install.ps1)" ;;
esac
case "$ARCH" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64)  ARCH="x64" ;;
  *) die "unsupported architecture: $ARCH" ;;
esac

command -v curl >/dev/null 2>&1 || die "curl is required"

log "Resolving latest CapixIDE release…"
TAG="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p')"
[ -n "$TAG" ] || die "could not resolve the latest release tag"

NAME="CapixIDE-${TAG}-${PLATFORM}-${ARCH}-unsigned"
ARCHIVE="${NAME}.tar.gz"
BASE="https://github.com/$REPO/releases/download/$TAG"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

log "Downloading $ARCHIVE ($TAG, $PLATFORM/$ARCH)"
curl -fSL --progress-bar -o "$TMP/$ARCHIVE" "$BASE/$ARCHIVE" || die "download failed — is there a $PLATFORM/$ARCH build in $TAG?"
curl -fsSL -o "$TMP/$ARCHIVE.sha256" "$BASE/$ARCHIVE.sha256" || die "checksum file missing for $ARCHIVE"

log "Verifying SHA-256 checksum"
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$TMP" && sha256sum -c "$ARCHIVE.sha256") || die "checksum verification failed — aborting"
else
  (cd "$TMP" && shasum -a 256 -c "$ARCHIVE.sha256") || die "checksum verification failed — aborting"
fi

if [ "$PLATFORM" = darwin ]; then
  log "Installing CapixIDE.app to /Applications (may ask for your password)"
  tar -xzf "$TMP/$ARCHIVE" -C "$TMP"
  [ -d "$TMP/CapixIDE.app" ] || die "archive did not contain CapixIDE.app"
  SUDO=""
  [ -w /Applications ] || SUDO="sudo"
  $SUDO rm -rf /Applications/CapixIDE.app
  $SUDO cp -R "$TMP/CapixIDE.app" /Applications/CapixIDE.app
  xattr -dr com.apple.quarantine /Applications/CapixIDE.app 2>/dev/null || true
  log "Launching CapixIDE"
  open /Applications/CapixIDE.app
else
  DEST="$HOME/.local/share/capix-ide"
  mkdir -p "$DEST" "$HOME/.local/bin" "$HOME/.local/share/applications"
  tar -xzf "$TMP/$ARCHIVE" -C "$TMP"
  SRC="$(find "$TMP" -maxdepth 1 -type d -name 'VSCode-linux-*' -print -quit)"
  [ -n "$SRC" ] || die "archive did not contain the expected VSCode-linux-x64 tree"
  rm -rf "$DEST/app"
  mkdir -p "$DEST/app"
  cp -R "$SRC/." "$DEST/app/"
  BIN="$(find "$DEST/app" -maxdepth 2 -type f \( -name 'capix' -o -name 'capixide' \) -perm -111 -print -quit)"
  [ -n "$BIN" ] || die "installed executable not found"
  ln -sf "$BIN" "$HOME/.local/bin/capix-ide"
  cat > "$HOME/.local/share/applications/capix-ide.desktop" <<DESKTOP
[Desktop Entry]
Name=CapixIDE
Comment=The AI IDE for the Capix protocol
Exec=$BIN %F
Icon=$DEST/app/resources/app/resources/linux/code.png
Type=Application
Categories=Development;IDE;
DESKTOP
  log "Launching CapixIDE (also available as 'capix-ide' in ~/.local/bin)"
  nohup "$BIN" >/dev/null 2>&1 &
fi

log "CapixIDE $TAG installed."
