# Itachi Memory System - Setup (delegates to Node.js)
# Usage: powershell -ExecutionPolicy Bypass -File setup.ps1 [-HooksOnly]
param([switch]$HooksOnly)
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host "Install Node.js first (winget install OpenJS.NodeJS.LTS)"; exit 1 }
$nodeArgs = @("$PSScriptRoot\setup.mjs")
if ($HooksOnly) { $nodeArgs += "--hooks-only" }
node @nodeArgs
