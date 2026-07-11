#!/usr/bin/env bash
# package.sh — create an unsigned macOS DMG from the built CapixIDE.app.
#
# Usage: scripts/package.sh [VERSION] [ARCH] [SOURCE_DIR]
#   VERSION     default: 0.1.0-dev
#   ARCH        default: arm64
#   SOURCE_DIR  default: .. (the CapixIDE repo root)
#
# Prerequisites:
#   - Run scripts/build.sh first (produces VSCode-darwin-<arch>/CapixIDE.app)
#   - hdiutil (macOS only)
#
# Output (in <SOURCE_DIR>/dist/):
#   CapixIDE-<VERSION>-darwin-<ARCH>.dmg
#   CapixIDE-<VERSION>-darwin-<ARCH>.dmg.sha256
#   CapixIDE-<VERSION>-darwin-<ARCH>.provenance.json
#   CapixIDE-<VERSION>-darwin-<ARCH>.sbom.json
set -euo pipefail

VERSION="${1:-0.1.0-dev}"
ARCH="${2:-arm64}"
SOURCE_DIR="${3:-..}"

# Resolve SOURCE_DIR to an absolute path so subshell git commands work.
SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd)"
BUILD_DIR="$SOURCE_DIR/VSCode-darwin-$ARCH"
OUTPUT_DIR="$SOURCE_DIR/dist"
ARTIFACT_NAME="CapixIDE-$VERSION-darwin-$ARCH"

echo "=== Packaging CapixIDE $VERSION ($ARCH) ==="

# 1. Verify build exists
if [ ! -d "$BUILD_DIR" ]; then
  echo "ERROR: Build directory not found: $BUILD_DIR"
  echo "Run scripts/build.sh first."
  exit 1
fi

APP_PATH="$BUILD_DIR/CapixIDE.app"
if [ ! -d "$APP_PATH" ]; then
  echo "ERROR: CapixIDE.app not found in $BUILD_DIR"
  echo "Run scripts/build.sh first."
  exit 1
fi

# 2. Create output directory
mkdir -p "$OUTPUT_DIR"

# Capture source commit and build timestamp for provenance.
SOURCE_COMMIT="$(git -C "$SOURCE_DIR" rev-parse HEAD 2>/dev/null || echo 'unknown')"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# 3. Create DMG (unsigned)
echo "Creating DMG..."
DMG_PATH="$OUTPUT_DIR/$ARTIFACT_NAME.dmg"
hdiutil create \
  -volname "CapixIDE" \
  -srcfolder "$BUILD_DIR" \
  -ov \
  -format UDZO \
  "$DMG_PATH"

# 4. Generate SHA-256 checksum
echo "Generating SHA-256..."
shasum -a 256 "$DMG_PATH" > "$OUTPUT_DIR/$ARTIFACT_NAME.dmg.sha256"
CHECKSUM="$(awk '{print $1}' "$OUTPUT_DIR/$ARTIFACT_NAME.dmg.sha256")"

# 5. Generate provenance file
echo "Generating provenance..."
cat > "$OUTPUT_DIR/$ARTIFACT_NAME.provenance.json" << EOF
{
  "artifact": "$ARTIFACT_NAME.dmg",
  "version": "$VERSION",
  "platform": "darwin-$ARCH",
  "signed": false,
  "sourceCommit": "$SOURCE_COMMIT",
  "builtAt": "$BUILT_AT",
  "builder": "$(whoami)@$(hostname)",
  "checksum": "$CHECKSUM"
}
EOF

# 6. Generate minimal SBOM (dependency tree from package-lock.json)
echo "Generating SBOM..."
SBOM_PATH="$OUTPUT_DIR/$ARTIFACT_NAME.sbom.json"
if [ -f "$SOURCE_DIR/vscode/package-lock.json" ]; then
  DEP_COUNT="$(node -e '
    try {
      const lock = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const deps = lock.dependencies || {};
      console.log(Object.keys(deps).length);
    } catch { console.log("0"); }
  ' "$SOURCE_DIR/vscode/package-lock.json" 2>/dev/null || echo "0")"
else
  DEP_COUNT="0"
fi

cat > "$SBOM_PATH" << EOF
{
  "sbomFormat": "CapIX-minimal",
  "version": "0.1.0",
  "generatedAt": "$BUILT_AT",
  "artifact": "$ARTIFACT_NAME.dmg",
  "platform": "darwin-$ARCH",
  "sourceCommit": "$SOURCE_COMMIT",
  "signed": false,
  "dependencies": {
    "description": "See vscode/package-lock.json for full dependency tree",
    "topLevelPackageCount": $DEP_COUNT
  },
  "buildTools": {
    "node": "$(node --version 2>/dev/null || echo 'unknown')",
    "npm": "$(npm --version 2>/dev/null || echo 'unknown')"
  }
}
EOF

# 7. Print installation instructions
cat << INST

=== CapixIDE $VERSION (UNSIGNED) ===

Artifact:  $DMG_PATH
SHA-256:   $CHECKSUM
Source:    $SOURCE_COMMIT
Built:     $BUILT_AT

## Installation (UNSIGNED — Gatekeeper bypass required)

1. Verify checksum:
   shasum -a 256 "$DMG_PATH"
   # Expected: $CHECKSUM

2. Mount and install:
   open "$DMG_PATH"
   # Drag CapixIDE to Applications

3. Bypass Gatekeeper (unsigned):
   xattr -cr /Applications/CapixIDE.app

4. Launch:
   open /Applications/CapixIDE.app

## WARNING

This artifact is NOT code-signed or notarized. Running it requires bypassing
macOS Gatekeeper (step 3). Only install on machines you control after
verifying the SHA-256 checksum matches the value above.

## Files Produced

  $OUTPUT_DIR/$ARTIFACT_NAME.dmg               — unsigned disk image
  $OUTPUT_DIR/$ARTIFACT_NAME.dmg.sha256         — SHA-256 checksum
  $OUTPUT_DIR/$ARTIFACT_NAME.provenance.json    — build provenance
  $OUTPUT_DIR/$ARTIFACT_NAME.sbom.json          — minimal SBOM

INST
