#!/bin/bash
# Itachi Memory - SessionStart Hook
# 1) Pulls + decrypts synced .env/.md files from remote
# 2) Fetches session briefing from code-intel API
# 3) Fetches recent memories for context
# 4) Writes briefing data to auto-memory MEMORY.md for persistent context

BASE_API="${ITACHI_API_URL:-https://itachisbrainserver.online}"
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

# ============ Auto-register repo URL ============
REPO_URL=$(git remote get-url origin 2>/dev/null)
if [ -n "$REPO_URL" ] && [ -n "$PROJECT_NAME" ]; then
    curl -s -k -X POST "${BASE_API}/api/repos/register" \
      -H "Content-Type: application/json" \
      -H "$AUTH_HEADER" \
      -d "{\"name\":\"${PROJECT_NAME}\",\"repo_url\":\"${REPO_URL}\"}" \
      --max-time 5 > /dev/null 2>&1 &
fi

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

# ============ Settings Hooks Merge ============
# Pull settings-hooks.json from _global, merge Itachi hooks into local settings.json
SETTINGS_MERGE_OUTPUT=$(node -e "
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const os = require('os');

const keyFile = process.argv[1];
const syncApi = process.argv[2];
const platform = process.argv[3];

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
        const hooksDir = path.join(os.homedir(), '.claude', 'hooks');
        const settingsFile = path.join(os.homedir(), '.claude', 'settings.json');

        const fileData = await httpGet(syncApi + '/pull/_global/settings-hooks.json');
        const templateStr = decrypt(fileData.encrypted_data, fileData.salt, passphrase);
        const template = JSON.parse(templateStr);

        if (!template.hooks || Object.keys(template.hooks).length === 0) return;

        let settings = {};
        if (fs.existsSync(settingsFile)) {
            settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        }
        if (!settings.hooks) settings.hooks = {};

        const itachiMarkers = ['session-start', 'after-edit', 'session-end', 'user-prompt-submit'];
        const isItachiHook = (cmd) => itachiMarkers.some(m => cmd && cmd.toLowerCase().includes(m));

        for (const [event, templateEntries] of Object.entries(template.hooks)) {
            const existing = settings.hooks[event] || [];
            const nonItachi = existing.filter(entry => {
                if (!entry.hooks) return true;
                return !entry.hooks.some(h => isItachiHook(h.command));
            });

            const newEntries = templateEntries.map(entry => {
                const converted = JSON.parse(JSON.stringify(entry));
                for (const h of (converted.hooks || [])) {
                    if (h.command_template) {
                        const cmd = h.command_template[platform] || h.command_template.unix;
                        h.command = cmd.replace(/__HOOKS_DIR__/g, hooksDir);
                        delete h.command_template;
                    }
                }
                return converted;
            });

            settings.hooks[event] = [...nonItachi, ...newEntries];
        }

        fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
        console.log('[sync] Merged Itachi hooks into settings.json');
    } catch(e) {}
})();
" "$ITACHI_KEY_FILE" "$SYNC_API" "unix" 2>/dev/null)

if [ -n "$SETTINGS_MERGE_OUTPUT" ]; then
    echo "$SETTINGS_MERGE_OUTPUT"
fi

# ============ API Keys Merge ============
# Pull api-keys from _global, merge into ~/.itachi-api-keys
API_KEYS_MERGE_OUTPUT=$(node -e "
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const os = require('os');

const keyFile = process.argv[1];
const syncApi = process.argv[2];

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

(async () => {
    try {
        const passphrase = fs.readFileSync(keyFile, 'utf8').trim();
        const apiKeysFile = path.join(os.homedir(), '.itachi-api-keys');

        const fileData = await httpGet(syncApi + '/pull/_global/api-keys');
        const remoteContent = decrypt(fileData.encrypted_data, fileData.salt, passphrase);

        const remoteKV = {};
        for (const line of remoteContent.split('\n')) {
            const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
            if (m) remoteKV[m[1]] = m[2];
        }

        const localKV = {};
        if (fs.existsSync(apiKeysFile)) {
            const localContent = fs.readFileSync(apiKeysFile, 'utf8');
            for (const line of localContent.split('\n')) {
                const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
                if (m) localKV[m[1]] = m[2];
            }
        }

        const merged = { ...localKV, ...remoteKV };

        for (const mk of machineKeys) {
            if (localKV[mk]) merged[mk] = localKV[mk];
            else delete merged[mk];
        }

        const result = Object.entries(merged).map(([k, v]) => k + '=' + v).join('\n') + '\n';
        fs.writeFileSync(apiKeysFile, result);
        console.log('[sync] Merged API keys');
    } catch(e) {}
})();
" "$ITACHI_KEY_FILE" "$SYNC_API" 2>/dev/null)

if [ -n "$API_KEYS_MERGE_OUTPUT" ]; then
    echo "$API_KEYS_MERGE_OUTPUT"
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

# ============ Fetch Project Learnings (Rules) ============
LEARNINGS=$(curl -s -k -H "$AUTH_HEADER" "${BASE_API}/api/project/learnings?project=${PROJECT_NAME}&limit=15" --max-time 10 2>/dev/null)

# ============ Fetch Global Learnings (Cross-Project Rules) ============
GLOBAL_LEARNINGS=$(curl -s -k -H "$AUTH_HEADER" "${BASE_API}/api/project/learnings?project=_global&limit=10" --max-time 10 2>/dev/null)

# ============ Write Briefing to Auto-Memory MEMORY.md ============
if [ -n "$BRIEFING" ] || [ -n "$LEARNINGS" ] || [ -n "$GLOBAL_LEARNINGS" ]; then
    node -e "
const fs = require('fs');
const path = require('path');
const os = require('os');

const cwd = process.argv[1];
const briefingJson = process.argv[2];
const learningsJson = process.argv[3];
const globalLearningsJson = process.argv[4];
const itachiClient = process.argv[5] || '';

function encodeCwd(p) {
    return p.replace(/:/g, '').replace(/[\\/]/g, '--').replace(/^-+|-+\$/g, '');
}

try {
    const encodedCwd = encodeCwd(cwd);
    const memoryDir = path.join(os.homedir(), '.claude', 'projects', encodedCwd, 'memory');
    const memoryFile = path.join(memoryDir, 'MEMORY.md');
    const codexInstructionsFile = path.join(os.homedir(), '.codex', 'AGENTS.md');

    const briefing = briefingJson ? JSON.parse(briefingJson) : null;
    let learnings = null;
    try { learnings = learningsJson ? JSON.parse(learningsJson) : null; } catch {}
    let globalLearnings = null;
    try { globalLearnings = globalLearningsJson ? JSON.parse(globalLearningsJson) : null; } catch {}

    // Exit early if nothing to write
    if (!briefing && (!learnings || !learnings.rules || learnings.rules.length === 0) && (!globalLearnings || !globalLearnings.rules || globalLearnings.rules.length === 0)) return;

    const lines = [];
    lines.push('## Itachi Session Context');
    lines.push('<!-- auto-updated by itachi session-start hook -->');
    lines.push('');

    if (briefing) {
        if (briefing.hotFiles && briefing.hotFiles.length > 0) {
            const hotStr = briefing.hotFiles.slice(0, 5).map(f => f.path + ' (' + f.editCount + ' edits)').join(', ');
            lines.push('**Hot files**: ' + hotStr);
        }

        if (briefing.activePatterns && briefing.activePatterns.length > 0) {
            lines.push('**Active patterns**: ' + briefing.activePatterns.join(', '));
        }

        if (briefing.stylePreferences && Object.keys(briefing.stylePreferences).length > 0) {
            const styleStr = Object.entries(briefing.stylePreferences).map(([k,v]) => k + '=' + v).join(', ');
            lines.push('**Style**: ' + styleStr);
        }

        if (briefing.recentSessions && briefing.recentSessions.length > 0) {
            const decisions = briefing.recentSessions
                .filter(s => s.summary && s.summary.length > 10)
                .slice(0, 3)
                .map(s => s.summary);
            if (decisions.length > 0) {
                lines.push('**Recent decisions**: ' + decisions.join('; '));
            }
        }

        if (briefing.activeTasks && briefing.activeTasks.length > 0) {
            const tasksStr = briefing.activeTasks.map(t => '[' + t.status + '] ' + t.description).join('; ');
            lines.push('**Active tasks**: ' + tasksStr);
        }
    }

    fs.mkdirSync(memoryDir, { recursive: true });
    let existing = '';
    if (fs.existsSync(memoryFile)) {
        existing = fs.readFileSync(memoryFile, 'utf8');
    }

    // Helper: replace or append a ## section in the file content
    function upsertSection(content, sectionHeading, sectionBody) {
        const startIdx = content.indexOf(sectionHeading);
        if (startIdx !== -1) {
            const afterStart = content.substring(startIdx + sectionHeading.length);
            const nextHeadingMatch = afterStart.match(/\n## /);
            const endIdx = nextHeadingMatch
                ? startIdx + sectionHeading.length + nextHeadingMatch.index
                : content.length;
            return content.substring(0, startIdx) + sectionBody + content.substring(endIdx);
        } else {
            const separator = content.length > 0 && !content.endsWith('\n\n') ? '\n\n' : (content.length > 0 && !content.endsWith('\n') ? '\n' : '');
            return content + separator + sectionBody;
        }
    }

    // Write Itachi Session Context section (only if briefing has content)
    if (lines.length > 3) {
        lines.push('');
        const sectionContent = lines.join('\n');
        existing = upsertSection(existing, '## Itachi Session Context', sectionContent);
    }

    // Build and write Project Rules section from learnings
    if (learnings && learnings.rules && learnings.rules.length > 0) {
        const ruleLines = [];
        ruleLines.push('## Project Rules');
        ruleLines.push('<!-- auto-updated by itachi session-start hook -->');
        ruleLines.push('');
        for (const r of learnings.rules) {
            const reinforced = r.times_reinforced > 1 ? ' (reinforced ' + r.times_reinforced + 'x)' : '';
            ruleLines.push('- ' + r.rule + reinforced);
        }
        ruleLines.push('');
        existing = upsertSection(existing, '## Project Rules', ruleLines.join('\n'));
    }

    // Build and write Global Operational Rules section
    if (globalLearnings && globalLearnings.rules && globalLearnings.rules.length > 0) {
        const globalLines = [];
        globalLines.push('## Global Operational Rules');
        globalLines.push('<!-- auto-updated by itachi session-start hook -->');
        globalLines.push('');
        for (const r of globalLearnings.rules.slice(0, 10)) {
            const reinforced = r.times_reinforced > 1 ? ' (reinforced ' + r.times_reinforced + 'x)' : '';
            globalLines.push('- ' + r.rule + reinforced);
        }
        globalLines.push('');
        existing = upsertSection(existing, '## Global Operational Rules', globalLines.join('\n'));
    }

    fs.writeFileSync(memoryFile, existing);

    // Also write to Codex instructions.md (same sections, always — so both CLIs stay in sync)
    try {
        if (fs.existsSync(path.dirname(codexInstructionsFile))) {
            let codexContent = '';
            if (fs.existsSync(codexInstructionsFile)) {
                codexContent = fs.readFileSync(codexInstructionsFile, 'utf8');
            }
            if (lines.length > 3) {
                codexContent = upsertSection(codexContent, '## Itachi Session Context', lines.join('\n') + '\n');
            }
            if (learnings && learnings.rules && learnings.rules.length > 0) {
                const ruleLines2 = ['## Project Rules', '<!-- auto-updated by itachi session-start hook -->', ''];
                for (const r of learnings.rules) {
                    const reinforced = r.times_reinforced > 1 ? ' (reinforced ' + r.times_reinforced + 'x)' : '';
                    ruleLines2.push('- ' + r.rule + reinforced);
                }
                ruleLines2.push('');
                codexContent = upsertSection(codexContent, '## Project Rules', ruleLines2.join('\n'));
            }
            if (globalLearnings && globalLearnings.rules && globalLearnings.rules.length > 0) {
                const globalLines2 = ['## Global Operational Rules', '<!-- auto-updated by itachi session-start hook -->', ''];
                for (const r of globalLearnings.rules.slice(0, 10)) {
                    const reinforced = r.times_reinforced > 1 ? ' (reinforced ' + r.times_reinforced + 'x)' : '';
                    globalLines2.push('- ' + r.rule + reinforced);
                }
                globalLines2.push('');
                codexContent = upsertSection(codexContent, '## Global Operational Rules', globalLines2.join('\n'));
            }
            fs.writeFileSync(codexInstructionsFile, codexContent);
        }
    } catch(e2) {}
} catch(e) {}
" "$PWD" "$BRIEFING" "$LEARNINGS" "$GLOBAL_LEARNINGS" "${ITACHI_CLIENT:-claude}" 2>/dev/null
fi

exit 0
