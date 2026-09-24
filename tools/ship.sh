#!/usr/bin/env bash
# ship.sh — gate, version, tag, push, publish a herdr-plugin-amq release.
# Usage: tools/ship.sh 0.1.11
# The working tree must already contain the release (commit it first, or pass
# dirty files — this script never invents the commit message for you).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: tools/ship.sh <x.y.z>" >&2; exit 2; }
[[ -z "$(git status --porcelain)" ]] || { echo "tree is dirty — commit first" >&2; exit 1; }
[[ "$(git branch --show-current)" == "main" ]] || { echo "not on main" >&2; exit 1; }
git fetch origin >/dev/null 2>&1
[[ "$(git rev-list --count HEAD..origin/main)" == "0" ]] || { echo "origin/main is ahead — pull first" >&2; exit 1; }

echo "== gates =="
npm run check
npm test
if [ "${SKIP_E2E:-}" != "1" ]; then
  export CHROMIUM_BIN="${CHROMIUM_BIN:-/home/cabra.lat/.nix-profile/bin/chromium}"
  export HERDR_DISABLE_PROMPT=1
  npm run test:e2e
fi

echo "== version $VERSION =="
npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null
git add -- package.json package-lock.json
git commit -m "release: publish herdr-plugin-amq $VERSION" -- package.json package-lock.json
git tag -a "v$VERSION" -m "herdr-plugin-amq $VERSION"

echo "== push + publish =="
git push origin main "v$VERSION"
npm publish --access public

echo "shipped v$VERSION"
