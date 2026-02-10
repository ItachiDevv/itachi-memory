# Itachi Memory - SessionStart Hook
# 1) Pulls + decrypts synced .env/.md files from remote
# 2) Fetches session briefing from code-intel API
# 3) Fetches recent memories for context
# 4) Writes briefing data to auto-memory MEMORY.md for persistent context
# Runs for ALL Claude sessions (manual + orchestrator). Set ITACHI_DISABLED=1 to opt out.

if ($env:ITACHI_DISABLED -eq '1') { exit 0 }

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    # Load ITACHI_API_URL: ~/.itachi-api-keys > env var > fallback
    $BASE_API = $null
    $apiKeysFile = Join-Path $env:USERPROFILE ".itachi-api-keys"
    if (Test-Path $apiKeysFile) {
        $match = Select-String -Path $apiKeysFile -Pattern "^ITACHI_API_URL=(.+)" | Select-Object -First 1
        if ($match) { $BASE_API = $match.Matches.Groups[1].Value.Trim() }
    }
    if (-not $BASE_API -and $env:ITACHI_API_URL) { $BASE_API = $env:ITACHI_API_URL }
    if (-not $BASE_API) { $BASE_API = "https://itachisbrainserver.online" }
    $MEMORY_API = "$BASE_API/api/memory"
    $SYNC_API = "$BASE_API/api/sync"
    $SESSION_API = "$BASE_API/api/session"
    $authHeaders = @{}
    if ($env:ITACHI_API_KEY) { $authHeaders["Authorization"] = "Bearer $env:ITACHI_API_KEY" }

    # ============ Project Resolution ============
    $project = $null
    if ($env:ITACHI_PROJECT_NAME) {
        $project = $env:ITACHI_PROJECT_NAME
    }
    if (-not $project) {
        $itachiProjectFile = Join-Path (Get-Location) ".itachi-project"
        if (Test-Path $itachiProjectFile) {
            $project = (Get-Content $itachiProjectFile -Raw).Trim()
        }
    }
    if (-not $project) {
        try {
            $remoteUrl = git remote get-url origin 2>$null
            if ($remoteUrl) {
                $project = ($remoteUrl -replace '\.git$','') -replace '.*/','.'
                $project = ($project -split '[/:]')[-1]
            }
        } catch {}
    }
    if (-not $project) {
        $project = Split-Path -Leaf (Get-Location)
    }

    # Detect git branch
    $branchName = "main"
    try { $branchName = (git rev-parse --abbrev-ref HEAD 2>$null) } catch {}
    if (-not $branchName) { $branchName = "main" }

    # ============ Auto-register repo URL ============
    $repoUrl = $null
    try { $repoUrl = git remote get-url origin 2>$null } catch {}
    if ($repoUrl -and $project) {
        try {
            $regHeaders = @{ "Content-Type" = "application/json" }
            if ($env:ITACHI_API_KEY) { $regHeaders["Authorization"] = "Bearer $env:ITACHI_API_KEY" }
            $regBody = (@{ name = $project; repo_url = $repoUrl } | ConvertTo-Json -Compress)
            Invoke-RestMethod -Uri "$BASE_API/api/repos/register" `
                -Method Post `
                -Headers $regHeaders `
                -Body $regBody `
                -TimeoutSec 5 | Out-Null
        } catch {}
    }

    # ============ Encrypted File Sync (Pull) ============
    $itachiKeyFile = Join-Path $env:USERPROFILE ".itachi-key"

    if (Test-Path $itachiKeyFile) {
        $nodeScript = @"
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
"@
        $cwd = (Get-Location).Path
        $syncOutput = node -e $nodeScript $project $itachiKeyFile $SYNC_API $cwd 2>$null

        if ($syncOutput) {
            Write-Output $syncOutput
        }

        # ============ Global Sync (skills + commands) ============
        $globalNodeScript = @"
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

            // All global files use whole-file replacement
            fs.mkdirSync(path.dirname(localPath), { recursive: true });
            fs.writeFileSync(localPath, remoteContent);
            output.push('[sync] Updated ~\\.claude\\' + f.file_path.replace(/\//g, '\\') + ' (v' + f.version + ' by ' + f.updated_by + ')');
        }
        if (output.length > 0) console.log(output.join('\n'));
    } catch(e) {}
})();
"@
        $claudeDir = Join-Path $env:USERPROFILE ".claude"
        $globalSyncOutput = node -e $globalNodeScript $itachiKeyFile $SYNC_API $claudeDir 2>$null

        if ($globalSyncOutput) {
            Write-Output $globalSyncOutput
        }
    }

    # ============ Settings Hooks Merge ============
    # Pull settings-hooks.json from _global, merge Itachi hooks into local settings.json
    try {
        $settingsMergeScript = @"
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

        // Pull settings-hooks template
        const fileData = await httpGet(syncApi + '/pull/_global/settings-hooks.json');
        const templateStr = decrypt(fileData.encrypted_data, fileData.salt, passphrase);
        const template = JSON.parse(templateStr);

        if (!template.hooks || Object.keys(template.hooks).length === 0) return;

        // Read current settings
        let settings = {};
        if (fs.existsSync(settingsFile)) {
            settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        }
        if (!settings.hooks) settings.hooks = {};

        const itachiMarkers = ['session-start', 'after-edit', 'session-end', 'user-prompt-submit'];
        const isItachiHook = (cmd) => itachiMarkers.some(m => cmd && cmd.toLowerCase().includes(m));

        // For each event type, remove existing Itachi hooks and add new ones
        for (const [event, templateEntries] of Object.entries(template.hooks)) {
            const existing = settings.hooks[event] || [];
            // Filter out old Itachi hooks
            const nonItachi = existing.filter(entry => {
                if (!entry.hooks) return true;
                return !entry.hooks.some(h => isItachiHook(h.command));
            });

            // Convert template entries to platform-specific commands
            const newEntries = templateEntries.map(entry => {
                const converted = JSON.parse(JSON.stringify(entry));
                for (const h of (converted.hooks || [])) {
                    if (h.command_template) {
                        const cmd = h.command_template[platform] || h.command_template.unix;
                        h.command = cmd.replace(/__HOOKS_DIR__/g, platform === 'windows' ? hooksDir.replace(/\\\\/g, '\\\\') : hooksDir);
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
"@
        $settingsMergeOutput = node -e $settingsMergeScript $itachiKeyFile $SYNC_API "windows" 2>$null
        if ($settingsMergeOutput) { Write-Output $settingsMergeOutput }
    } catch {}

    # ============ API Keys Merge ============
    # Pull api-keys from _global, merge into ~/.itachi-api-keys
    try {
        $apiKeysMergeScript = @"
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

        // Parse remote keys
        const remoteKV = {};
        for (const line of remoteContent.split('\n')) {
            const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
            if (m) remoteKV[m[1]] = m[2];
        }

        // Parse local keys (if file exists)
        const localKV = {};
        if (fs.existsSync(apiKeysFile)) {
            const localContent = fs.readFileSync(apiKeysFile, 'utf8');
            for (const line of localContent.split('\n')) {
                const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
                if (m) localKV[m[1]] = m[2];
            }
        }

        // Merge: remote wins for shared keys, local-only keys preserved
        const merged = { ...localKV, ...remoteKV };

        // Restore machine-specific keys from local
        for (const mk of machineKeys) {
            if (localKV[mk]) merged[mk] = localKV[mk];
            else delete merged[mk];
        }

        const result = Object.entries(merged).map(([k, v]) => k + '=' + v).join('\n') + '\n';
        fs.writeFileSync(apiKeysFile, result);
        console.log('[sync] Merged API keys');
    } catch(e) {}
})();
"@
        $apiKeysMergeOutput = node -e $apiKeysMergeScript $itachiKeyFile $SYNC_API 2>$null
        if ($apiKeysMergeOutput) { Write-Output $apiKeysMergeOutput }
    } catch {}

    # ============ Session Briefing (Code-Intel) ============
    try {
        $briefingResponse = Invoke-RestMethod -Uri "$SESSION_API/briefing?project=$project&branch=$branchName" `
            -Method Get `
            -Headers $authHeaders `
            -TimeoutSec 10

        if ($briefingResponse) {
            Write-Output ""
            Write-Output "=== Session Briefing for $project ($branchName) ==="

            if ($briefingResponse.recentSessions -and $briefingResponse.recentSessions.Count -gt 0) {
                Write-Output "Recent sessions:"
                foreach ($sess in $briefingResponse.recentSessions) {
                    $files = if ($sess.filesChanged) { ($sess.filesChanged -join ", ") } else { "" }
                    Write-Output "  - $($sess.summary)$(if($files){" [$files]"})"
                }
            }

            if ($briefingResponse.hotFiles -and $briefingResponse.hotFiles.Count -gt 0) {
                Write-Output "Hot files (last 7d):"
                foreach ($hf in $briefingResponse.hotFiles | Select-Object -First 5) {
                    Write-Output "  - $($hf.path) ($($hf.editCount) edits)"
                }
            }

            if ($briefingResponse.activePatterns -and $briefingResponse.activePatterns.Count -gt 0) {
                Write-Output "Active patterns:"
                foreach ($pat in $briefingResponse.activePatterns) {
                    Write-Output "  - $pat"
                }
            }

            if ($briefingResponse.activeTasks -and $briefingResponse.activeTasks.Count -gt 0) {
                Write-Output "Active tasks:"
                foreach ($task in $briefingResponse.activeTasks) {
                    Write-Output "  - [$($task.status)] $($task.description)"
                }
            }

            if ($briefingResponse.warnings -and $briefingResponse.warnings.Count -gt 0) {
                foreach ($warn in $briefingResponse.warnings) {
                    Write-Output "  [warn] $warn"
                }
            }

            Write-Output "=== End Briefing ==="
            Write-Output ""
        }
    } catch {}

    # ============ Memory Context (fallback) ============
    $memHeaders = @{}
    if ($env:ITACHI_API_KEY) { $memHeaders["Authorization"] = "Bearer $env:ITACHI_API_KEY" }
    $response = Invoke-RestMethod -Uri "$MEMORY_API/recent?project=$project&limit=5&branch=$branchName" `
        -Method Get `
        -Headers $memHeaders `
        -TimeoutSec 10

    if ($response.recent -and $response.recent.Count -gt 0) {
        Write-Output ""
        Write-Output "=== Recent Memory Context for $project ($branchName) ==="
        foreach ($mem in $response.recent) {
            $files = if ($mem.files) { ($mem.files -join ", ") } else { "none" }
            Write-Output "[$($mem.category)] $($mem.summary) (Files: $files)"
        }
        Write-Output "=== End Memory Context ==="
        Write-Output ""
    }

    # ============ Fetch Project Learnings (Rules) ============
    $learningsJson = $null
    try {
        $learningsResponse = Invoke-RestMethod -Uri "$BASE_API/api/project/learnings?project=$project&limit=15" `
            -Method Get `
            -Headers $authHeaders `
            -TimeoutSec 10
        if ($learningsResponse -and $learningsResponse.rules -and $learningsResponse.rules.Count -gt 0) {
            $learningsJson = ($learningsResponse | ConvertTo-Json -Compress -Depth 5)
        }
    } catch {}

    # ============ Write Briefing to Auto-Memory MEMORY.md ============
    try {
        $cwd = (Get-Location).Path
        $memoryMdScript = @"
const fs = require('fs');
const path = require('path');
const os = require('os');

const cwd = process.argv[1];
const briefingJson = process.argv[2];
const learningsJson = process.argv[3];

// Encode cwd for Claude's project directory structure
// Replace :\ or :/ with --, replace remaining \ and / with --, strip leading/trailing --
function encodeCwd(p) {
    return p.replace(/:/g, '').replace(/[\\/]/g, '--').replace(/^-+|-+$/g, '');
}

try {
    const encodedCwd = encodeCwd(cwd);
    const memoryDir = path.join(os.homedir(), '.claude', 'projects', encodedCwd, 'memory');
    const memoryFile = path.join(memoryDir, 'MEMORY.md');

    const briefing = briefingJson ? JSON.parse(briefingJson) : null;
    let learnings = null;
    try { learnings = learningsJson ? JSON.parse(learningsJson) : null; } catch {}

    // Exit early if nothing to write
    if (!briefing && (!learnings || !learnings.rules || learnings.rules.length === 0)) return;

    // Build the Itachi Session Context section
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

    // Read existing MEMORY.md or create new
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

    fs.writeFileSync(memoryFile, existing);
} catch(e) {}
"@
        $briefingJsonArg = ""
        if ($briefingResponse) {
            $briefingJsonArg = ($briefingResponse | ConvertTo-Json -Compress -Depth 5)
        }
        $learningsJsonArg = if ($learningsJson) { $learningsJson } else { "" }
        if ($briefingJsonArg -or $learningsJsonArg) {
            node -e $memoryMdScript $cwd $briefingJsonArg $learningsJsonArg 2>$null
        }
    } catch {}
}
catch {
    # Silently ignore - don't block session start
}

exit 0
