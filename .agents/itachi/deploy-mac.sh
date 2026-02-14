#!/bin/bash
# Deploy itachi hooks + wrappers to Mac via SSH
# Usage: ./deploy-mac.sh
# Requires: ssh mac alias configured, Mac online on Tailscale

set -e

MAC="mac"
REMOTE_REPO="~/itachi/itachi-memory"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "[deploy] Checking Mac connectivity..."
ssh -o ConnectTimeout=5 "$MAC" "echo 'Connected to Mac'" || { echo "[deploy] ERROR: Mac is offline"; exit 1; }

echo "[deploy] Syncing repo on Mac..."
ssh "$MAC" "cd $REMOTE_REPO && git pull"

echo "[deploy] Running install for codex..."
ssh "$MAC" "cd $REMOTE_REPO/.agents/itachi && chmod +x install.sh && ./install.sh codex"

echo "[deploy] Running install for gemini..."
ssh "$MAC" "cd $REMOTE_REPO/.agents/itachi && ./install.sh gemini"

echo "[deploy] Verifying installation..."
ssh "$MAC" "echo '--- Hooks ---' && ls -la ~/.claude/hooks/ && echo '--- Wrappers ---' && ls -la ~/.claude/itachi*"

echo ""
echo "[deploy] Done! Installed on Mac:"
echo "  - itachic (codex wrapper)"
echo "  - itachig (gemini wrapper)"
echo "  - Unified hooks in ~/.claude/hooks/"
