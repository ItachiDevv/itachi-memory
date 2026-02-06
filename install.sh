#!/bin/bash
# Itachi Memory System - Mac/Linux Installer
# Usage: bash install.sh

set -e

API_URL="${1:-http://swoo0o4okwk8ocww4g4ks084.77.42.84.38.sslip.io}"
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
echo "[1/8] Creating directories..."
mkdir -p "$HOOKS_DIR" "$COMMANDS_DIR" "$SKILLS_DIR/itachi-init" "$SKILLS_DIR/itachi-env" "$SKILLS_DIR/github" "$SKILLS_DIR/vercel" "$SKILLS_DIR/supabase" "$SKILLS_DIR/x-api"

# Step 2: Copy hook scripts
echo "[2/8] Installing hook scripts..."
for hook in after-edit.sh session-start.sh session-end.sh skill-sync.sh; do
    cp "$SCRIPT_DIR/hooks/unix/$hook" "$HOOKS_DIR/$hook"
    chmod +x "$HOOKS_DIR/$hook"
    echo "  Installed: $HOOKS_DIR/$hook"
done

# Step 3: Copy commands
echo "[3/8] Installing commands..."
for cmd in recall.md recent.md; do
    cp "$SCRIPT_DIR/commands/$cmd" "$COMMANDS_DIR/$cmd"
    echo "  Installed: $COMMANDS_DIR/$cmd"
done

# Step 4: Copy skill
echo "[4/8] Installing skills..."
cp "$SCRIPT_DIR/skills/itachi-init/SKILL.md" "$SKILLS_DIR/itachi-init/SKILL.md"
echo "  Installed: $SKILLS_DIR/itachi-init/SKILL.md"
cp "$SCRIPT_DIR/skills/itachi-env/SKILL.md" "$SKILLS_DIR/itachi-env/SKILL.md"
echo "  Installed: $SKILLS_DIR/itachi-env/SKILL.md"

for skill in github vercel supabase x-api; do
    if [ -f "$SCRIPT_DIR/skills/$skill/SKILL.md" ]; then
        cp "$SCRIPT_DIR/skills/$skill/SKILL.md" "$SKILLS_DIR/$skill/SKILL.md"
        echo "  Installed: $SKILLS_DIR/$skill/SKILL.md"
    fi
done

# Step 5: Update settings.json
echo "[5/8] Updating settings.json..."
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

# Step 6: Register daily skill sync cron job
echo "[6/8] Registering daily skill sync cron job..."
CRON_CMD="bash $HOOKS_DIR/skill-sync.sh >> $HOME/.claude/.skill-sync.log 2>&1"
CRON_SCHEDULE="0 3 * * *"
# Add if not already present (remove old entry first, then add)
(crontab -l 2>/dev/null | grep -v "skill-sync.sh"; echo "$CRON_SCHEDULE $CRON_CMD") | crontab - 2>/dev/null
if [ $? -eq 0 ]; then
    echo "  Registered: skill-sync cron (daily at 3:00 AM)"
else
    echo "  WARNING: Could not register cron job. You can run skill-sync.sh manually."
fi

# Step 7: API Credentials Setup
echo "[7/8] Setting up API credentials..."
API_KEYS_FILE="$HOME/.itachi-api-keys"
ITACHI_KEY_FILE="$HOME/.itachi-key"

echo "  Configure API keys for cross-machine orchestration."
echo "  Press Enter to skip any key (keeps existing value if set)."
echo ""

# Load existing keys into associative array (bash 4+) or simple vars
declare -A EXISTING_KEYS 2>/dev/null || true
if [ -f "$API_KEYS_FILE" ]; then
    while IFS='=' read -r key value; do
        [ -n "$key" ] && [ -n "$value" ] && EXISTING_KEYS["$key"]="$value"
    done < "$API_KEYS_FILE"
fi

CHANGED=false

prompt_key() {
    local KEY_NAME="$1"
    local LABEL="$2"
    local HINT="$3"
    local EXISTING="${EXISTING_KEYS[$KEY_NAME]}"
    local DISPLAY="(not set)"
    if [ -n "$EXISTING" ]; then
        DISPLAY="****${EXISTING: -4}"
    fi
    local HINT_TEXT=""
    if [ -n "$HINT" ]; then
        HINT_TEXT=" [$HINT]"
    fi
    printf "  %s%s [%s]: " "$LABEL" "$HINT_TEXT" "$DISPLAY"
    read -r INPUT
    if [ -n "$INPUT" ]; then
        EXISTING_KEYS["$KEY_NAME"]="$INPUT"
        CHANGED=true
    fi
}

prompt_key "ITACHI_API_KEY"         "Itachi API Key"               "Required for all hooks/orchestrator auth"
prompt_key "GITHUB_TOKEN"          "GitHub Personal Access Token" "ghp_... (repo, workflow scopes)"
prompt_key "VERCEL_TOKEN"          "Vercel Token"                 "from vercel.com/account/tokens"
prompt_key "SUPABASE_ACCESS_TOKEN" "Supabase Access Token"        "from supabase.com/dashboard/account/tokens"
prompt_key "ANTHROPIC_API_KEY"     "Anthropic API Key"            "sk-ant-..."
prompt_key "GEMINI_API_KEY"        "Google Gemini API Key"        "from aistudio.google.com/apikey"
prompt_key "X_API_KEY"             "X (Twitter) API Key"          "from developer.x.com"
prompt_key "X_API_SECRET"          "X (Twitter) API Secret"       ""
prompt_key "X_ACCESS_TOKEN"        "X Access Token"               "OAuth 1.0a user token"
prompt_key "X_ACCESS_TOKEN_SECRET" "X Access Token Secret"        ""
prompt_key "X_BEARER_TOKEN"        "X Bearer Token"               "App-only auth"

# Write keys file (sorted)
> "$API_KEYS_FILE"
for KEY_NAME in $(echo "${!EXISTING_KEYS[@]}" | tr ' ' '\n' | sort); do
    echo "${KEY_NAME}=${EXISTING_KEYS[$KEY_NAME]}" >> "$API_KEYS_FILE"
done
chmod 600 "$API_KEYS_FILE"
echo "  Saved: $API_KEYS_FILE"

# Add to shell profile for persistence
SHELL_RC="$HOME/.bashrc"
[ -f "$HOME/.zshrc" ] && SHELL_RC="$HOME/.zshrc"
SOURCE_LINE="[ -f ~/.itachi-api-keys ] && set -a && source ~/.itachi-api-keys && set +a"
if ! grep -q "itachi-api-keys" "$SHELL_RC" 2>/dev/null; then
    echo "" >> "$SHELL_RC"
    echo "# Itachi API keys" >> "$SHELL_RC"
    echo "$SOURCE_LINE" >> "$SHELL_RC"
    echo "  Added source line to $SHELL_RC"
fi

# Source now for current session
set -a && source "$API_KEYS_FILE" && set +a

# Encrypt and push to sync API if passphrase exists
if [ -f "$ITACHI_KEY_FILE" ] && [ "$CHANGED" = "true" ]; then
    SYNC_RESULT=$(node -e "
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const http = require('http');
const os = require('os');

const keyFile = process.argv[1];
const syncApi = process.argv[2];
const apiKeysFile = process.argv[3];

try {
    const passphrase = fs.readFileSync(keyFile, 'utf8').trim();
    const content = fs.readFileSync(apiKeysFile, 'utf8');
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');

    const salt = crypto.randomBytes(16);
    const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()]);
    const packed = Buffer.concat([iv, cipher.getAuthTag(), ct]);

    const body = JSON.stringify({
        repo_name: '_global',
        file_path: 'api-keys',
        encrypted_data: packed.toString('base64'),
        salt: salt.toString('base64'),
        content_hash: contentHash,
        updated_by: os.hostname()
    });

    const url = new URL(syncApi + '/push');
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 15000,
        rejectUnauthorized: false
    }, (res) => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { const r = JSON.parse(d); console.log('v' + (r.version || '?')); } catch { console.log('ok'); } });
    });
    req.on('error', (e) => { console.log('error: ' + e.message); });
    req.write(body);
    req.end();
} catch(e) { console.log('error: ' + e.message); }
" "$ITACHI_KEY_FILE" "$API_URL/api/sync" "$API_KEYS_FILE" 2>/dev/null)
    if [ -n "$SYNC_RESULT" ]; then
        echo "  Encrypted + synced to remote ($SYNC_RESULT)"
    fi
elif [ ! -f "$ITACHI_KEY_FILE" ]; then
    echo "  NOTE: ~/.itachi-key not found — keys saved locally only (not synced)"
fi

# Step 8: Test API
echo "[8/8] Testing API connectivity..."
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
