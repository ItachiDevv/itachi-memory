#!/bin/bash
# Itachi Memory System - Mac/Linux Installer
# Usage: bash install.sh

set -e

API_URL="${1:-https://eliza-claude-production.up.railway.app}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
HOOKS_DIR="$CLAUDE_DIR/hooks"
COMMANDS_DIR="$CLAUDE_DIR/commands"
SKILLS_DIR="$CLAUDE_DIR/skills"

echo ""
echo "========================================"
echo "  Itachi Memory System - Installer"
echo "========================================"
echo ""

# Step 1: Create directories
echo "[1/6] Creating directories..."
mkdir -p "$HOOKS_DIR" "$COMMANDS_DIR" "$SKILLS_DIR/itachi-init"

# Step 2: Copy hook scripts
echo "[2/6] Installing hook scripts..."
for hook in after-edit.sh session-start.sh session-end.sh; do
    cp "$SCRIPT_DIR/hooks/unix/$hook" "$HOOKS_DIR/$hook"
    chmod +x "$HOOKS_DIR/$hook"
    echo "  Installed: $HOOKS_DIR/$hook"
done

# Step 3: Copy commands
echo "[3/6] Installing commands..."
for cmd in recall.md recent.md; do
    cp "$SCRIPT_DIR/commands/$cmd" "$COMMANDS_DIR/$cmd"
    echo "  Installed: $COMMANDS_DIR/$cmd"
done

# Step 4: Copy skill
echo "[4/6] Installing skills..."
cp "$SCRIPT_DIR/skills/itachi-init/SKILL.md" "$SKILLS_DIR/itachi-init/SKILL.md"
echo "  Installed: $SKILLS_DIR/itachi-init/SKILL.md"

# Step 5: Update settings.json
echo "[5/6] Updating settings.json..."
SETTINGS_FILE="$CLAUDE_DIR/settings.json"
if [ -f "$SETTINGS_FILE" ]; then
    # Use node for reliable JSON manipulation
    node -e "
const fs = require('fs');
const settings = JSON.parse(fs.readFileSync('$SETTINGS_FILE', 'utf8'));
settings.hooks = {
    SessionStart: [{
        hooks: [{
            type: 'command',
            command: 'bash $HOOKS_DIR/session-start.sh',
            timeout: 30
        }]
    }],
    PostToolUse: [{
        matcher: 'Write|Edit',
        hooks: [{
            type: 'command',
            command: 'bash $HOOKS_DIR/after-edit.sh',
            timeout: 30
        }]
    }],
    SessionEnd: [{
        hooks: [{
            type: 'command',
            command: 'bash $HOOKS_DIR/session-end.sh',
            timeout: 30
        }]
    }]
};
fs.writeFileSync('$SETTINGS_FILE', JSON.stringify(settings, null, 2));
" 2>/dev/null
    echo "  Updated: $SETTINGS_FILE"
else
    echo "  WARNING: $SETTINGS_FILE not found - skipping"
fi

# Remove hooks from settings.local.json if it exists
LOCAL_SETTINGS="$CLAUDE_DIR/settings.local.json"
if [ -f "$LOCAL_SETTINGS" ]; then
    node -e "
const fs = require('fs');
const s = JSON.parse(fs.readFileSync('$LOCAL_SETTINGS', 'utf8'));
if (s.hooks) { delete s.hooks; fs.writeFileSync('$LOCAL_SETTINGS', JSON.stringify(s, null, 2)); }
" 2>/dev/null
    echo "  Removed conflicting hooks from settings.local.json"
fi

# Step 6: Test API
echo "[6/6] Testing API connectivity..."
HEALTH=$(curl -s -k "$API_URL/health" --max-time 10 2>/dev/null)
if [ -n "$HEALTH" ]; then
    echo "  API Response: $HEALTH"
else
    echo "  WARNING: Could not reach API at $API_URL"
fi

echo ""
echo "========================================"
echo "  Installation Complete!"
echo "========================================"
echo ""
echo "Verify by:"
echo "  1. Start a new Claude Code session"
echo "  2. Edit any file"
echo "  3. Check: curl $API_URL/api/memory/recent"
echo ""
