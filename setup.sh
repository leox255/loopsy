#!/usr/bin/env bash
set -e

echo "=== Loopsy Setup ==="
echo ""

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "Error: Node.js is not installed. Install Node.js 20+ first."
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo "Error: Node.js 20+ required (found $(node -v))"
  exit 1
fi

# Check/install pnpm
if ! command -v pnpm &>/dev/null; then
  echo "Installing pnpm..."
  npm install -g pnpm
fi

echo "Installing dependencies..."
pnpm install

echo "Building packages..."
pnpm build

echo "Installing loopsy command globally..."
# Ensure pnpm global bin dir exists
pnpm setup 2>/dev/null || true
export PNPM_HOME="${PNPM_HOME:-$HOME/Library/pnpm}"
export PATH="$PNPM_HOME:$PATH"
(cd packages/cli && pnpm link --global 2>/dev/null) || npm link packages/cli 2>/dev/null || true

echo "Initializing Loopsy..."
node packages/cli/dist/index.js init

echo ""
echo "=== Setup complete! ==="
echo ""
echo "Next: connect to another machine:"
echo "  loopsy connect"
echo ""
echo "Or start the daemon manually:"
echo "  loopsy start"
