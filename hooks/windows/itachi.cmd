@echo off
REM Itachi Memory System - Claude Code wrapper

:: Utility commands (no hooks needed for these)
if "%~1"=="clear-failed" ( node "%~dp0..\documents\crypto\skills-plugins\itachi-memory\orchestrator\scripts\clear-tasks.js" failed & goto :eof )
if "%~1"=="clear-done"   ( node "%~dp0..\documents\crypto\skills-plugins\itachi-memory\orchestrator\scripts\clear-tasks.js" completed & goto :eof )

:: Map shortcut flags to CLI args (fall through to hooks below)
:: NOTE: Do NOT pass --permission-mode via CLI — it forces API auth instead of subscription.
:: settings.json defaultMode=bypassPermissions handles permissions. --dangerously-skip-permissions is belt-and-suspenders.
set "CLI_ARGS=%*"
if "%~1"=="--cds" set "CLI_ARGS=--continue --dangerously-skip-permissions %2 %3 %4 %5 %6 %7 %8 %9"
if "%~1"=="--c"   set "CLI_ARGS=--continue %2 %3 %4 %5 %6 %7 %8 %9"
if "%~1"=="--ds"  set "CLI_ARGS=--dangerously-skip-permissions %2 %3 %4 %5 %6 %7 %8 %9"
if "%~1"=="--p"   set "CLI_ARGS=-p %2 %3 %4 %5 %6 %7 %8 %9"
if "%~1"=="--dp"  set "CLI_ARGS=--dangerously-skip-permissions -p %2 %3 %4 %5 %6 %7 %8 %9"
if "%~1"=="--cdp" set "CLI_ARGS=--continue --dangerously-skip-permissions -p %2 %3 %4 %5 %6 %7 %8 %9"

:: Load env vars
set ITACHI_ENABLED=1
set "ITACHI_KEYS_FILE=%USERPROFILE%\.itachi-api-keys"
if exist "%ITACHI_KEYS_FILE%" (
    for /f "usebackq tokens=1,* delims==" %%a in ("%ITACHI_KEYS_FILE%") do set "%%a=%%b"
)
if not defined ITACHI_API_URL set "ITACHI_API_URL=https://itachisbrainserver.online"

:: NOTE: .auth-token loading REMOVED — it caused stale tokens to force API billing.
:: Claude Code reads ~/.claude/.credentials.json directly for OAuth/Max auth.

:: Run session-start hook (redirect stdout to stderr so it doesn't pollute session output)
set "HOOKS_DIR=%USERPROFILE%\.claude\hooks"
if exist "%HOOKS_DIR%\session-start.ps1" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%HOOKS_DIR%\session-start.ps1" 1>&2
)

:: Launch claude
claude %CLI_ARGS%
set ITACHI_EXIT_CODE=%ERRORLEVEL%

:: Run session-end hook
if exist "%HOOKS_DIR%\session-end.ps1" (
    set "ITACHI_EXIT_CODE=%ITACHI_EXIT_CODE%"
    powershell -NoProfile -ExecutionPolicy Bypass -File "%HOOKS_DIR%\session-end.ps1"
)
