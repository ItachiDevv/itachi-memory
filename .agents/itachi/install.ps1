# Itachi Memory - Agent Wrapper Installer (Windows)
# Usage: .\install.ps1 [client]
#   client: claude, codex, aider, cursor, or any CLI name
#
# Examples:
#   .\install.ps1 codex     -> creates itachic.cmd/.ps1
#   .\install.ps1 aider     -> creates itachia.cmd/.ps1

param(
    [Parameter(Position=0)]
    [string]$Client = "codex"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $PSCommandPath
$HooksSource = Join-Path $ScriptDir "hooks"
$ClaudeDir = Join-Path $env:USERPROFILE ".claude"
$HooksDest = Join-Path $ClaudeDir "hooks"

# ============ Client configurations ============
$Clients = @{
    claude = @{ Cli = "claude"; Short = ""; Native = $true; DsFlag = "--dangerously-skip-permissions"; FaFlag = ""; CFlag = "--continue" }
    codex  = @{ Cli = "codex";  Short = "c"; Native = $false; DsFlag = "--dangerously-bypass-approvals-and-sandbox"; FaFlag = "--full-auto"; CFlag = "resume --last" }
    aider  = @{ Cli = "aider";  Short = "a"; Native = $false; DsFlag = "--yes-always"; FaFlag = "--yes-always --auto-commits"; CFlag = "" }
    cursor = @{ Cli = "cursor"; Short = "cur"; Native = $false; DsFlag = ""; FaFlag = ""; CFlag = "" }
}

if ($Clients.ContainsKey($Client)) {
    $c = $Clients[$Client]
} else {
    $c = @{ Cli = $Client; Short = $Client.Substring(0, [Math]::Min(3, $Client.Length)); Native = $false; DsFlag = ""; FaFlag = ""; CFlag = "" }
    Write-Host "[install] Unknown client '$Client' - creating generic wrapper"
}

$cliCmd = [string]$c["Cli"]
$shortN = [string]$c["Short"]
$isNative = $c["Native"]
$dsFlag = [string]$c["DsFlag"]
$faFlag = [string]$c["FaFlag"]
$cFlag = [string]$c["CFlag"]

$wrapperName = "itachi$shortN"
Write-Host "[install] Installing itachi wrapper for '$Client' as '$wrapperName'"

# ============ 1. Deploy unified hooks ============
if (-not (Test-Path $HooksDest)) {
    New-Item -ItemType Directory -Path $HooksDest -Force | Out-Null
}
Copy-Item (Join-Path $HooksSource "session-start.ps1") (Join-Path $HooksDest "session-start.ps1") -Force
Copy-Item (Join-Path $HooksSource "session-end.ps1") (Join-Path $HooksDest "session-end.ps1") -Force
Write-Host "[install] Deployed unified hooks to $HooksDest"

# ============ 2. Skip wrapper for native-hook clients ============
if ($isNative) {
    Write-Host "[install] $cliCmd uses native hooks - no external wrapper needed"
    Write-Host "[install] Done!"
    exit 0
}

# ============ 3. Build CMD flag mappings ============
$cmdFlagLines = ""
if ($dsFlag) { $cmdFlagLines += "if `"%~1`"==`"--ds`" set `"CLI_ARGS=$dsFlag %2 %3 %4 %5 %6 %7 %8 %9`"`r`n" }
if ($faFlag) { $cmdFlagLines += "if `"%~1`"==`"--fa`" set `"CLI_ARGS=$faFlag %2 %3 %4 %5 %6 %7 %8 %9`"`r`n" }
if ($cFlag)  { $cmdFlagLines += "if `"%~1`"==`"--c`"  set `"CLI_ARGS=$cFlag %2 %3 %4 %5 %6 %7 %8 %9`"`r`n" }

# ============ 4. Write .cmd wrapper using node (avoids PS parsing issues with batch syntax) ============
$cmdContent = @"
@echo off
REM Itachi Memory System - $cliCmd CLI wrapper (auto-generated)
REM All sessions go through hooks (wrapper-managed lifecycle)

:: Utility commands
if "%~1"=="clear-failed" ( node "%~dp0..\documents\crypto\skills-plugins\itachi-memory\orchestrator\scripts\clear-tasks.js" failed & goto :eof )
if "%~1"=="clear-done"   ( node "%~dp0..\documents\crypto\skills-plugins\itachi-memory\orchestrator\scripts\clear-tasks.js" completed & goto :eof )

:: Map shortcut flags
set "CLI_ARGS=%*"
$cmdFlagLines
:: Load env vars
set ITACHI_ENABLED=1
set ITACHI_CLIENT=$Client
set "ITACHI_KEYS_FILE=%USERPROFILE%\.itachi-api-keys"
if exist "%ITACHI_KEYS_FILE%" (
    for /f "usebackq tokens=1,* delims==" %%a in ("%ITACHI_KEYS_FILE%") do set "%%a=%%b"
)
if not defined ITACHI_API_URL set "ITACHI_API_URL=https://itachisbrainserver.online"

:: Run session-start hook
set "HOOKS_DIR=%USERPROFILE%\.claude\hooks"
if exist "%HOOKS_DIR%\session-start.ps1" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%HOOKS_DIR%\session-start.ps1"
)

:: Launch $cliCmd
$cliCmd %CLI_ARGS%
set ITACHI_EXIT_CODE=%ERRORLEVEL%

:: Run session-end hook
if exist "%HOOKS_DIR%\session-end.ps1" (
    set "ITACHI_EXIT_CODE=%ITACHI_EXIT_CODE%"
    powershell -NoProfile -ExecutionPolicy Bypass -File "%HOOKS_DIR%\session-end.ps1"
)
"@

# Write cmd file via node to avoid PowerShell string escaping issues
$cmdPath = Join-Path $ClaudeDir "$wrapperName.cmd"
$escapedContent = $cmdContent.Replace('\', '\\').Replace('`', '\`').Replace('"', '\"')
node -e "require('fs').writeFileSync(process.argv[1], process.argv[2])" $cmdPath $cmdContent
Write-Host "[install] Created $cmdPath"

# ============ 5. Build PS1 flag mappings ============
$ps1FlagCases = ""
if ($dsFlag) {
    $dsParts = ($dsFlag -split ' ' | ForEach-Object { "'$_'" }) -join ', '
    $ps1FlagCases += "    '--ds' { @($dsParts) + `$rest }`n"
}
if ($faFlag) {
    $faParts = ($faFlag -split ' ' | ForEach-Object { "'$_'" }) -join ', '
    $ps1FlagCases += "    '--fa' { @($faParts) + `$rest }`n"
}
if ($cFlag) {
    $cParts = ($cFlag -split ' ' | ForEach-Object { "'$_'" }) -join ', '
    $ps1FlagCases += "    '--c'  { @($cParts) + `$rest }`n"
}

$ps1Content = @"
# Itachi Memory System - $cliCmd CLI wrapper (auto-generated)
# All sessions go through hooks (wrapper-managed lifecycle)

# Utility commands
switch (`$args[0]) {
    'clear-failed' { node (Join-Path `$PSScriptRoot '..\documents\crypto\skills-plugins\itachi-memory\orchestrator\scripts\clear-tasks.js') failed; return }
    'clear-done'   { node (Join-Path `$PSScriptRoot '..\documents\crypto\skills-plugins\itachi-memory\orchestrator\scripts\clear-tasks.js') completed; return }
}

# Load env vars
`$env:ITACHI_ENABLED = "1"
`$env:ITACHI_CLIENT = "$Client"
`$keysFile = Join-Path `$env:USERPROFILE ".itachi-api-keys"
if (Test-Path `$keysFile) {
    Get-Content `$keysFile | ForEach-Object {
        if (`$_ -match '^([A-Za-z_][A-Za-z0-9_]*)=(.+)`$') {
            [Environment]::SetEnvironmentVariable(`$matches[1], `$matches[2], "Process")
        }
    }
}
if (-not `$env:ITACHI_API_URL) { `$env:ITACHI_API_URL = "https://itachisbrainserver.online" }

# Map shortcut flags
`$rest = @()
if (`$args.Length -gt 1) { `$rest = `$args[1..(`$args.Length-1)] }

`$cliArgs = switch (`$args[0]) {
$ps1FlagCases    default { `$args }
}

# Run session-start hook
`$hooksDir = Join-Path `$env:USERPROFILE ".claude\hooks"
`$startHook = Join-Path `$hooksDir "session-start.ps1"
if (Test-Path `$startHook) { & `$startHook }

# Launch $cliCmd
$cliCmd @cliArgs
`$env:ITACHI_EXIT_CODE = `$LASTEXITCODE

# Run session-end hook
`$endHook = Join-Path `$hooksDir "session-end.ps1"
if (Test-Path `$endHook) { & `$endHook }
"@

$ps1Path = Join-Path $ClaudeDir "$wrapperName.ps1"
$ps1Content | Set-Content -Path $ps1Path -Encoding UTF8
Write-Host "[install] Created $ps1Path"

Write-Host ""
Write-Host "[install] Done! Run '$wrapperName --ds' to start a $cliCmd session with itachi hooks."
