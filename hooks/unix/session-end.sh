#!/bin/bash
# Itachi Memory - SessionEnd Hook
# 1) Logs session end to memory API
# 2) Posts session complete to code-intel API
# 3) Extracts conversation insights from transcript (background)

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

    // Read summary from latest .jsonl transcript (sessions-index.json no longer exists in Claude Code v2)
    try {
        function encodeCwd(p) { return p.replace(/:/g, '').replace(/[\\/]/g, '--').replace(/^-+|-+$/g, ''); }
        const projectDir = path.join(os.homedir(), '.claude', 'projects', encodeCwd(process.cwd()));
        if (fs.existsSync(projectDir)) {
            const files = fs.readdirSync(projectDir)
                .filter(f => f.endsWith('.jsonl'))
                .map(f => ({ name: f, mt: fs.statSync(path.join(projectDir, f)).mtimeMs }))
                .sort((a, b) => b.mt - a.mt);
            if (files.length > 0) {
                const content = fs.readFileSync(path.join(projectDir, files[0].name), 'utf8');
                const lines = content.split('\n').filter(Boolean);
                let firstTs = null, lastTs = null;
                for (const line of lines) {
                    try {
                        const e = JSON.parse(line);
                        if (e.timestamp) { if (!firstTs) firstTs = e.timestamp; lastTs = e.timestamp; }
                        if (!body.summary && e.type === 'assistant' && e.message && e.message.content) {
                            const texts = (Array.isArray(e.message.content)
                                ? e.message.content.filter(c => c.type === 'text').map(c => c.text)
                                : [typeof e.message.content === 'string' ? e.message.content : '']
                            ).join(' ').trim();
                            if (texts.length > 20) body.summary = texts.substring(0, 200).replace(/\n/g, ' ').trim();
                        }
                    } catch {}
                }
                if (firstTs && lastTs) {
                    body.started_at = firstTs;
                    body.duration_ms = new Date(lastTs).getTime() - new Date(firstTs).getTime();
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

# ============ Extract Insights from Transcript (background) ============
# Get files changed and summary from the session complete data
FILES_CHANGED=$(git diff --name-only HEAD 2>/dev/null | tr '\n' ',' | sed 's/,$//')
SESSION_SUMMARY=""
DURATION_MS="0"

# Extract summary from latest .jsonl transcript
META=$(node -e "
const fs = require('fs');
const path = require('path');
const os = require('os');
function encodeCwd(p) { return p.replace(/:/g, '').replace(/[\\\\/]/g, '--').replace(/^-+|-+$/g, ''); }
try {
    const projectDir = path.join(os.homedir(), '.claude', 'projects', encodeCwd(process.cwd()));
    if (!fs.existsSync(projectDir)) process.exit(0);
    const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'))
        .map(f => ({ name: f, mt: fs.statSync(path.join(projectDir, f)).mtimeMs }))
        .sort((a, b) => b.mt - a.mt);
    if (files.length === 0) process.exit(0);
    const content = fs.readFileSync(path.join(projectDir, files[0].name), 'utf8');
    const lines = content.split('\n').filter(Boolean);
    let summary = '', firstTs = null, lastTs = null;
    for (const line of lines) {
        try {
            const e = JSON.parse(line);
            if (e.timestamp) { if (!firstTs) firstTs = e.timestamp; lastTs = e.timestamp; }
            if (!summary && e.type === 'assistant' && e.message && e.message.content) {
                const texts = (Array.isArray(e.message.content)
                    ? e.message.content.filter(c => c.type === 'text').map(c => c.text)
                    : [typeof e.message.content === 'string' ? e.message.content : '']
                ).join(' ').trim();
                if (texts.length > 20) summary = texts.substring(0, 200).replace(/\n/g, ' ').trim();
            }
        } catch {}
    }
    let duration = 0;
    if (firstTs && lastTs) duration = new Date(lastTs).getTime() - new Date(firstTs).getTime();
    console.log(JSON.stringify({ summary, duration }));
} catch(e) {}
" 2>/dev/null)

if [ -n "$META" ]; then
    SESSION_SUMMARY=$(node -e "try{console.log(JSON.parse(process.argv[1]).summary||'')}catch(e){}" "$META" 2>/dev/null)
    DURATION_MS=$(node -e "try{console.log(JSON.parse(process.argv[1]).duration||0)}catch(e){console.log(0)}" "$META" 2>/dev/null)
fi

node -e "
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');

const sessionId = process.argv[1];
const project = process.argv[2];
const cwd = process.argv[3];
const sessionApi = process.argv[4];
const summary = process.argv[5] || '';
const durationMs = parseInt(process.argv[6]) || 0;
const filesChanged = process.argv[7] ? process.argv[7].split(',').filter(Boolean) : [];
const exitReason = process.argv[8] || 'unknown';

function encodeCwd(p) {
    return p.replace(/:/g, '').replace(/[\\/]/g, '--').replace(/^-+|-+\$/g, '');
}

function httpPost(url, body) {
    return new Promise((resolve, reject) => {
        const jsonBody = JSON.stringify(body);
        const u = new URL(url);
        const mod = u.protocol === 'https:' ? https : http;
        const req = mod.request(u, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(jsonBody),
                'Authorization': 'Bearer ' + (process.env.ITACHI_API_KEY || '')
            },
            timeout: 30000,
            rejectUnauthorized: false
        }, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                if (res.statusCode >= 400) reject(new Error(d));
                else { try { resolve(JSON.parse(d)); } catch { resolve(d); } }
            });
        });
        req.on('error', reject);
        req.write(jsonBody);
        req.end();
    });
}

(async () => {
    try {
        const claudeDir = path.join(os.homedir(), '.claude', 'projects');
        const encodedCwd = encodeCwd(cwd);
        const projectDir = path.join(claudeDir, encodedCwd);
        if (!fs.existsSync(projectDir)) return;

        let transcriptPath = null;
        const directPath = path.join(projectDir, sessionId + '.jsonl');
        if (fs.existsSync(directPath)) {
            transcriptPath = directPath;
        } else {
            const files = fs.readdirSync(projectDir)
                .filter(f => f.endsWith('.jsonl'))
                .map(f => ({ name: f, mtime: fs.statSync(path.join(projectDir, f)).mtimeMs }))
                .sort((a, b) => b.mtime - a.mtime);
            if (files.length > 0) {
                transcriptPath = path.join(projectDir, files[0].name);
            }
        }

        if (!transcriptPath) return;

        const content = fs.readFileSync(transcriptPath, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        const conversationParts = [];

        for (const line of lines) {
            try {
                const entry = JSON.parse(line);
                if (entry.type === 'assistant' && entry.message && entry.message.content) {
                    const textParts = Array.isArray(entry.message.content)
                        ? entry.message.content.filter(c => c.type === 'text').map(c => c.text).join(' ')
                        : (typeof entry.message.content === 'string' ? entry.message.content : '');
                    if (textParts.length > 50) {
                        conversationParts.push('[ASSISTANT] ' + textParts);
                    }
                } else if (entry.type === 'human' && entry.message && entry.message.content) {
                    const textParts = Array.isArray(entry.message.content)
                        ? entry.message.content.filter(c => c.type === 'text').map(c => c.text).join(' ')
                        : (typeof entry.message.content === 'string' ? entry.message.content : '');
                    if (textParts.length > 10) {
                        conversationParts.push('[USER] ' + textParts);
                    }
                }
            } catch {}
        }

        if (conversationParts.length === 0) return;

        // Concatenate and truncate to 6000 chars (increased to capture user+assistant)
        const conversationText = conversationParts.join('\n---\n').substring(0, 6000);

        await httpPost(sessionApi + '/extract-insights', {
            session_id: sessionId,
            project: project,
            conversation_text: conversationText,
            files_changed: filesChanged,
            summary: summary,
            duration_ms: durationMs,
            exit_reason: exitReason
        });

        // Also contribute lessons directly to the task_lesson pool
        try {
            await httpPost(sessionApi + '/contribute-lessons', {
                conversation_text: conversationText,
                project: project,
                exit_reason: exitReason,
            });
        } catch(e) {}
    } catch(e) {}
})();
" "$SESSION_ID" "$PROJECT_NAME" "$PWD" "$SESSION_API" "$SESSION_SUMMARY" "$DURATION_MS" "$FILES_CHANGED" "$REASON" 2>/dev/null &

exit 0
