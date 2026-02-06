# Itachi Memory - SessionStart Hook
# 1) Pulls + decrypts synced .env/.md files from remote
# 2) Fetches session briefing from code-intel API
# 3) Fetches recent memories for context
# Only runs when launched via `itachi` (ITACHI_ENABLED=1)

if (-not $env:ITACHI_ENABLED) { exit 0 }

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    $BASE_API = if ($env:ITACHI_API_URL) { $env:ITACHI_API_URL } else { "https://eliza-claude-production.up.railway.app" }
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
}
catch {
    # Silently ignore - don't block session start
}

exit 0
