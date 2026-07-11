#!/usr/bin/env bash
# checksum.sh — generate SHA-256 checksums for all distributable artifacts.
#
# Usage: scripts/checksum.sh [DIST_DIR]
#   DIST_DIR  default: ../dist
#
# Generates .sha256 sidecar files for every .dmg, .zip, and .tar.gz
# found in the distribution directory.
set -euo pipefail

DIST_DIR="${1:-../dist}"

if [ ! -d "$DIST_DIR" ]; then
  echo "ERROR: Distribution directory not found: $DIST_DIR"
  echo "Run scripts/package.sh first."
  exit 1
fi

echo "=== Generating SHA-256 checksums ==="

FOUND=0
for f in "$DIST_DIR"/*.dmg "$DIST_DIR"/*.zip "$DIST_DIR"/*.tar.gz; do
  [ -f "$f" ] || continue
  FOUND=1
  shasum -a 256 "$f" > "$f.sha256"
  HASH="$(awk '{print $1}' "$f.sha256")"
  printf "  %-50s %s\n" "$(basename "$f")" "$HASH"
done

if [ "$FOUND" -eq 0 ]; then
  echo "  No distributable artifacts found in $DIST_DIR"
  exit 1
fi

echo "Done."
