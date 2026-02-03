# Itachi Secrets - Windows wrapper
# Usage: .\secrets.ps1 push|pull|list|delete [args...]

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$jsPath = Join-Path $scriptDir "dist\itachi-secrets.js"

if (-not (Test-Path $jsPath)) {
    Write-Host "Building itachi-secrets..."
    Push-Location $scriptDir
    npx.cmd tsc
    Pop-Location
}

node $jsPath @args
