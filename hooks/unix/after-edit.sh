#!/bin/bash
# Itachi Memory - PostToolUse Hook (Write|Edit)
# 1) Sends file change to memory API
# 2) If .env or .md file AND ~/.itachi-key exists, encrypts + pushes to sync API

MEMORY_API="https://eliza-claude-production.up.railway.app/api/memory"
SYNC_API="https://eliza-claude-production.up.railway.app/api/sync"
AUTH_HEADER="Authorization: Bearer ${ITACHI_API_KEY:-}"
PROJECT_NAME=$(basename "$PWD")

# Detect git branch
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
[ -z "$BRANCH" ] && BRANCH="main"

# Task ID from orchestrator (empty for manual sessions)
TASK_ID="${ITACHI_TASK_ID:-}"

# Read JSON input from stdin
INPUT=$(cat)

# Extract file_path using node (portable, no jq needed)
FILE_PATH=$(node -e "try{const j=JSON.parse(process.argv[1]);console.log(j.tool_input&&j.tool_input.file_path||'')}catch(e){}" "$INPUT" 2>/dev/null)

# Skip if no file path
if [ -z "$FILE_PATH" ]; then
    exit 0
fi

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

# Send to memory API
curl -s -k -X POST "${MEMORY_API}/code-change" \
  -H "Content-Type: application/json" \
  -H "$AUTH_HEADER" \
  -d "{\"files\":[\"${FILENAME}\"],\"summary\":\"${SUMMARY}\",\"category\":\"${CATEGORY}\",\"project\":\"${PROJECT_NAME}\",\"branch\":\"${BRANCH}\"${TASK_FIELD}}" \
  --max-time 10 > /dev/null 2>&1

# ============ Encrypted File Sync ============
# Push .env, .md, skills, and commands to encrypted sync storage

ITACHI_KEY_FILE="$HOME/.itachi-key"

# Only sync if passphrase exists
if [ -f "$ITACHI_KEY_FILE" ] && [ -f "$FILE_PATH" ]; then
    # Determine sync repo and relative file path
    SYNC_REPO=""
    SYNC_FILE_PATH=""

    # 1. .env or .md in project root → repo=<project>, file_path=<filename>
    case "$FILENAME" in
        .env|.env.*|*.md)
            SYNC_REPO="$PROJECT_NAME"
            SYNC_FILE_PATH="$FILENAME"
            ;;
    esac

    # 2-4. Skills and commands (check full path)
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

    // For .env files, strip machine-specific keys before hashing/encrypting
    if (fileName === '.env' || fileName.startsWith('.env.')) {
        const re = new RegExp('^(' + machineKeys + ')=.*$', 'gm');
        content = content.replace(re, '').replace(/\n{3,}/g, '\n\n').trim() + '\n';
    }

    // Content hash (SHA-256 of stripped plaintext)
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');

    // Encrypt (AES-256-GCM + PBKDF2)
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
fi

exit 0
