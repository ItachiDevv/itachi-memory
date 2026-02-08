#!/bin/bash
# Itachi Memory - SessionEnd Hook
# 1) Logs session end to memory API
# 2) Posts session complete to code-intel API

BASE_API="${ITACHI_API_URL:-https://itachisbrainserver.online}"
MEMORY_API="$BASE_API/api/memory"
SESSION_API="$BASE_API/api/session"
AUTH_HEADER="Authorization: Bearer ${ITACHI_API_KEY:-}"

# ============ Project Resolution ============
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

# Session ID
SESSION_ID="${ITACHI_SESSION_ID:-}"
if [ -z "$SESSION_ID" ]; then
    SESSION_ID="manual-$(date +%Y%m%d-%H%M%S)-$$"
fi

# Read JSON input from stdin
INPUT=$(cat)

# Extract reason using node (no jq dependency)
REASON=$(node -e "try{const j=JSON.parse(process.argv[1]);console.log(j.reason||'unknown')}catch(e){console.log('unknown')}" "$INPUT" 2>/dev/null)

# Build JSON body with optional task_id
TASK_FIELD=""
if [ -n "$TASK_ID" ]; then
    TASK_FIELD=",\"task_id\":\"${TASK_ID}\""
fi

# ============ Memory API (existing) ============
curl -s -k -X POST "${MEMORY_API}/code-change" \
  -H "Content-Type: application/json" \
  -H "$AUTH_HEADER" \
  -d "{\"files\":[],\"summary\":\"Session ended: ${REASON}\",\"category\":\"session\",\"project\":\"${PROJECT_NAME}\",\"branch\":\"${BRANCH}\"${TASK_FIELD}}" \
  --max-time 10 > /dev/null 2>&1

# ============ Code-Intel: Session Complete ============
node -e "
try {
    const https = require('https');
    const http = require('http');
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    const body = {
        session_id: process.argv[1],
        project: process.argv[2],
        exit_reason: process.argv[3],
        branch: process.argv[4],
        ended_at: new Date().toISOString()
    };
    if (process.argv[5]) body.task_id = process.argv[5];

    // Try to get files changed from git
    try {
        const { execSync } = require('child_process');
        const diff = execSync('git diff --name-only HEAD', { encoding: 'utf8', timeout: 5000 }).trim();
        if (diff) body.files_changed = diff.split('\n').filter(Boolean);
    } catch(e) {}

    // Try to read sessions-index.json
    try {
        const indexPath = path.join(os.homedir(), '.claude', 'sessions-index.json');
        if (fs.existsSync(indexPath)) {
            const sessions = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
            if (Array.isArray(sessions) && sessions.length > 0) {
                const latest = sessions.sort((a, b) => (b.modified || '').localeCompare(a.modified || ''))[0];
                if (latest) {
                    if (latest.summary) body.summary = latest.summary;
                    if (latest.created && latest.modified) {
                        body.started_at = latest.created;
                        body.duration_ms = new Date(latest.modified).getTime() - new Date(latest.created).getTime();
                    }
                }
            }
        }
    } catch(e) {}

    const jsonBody = JSON.stringify(body);
    const url = new URL(process.argv[6] + '/complete');
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
" "$SESSION_ID" "$PROJECT_NAME" "$REASON" "$BRANCH" "$TASK_ID" "$SESSION_API" 2>/dev/null &

exit 0
