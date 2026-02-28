#!/bin/bash
# Itachi Memory - Gemini SessionEnd Hook
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
    SESSION_ID="gemini-manual-$(date +%Y%m%d-%H%M%S)-$$"
fi

# Exit code from wrapper (no stdin JSON for Gemini — wrapper sets env var)
EXIT_CODE="${ITACHI_GEMINI_EXIT_CODE:-0}"
if [ "$EXIT_CODE" = "0" ]; then
    REASON="completed"
else
    REASON="error"
fi

# Build JSON body with optional task_id
TASK_FIELD=""
if [ -n "$TASK_ID" ]; then
    TASK_FIELD=",\"task_id\":\"${TASK_ID}\""
fi

# ============ Memory API (existing) ============
curl -s -k -X POST "${MEMORY_API}/code-change" \
  -H "Content-Type: application/json" \
  -H "$AUTH_HEADER" \
  -d "{\"files\":[],\"summary\":\"Session ended: ${REASON}\",\"category\":\"session\",\"project\":\"${PROJECT_NAME}\",\"branch\":\"${BRANCH}\",\"metadata\":{\"outcome\":\"${REASON}\",\"exit_reason\":\"${REASON}\"}${TASK_FIELD}}" \
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
FILES_CHANGED=$(git diff --name-only HEAD 2>/dev/null | tr '\n' ',' | sed 's/,$//')

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
        // Gemini transcript path: ~/.gemini/sessions/{year}/{month}/{day}/*.jsonl
        const geminiSessionsDir = path.join(os.homedir(), '.gemini', 'sessions');
        if (!fs.existsSync(geminiSessionsDir)) return;

        // Find the most recent .jsonl file
        const now = new Date();
        const year = now.getFullYear().toString();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');

        const dirsToCheck = [
            path.join(geminiSessionsDir, year, month, day),
        ];
        const yesterday = new Date(now.getTime() - 86400000);
        dirsToCheck.push(path.join(geminiSessionsDir,
            yesterday.getFullYear().toString(),
            String(yesterday.getMonth() + 1).padStart(2, '0'),
            String(yesterday.getDate()).padStart(2, '0')
        ));

        let transcriptPath = null;
        let latestMtime = 0;

        for (const dir of dirsToCheck) {
            if (!fs.existsSync(dir)) continue;
            const files = fs.readdirSync(dir)
                .filter(f => f.endsWith('.jsonl'))
                .map(f => {
                    const fp = path.join(dir, f);
                    return { path: fp, mtime: fs.statSync(fp).mtimeMs };
                });
            for (const f of files) {
                if (f.mtime > latestMtime) {
                    latestMtime = f.mtime;
                    transcriptPath = f.path;
                }
            }
        }

        if (!transcriptPath) return;

        // Read and parse Gemini JSONL, extract model/assistant messages
        const content = fs.readFileSync(transcriptPath, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        const modelTexts = [];

        for (const line of lines) {
            try {
                const entry = JSON.parse(line);

                // Codex-compatible format: response_item with role=assistant content
                if (entry.type === 'response_item' && entry.payload) {
                    const payload = entry.payload;
                    if (payload.role === 'assistant' && payload.content) {
                        const textParts = Array.isArray(payload.content)
                            ? payload.content
                                .filter(c => c.type === 'output_text' || c.type === 'text')
                                .map(c => c.text)
                                .join(' ')
                            : (typeof payload.content === 'string' ? payload.content : '');
                        if (textParts.length > 50) {
                            modelTexts.push(textParts);
                        }
                    }
                }

                // Google AI format: role 'model' with parts array
                if (entry.role === 'model' && Array.isArray(entry.parts)) {
                    const textParts = entry.parts
                        .filter(p => p.text)
                        .map(p => p.text)
                        .join(' ');
                    if (textParts.length > 50) {
                        modelTexts.push(textParts);
                    }
                }

                // Google AI candidates array format (generateContent response)
                if (Array.isArray(entry.candidates)) {
                    for (const candidate of entry.candidates) {
                        if (candidate.content && candidate.content.role === 'model' && Array.isArray(candidate.content.parts)) {
                            const textParts = candidate.content.parts
                                .filter(p => p.text)
                                .map(p => p.text)
                                .join(' ');
                            if (textParts.length > 50) {
                                modelTexts.push(textParts);
                            }
                        }
                    }
                }

                // Also capture event_msg/agent_reasoning
                if (entry.type === 'event_msg' && entry.payload && entry.payload.agent_reasoning) {
                    const reasoning = entry.payload.agent_reasoning;
                    if (reasoning.length > 50) {
                        modelTexts.push(reasoning);
                    }
                }
            } catch {}
        }

        if (modelTexts.length === 0) return;

        const conversationText = modelTexts.join('\n---\n').substring(0, 8000);

        await httpPost(sessionApi + '/extract-insights', {
            session_id: sessionId,
            project: project,
            conversation_text: conversationText,
            files_changed: filesChanged,
            summary: summary,
            duration_ms: durationMs,
            exit_reason: exitReason
        });
    } catch(e) {}
})();
" "$SESSION_ID" "$PROJECT_NAME" "$PWD" "$SESSION_API" "" "0" "$FILES_CHANGED" "$REASON" 2>/dev/null &

exit 0
