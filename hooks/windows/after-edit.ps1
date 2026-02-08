# Itachi Memory - PostToolUse Hook (Write|Edit)
# 1) Sends file change notifications to memory API
# 2) Sends per-edit data to code-intel API (session/edit)
# 3) If .env or .md file AND ~/.itachi-key exists, encrypts + pushes to sync API
# Runs for ALL Claude sessions (manual + orchestrator). Set ITACHI_DISABLED=1 to opt out.

if ($env:ITACHI_DISABLED -eq '1') { exit 0 }

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    $BASE_API = if ($env:ITACHI_API_URL) { $env:ITACHI_API_URL } else { "https://itachisbrainserver.online" }
    $MEMORY_API = "$BASE_API/api/memory"
    $SYNC_API = "$BASE_API/api/sync"
    $SESSION_API = "$BASE_API/api/session"
    $authHeaders = @{ "Content-Type" = "application/json" }
    if ($env:ITACHI_API_KEY) { $authHeaders["Authorization"] = "Bearer $env:ITACHI_API_KEY" }

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

    # Get filename
    $fileName = Split-Path $filePath -Leaf

    # ============ Project Resolution ============
    # Priority: $env:ITACHI_PROJECT_NAME > .itachi-project file > git remote > basename
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

    # Task ID from orchestrator (null for manual sessions)
    $taskId = $env:ITACHI_TASK_ID

    # Session ID (generate if not set)
    $sessionId = $env:ITACHI_SESSION_ID
    if (-not $sessionId) {
        $sessionId = "manual-" + (Get-Date -Format "yyyyMMdd-HHmmss") + "-" + [System.Environment]::ProcessId
        $env:ITACHI_SESSION_ID = $sessionId
    }

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

    # ============ Memory API (existing) ============
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
        -Headers $authHeaders `
        -Body $body `
        -TimeoutSec 10 | Out-Null

    # ============ Code-Intel: Session Edit ============
    $toolName = if ($json.tool_name) { $json.tool_name } else { "unknown" }
    $editType = if ($toolName -eq "Write") { "create" } else { "modify" }

    # Build diff from old_string/new_string
    $diffContent = $null
    $linesAdded = 0
    $linesRemoved = 0
    if ($json.tool_input) {
        $oldStr = $json.tool_input.old_string
        $newStr = $json.tool_input.new_string

        if ($newStr -and -not $oldStr) {
            # Write tool (new file)
            $editType = "create"
            $diffContent = $newStr
            $linesAdded = ($newStr -split "`n").Count
        }
        elseif ($oldStr -and $newStr) {
            # Edit tool
            $editType = "modify"
            $diffContent = "--- old`n$oldStr`n+++ new`n$newStr"
            $linesRemoved = ($oldStr -split "`n").Count
            $linesAdded = ($newStr -split "`n").Count
        }

        # Truncate diff to 10KB
        if ($diffContent -and $diffContent.Length -gt 10240) {
            $diffContent = $diffContent.Substring(0, 10240)
        }
    }

    # Detect language from extension
    $language = $null
    $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
    $langMap = @{
        '.ts' = 'typescript'; '.tsx' = 'typescript'; '.js' = 'javascript'; '.jsx' = 'javascript'
        '.py' = 'python'; '.rs' = 'rust'; '.go' = 'go'; '.java' = 'java'
        '.sql' = 'sql'; '.sh' = 'shell'; '.ps1' = 'powershell'
        '.css' = 'css'; '.html' = 'html'; '.json' = 'json'; '.yaml' = 'yaml'; '.yml' = 'yaml'
        '.md' = 'markdown'; '.toml' = 'toml'; '.dockerfile' = 'dockerfile'
    }
    if ($langMap.ContainsKey($ext)) { $language = $langMap[$ext] }

    $editBody = @{
        session_id    = $sessionId
        project       = $project
        file_path     = $filePath
        edit_type     = $editType
        lines_added   = $linesAdded
        lines_removed = $linesRemoved
        tool_name     = $toolName
        branch        = $branchName
    }
    if ($diffContent) { $editBody.diff_content = $diffContent }
    if ($language) { $editBody.language = $language }
    if ($taskId) { $editBody.task_id = $taskId }

    $editJson = $editBody | ConvertTo-Json -Compress

    try {
        Invoke-RestMethod -Uri "$SESSION_API/edit" `
            -Method Post `
            -Headers $authHeaders `
            -Body $editJson `
            -TimeoutSec 10 | Out-Null
    } catch {}

    # ============ Encrypted File Sync ============
    $itachiKeyFile = Join-Path $env:USERPROFILE ".itachi-key"

    if ((Test-Path $itachiKeyFile) -and (Test-Path $filePath)) {
        # Determine sync repo and relative file path
        $syncRepo = $null
        $syncFilePath = $null
        $cwd = (Get-Location).Path
        $userHome = $env:USERPROFILE

        # 1. .env or .md in project root
        if ($fileName -eq '.env' -or $fileName -match '^\.env\.' -or $fileName -match '\.md$') {
            $syncRepo = $project
            $syncFilePath = $fileName
        }

        # 2. Project skills: <cwd>/.claude/skills/**
        if (-not $syncRepo) {
            $projectSkillsPrefix = Join-Path $cwd ".claude\skills\"
            $userSkillsPrefix = Join-Path $userHome ".claude\skills\"
            $userCommandsPrefix = Join-Path $userHome ".claude\commands\"
            # Normalize path separators for comparison
            $normalizedFilePath = $filePath.Replace('/', '\')

            if ($normalizedFilePath.StartsWith($projectSkillsPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                $syncRepo = $project
                $syncFilePath = $normalizedFilePath.Substring($cwd.Length + 1).Replace('\', '/')
            }
            # 3. User skills: ~/.claude/skills/**
            elseif ($normalizedFilePath.StartsWith($userSkillsPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                $syncRepo = "_global"
                $relativePart = $normalizedFilePath.Substring($userSkillsPrefix.Length).Replace('\', '/')
                $syncFilePath = "skills/$relativePart"
            }
            # 4. User commands: ~/.claude/commands/**
            elseif ($normalizedFilePath.StartsWith($userCommandsPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                $syncRepo = "_global"
                $relativePart = $normalizedFilePath.Substring($userCommandsPrefix.Length).Replace('\', '/')
                $syncFilePath = "commands/$relativePart"
            }
        }

        if ($syncRepo) {
            $machineKeys = @('ITACHI_ORCHESTRATOR_ID', 'ITACHI_WORKSPACE_DIR', 'ITACHI_PROJECT_PATHS')

            # Use node for crypto (same pattern as unix hook)
            $nodeScript = @"
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const http = require('http');

const filePath = process.argv[1];
const repoName = process.argv[2];
const keyFile = process.argv[3];
const syncApi = process.argv[4];
const machineKeysStr = process.argv[5];
const syncFilePath = process.argv[6];

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
"@
            $machineKeysJoined = $machineKeys -join ','
            Start-Process -NoNewWindow -FilePath "node" -ArgumentList @(
                "-e", $nodeScript,
                $filePath, $syncRepo, $itachiKeyFile, $SYNC_API, $machineKeysJoined, $syncFilePath
            ) -ErrorAction SilentlyContinue
        }
    }

    # ============ Settings.json Hook Sync (Push) ============
    # When settings.json is edited, extract Itachi hooks and push as template
    $settingsPath = Join-Path $env:USERPROFILE ".claude\settings.json"
    $normalizedEditPath = $filePath.Replace('/', '\')
    if ($normalizedEditPath -eq $settingsPath) {
        $settingsSyncScript = @"
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const os = require('os');

const keyFile = process.argv[1];
const syncApi = process.argv[2];
const settingsFile = process.argv[3];

try {
    const passphrase = fs.readFileSync(keyFile, 'utf8').trim();
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    if (!settings.hooks) process.exit(0);

    const itachiMarkers = ['session-start', 'after-edit', 'session-end'];
    const isItachiHook = (cmd) => itachiMarkers.some(m => cmd && cmd.toLowerCase().includes(m));

    // Build template: extract Itachi hooks and replace paths with __HOOKS_DIR__
    const hooksDir = path.join(os.homedir(), '.claude', 'hooks');
    const hooksDirWin = hooksDir.replace(/\\\\/g, '\\\\');
    const hooksDirUnix = hooksDir.replace(/\\\\/g, '/');

    const template = { version: 1, hooks: {} };
    for (const [event, entries] of Object.entries(settings.hooks)) {
        const itachiEntries = [];
        for (const entry of entries) {
            if (entry.hooks && entry.hooks.some(h => isItachiHook(h.command))) {
                const newEntry = JSON.parse(JSON.stringify(entry));
                for (const h of newEntry.hooks) {
                    if (h.command && isItachiHook(h.command)) {
                        const winCmd = h.command.replace(new RegExp(hooksDirWin.replace(/\\\\/g, '\\\\\\\\'), 'gi'), '__HOOKS_DIR__');
                        const unixEquiv = winCmd
                            .replace(/powershell\\.exe.*-File\\s+"?/i, 'bash ')
                            .replace(/\\.ps1"?/, '.sh')
                            .replace(/__HOOKS_DIR__\\\\\\\\/g, '__HOOKS_DIR__/');
                        h.command_template = {
                            windows: winCmd,
                            unix: unixEquiv.startsWith('bash') ? unixEquiv : 'bash __HOOKS_DIR__/' + winCmd.match(/([\\w-]+\\.ps1)/)?.[1]?.replace('.ps1', '.sh')
                        };
                        delete h.command;
                    }
                }
                itachiEntries.push(newEntry);
            }
        }
        if (itachiEntries.length > 0) template.hooks[event] = itachiEntries;
    }

    if (Object.keys(template.hooks).length === 0) process.exit(0);

    const content = JSON.stringify(template, null, 2);
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');
    const salt = crypto.randomBytes(16);
    const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()]);
    const packed = Buffer.concat([iv, cipher.getAuthTag(), ct]);

    const body = JSON.stringify({
        repo_name: '_global',
        file_path: 'settings-hooks.json',
        encrypted_data: packed.toString('base64'),
        salt: salt.toString('base64'),
        content_hash: contentHash,
        updated_by: os.hostname()
    });

    const url = new URL(syncApi + '/push');
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Authorization': 'Bearer ' + (process.env.ITACHI_API_KEY || '') },
        timeout: 10000, rejectUnauthorized: false
    }, (res) => { res.resume(); });
    req.on('error', () => {});
    req.write(body);
    req.end();
} catch(e) {}
"@
        Start-Process -NoNewWindow -FilePath "node" -ArgumentList @(
            "-e", $settingsSyncScript,
            $itachiKeyFile, $SYNC_API, $settingsPath
        ) -ErrorAction SilentlyContinue
    }

    # ============ API Keys Sync (Push) ============
    # When ~/.itachi-api-keys is edited, strip machine keys and push
    $apiKeysPath = Join-Path $env:USERPROFILE ".itachi-api-keys"
    if ($normalizedEditPath -eq $apiKeysPath) {
        $apiKeysSyncScript = @"
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const http = require('http');
const os = require('os');

const keyFile = process.argv[1];
const syncApi = process.argv[2];
const apiKeysFile = process.argv[3];

try {
    const passphrase = fs.readFileSync(keyFile, 'utf8').trim();
    let content = fs.readFileSync(apiKeysFile, 'utf8');

    // Strip machine-specific keys
    const machineKeys = ['ITACHI_ORCHESTRATOR_ID', 'ITACHI_WORKSPACE_DIR', 'ITACHI_PROJECT_PATHS'];
    content = content.replace(new RegExp('^(' + machineKeys.join('|') + ')=.*$', 'gm'), '').replace(/\n{3,}/g, '\n\n').trim() + '\n';

    const contentHash = crypto.createHash('sha256').update(content).digest('hex');
    const salt = crypto.randomBytes(16);
    const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()]);
    const packed = Buffer.concat([iv, cipher.getAuthTag(), ct]);

    const body = JSON.stringify({
        repo_name: '_global',
        file_path: 'api-keys',
        encrypted_data: packed.toString('base64'),
        salt: salt.toString('base64'),
        content_hash: contentHash,
        updated_by: os.hostname()
    });

    const url = new URL(syncApi + '/push');
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Authorization': 'Bearer ' + (process.env.ITACHI_API_KEY || '') },
        timeout: 10000, rejectUnauthorized: false
    }, (res) => { res.resume(); });
    req.on('error', () => {});
    req.write(body);
    req.end();
} catch(e) {}
"@
        Start-Process -NoNewWindow -FilePath "node" -ArgumentList @(
            "-e", $apiKeysSyncScript,
            $itachiKeyFile, $SYNC_API, $apiKeysPath
        ) -ErrorAction SilentlyContinue
    }
}
catch {
    # Silently ignore all errors - hooks must never block Claude Code
}

exit 0
