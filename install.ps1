# Itachi Memory System - Windows Installer
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1

param(
    [string]$ApiUrl = "https://itachisbrainserver.online"
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
Write-Host "[1/8] Creating directories..." -ForegroundColor Yellow
@($HooksDir, $CommandsDir, (Join-Path $SkillsDir "itachi-init"), (Join-Path $SkillsDir "itachi-env"), (Join-Path $SkillsDir "github"), (Join-Path $SkillsDir "vercel"), (Join-Path $SkillsDir "supabase"), (Join-Path $SkillsDir "x-api")) | ForEach-Object {
    if (-not (Test-Path $_)) {
        New-Item -ItemType Directory -Path $_ -Force | Out-Null
        Write-Host "  Created: $_" -ForegroundColor Gray
    }
}

# Step 2: Copy hook scripts
Write-Host "[2/8] Installing hook scripts..." -ForegroundColor Yellow
$hookFiles = @("after-edit.ps1", "session-start.ps1", "session-end.ps1", "skill-sync.ps1")
foreach ($hook in $hookFiles) {
    $src = Join-Path $ScriptDir "hooks\windows\$hook"
    $dst = Join-Path $HooksDir $hook
    Copy-Item $src $dst -Force
    Write-Host "  Installed: $dst" -ForegroundColor Gray
}

# Step 3: Copy commands
Write-Host "[3/8] Installing commands..." -ForegroundColor Yellow
$cmdFiles = @("recall.md", "recent.md")
foreach ($cmd in $cmdFiles) {
    $src = Join-Path $ScriptDir "commands\$cmd"
    $dst = Join-Path $CommandsDir $cmd
    Copy-Item $src $dst -Force
    Write-Host "  Installed: $dst" -ForegroundColor Gray
}

# Step 4: Copy skill
Write-Host "[4/8] Installing skills..." -ForegroundColor Yellow
$skillSrc = Join-Path $ScriptDir "skills\itachi-init\SKILL.md"
$skillDst = Join-Path $SkillsDir "itachi-init\SKILL.md"
Copy-Item $skillSrc $skillDst -Force
Write-Host "  Installed: $skillDst" -ForegroundColor Gray

$skillSrc2 = Join-Path $ScriptDir "skills\itachi-env\SKILL.md"
$skillDst2 = Join-Path $SkillsDir "itachi-env\SKILL.md"
Copy-Item $skillSrc2 $skillDst2 -Force
Write-Host "  Installed: $skillDst2" -ForegroundColor Gray

foreach ($skill in @("github", "vercel", "supabase", "x-api")) {
    $src = Join-Path $ScriptDir "skills\$skill\SKILL.md"
    $dst = Join-Path $SkillsDir "$skill\SKILL.md"
    if (Test-Path $src) {
        Copy-Item $src $dst -Force
        Write-Host "  Installed: $dst" -ForegroundColor Gray
    }
}

# Step 5: Update settings.json - replace hooks with PowerShell versions
Write-Host "[5/8] Updating settings.json..." -ForegroundColor Yellow
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

# Step 6: Register daily skill sync scheduled task
Write-Host "[6/8] Registering daily skill sync task..." -ForegroundColor Yellow
try {
    $taskName = "ItachiSkillSync"
    $syncScript = Join-Path $HooksDir "skill-sync.ps1"
    $action = New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument "-ExecutionPolicy Bypass -NoProfile -File `"$syncScript`""
    $trigger = New-ScheduledTaskTrigger -Daily -At "3:00AM"
    $taskSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
        -Settings $taskSettings -Description "Daily sync of Claude Code skills across machines" -Force | Out-Null
    Write-Host "  Registered: $taskName (daily at 3:00 AM)" -ForegroundColor Gray
}
catch {
    Write-Host "  WARNING: Could not register scheduled task: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  You can run skill-sync.ps1 manually or register the task yourself." -ForegroundColor Red
}

# Step 7: API Credentials Setup
Write-Host "[7/8] Setting up API credentials..." -ForegroundColor Yellow
$apiKeysFile = Join-Path $env:USERPROFILE ".itachi-api-keys"
$itachiKeyFile = Join-Path $env:USERPROFILE ".itachi-key"

# Define all supported credentials
$credentials = @(
    @{ key = "ITACHI_API_KEY";         label = "Itachi API Key";               hint = "Required for all hooks/orchestrator auth" },
    @{ key = "GITHUB_TOKEN";           label = "GitHub Personal Access Token"; hint = "ghp_... (repo, workflow scopes)" },
    @{ key = "VERCEL_TOKEN";           label = "Vercel Token";                 hint = "from vercel.com/account/tokens" },
    @{ key = "SUPABASE_ACCESS_TOKEN";  label = "Supabase Access Token";        hint = "from supabase.com/dashboard/account/tokens (Management API)" },
    @{ key = "ANTHROPIC_API_KEY";      label = "Anthropic API Key";            hint = "sk-ant-..." },
    @{ key = "GEMINI_API_KEY";         label = "Google Gemini API Key";        hint = "from aistudio.google.com/apikey" },
    @{ key = "X_API_KEY";              label = "X (Twitter) API Key";          hint = "from developer.x.com" },
    @{ key = "X_API_SECRET";           label = "X (Twitter) API Secret";       hint = "" },
    @{ key = "X_ACCESS_TOKEN";         label = "X Access Token";               hint = "OAuth 1.0a user token" },
    @{ key = "X_ACCESS_TOKEN_SECRET";  label = "X Access Token Secret";        hint = "" },
    @{ key = "X_BEARER_TOKEN";         label = "X Bearer Token";               hint = "App-only auth" }
)

# Load existing keys
$existingKeys = @{}
if (Test-Path $apiKeysFile) {
    Get-Content $apiKeysFile | ForEach-Object {
        if ($_ -match '^([A-Za-z_][A-Za-z0-9_]*)=(.+)$') {
            $existingKeys[$matches[1]] = $matches[2]
        }
    }
}

Write-Host "  Configure API keys for cross-machine orchestration." -ForegroundColor Gray
Write-Host "  Press Enter to skip any key (keeps existing value if set)." -ForegroundColor Gray
Write-Host ""

$changed = $false
foreach ($cred in $credentials) {
    $existing = $existingKeys[$cred.key]
    $displayExisting = if ($existing) { "****" + $existing.Substring([Math]::Max(0, $existing.Length - 4)) } else { "(not set)" }
    $hintText = if ($cred.hint) { " [$($cred.hint)]" } else { "" }

    $input = Read-Host "  $($cred.label)$hintText [$displayExisting]"
    if ($input) {
        $existingKeys[$cred.key] = $input.Trim()
        $changed = $true
    }
}

# Write keys file
$keyLines = $existingKeys.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Key)=$($_.Value)" }
$keyLines -join "`n" | Set-Content $apiKeysFile -Encoding UTF8
Write-Host "  Saved: $apiKeysFile" -ForegroundColor Gray

# Set as environment variables for current user (persistent)
foreach ($entry in $existingKeys.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "User")
}
Write-Host "  Set as user environment variables" -ForegroundColor Gray

# Encrypt and push to sync API if passphrase exists
if ((Test-Path $itachiKeyFile) -and $changed) {
    $tmpJs = Join-Path $env:TEMP "itachi-push-sync.js"
    $pushLines = @(
        "const crypto = require('crypto');"
        "const fs = require('fs');"
        "const https = require('https');"
        "const http = require('http');"
        "const os = require('os');"
        "const keyFile = process.argv[1];"
        "const syncApi = process.argv[2];"
        "const apiKeysFile = process.argv[3];"
        "try {"
        "    const passphrase = fs.readFileSync(keyFile, 'utf8').trim();"
        "    const content = fs.readFileSync(apiKeysFile, 'utf8');"
        "    const contentHash = crypto.createHash('sha256').update(content).digest('hex');"
        "    const salt = crypto.randomBytes(16);"
        "    const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');"
        "    const iv = crypto.randomBytes(12);"
        "    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);"
        "    const ct = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()]);"
        "    const packed = Buffer.concat([iv, cipher.getAuthTag(), ct]);"
        "    const body = JSON.stringify({ repo_name: '_global', file_path: 'api-keys', encrypted_data: packed.toString('base64'), salt: salt.toString('base64'), content_hash: contentHash, updated_by: os.hostname() });"
        "    const url = new URL(syncApi + '/push');"
        "    const mod = url.protocol === 'https:' ? https : http;"
        "    const req = mod.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 15000, rejectUnauthorized: false }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { const r = JSON.parse(d); console.log('v' + (r.version || '?')); } catch { console.log('ok'); } }); });"
        "    req.on('error', (e) => { console.log('error: ' + e.message); });"
        "    req.write(body);"
        "    req.end();"
        "} catch(e) { console.log('error: ' + e.message); }"
    )
    $pushLines -join "`n" | Set-Content $tmpJs -Encoding UTF8
    $syncResult = node $tmpJs $itachiKeyFile "$ApiUrl/api/sync" $apiKeysFile 2>$null
    Remove-Item $tmpJs -Force -ErrorAction SilentlyContinue
    if ($syncResult) {
        Write-Host "  Encrypted + synced to remote ($syncResult)" -ForegroundColor Gray
    }
}
elseif (-not (Test-Path $itachiKeyFile)) {
    Write-Host "  NOTE: ~/.itachi-key not found - keys saved locally only (not synced)" -ForegroundColor Yellow
}

# Step 8: Test API connectivity
Write-Host "[8/8] Testing API connectivity..." -ForegroundColor Yellow
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $health = Invoke-RestMethod -Uri "$ApiUrl/health" -TimeoutSec 10
    Write-Host "  API Status: $($health.status) | Memories: $($health.memories)" -ForegroundColor Green
}
catch {
    Write-Host "  WARNING: Could not reach API at $ApiUrl" -ForegroundColor Red
    Write-Host "  Error: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  Hooks are installed but will not work until the API is reachable." -ForegroundColor Red
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
