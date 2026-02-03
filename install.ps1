# Itachi Memory System - Windows Installer
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1

param(
    [string]$ApiUrl = "https://eliza-claude-production.up.railway.app"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ClaudeDir = Join-Path $env:USERPROFILE ".claude"
$HooksDir = Join-Path $ClaudeDir "hooks"
$CommandsDir = Join-Path $ClaudeDir "commands"
$SkillsDir = Join-Path $ClaudeDir "skills"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Itachi Memory System - Installer" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Step 1: Create directories
Write-Host "[1/6] Creating directories..." -ForegroundColor Yellow
@($HooksDir, $CommandsDir, (Join-Path $SkillsDir "itachi-init")) | ForEach-Object {
    if (-not (Test-Path $_)) {
        New-Item -ItemType Directory -Path $_ -Force | Out-Null
        Write-Host "  Created: $_" -ForegroundColor Gray
    }
}

# Step 2: Copy hook scripts
Write-Host "[2/6] Installing hook scripts..." -ForegroundColor Yellow
$hookFiles = @("after-edit.ps1", "session-start.ps1", "session-end.ps1")
foreach ($hook in $hookFiles) {
    $src = Join-Path $ScriptDir "hooks\windows\$hook"
    $dst = Join-Path $HooksDir $hook
    Copy-Item $src $dst -Force
    Write-Host "  Installed: $dst" -ForegroundColor Gray
}

# Step 3: Copy commands
Write-Host "[3/6] Installing commands..." -ForegroundColor Yellow
$cmdFiles = @("recall.md", "recent.md")
foreach ($cmd in $cmdFiles) {
    $src = Join-Path $ScriptDir "commands\$cmd"
    $dst = Join-Path $CommandsDir $cmd
    Copy-Item $src $dst -Force
    Write-Host "  Installed: $dst" -ForegroundColor Gray
}

# Step 4: Copy skill
Write-Host "[4/6] Installing skills..." -ForegroundColor Yellow
$skillSrc = Join-Path $ScriptDir "skills\itachi-init\SKILL.md"
$skillDst = Join-Path $SkillsDir "itachi-init\SKILL.md"
Copy-Item $skillSrc $skillDst -Force
Write-Host "  Installed: $skillDst" -ForegroundColor Gray

# Step 5: Update settings.json - replace hooks with PowerShell versions
Write-Host "[5/6] Updating settings.json..." -ForegroundColor Yellow
$settingsPath = Join-Path $ClaudeDir "settings.json"
if (Test-Path $settingsPath) {
    $settings = Get-Content $settingsPath -Raw | ConvertFrom-Json

    # Build new hooks config with absolute paths
    $hooksDir_escaped = $HooksDir -replace '\\', '\\'

    $newHooks = @{
        SessionStart = @(
            @{
                hooks = @(
                    @{
                        type    = "command"
                        command = "powershell.exe -ExecutionPolicy Bypass -NoProfile -File `"$HooksDir\session-start.ps1`""
                        timeout = 30
                    }
                )
            }
        )
        PostToolUse  = @(
            @{
                matcher = "Write|Edit"
                hooks   = @(
                    @{
                        type    = "command"
                        command = "powershell.exe -ExecutionPolicy Bypass -NoProfile -File `"$HooksDir\after-edit.ps1`""
                        timeout = 30
                    }
                )
            }
        )
        SessionEnd   = @(
            @{
                hooks = @(
                    @{
                        type    = "command"
                        command = "powershell.exe -ExecutionPolicy Bypass -NoProfile -File `"$HooksDir\session-end.ps1`""
                        timeout = 30
                    }
                )
            }
        )
    }

    # Replace hooks property
    if ($settings.PSObject.Properties['hooks']) {
        $settings.PSObject.Properties.Remove('hooks')
    }
    $settings | Add-Member -NotePropertyName 'hooks' -NotePropertyValue $newHooks

    $settings | ConvertTo-Json -Depth 10 | Set-Content $settingsPath -Encoding UTF8
    Write-Host "  Updated: $settingsPath" -ForegroundColor Gray
}
else {
    Write-Host "  WARNING: $settingsPath not found - skipping" -ForegroundColor Red
}

# Step 5b: Remove hooks from settings.local.json (keep permissions)
$localSettingsPath = Join-Path $ClaudeDir "settings.local.json"
if (Test-Path $localSettingsPath) {
    $localSettings = Get-Content $localSettingsPath -Raw | ConvertFrom-Json
    if ($localSettings.PSObject.Properties['hooks']) {
        $localSettings.PSObject.Properties.Remove('hooks')
        $localSettings | ConvertTo-Json -Depth 10 | Set-Content $localSettingsPath -Encoding UTF8
        Write-Host "  Removed conflicting hooks from settings.local.json" -ForegroundColor Gray
    }
}

# Step 6: Test API connectivity
Write-Host "[6/6] Testing API connectivity..." -ForegroundColor Yellow
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $health = Invoke-RestMethod -Uri "$ApiUrl/health" -TimeoutSec 10
    Write-Host "  API Status: $($health.status) | Memories: $($health.memories)" -ForegroundColor Green
}
catch {
    Write-Host "  WARNING: Could not reach API at $ApiUrl" -ForegroundColor Red
    Write-Host "  Error: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  Hooks are installed but won't work until the API is reachable." -ForegroundColor Red
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Installation Complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Verify by:" -ForegroundColor Yellow
Write-Host "  1. Start a new Claude Code session" -ForegroundColor White
Write-Host "  2. Edit any file" -ForegroundColor White
Write-Host "  3. Check: curl $ApiUrl/api/memory/recent" -ForegroundColor White
Write-Host ""
