@echo off
REM Itachi Memory System — Zero-prerequisite installer for Windows
REM Usage: bootstrap.cmd
REM   or:  bootstrap.cmd --uninstall [--force]
setlocal

echo.
echo   Itachi Memory System — Bootstrap
echo.

REM 1. Install Node.js if missing
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo   Installing Node.js via winget...
    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    if %errorlevel% neq 0 (
        echo   winget failed. Install Node.js manually: https://nodejs.org
        exit /b 1
    )
    REM Refresh PATH
    set "PATH=%ProgramFiles%\nodejs;%PATH%"
)

REM 2. Install Git if missing
where git >nul 2>&1
if %errorlevel% neq 0 (
    echo   Installing Git via winget...
    winget install Git.Git --accept-package-agreements --accept-source-agreements
    if %errorlevel% neq 0 (
        echo   winget failed. Install Git manually: https://git-scm.com
        exit /b 1
    )
    set "PATH=%ProgramFiles%\Git\cmd;%PATH%"
)

REM 3. Clone repo if not already in it
if not exist "%~dp0install.mjs" (
    set "CLONE_DIR=%USERPROFILE%\itachi-memory"
    if not exist "%CLONE_DIR%" (
        echo   Cloning itachi-memory...
        git clone https://github.com/ItachiDevv/itachi-memory.git "%CLONE_DIR%"
    )
    cd /d "%CLONE_DIR%"
) else (
    cd /d "%~dp0"
)

REM 4. Run the real installer
node install.mjs %*
