#!/bin/bash
# Itachi Memory - SessionStart Hook
# 1) Pulls + decrypts synced .env/.md files from remote
# 2) Fetches session briefing from code-intel API
# 3) Fetches recent memories for context

BASE_API="${ITACHI_API_URL:-https://eliza-claude-production.up.railway.app}"
MEMORY_API="$BASE_API/api/memory"
SYNC_API="$BASE_API/api/sync"
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

# ============ Encrypted File Sync (Pull) ============
ITACHI_KEY_FILE="$HOME/.itachi-key"

if [ -f "$ITACHI_KEY_FILE" ]; then
    SYNC_OUTPUT=$(node -e "
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const project = process.argv[1];
const keyFile = process.argv[2];
const syncApi = process.argv[3];
const cwd = process.argv[4];

const machineKeys = ['ITACHI_ORCHESTRATOR_ID', 'ITACHI_WORKSPACE_DIR', 'ITACHI_PROJECT_PATHS'];

function httpGet(url) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const mod = u.protocol === 'https:' ? https : http;
        mod.get(u, { rejectUnauthorized: false, timeout: 10000, headers: { 'Authorization': 'Bearer ' + (process.env.ITACHI_API_KEY || '') } }, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                if (res.statusCode >= 400) reject(new Error(d));
                else resolve(JSON.parse(d));
            });
        }).on('error', reject);
    });
}

function decrypt(encB64, saltB64, passphrase) {
    const packed = Buffer.from(encB64, 'base64');
    const salt = Buffer.from(saltB64, 'base64');
    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const ct = packed.subarray(28);
    const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ct, null, 'utf8') + decipher.final('utf8');
}

function stripMachineKeys(content) {
    return content.replace(new RegExp('^(' + machineKeys.join('|') + ')=.*$', 'gm'), '').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function mergeEnv(localContent, remoteContent) {
    const localKV = {};
    const localLines = localContent.split('\n');
    for (const line of localLines) {
        const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (m) localKV[m[1]] = m[2];
    }
    const remoteKV = {};
    for (const line of remoteContent.split('\n')) {
        const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (m) remoteKV[m[1]] = m[2];
    }
    Object.assign(localKV, remoteKV);
    for (const line of localLines) {
        const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (m && machineKeys.includes(m[1])) {
            localKV[m[1]] = m[2];
        }
    }
    return Object.entries(localKV).map(([k, v]) => k + '=' + v).join('\n') + '\n';
}

(async () => {
    try {
        const passphrase = fs.readFileSync(keyFile, 'utf8').trim();
        const list = await httpGet(syncApi + '/list/' + encodeURIComponent(project));
        if (!list.files || list.files.length === 0) return;

        const output = [];
        for (const f of list.files) {
            const localPath = path.join(cwd, f.file_path);
            let localHash = null;

            if (fs.existsSync(localPath)) {
                let localContent = fs.readFileSync(localPath, 'utf8');
                const fn = path.basename(localPath);
                if (fn === '.env' || fn.startsWith('.env.')) {
                    localContent = stripMachineKeys(localContent);
                }
                localHash = crypto.createHash('sha256').update(localContent).digest('hex');
            }

            if (localHash === f.content_hash) continue;

            const fileData = await httpGet(syncApi + '/pull/' + encodeURIComponent(project) + '/' + f.file_path);
            const remoteContent = decrypt(fileData.encrypted_data, fileData.salt, passphrase);

            const fn = path.basename(f.file_path);
            if (fn === '.env' || fn.startsWith('.env.')) {
                if (fs.existsSync(localPath)) {
                    const localContent = fs.readFileSync(localPath, 'utf8');
                    const merged = mergeEnv(localContent, remoteContent);
                    fs.writeFileSync(localPath, merged);
                } else {
                    fs.mkdirSync(path.dirname(localPath), { recursive: true });
                    fs.writeFileSync(localPath, remoteContent);
                }
            } else {
                fs.mkdirSync(path.dirname(localPath), { recursive: true });
                fs.writeFileSync(localPath, remoteContent);
            }
            output.push('[sync] Updated ' + f.file_path + ' (v' + f.version + ' by ' + f.updated_by + ')');
        }
        if (output.length > 0) console.log(output.join('\n'));
    } catch(e) {}
})();
" "$PROJECT_NAME" "$ITACHI_KEY_FILE" "$SYNC_API" "$PWD" 2>/dev/null)

    if [ -n "$SYNC_OUTPUT" ]; then
        echo "$SYNC_OUTPUT"
    fi

    # ============ Global Sync (skills + commands) ============
    GLOBAL_SYNC_OUTPUT=$(node -e "
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const repoName = '_global';
const keyFile = process.argv[1];
const syncApi = process.argv[2];
const targetDir = process.argv[3];

function httpGet(url) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const mod = u.protocol === 'https:' ? https : http;
        mod.get(u, { rejectUnauthorized: false, timeout: 10000, headers: { 'Authorization': 'Bearer ' + (process.env.ITACHI_API_KEY || '') } }, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                if (res.statusCode >= 400) reject(new Error(d));
                else resolve(JSON.parse(d));
            });
        }).on('error', reject);
    });
}

function decrypt(encB64, saltB64, passphrase) {
    const packed = Buffer.from(encB64, 'base64');
    const salt = Buffer.from(saltB64, 'base64');
    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const ct = packed.subarray(28);
    const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ct, null, 'utf8') + decipher.final('utf8');
}

(async () => {
    try {
        const passphrase = fs.readFileSync(keyFile, 'utf8').trim();
        const list = await httpGet(syncApi + '/list/' + encodeURIComponent(repoName));
        if (!list.files || list.files.length === 0) return;

        const output = [];
        for (const f of list.files) {
            const localPath = path.join(targetDir, f.file_path);
            let localHash = null;

            if (fs.existsSync(localPath)) {
                const localContent = fs.readFileSync(localPath, 'utf8');
                localHash = crypto.createHash('sha256').update(localContent).digest('hex');
            }

            if (localHash === f.content_hash) continue;

            const fileData = await httpGet(syncApi + '/pull/' + encodeURIComponent(repoName) + '/' + f.file_path);
            const remoteContent = decrypt(fileData.encrypted_data, fileData.salt, passphrase);

            fs.mkdirSync(path.dirname(localPath), { recursive: true });
            fs.writeFileSync(localPath, remoteContent);
            output.push('[sync] Updated ~/' + path.relative(require('os').homedir(), localPath) + ' (v' + f.version + ' by ' + f.updated_by + ')');
        }
        if (output.length > 0) console.log(output.join('\n'));
    } catch(e) {}
})();
" "$ITACHI_KEY_FILE" "$SYNC_API" "$HOME/.claude" 2>/dev/null)

    if [ -n "$GLOBAL_SYNC_OUTPUT" ]; then
        echo "$GLOBAL_SYNC_OUTPUT"
    fi
fi

# ============ Session Briefing (Code-Intel) ============
BRIEFING=$(curl -s -k -H "$AUTH_HEADER" "${SESSION_API}/briefing?project=${PROJECT_NAME}&branch=${BRANCH}" --max-time 10 2>/dev/null)

if [ -n "$BRIEFING" ]; then
    BRIEFING_OUTPUT=$(node -e "
try {
    const d = JSON.parse(process.argv[1]);
    const lines = [];
    lines.push('');
    lines.push('=== Session Briefing for ${PROJECT_NAME} (${BRANCH}) ===');

    if (d.recentSessions && d.recentSessions.length > 0) {
        lines.push('Recent sessions:');
        d.recentSessions.forEach(s => {
            const files = (s.filesChanged || []).join(', ');
            lines.push('  - ' + (s.summary || '(no summary)') + (files ? ' [' + files + ']' : ''));
        });
    }

    if (d.hotFiles && d.hotFiles.length > 0) {
        lines.push('Hot files (last 7d):');
        d.hotFiles.slice(0, 5).forEach(f => {
            lines.push('  - ' + f.path + ' (' + f.editCount + ' edits)');
        });
    }

    if (d.activePatterns && d.activePatterns.length > 0) {
        lines.push('Active patterns:');
        d.activePatterns.forEach(p => lines.push('  - ' + p));
    }

    if (d.activeTasks && d.activeTasks.length > 0) {
        lines.push('Active tasks:');
        d.activeTasks.forEach(t => lines.push('  - [' + t.status + '] ' + t.description));
    }

    if (d.warnings && d.warnings.length > 0) {
        d.warnings.forEach(w => lines.push('  [warn] ' + w));
    }

    lines.push('=== End Briefing ===');
    lines.push('');
    console.log(lines.join('\n'));
} catch(e) {}
" "$BRIEFING" 2>/dev/null)

    if [ -n "$BRIEFING_OUTPUT" ]; then
        echo "$BRIEFING_OUTPUT"
    fi
fi

# ============ Memory Context (fallback) ============
RECENT=$(curl -s -k -H "$AUTH_HEADER" "${MEMORY_API}/recent?project=${PROJECT_NAME}&limit=5&branch=${BRANCH}" --max-time 10 2>/dev/null)

if [ -n "$RECENT" ]; then
    OUTPUT=$(node -e "
try {
    const d = JSON.parse(process.argv[1]);
    if (d.recent && d.recent.length > 0) {
        console.log('');
        console.log('=== Recent Memory Context for ${PROJECT_NAME} (${BRANCH}) ===');
        d.recent.forEach(m => {
            const files = (m.files || []).join(', ') || 'none';
            console.log('[' + m.category + '] ' + m.summary + ' (Files: ' + files + ')');
        });
        console.log('=== End Memory Context ===');
        console.log('');
    }
} catch(e) {}
" "$RECENT" 2>/dev/null)

    if [ -n "$OUTPUT" ]; then
        echo "$OUTPUT"
    fi
fi

exit 0
