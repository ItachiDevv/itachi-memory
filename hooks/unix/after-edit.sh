#!/bin/bash
# Itachi Memory - PostToolUse Hook (Write|Edit)
# 1) Sends file change to memory API
# 2) Sends per-edit data to code-intel API (session/edit)
# 3) If .env or .md file AND ~/.itachi-key exists, encrypts + pushes to sync API

# ============ Diagnostic Logging ============
DIAG_LOG="$HOME/.itachi-hook-diag.log"
diag() { echo "$(date '+%Y-%m-%d %H:%M:%S') [after-edit] $1" >> "$DIAG_LOG"; }

BASE_API="${ITACHI_API_URL:-https://itachisbrainserver.online}"
MEMORY_API="$BASE_API/api/memory"
SYNC_API="$BASE_API/api/sync"
SESSION_API="$BASE_API/api/session"
AUTH_HEADER="Authorization: Bearer ${ITACHI_API_KEY:-}"

diag "Hook started (PID=$$)"

# ============ Project Resolution ============
# Priority: ITACHI_PROJECT_NAME > .itachi-project > git remote > basename
PROJECT_NAME=""
if [ -n "$ITACHI_PROJECT_NAME" ]; then
    PROJECT_NAME="$ITACHI_PROJECT_NAME"
fi
if [ -z "$PROJECT_NAME" ] && [ -f ".itachi-project" ]; then
    PROJECT_NAME=$(cat .itachi-project | tr -d '\n\r')
fi
if [ -z "$PROJECT_NAME" ]; then
    REMOTE_URL=$(git remote get-url origin 2>/dev/null)
    if [ -n "$REMOTE_URL" ]; then
        PROJECT_NAME=$(echo "$REMOTE_URL" | sed 's/\.git$//' | sed 's/.*[/:]//')
    fi
fi
if [ -z "$PROJECT_NAME" ]; then
    PROJECT_NAME=$(basename "$PWD")
fi

# Detect git branch
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
[ -z "$BRANCH" ] && BRANCH="main"

# Task ID from orchestrator (empty for manual sessions)
TASK_ID="${ITACHI_TASK_ID:-}"

# Session ID (generate if not set)
SESSION_ID="${ITACHI_SESSION_ID:-}"
if [ -z "$SESSION_ID" ]; then
    SESSION_ID="manual-$(date +%Y%m%d-%H%M%S)-$$"
    export ITACHI_SESSION_ID="$SESSION_ID"
fi

# Read JSON input from stdin
INPUT=$(cat)

if [ -z "$INPUT" ]; then
    diag "No stdin data, exiting"
    exit 0
fi

diag "Stdin received (${#INPUT} chars)"

# Extract file_path using node (portable, no jq needed)
FILE_PATH=$(node -e "try{const j=JSON.parse(process.argv[1]);console.log(j.tool_input&&j.tool_input.file_path||'')}catch(e){}" "$INPUT" 2>/dev/null)

# Skip if no file path
if [ -z "$FILE_PATH" ]; then
    diag "No file_path in tool_input, exiting"
    exit 0
fi

TOOL_NAME=$(node -e "try{console.log(JSON.parse(process.argv[1]).tool_name||'unknown')}catch(e){console.log('unknown')}" "$INPUT" 2>/dev/null)
diag "File: $FILE_PATH | Tool: $TOOL_NAME"

# Get just the filename
FILENAME=$(basename "$FILE_PATH")

# Auto-categorize
CATEGORY="code_change"
case "$FILENAME" in
    *.test.*|*.spec.*|test_*|test-*) CATEGORY="test" ;;
    *.md|*.rst|*.txt|README*) CATEGORY="documentation" ;;
    package.json|requirements.txt|Cargo.toml|go.mod|pom.xml|Gemfile|*.csproj) CATEGORY="dependencies" ;;
esac

SUMMARY="Updated $FILENAME"

# Build JSON body with optional task_id
TASK_FIELD=""
if [ -n "$TASK_ID" ]; then
    TASK_FIELD=",\"task_id\":\"${TASK_ID}\""
fi

# ============ Memory API (existing) ============
diag "POST ${MEMORY_API}/code-change ($CATEGORY) project=$PROJECT_NAME"
MEM_RESULT=$(curl -s -k -X POST "${MEMORY_API}/code-change" \
  -H "Content-Type: application/json" \
  -H "$AUTH_HEADER" \
  -d "{\"files\":[\"${FILENAME}\"],\"summary\":\"${SUMMARY}\",\"category\":\"${CATEGORY}\",\"project\":\"${PROJECT_NAME}\",\"branch\":\"${BRANCH}\"${TASK_FIELD}}" \
  --max-time 10 -w "\nHTTP_STATUS:%{http_code}" 2>&1)
HTTP_STATUS=$(echo "$MEM_RESULT" | grep -o 'HTTP_STATUS:[0-9]*' | cut -d: -f2)
diag "Memory API response: HTTP $HTTP_STATUS"

# ============ Code-Intel: Session Edit ============
node -e "
try {
    const input = JSON.parse(process.argv[1]);
    const https = require('https');
    const http = require('http');
    const path = require('path');

    const toolName = input.tool_name || 'unknown';
    let editType = toolName === 'Write' ? 'create' : 'modify';
    let diffContent = null;
    let linesAdded = 0;
    let linesRemoved = 0;

    if (input.tool_input) {
        const oldStr = input.tool_input.old_string || '';
        const newStr = input.tool_input.new_string || input.tool_input.content || '';

        if (newStr && !oldStr) {
            editType = 'create';
            diffContent = newStr.substring(0, 10240);
            linesAdded = newStr.split('\n').length;
        } else if (oldStr && newStr) {
            editType = 'modify';
            diffContent = ('--- old\n' + oldStr + '\n+++ new\n' + newStr).substring(0, 10240);
            linesRemoved = oldStr.split('\n').length;
            linesAdded = newStr.split('\n').length;
        }
    }

    // Detect language
    const ext = path.extname(process.argv[2]).toLowerCase();
    const langMap = {
        '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
        '.py': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java',
        '.sql': 'sql', '.sh': 'shell', '.ps1': 'powershell',
        '.css': 'css', '.html': 'html', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
        '.md': 'markdown', '.toml': 'toml'
    };

    const body = {
        session_id: process.argv[3],
        project: process.argv[4],
        file_path: process.argv[2],
        edit_type: editType,
        lines_added: linesAdded,
        lines_removed: linesRemoved,
        tool_name: toolName,
        branch: process.argv[5]
    };
    if (diffContent) body.diff_content = diffContent;
    if (langMap[ext]) body.language = langMap[ext];
    if (process.argv[6]) body.task_id = process.argv[6];

    const jsonBody = JSON.stringify(body);
    const url = new URL(process.argv[7] + '/edit');
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(jsonBody), 'Authorization': 'Bearer ' + (process.env.ITACHI_API_KEY || '') },
        timeout: 10000, rejectUnauthorized: false
    }, (res) => { res.resume(); });
    req.on('error', () => {});
    req.write(jsonBody);
    req.end();
} catch(e) {}
" "$INPUT" "$FILE_PATH" "$SESSION_ID" "$PROJECT_NAME" "$BRANCH" "$TASK_ID" "$SESSION_API" 2>/dev/null &

# ============ Encrypted File Sync ============
ITACHI_KEY_FILE="$HOME/.itachi-key"

if [ -f "$ITACHI_KEY_FILE" ] && [ -f "$FILE_PATH" ]; then
    SYNC_REPO=""
    SYNC_FILE_PATH=""

    case "$FILENAME" in
        .env|.env.*|*.md)
            SYNC_REPO="$PROJECT_NAME"
            SYNC_FILE_PATH="$FILENAME"
            ;;
    esac

    if [ -z "$SYNC_REPO" ]; then
        case "$FILE_PATH" in
            "$PWD/.claude/skills/"*)
                SYNC_REPO="$PROJECT_NAME"
                SYNC_FILE_PATH="${FILE_PATH#$PWD/}"
                ;;
            "$HOME/.claude/skills/"*)
                SYNC_REPO="_global"
                SYNC_FILE_PATH="skills/${FILE_PATH#$HOME/.claude/skills/}"
                ;;
            "$HOME/.claude/commands/"*)
                SYNC_REPO="_global"
                SYNC_FILE_PATH="commands/${FILE_PATH#$HOME/.claude/commands/}"
                ;;
        esac
    fi

    if [ -n "$SYNC_REPO" ]; then
        MACHINE_KEYS="ITACHI_ORCHESTRATOR_ID|ITACHI_WORKSPACE_DIR|ITACHI_PROJECT_PATHS"

        node -e "
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const http = require('http');

const filePath = process.argv[1];
const repoName = process.argv[2];
const keyFile = process.argv[3];
const syncApi = process.argv[4];
const machineKeys = process.argv[5];
const syncFilePath = process.argv[6];

try {
    const passphrase = fs.readFileSync(keyFile, 'utf8').trim();
    let content = fs.readFileSync(filePath, 'utf8');
    const fileName = require('path').basename(filePath);

    if (fileName === '.env' || fileName.startsWith('.env.')) {
        const re = new RegExp('^(' + machineKeys + ')=.*$', 'gm');
        content = content.replace(re, '').replace(/\n{3,}/g, '\n\n').trim() + '\n';
    }

    const contentHash = crypto.createHash('sha256').update(content).digest('hex');

    const salt = crypto.randomBytes(16);
    const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()]);
    const packed = Buffer.concat([iv, cipher.getAuthTag(), ct]);

    const body = JSON.stringify({
        repo_name: repoName,
        file_path: syncFilePath,
        encrypted_data: packed.toString('base64'),
        salt: salt.toString('base64'),
        content_hash: contentHash,
        updated_by: require('os').hostname()
    });

    const url = new URL(syncApi + '/push');
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Authorization': 'Bearer ' + (process.env.ITACHI_API_KEY || '') },
        timeout: 10000,
        rejectUnauthorized: false
    }, (res) => { res.resume(); });
    req.on('error', () => {});
    req.write(body);
    req.end();
} catch(e) {}
" "$FILE_PATH" "$SYNC_REPO" "$ITACHI_KEY_FILE" "$SYNC_API" "$MACHINE_KEYS" "$SYNC_FILE_PATH" 2>/dev/null &
    fi

    # ============ Settings.json Hook Sync (Push) ============
    SETTINGS_FILE="$HOME/.claude/settings.json"
    if [ "$FILE_PATH" = "$SETTINGS_FILE" ]; then
        node -e "
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const os = require('os');

const keyFile = process.argv[1];
const syncApi = process.argv[2];
const settingsFile = process.argv[3];

try {
    const passphrase = fs.readFileSync(keyFile, 'utf8').trim();
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    if (!settings.hooks) process.exit(0);

    const itachiMarkers = ['session-start', 'after-edit', 'session-end', 'user-prompt-submit'];
    const isItachiHook = (cmd) => itachiMarkers.some(m => cmd && cmd.toLowerCase().includes(m));

    const hooksDir = path.join(os.homedir(), '.claude', 'hooks');

    const template = { version: 1, hooks: {} };
    for (const [event, entries] of Object.entries(settings.hooks)) {
        const itachiEntries = [];
        for (const entry of entries) {
            if (entry.hooks && entry.hooks.some(h => isItachiHook(h.command))) {
                const newEntry = JSON.parse(JSON.stringify(entry));
                for (const h of newEntry.hooks) {
                    if (h.command && isItachiHook(h.command)) {
                        const unixCmd = h.command.replace(new RegExp(hooksDir.replace(/\\//g, '\\\\/'), 'g'), '__HOOKS_DIR__');
                        const winEquiv = unixCmd
                            .replace(/^bash\\s+/, 'powershell.exe -ExecutionPolicy Bypass -NoProfile -File \"')
                            .replace(/\\.sh$/, '.ps1\"')
                            .replace(/__HOOKS_DIR__\\//g, '__HOOKS_DIR__\\\\\\\\');
                        h.command_template = {
                            unix: unixCmd,
                            windows: winEquiv
                        };
                        delete h.command;
                    }
                }
                itachiEntries.push(newEntry);
            }
        }
        if (itachiEntries.length > 0) template.hooks[event] = itachiEntries;
    }

    if (Object.keys(template.hooks).length === 0) process.exit(0);

    const content = JSON.stringify(template, null, 2);
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');
    const salt = crypto.randomBytes(16);
    const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()]);
    const packed = Buffer.concat([iv, cipher.getAuthTag(), ct]);

    const body = JSON.stringify({
        repo_name: '_global',
        file_path: 'settings-hooks.json',
        encrypted_data: packed.toString('base64'),
        salt: salt.toString('base64'),
        content_hash: contentHash,
        updated_by: os.hostname()
    });

    const url = new URL(syncApi + '/push');
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Authorization': 'Bearer ' + (process.env.ITACHI_API_KEY || '') },
        timeout: 10000, rejectUnauthorized: false
    }, (res) => { res.resume(); });
    req.on('error', () => {});
    req.write(body);
    req.end();
} catch(e) {}
" "$ITACHI_KEY_FILE" "$SYNC_API" "$SETTINGS_FILE" 2>/dev/null &
    fi

    # ============ API Keys Sync (Push) ============
    API_KEYS_FILE="$HOME/.itachi-api-keys"
    if [ "$FILE_PATH" = "$API_KEYS_FILE" ]; then
        node -e "
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
    let content = fs.readFileSync(apiKeysFile, 'utf8');

    const machineKeys = ['ITACHI_ORCHESTRATOR_ID', 'ITACHI_WORKSPACE_DIR', 'ITACHI_PROJECT_PATHS'];
    content = content.replace(new RegExp('^(' + machineKeys.join('|') + ')=.*$', 'gm'), '').replace(/\n{3,}/g, '\n\n').trim() + '\n';

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
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Authorization': 'Bearer ' + (process.env.ITACHI_API_KEY || '') },
        timeout: 10000, rejectUnauthorized: false
    }, (res) => { res.resume(); });
    req.on('error', () => {});
    req.write(body);
    req.end();
} catch(e) {}
" "$ITACHI_KEY_FILE" "$SYNC_API" "$API_KEYS_FILE" 2>/dev/null &
    fi
fi

exit 0
