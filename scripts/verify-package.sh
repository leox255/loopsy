#!/usr/bin/env bash
# Verify the published-shape tarball loads correctly under installs that
# skip lifecycle scripts. The npx loopsy crash in #16 was caused by
# `--ignore-scripts` (common in security-conscious .npmrc) skipping the
# postinstall that used to create @loopsy/* stubs. With bundleDependencies,
# the stubs ship inside the tarball — this script proves it.
#
# Usage: pnpm build && node scripts/package.mjs && bash scripts/verify-package.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARBALL="$ROOT/package-dist/loopsy-$(node -p "require('$ROOT/package.json').version").tgz"

if [ ! -f "$TARBALL" ]; then
  echo "Tarball not found at $TARBALL — run 'cd package-dist && npm pack' first." >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

run_case() {
  local name="$1"
  local dir="$WORK/$name"
  shift
  mkdir -p "$dir"
  cp "$TARBALL" "$dir/"
  echo "── $name ──"
  ( cd "$dir" && "$@" >/dev/null 2>&1 ) || { echo "FAIL: install step in $name" >&2; exit 1; }
  local cli="$dir/node_modules/loopsy/dist/cli/index.js"
  if [ ! -f "$cli" ]; then
    echo "FAIL: $cli missing in $name" >&2
    exit 1
  fi
  if ! ( cd "$dir" && node "$cli" --version >/dev/null 2>&1 ); then
    echo "FAIL: 'loopsy --version' crashed in $name (likely ERR_MODULE_NOT_FOUND)" >&2
    ( cd "$dir" && node "$cli" --version 2>&1 | head -20 ) >&2
    exit 1
  fi
  echo "  ok"
}

run_case npm-ignore-scripts npm install --ignore-scripts --no-audit --no-fund "$(basename "$TARBALL")"

if command -v pnpm >/dev/null 2>&1; then
  run_case pnpm-ignore-scripts pnpm add --ignore-scripts "./$(basename "$TARBALL")"
else
  echo "── pnpm-ignore-scripts: SKIPPED (pnpm not installed) ──"
fi

echo
echo "All install variants resolved @loopsy/protocol bare imports without postinstall."
