$ErrorActionPreference = "Stop"

Write-Host "=== Loopsy Setup ===" -ForegroundColor Cyan
Write-Host ""

# Check Node.js
try {
    $nodeVersion = (node -v) -replace 'v','' -split '\.' | Select-Object -First 1
    if ([int]$nodeVersion -lt 20) {
        Write-Host "Error: Node.js 20+ required (found $(node -v))" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "Error: Node.js is not installed. Install Node.js 20+ first." -ForegroundColor Red
    exit 1
}

# Check/install pnpm
try {
    pnpm --version | Out-Null
} catch {
    Write-Host "Installing pnpm..."
    npm install -g pnpm
}

Write-Host "Installing dependencies..."
pnpm install

Write-Host "Building packages..."
pnpm build

Write-Host "Initializing Loopsy..."
node packages/cli/dist/index.js init

Write-Host ""
Write-Host "=== Setup complete! ===" -ForegroundColor Green
Write-Host ""
Write-Host "Start the daemon with:"
Write-Host "  pnpm loopsy start" -ForegroundColor Yellow
Write-Host ""
Write-Host "Or run it directly:"
Write-Host "  node packages\daemon\dist\main.js" -ForegroundColor Yellow
