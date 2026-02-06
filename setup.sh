#!/bin/bash
# Itachi Memory System - Unified Setup
# Installs hooks + orchestrator in one step.
# Works on macOS, Linux, and Raspberry Pi.
#
# Usage:
#   bash setup.sh                     # Interactive — prompts for credentials
#   bash setup.sh --hooks-only        # Skip orchestrator setup (hooks only)
#
set -e

API_URL="https://eliza-claude-production.up.railway.app"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
HOOKS_DIR="$CLAUDE_DIR/hooks"
COMMANDS_DIR="$CLAUDE_DIR/commands"
SKILLS_DIR="$CLAUDE_DIR/skills"
ORCH_DIR="$SCRIPT_DIR/orchestrator"

HOOKS_ONLY=false
if [ "$1" = "--hooks-only" ]; then
    HOOKS_ONLY=true
fi

echo ""
echo "========================================"
echo "  Itachi Memory System - Setup"
echo "========================================"
echo ""

# ---------- Prerequisites check ----------
echo "[prereqs] Checking dependencies..."
MISSING=""
command -v node >/dev/null 2>&1 || MISSING="$MISSING node"
command -v npm >/dev/null 2>&1  || MISSING="$MISSING npm"
command -v git >/dev/null 2>&1  || MISSING="$MISSING git"
command -v gh >/dev/null 2>&1   || MISSING="$MISSING gh"

if [ -n "$MISSING" ]; then
    echo "  Missing:$MISSING"
    echo ""
    echo "  Install them first:"
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "    brew install node gh"
    elif command -v apt-get >/dev/null 2>&1; then
        echo "    sudo apt-get install -y nodejs npm git gh"
    else
        echo "    Install node, npm, git, gh for your platform"
    fi
    exit 1
fi

# Check Claude Code CLI
if ! command -v claude >/dev/null 2>&1; then
    echo "  Claude Code CLI not found. Installing..."
    npm install -g @anthropic-ai/claude-code
fi

echo "  All dependencies OK"

# ---------- Passphrase + Bootstrap ----------
echo ""
echo "=== Passphrase & Bootstrap ==="
echo ""

ITACHI_KEY_FILE="$HOME/.itachi-key"
CRED_FILE="$HOME/.supabase-credentials"

# Step 1: Ensure passphrase exists
if [ -f "$ITACHI_KEY_FILE" ]; then
    echo "  Found existing passphrase at $ITACHI_KEY_FILE"
else
    echo "  Enter the shared Itachi passphrase (used for encrypted sync)."
    echo "  All machines must use the same passphrase."
    echo ""
    read -rsp "  Passphrase: " PASSPHRASE
    echo ""
    if [ -z "$PASSPHRASE" ]; then
        echo "  ERROR: Passphrase cannot be empty."
        exit 1
    fi
    echo -n "$PASSPHRASE" > "$ITACHI_KEY_FILE"
    chmod 600 "$ITACHI_KEY_FILE"
    echo "  Saved to $ITACHI_KEY_FILE"
fi

# Step 2: Bootstrap Supabase credentials if missing
if [ -f "$CRED_FILE" ]; then
    echo "  Found existing credentials at $CRED_FILE"
    SUPABASE_URL=$(grep 'SUPABASE_URL=' "$CRED_FILE" | cut -d= -f2- | tr -d ' ')
    SUPABASE_KEY=$(grep 'SUPABASE_SERVICE_ROLE_KEY=' "$CRED_FILE" | cut -d= -f2- | tr -d ' ')
    [ -z "$SUPABASE_KEY" ] && SUPABASE_KEY=$(grep 'SUPABASE_KEY=' "$CRED_FILE" | cut -d= -f2- | tr -d ' ')
fi

if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_KEY" ]; then
    echo "  Bootstrapping Supabase credentials from server..."
    BOOTSTRAP=$(curl -s -k "$API_URL/api/bootstrap" --max-time 10 2>/dev/null)

    if echo "$BOOTSTRAP" | node -e "try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));if(d.error){process.exit(1)}}catch(e){process.exit(1)}" 2>/dev/null; then
        # Decrypt bootstrap config with passphrase
        DECRYPT_RESULT=$(node -e "
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
    console.log(config.SUPABASE_SERVICE_ROLE_KEY || config.SUPABASE_KEY);
} catch(e) {
    console.error('DECRYPT_FAILED');
    process.exit(1);
}
" "$BOOTSTRAP" "$ITACHI_KEY_FILE" 2>/dev/null)

        if [ $? -eq 0 ]; then
            SUPABASE_URL=$(echo "$DECRYPT_RESULT" | head -1)
            SUPABASE_KEY=$(echo "$DECRYPT_RESULT" | tail -1)
            cat > "$CRED_FILE" << EOF
SUPABASE_URL=$SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_KEY
EOF
            chmod 600 "$CRED_FILE"
            echo "  Bootstrapped credentials to $CRED_FILE"
        else
            echo "  ERROR: Wrong passphrase or bootstrap decryption failed."
            echo "  Check your passphrase and try again."
            exit 1
        fi
    else
        echo "  Bootstrap not available. Falling back to manual entry."
        echo "  (Get these from the project owner or your Supabase dashboard)"
        echo ""
        read -rp "  SUPABASE_URL: " SUPABASE_URL
        read -rp "  SUPABASE_SERVICE_ROLE_KEY: " SUPABASE_KEY
        cat > "$CRED_FILE" << EOF
SUPABASE_URL=$SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_KEY
EOF
        chmod 600 "$CRED_FILE"
        echo "  Saved to $CRED_FILE"
    fi
fi

# ---------- Part 1: Hooks + Commands + Skills ----------
echo ""
echo "=== Part 1: Claude Code Hooks ==="
echo ""

echo "[1/5] Creating directories..."
mkdir -p "$HOOKS_DIR" "$COMMANDS_DIR" "$SKILLS_DIR/itachi-init" "$SKILLS_DIR/itachi-env"

echo "[2/5] Installing hook scripts..."
for hook in after-edit.sh session-start.sh session-end.sh; do
    cp "$SCRIPT_DIR/hooks/unix/$hook" "$HOOKS_DIR/$hook"
    chmod +x "$HOOKS_DIR/$hook"
    echo "  $hook"
done

echo "[3/5] Installing commands..."
for cmd in recall.md recent.md; do
    cp "$SCRIPT_DIR/commands/$cmd" "$COMMANDS_DIR/$cmd"
    echo "  $cmd"
done

echo "[4/5] Installing skills..."
cp "$SCRIPT_DIR/skills/itachi-init/SKILL.md" "$SKILLS_DIR/itachi-init/SKILL.md"
echo "  itachi-init"
cp "$SCRIPT_DIR/skills/itachi-env/SKILL.md" "$SKILLS_DIR/itachi-env/SKILL.md"
echo "  itachi-env"

echo "[5/5] Updating settings.json..."
SETTINGS_FILE="$CLAUDE_DIR/settings.json"
if [ -f "$SETTINGS_FILE" ]; then
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
    echo "  Updated $SETTINGS_FILE"
else
    echo "  WARNING: $SETTINGS_FILE not found — run 'claude' once first, then re-run this script"
fi

# Remove hooks from settings.local.json if it exists
LOCAL_SETTINGS="$CLAUDE_DIR/settings.local.json"
if [ -f "$LOCAL_SETTINGS" ]; then
    node -e "
const fs = require('fs');
const s = JSON.parse(fs.readFileSync('$LOCAL_SETTINGS', 'utf8'));
if (s.hooks) { delete s.hooks; fs.writeFileSync('$LOCAL_SETTINGS', JSON.stringify(s, null, 2)); }
" 2>/dev/null
fi

echo ""
echo "  Hooks installed."

# Test API
echo ""
echo "Testing API connectivity..."
HEALTH=$(curl -s "$API_URL/health" --max-time 10 2>/dev/null || echo "")
if [ -n "$HEALTH" ]; then
    echo "  API: OK"
else
    echo "  WARNING: Could not reach $API_URL — hooks won't sync until API is reachable"
fi

if [ "$HOOKS_ONLY" = true ]; then
    echo ""
    echo "========================================"
    echo "  Hooks-only setup complete!"
    echo "========================================"
    echo ""
    exit 0
fi

# ---------- Part 2: Orchestrator (join the network) ----------
echo ""
echo "=== Part 2: Orchestrator (Task Runner) ==="
echo ""

# Try to pull .env from itachi-secrets
ORCH_ENV="$ORCH_DIR/.env"
USE_SECRETS=false

if [ ! -f "$ORCH_ENV" ]; then
    echo ""
    echo "  No orchestrator .env found."
    echo "  Checking itachi-secrets for a shared config..."

    # Build secrets tool if needed
    SECRETS_JS="$SCRIPT_DIR/tools/dist/itachi-secrets.js"
    if [ ! -f "$SECRETS_JS" ]; then
        echo "  Building itachi-secrets tool..."
        (cd "$SCRIPT_DIR/tools" && npm install 2>/dev/null && npx tsc 2>/dev/null)
    fi

    if [ -f "$SECRETS_JS" ]; then
        export SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_KEY
        LIST_OUTPUT=$(node "$SECRETS_JS" list 2>/dev/null || echo "")
        if echo "$LIST_OUTPUT" | grep -q "orchestrator-env"; then
            echo ""
            echo "  Found shared orchestrator config in itachi-secrets."
            read -rp "  Pull it? (y/n): " PULL_CHOICE
            if [ "$PULL_CHOICE" = "y" ]; then
                node "$SECRETS_JS" pull orchestrator-env --out "$ORCH_ENV"
                USE_SECRETS=true
                echo "  Pulled .env from itachi-secrets"
            fi
        else
            echo "  No shared config found in itachi-secrets."
        fi
    fi
else
    echo "  Found existing .env at $ORCH_ENV"
    USE_SECRETS=true
fi

# If we pulled from secrets or found existing, patch machine-specific values
if [ "$USE_SECRETS" = true ]; then
    echo ""
    echo "  Updating machine-specific values..."

    DEFAULT_ID=$(hostname | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd '[:alnum:]-')
    read -rp "  Orchestrator ID [$DEFAULT_ID]: " ORCH_ID
    ORCH_ID="${ORCH_ID:-$DEFAULT_ID}"

    DEFAULT_WS="$HOME/itachi-workspaces"
    read -rp "  Workspace directory [$DEFAULT_WS]: " WS_DIR
    WS_DIR="${WS_DIR:-$DEFAULT_WS}"
    mkdir -p "$WS_DIR"

    # Patch values in pulled .env
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s|ITACHI_ORCHESTRATOR_ID=.*|ITACHI_ORCHESTRATOR_ID=$ORCH_ID|" "$ORCH_ENV"
        sed -i '' "s|ITACHI_WORKSPACE_DIR=.*|ITACHI_WORKSPACE_DIR=$WS_DIR|" "$ORCH_ENV"
        sed -i '' "s|ITACHI_PROJECT_PATHS={.*}|ITACHI_PROJECT_PATHS={}|" "$ORCH_ENV"
    else
        sed -i "s|ITACHI_ORCHESTRATOR_ID=.*|ITACHI_ORCHESTRATOR_ID=$ORCH_ID|" "$ORCH_ENV"
        sed -i "s|ITACHI_WORKSPACE_DIR=.*|ITACHI_WORKSPACE_DIR=$WS_DIR|" "$ORCH_ENV"
        sed -i "s|ITACHI_PROJECT_PATHS={.*}|ITACHI_PROJECT_PATHS={}|" "$ORCH_ENV"
    fi
    echo "  Updated orchestrator ID and workspace path"
else
    # Generate fresh .env from prompts
    DEFAULT_ID=$(hostname | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd '[:alnum:]-')
    read -rp "  Orchestrator ID [$DEFAULT_ID]: " ORCH_ID
    ORCH_ID="${ORCH_ID:-$DEFAULT_ID}"

    DEFAULT_WS="$HOME/itachi-workspaces"
    read -rp "  Workspace directory [$DEFAULT_WS]: " WS_DIR
    WS_DIR="${WS_DIR:-$DEFAULT_WS}"
    mkdir -p "$WS_DIR"

    read -rp "  Max concurrent Claude sessions [2]: " MAX_CONC
    MAX_CONC="${MAX_CONC:-2}"

    echo ""
    echo "Writing orchestrator config..."
    cat > "$ORCH_ENV" << EOF
SUPABASE_URL=$SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_KEY
ITACHI_ORCHESTRATOR_ID=$ORCH_ID
ITACHI_MAX_CONCURRENT=$MAX_CONC
ITACHI_WORKSPACE_DIR=$WS_DIR
ITACHI_TASK_TIMEOUT_MS=600000
ITACHI_DEFAULT_MODEL=sonnet
ITACHI_DEFAULT_BUDGET=5.00
ITACHI_POLL_INTERVAL_MS=5000
ITACHI_PROJECT_PATHS={}
ITACHI_API_URL=$API_URL
EOF
    echo "  Written: $ORCH_ENV"
fi

# Build orchestrator
echo ""
echo "Building orchestrator..."
cd "$ORCH_DIR"
npm install
npm run build
echo "  Build OK"

# Offer PM2 setup
echo ""
echo "The orchestrator needs to run continuously to pick up tasks."
echo ""
echo "Options:"
echo "  1) Start with PM2 (recommended — auto-restarts, survives reboots)"
echo "  2) Start in foreground (for testing)"
echo "  3) Skip — I'll start it myself later"
echo ""
read -rp "Choose [1/2/3]: " START_CHOICE

case "$START_CHOICE" in
    1)
        if ! command -v pm2 >/dev/null 2>&1; then
            echo "  Installing PM2..."
            npm install -g pm2
        fi
        pm2 start "$ORCH_DIR/dist/index.js" --name itachi-orchestrator
        pm2 save
        echo ""
        echo "  Started with PM2."
        echo "  Run 'pm2 startup' and follow the printed command to auto-start on boot."
        echo "  Logs: pm2 logs itachi-orchestrator"
        ;;
    2)
        echo ""
        echo "  Starting in foreground (Ctrl+C to stop)..."
        echo ""
        node "$ORCH_DIR/dist/index.js"
        ;;
    *)
        echo ""
        echo "  Skipped. Start later with:"
        echo "    cd $ORCH_DIR && node dist/index.js"
        echo "  Or with PM2:"
        echo "    pm2 start $ORCH_DIR/dist/index.js --name itachi-orchestrator"
        ;;
esac

echo ""
echo "========================================"
echo "  Setup Complete!"
echo "========================================"
echo ""
echo "  Orchestrator ID: $ORCH_ID"
echo "  Workspace: $WS_DIR"
echo "  API: $API_URL"
echo ""
echo "  Test: Send '/task <project> Hello world' on Telegram"
echo "  Health: curl http://localhost:3001/health"
echo ""
