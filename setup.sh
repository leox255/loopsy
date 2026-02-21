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

echo "Initializing Loopsy..."
node packages/cli/dist/index.js init

echo ""
echo "=== Setup complete! ==="
echo ""
echo "Start the daemon with:"
echo "  pnpm loopsy start"
echo ""
echo "Or run it directly:"
echo "  node packages/daemon/dist/main.js"
