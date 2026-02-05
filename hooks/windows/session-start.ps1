# Itachi Memory - SessionStart Hook
# 1) Pulls + decrypts synced .env/.md files from remote
# 2) Fetches recent memories for context
# Only runs when launched via `itachi` (ITACHI_ENABLED=1)

if (-not $env:ITACHI_ENABLED) { exit 0 }

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    $MEMORY_API = "https://eliza-claude-production.up.railway.app/api/memory"
    $SYNC_API = "https://eliza-claude-production.up.railway.app/api/sync"
    $project = Split-Path -Leaf (Get-Location)

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
        mod.get(u, { rejectUnauthorized: false, timeout: 10000 }, (res) => {
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
    }

    # ============ Memory Context ============
    $response = Invoke-RestMethod -Uri "$MEMORY_API/recent?project=$project&limit=5&branch=$branchName" `
        -Method Get `
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
