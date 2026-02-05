# Itachi Memory System - Windows Setup
# Installs hooks + orchestrator in one step.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File setup.ps1
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -HooksOnly
#
param(
    [switch]$HooksOnly
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ClaudeDir = Join-Path $env:USERPROFILE ".claude"
$HooksDir = Join-Path $ClaudeDir "hooks"
$CommandsDir = Join-Path $ClaudeDir "commands"
$SkillsDir = Join-Path $ClaudeDir "skills"
$OrchDir = Join-Path $ScriptDir "orchestrator"
$ApiUrl = "https://eliza-claude-production.up.railway.app"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Itachi Memory System - Setup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# ---------- Prerequisites ----------
Write-Host "[prereqs] Checking dependencies..." -ForegroundColor Yellow

$missing = @()
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { $missing += "node" }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { $missing += "npm" }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { $missing += "git" }
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { $missing += "gh" }

if ($missing.Count -gt 0) {
    Write-Host "  Missing: $($missing -join ', ')" -ForegroundColor Red
    Write-Host ""
    Write-Host "  Install them first:" -ForegroundColor Yellow
    Write-Host "    winget install OpenJS.NodeJS.LTS" -ForegroundColor White
    Write-Host "    winget install GitHub.cli" -ForegroundColor White
    Write-Host "    winget install Git.Git" -ForegroundColor White
    exit 1
}

# Check Claude Code CLI
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Host "  Claude Code CLI not found. Installing..." -ForegroundColor Yellow
    npm install -g @anthropic-ai/claude-code
}

Write-Host "  All dependencies OK" -ForegroundColor Green

# ---------- Passphrase + Bootstrap ----------
Write-Host ""
Write-Host "=== Passphrase & Bootstrap ===" -ForegroundColor Cyan
Write-Host ""

$itachiKeyFile = Join-Path $env:USERPROFILE ".itachi-key"
$credFile = Join-Path $env:USERPROFILE ".supabase-credentials"

# Step 1: Ensure passphrase exists
if (Test-Path $itachiKeyFile) {
    Write-Host "  Found existing passphrase at $itachiKeyFile" -ForegroundColor Gray
} else {
    Write-Host "  Enter the shared Itachi passphrase (used for encrypted sync)." -ForegroundColor Yellow
    Write-Host "  All machines must use the same passphrase." -ForegroundColor Gray
    Write-Host ""
    $passphrase = Read-Host "  Passphrase" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($passphrase)
    $plainPass = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)

    if (-not $plainPass) {
        Write-Host "  ERROR: Passphrase cannot be empty." -ForegroundColor Red
        exit 1
    }
    [System.IO.File]::WriteAllText($itachiKeyFile, $plainPass)
    Write-Host "  Saved to $itachiKeyFile" -ForegroundColor Gray
}

# Step 2: Bootstrap Supabase credentials if missing
$supaUrl = $null
$supaKey = $null

if (Test-Path $credFile) {
    Write-Host "  Found existing credentials at $credFile" -ForegroundColor Gray
    $content = Get-Content $credFile -Raw
    if ($content -match 'SUPABASE_URL=(.+)') { $supaUrl = $Matches[1].Trim() }
    if ($content -match 'SUPABASE_KEY=(.+)') { $supaKey = $Matches[1].Trim() }
}

if (-not $supaUrl -or -not $supaKey) {
    Write-Host "  Bootstrapping Supabase credentials from server..." -ForegroundColor Yellow

    $bootstrapOk = $false
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $bootstrap = Invoke-RestMethod -Uri "$ApiUrl/api/bootstrap" -TimeoutSec 10
        if ($bootstrap.encrypted_config -and $bootstrap.salt) {
            $bootstrapOk = $true
        }
    } catch {
        $bootstrapOk = $false
    }

    if ($bootstrapOk) {
        # Decrypt bootstrap config with passphrase
        $bootstrapJson = $bootstrap | ConvertTo-Json -Compress
        $decryptResult = node -e "
const crypto = require('crypto');
const fs = require('fs');
const bootstrap = JSON.parse(process.argv[1]);
const passphrase = fs.readFileSync(process.argv[2], 'utf8').trim();
try {
    const packed = Buffer.from(bootstrap.encrypted_config, 'base64');
    const salt = Buffer.from(bootstrap.salt, 'base64');
    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const ct = packed.subarray(28);
    const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const config = JSON.parse(decipher.update(ct, null, 'utf8') + decipher.final('utf8'));
    console.log(config.SUPABASE_URL);
    console.log(config.SUPABASE_KEY);
} catch(e) {
    console.error('DECRYPT_FAILED');
    process.exit(1);
}
" $bootstrapJson $itachiKeyFile 2>$null

        if ($LASTEXITCODE -eq 0 -and $decryptResult) {
            $lines = $decryptResult -split "`n"
            $supaUrl = $lines[0].Trim()
            $supaKey = $lines[1].Trim()
            @"
SUPABASE_URL=$supaUrl
SUPABASE_KEY=$supaKey
"@ | Set-Content $credFile -Encoding UTF8
            Write-Host "  Bootstrapped credentials to $credFile" -ForegroundColor Green
        } else {
            Write-Host "  ERROR: Wrong passphrase or bootstrap decryption failed." -ForegroundColor Red
            Write-Host "  Check your passphrase and try again." -ForegroundColor Red
            exit 1
        }
    } else {
        Write-Host "  Bootstrap not available. Falling back to manual entry." -ForegroundColor Yellow
        Write-Host "  (Get these from the project owner or your Supabase dashboard)" -ForegroundColor Gray
        Write-Host ""
        $supaUrl = Read-Host "  SUPABASE_URL"
        $supaKey = Read-Host "  SUPABASE_KEY"
        @"
SUPABASE_URL=$supaUrl
SUPABASE_KEY=$supaKey
"@ | Set-Content $credFile -Encoding UTF8
        Write-Host "  Saved to $credFile" -ForegroundColor Gray
    }
}

# ---------- Part 1: Hooks + Commands + Skills ----------
Write-Host ""
Write-Host "=== Part 1: Claude Code Hooks ===" -ForegroundColor Cyan
Write-Host ""

Write-Host "[1/5] Creating directories..." -ForegroundColor Yellow
@($HooksDir, $CommandsDir, (Join-Path $SkillsDir "itachi-init"), (Join-Path $SkillsDir "itachi-env")) | ForEach-Object {
    if (-not (Test-Path $_)) {
        New-Item -ItemType Directory -Path $_ -Force | Out-Null
    }
}

Write-Host "[2/5] Installing hook scripts..." -ForegroundColor Yellow
$hookFiles = @("after-edit.ps1", "session-start.ps1", "session-end.ps1")
foreach ($hook in $hookFiles) {
    $src = Join-Path $ScriptDir "hooks\windows\$hook"
    $dst = Join-Path $HooksDir $hook
    Copy-Item $src $dst -Force
    Write-Host "  $hook" -ForegroundColor Gray
}

Write-Host "[3/5] Installing commands..." -ForegroundColor Yellow
$cmdFiles = @("recall.md", "recent.md")
foreach ($cmd in $cmdFiles) {
    $src = Join-Path $ScriptDir "commands\$cmd"
    $dst = Join-Path $CommandsDir $cmd
    Copy-Item $src $dst -Force
    Write-Host "  $cmd" -ForegroundColor Gray
}

Write-Host "[4/5] Installing skills..." -ForegroundColor Yellow
$skillSrc = Join-Path $ScriptDir "skills\itachi-init\SKILL.md"
$skillDst = Join-Path $SkillsDir "itachi-init\SKILL.md"
Copy-Item $skillSrc $skillDst -Force
Write-Host "  itachi-init" -ForegroundColor Gray

$skillSrc2 = Join-Path $ScriptDir "skills\itachi-env\SKILL.md"
$skillDst2 = Join-Path $SkillsDir "itachi-env\SKILL.md"
Copy-Item $skillSrc2 $skillDst2 -Force
Write-Host "  itachi-env" -ForegroundColor Gray

Write-Host "[5/5] Updating settings.json..." -ForegroundColor Yellow
$settingsPath = Join-Path $ClaudeDir "settings.json"
if (Test-Path $settingsPath) {
    $settings = Get-Content $settingsPath -Raw | ConvertFrom-Json

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

    if ($settings.PSObject.Properties['hooks']) {
        $settings.PSObject.Properties.Remove('hooks')
    }
    $settings | Add-Member -NotePropertyName 'hooks' -NotePropertyValue $newHooks

    $settings | ConvertTo-Json -Depth 10 | Set-Content $settingsPath -Encoding UTF8
    Write-Host "  Updated $settingsPath" -ForegroundColor Gray
}
else {
    Write-Host "  WARNING: $settingsPath not found - run 'claude' once first, then re-run this script" -ForegroundColor Red
}

# Remove hooks from settings.local.json
$localSettingsPath = Join-Path $ClaudeDir "settings.local.json"
if (Test-Path $localSettingsPath) {
    $localSettings = Get-Content $localSettingsPath -Raw | ConvertFrom-Json
    if ($localSettings.PSObject.Properties['hooks']) {
        $localSettings.PSObject.Properties.Remove('hooks')
        $localSettings | ConvertTo-Json -Depth 10 | Set-Content $localSettingsPath -Encoding UTF8
    }
}

Write-Host ""
Write-Host "  Hooks installed." -ForegroundColor Green

# Test API
Write-Host ""
Write-Host "Testing API connectivity..." -ForegroundColor Yellow
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $health = Invoke-RestMethod -Uri "$ApiUrl/health" -TimeoutSec 10
    Write-Host "  API: OK ($($health.memories) memories)" -ForegroundColor Green
}
catch {
    Write-Host "  WARNING: Could not reach $ApiUrl" -ForegroundColor Red
}

if ($HooksOnly) {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Hooks-only setup complete!" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    exit 0
}

# ---------- Part 2: Orchestrator ----------
Write-Host ""
Write-Host "=== Part 2: Orchestrator (Task Runner) ===" -ForegroundColor Cyan
Write-Host ""

# Try to pull .env from itachi-secrets
$orchEnv = Join-Path $OrchDir ".env"
$useSecrets = $false

if (-not (Test-Path $orchEnv)) {
    Write-Host ""
    Write-Host "  No orchestrator .env found." -ForegroundColor Yellow
    Write-Host "  Checking itachi-secrets for a shared config..." -ForegroundColor Gray

    # Build secrets tool if needed
    $secretsJs = Join-Path $ScriptDir "tools\dist\itachi-secrets.js"
    if (-not (Test-Path $secretsJs)) {
        Write-Host "  Building itachi-secrets tool..." -ForegroundColor Gray
        Push-Location (Join-Path $ScriptDir "tools")
        npm install 2>$null
        npx tsc 2>$null
        Pop-Location
    }

    if (Test-Path $secretsJs) {
        # Check if orchestrator-env secret exists
        try {
            $env:SUPABASE_URL = $supaUrl
            $env:SUPABASE_KEY = $supaKey
            $listOutput = node $secretsJs list 2>$null
            if ($listOutput -match "orchestrator-env") {
                Write-Host ""
                Write-Host "  Found shared orchestrator config in itachi-secrets." -ForegroundColor Green
                $pullChoice = Read-Host "  Pull it? (y/n)"
                if ($pullChoice -eq 'y') {
                    node $secretsJs pull orchestrator-env --out $orchEnv
                    $useSecrets = $true
                    Write-Host "  Pulled .env from itachi-secrets" -ForegroundColor Green
                }
            }
            else {
                Write-Host "  No shared config found in itachi-secrets." -ForegroundColor Gray
            }
        }
        catch {
            Write-Host "  Could not check itachi-secrets: $($_.Exception.Message)" -ForegroundColor Gray
        }
    }
}
else {
    Write-Host "  Found existing .env at $orchEnv" -ForegroundColor Gray
    $useSecrets = $true
}

# If we didn't pull from secrets, generate a fresh .env
if (-not $useSecrets) {
    Write-Host ""
    Write-Host "  Configuring orchestrator..." -ForegroundColor Yellow

    $defaultId = ($env:COMPUTERNAME).ToLower() -replace ' ', '-'
    $orchId = Read-Host "  Orchestrator ID [$defaultId]"
    if (-not $orchId) { $orchId = $defaultId }

    $defaultWs = Join-Path $env:USERPROFILE "itachi-workspaces"
    $wsDir = Read-Host "  Workspace directory [$defaultWs]"
    if (-not $wsDir) { $wsDir = $defaultWs }
    New-Item -ItemType Directory -Path $wsDir -Force | Out-Null

    @"
SUPABASE_URL=$supaUrl
SUPABASE_KEY=$supaKey
ITACHI_ORCHESTRATOR_ID=$orchId
ITACHI_MAX_CONCURRENT=2
ITACHI_WORKSPACE_DIR=$wsDir
ITACHI_TASK_TIMEOUT_MS=600000
ITACHI_DEFAULT_MODEL=sonnet
ITACHI_DEFAULT_BUDGET=5.00
ITACHI_POLL_INTERVAL_MS=5000
ITACHI_PROJECT_PATHS={}
ITACHI_API_URL=$ApiUrl
"@ | Set-Content $orchEnv -Encoding UTF8
    Write-Host "  Written: $orchEnv" -ForegroundColor Gray
}

# Patch machine-specific values in pulled .env
if ($useSecrets -and (Test-Path $orchEnv)) {
    Write-Host ""
    Write-Host "  Updating machine-specific values..." -ForegroundColor Yellow

    $defaultId = ($env:COMPUTERNAME).ToLower() -replace ' ', '-'
    $orchId = Read-Host "  Orchestrator ID [$defaultId]"
    if (-not $orchId) { $orchId = $defaultId }

    $defaultWs = Join-Path $env:USERPROFILE "itachi-workspaces"
    $wsDir = Read-Host "  Workspace directory [$defaultWs]"
    if (-not $wsDir) { $wsDir = $defaultWs }
    New-Item -ItemType Directory -Path $wsDir -Force | Out-Null

    $envContent = Get-Content $orchEnv -Raw
    $envContent = $envContent -replace 'ITACHI_ORCHESTRATOR_ID=.+', "ITACHI_ORCHESTRATOR_ID=$orchId"
    $envContent = $envContent -replace 'ITACHI_WORKSPACE_DIR=.+', "ITACHI_WORKSPACE_DIR=$wsDir"
    # Clear project paths — new machine won't have the same local repos
    $envContent = $envContent -replace 'ITACHI_PROJECT_PATHS=\{.+\}', 'ITACHI_PROJECT_PATHS={}'
    Set-Content $orchEnv $envContent -Encoding UTF8
    Write-Host "  Updated orchestrator ID and workspace path" -ForegroundColor Gray
}

# Build orchestrator
Write-Host ""
Write-Host "Building orchestrator..." -ForegroundColor Yellow
Push-Location $OrchDir
npm install
npm run build
Pop-Location
Write-Host "  Build OK" -ForegroundColor Green

# Start options
Write-Host ""
Write-Host "The orchestrator needs to run continuously to pick up tasks." -ForegroundColor Yellow
Write-Host ""
Write-Host "Options:" -ForegroundColor White
Write-Host "  1) Start with PM2 (recommended)" -ForegroundColor White
Write-Host "  2) Start in foreground (for testing)" -ForegroundColor White
Write-Host "  3) Skip - I'll start it myself later" -ForegroundColor White
Write-Host ""
$startChoice = Read-Host "Choose [1/2/3]"

switch ($startChoice) {
    "1" {
        if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
            Write-Host "  Installing PM2..." -ForegroundColor Gray
            npm install -g pm2
        }
        pm2 start "$OrchDir\dist\index.js" --name itachi-orchestrator
        pm2 save
        Write-Host ""
        Write-Host "  Started with PM2." -ForegroundColor Green
        Write-Host "  Logs: pm2 logs itachi-orchestrator" -ForegroundColor Gray
    }
    "2" {
        Write-Host ""
        Write-Host "  Starting in foreground (Ctrl+C to stop)..." -ForegroundColor Yellow
        node "$OrchDir\dist\index.js"
    }
    default {
        Write-Host ""
        Write-Host "  Skipped. Start later with:" -ForegroundColor Gray
        Write-Host "    node $OrchDir\dist\index.js" -ForegroundColor White
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Setup Complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Test: Send '/task <project> Hello world' on Telegram" -ForegroundColor White
Write-Host "  Health: curl http://localhost:3001/health" -ForegroundColor White
Write-Host ""
