#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:?release version required}"
RELEASE_TAG="${2:?release tag required}"
EXPECTED_SHA="${3:?expected source commit required}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NORMALIZED_VERSION="${VERSION#v}"
EXPECTED_TAG="v${NORMALIZED_VERSION}"

PRODUCT_VERSION="$(node -e "const p=require(process.argv[1]); process.stdout.write(p.capixVersion)" "$ROOT/product.json")"
test "$NORMALIZED_VERSION" = "$PRODUCT_VERSION" || {
  echo "ERROR: requested version $NORMALIZED_VERSION does not match product version $PRODUCT_VERSION"
  exit 1
}
test "$RELEASE_TAG" = "$EXPECTED_TAG" || {
  echo "ERROR: release tag $RELEASE_TAG must be exactly $EXPECTED_TAG"
  exit 1
}

git -C "$ROOT" rev-parse --verify "refs/tags/$RELEASE_TAG^{commit}" >/dev/null 2>&1 || {
  echo "ERROR: annotated or lightweight tag $RELEASE_TAG is not present in the checkout"
  exit 1
}
TAG_SHA="$(git -C "$ROOT" rev-parse "refs/tags/$RELEASE_TAG^{commit}")"
HEAD_SHA="$(git -C "$ROOT" rev-parse HEAD)"
test "$TAG_SHA" = "$EXPECTED_SHA" || {
  echo "ERROR: $RELEASE_TAG points to $TAG_SHA, expected workflow source $EXPECTED_SHA"
  exit 1
}
test "$HEAD_SHA" = "$EXPECTED_SHA" || {
  echo "ERROR: checked-out source $HEAD_SHA does not match workflow source $EXPECTED_SHA"
  exit 1
}

echo "Release identity verified: $RELEASE_TAG -> $EXPECTED_SHA (CapixIDE $PRODUCT_VERSION)"
