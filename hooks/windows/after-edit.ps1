# Itachi Memory - PostToolUse Hook (Write|Edit)
# 1) Sends file change notifications to memory API
# 2) If .env or .md file AND ~/.itachi-key exists, encrypts + pushes to sync API
# Must never block Claude Code - all errors silently caught

if (-not $env:ITACHI_ENABLED) { exit 0 }

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    $MEMORY_API = "https://eliza-claude-production.up.railway.app/api/memory"
    $SYNC_API = "https://eliza-claude-production.up.railway.app/api/sync"

    # Read JSON from stdin
    $raw = [Console]::In.ReadToEnd()
    if (-not $raw) { exit 0 }

    $json = $raw | ConvertFrom-Json

    # Extract file_path from tool_input
    $filePath = $null
    if ($json.tool_input -and $json.tool_input.file_path) {
        $filePath = $json.tool_input.file_path
    }
    if (-not $filePath) { exit 0 }

    # Get filename and project
    $fileName = Split-Path $filePath -Leaf
    $project = Split-Path -Leaf (Get-Location)

    # Detect git branch
    $branchName = "main"
    try { $branchName = (git rev-parse --abbrev-ref HEAD 2>$null) } catch {}
    if (-not $branchName) { $branchName = "main" }

    # Task ID from orchestrator (null for manual sessions)
    $taskId = $env:ITACHI_TASK_ID

    # Auto-categorize based on file
    $category = "code_change"
    if ($fileName -match '\.(test|spec)\.' -or $fileName -match '^test[_-]') {
        $category = "test"
    }
    elseif ($fileName -match '\.(md|rst|txt)$' -or $fileName -eq 'README' -or $fileName -match '^docs[/\\]') {
        $category = "documentation"
    }
    elseif ($fileName -match '(package\.json|requirements\.txt|Cargo\.toml|go\.mod|pom\.xml|Gemfile|\.csproj)$') {
        $category = "dependencies"
    }

    $summary = "Updated $fileName"

    $bodyObj = @{
        files    = @($fileName)
        summary  = $summary
        category = $category
        project  = $project
        branch   = $branchName
    }
    if ($taskId) { $bodyObj.task_id = $taskId }

    $body = $bodyObj | ConvertTo-Json -Compress

    Invoke-RestMethod -Uri "$MEMORY_API/code-change" `
        -Method Post `
        -ContentType "application/json" `
        -Body $body `
        -TimeoutSec 10 | Out-Null

    # ============ Encrypted File Sync ============
    $itachiKeyFile = Join-Path $env:USERPROFILE ".itachi-key"

    if ((Test-Path $itachiKeyFile) -and (Test-Path $filePath)) {
        # Check if file is .env or .md
        $shouldSync = $false
        if ($fileName -eq '.env' -or $fileName -match '^\.env\.' -or $fileName -match '\.md$') {
            $shouldSync = $true
        }

        if ($shouldSync) {
            $machineKeys = @('ITACHI_ORCHESTRATOR_ID', 'ITACHI_WORKSPACE_DIR', 'ITACHI_PROJECT_PATHS')

            # Use node for crypto (same pattern as unix hook)
            $nodeScript = @"
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const http = require('http');

const filePath = process.argv[1];
const project = process.argv[2];
const keyFile = process.argv[3];
const syncApi = process.argv[4];
const machineKeysStr = process.argv[5];

try {
    const machineKeys = machineKeysStr.split(',');
    const passphrase = fs.readFileSync(keyFile, 'utf8').trim();
    let content = fs.readFileSync(filePath, 'utf8');
    const fileName = require('path').basename(filePath);

    if (fileName === '.env' || fileName.startsWith('.env.')) {
        const re = new RegExp('^(' + machineKeys.join('|') + ')=.*$', 'gm');
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
        repo_name: project,
        file_path: fileName,
        encrypted_data: packed.toString('base64'),
        salt: salt.toString('base64'),
        content_hash: contentHash,
        updated_by: require('os').hostname()
    });

    const url = new URL(syncApi + '/push');
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 10000,
        rejectUnauthorized: false
    }, (res) => { res.resume(); });
    req.on('error', () => {});
    req.write(body);
    req.end();
} catch(e) {}
"@
            $machineKeysJoined = $machineKeys -join ','
            Start-Process -NoNewWindow -FilePath "node" -ArgumentList @(
                "-e", $nodeScript,
                $filePath, $project, $itachiKeyFile, $SYNC_API, $machineKeysJoined
            ) -ErrorAction SilentlyContinue
        }
    }
}
catch {
    # Silently ignore all errors - hooks must never block Claude Code
}

exit 0
