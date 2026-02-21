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

Write-Host "Installing loopsy command globally..."
try { pnpm setup 2>$null } catch {}
$env:PNPM_HOME = [System.IO.Path]::Combine($env:LOCALAPPDATA, "pnpm")
$env:PATH = "$env:PNPM_HOME;$env:PATH"
Push-Location packages/cli
try {
    pnpm link --global 2>$null
} catch {
    try { npm link 2>$null } catch {}
}
Pop-Location

Write-Host "Initializing Loopsy..."
node packages/cli/dist/index.js init

Write-Host ""
Write-Host "=== Setup complete! ===" -ForegroundColor Green
Write-Host ""
Write-Host "Next: connect to another machine:" -ForegroundColor Yellow
Write-Host "  loopsy connect" -ForegroundColor White
Write-Host ""
Write-Host "Or start the daemon manually:" -ForegroundColor Yellow
Write-Host "  loopsy start" -ForegroundColor White
