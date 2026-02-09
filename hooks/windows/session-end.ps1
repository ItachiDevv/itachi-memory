# Itachi Memory - SessionEnd Hook
# 1) Logs session end to memory API
# 2) Posts session complete to code-intel API
# 3) Extracts conversation insights from transcript (background)
# Runs for ALL Claude sessions (manual + orchestrator). Set ITACHI_DISABLED=1 to opt out.

if ($env:ITACHI_DISABLED -eq '1') { exit 0 }

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    $BASE_API = if ($env:ITACHI_API_URL) { $env:ITACHI_API_URL } else { "https://itachisbrainserver.online" }
    $MEMORY_API = "$BASE_API/api/memory"
    $SESSION_API = "$BASE_API/api/session"
    $authHeaders = @{ "Content-Type" = "application/json" }
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

    # Task ID from orchestrator (null for manual sessions)
    $taskId = $env:ITACHI_TASK_ID

    # Session ID
    $sessionId = $env:ITACHI_SESSION_ID
    if (-not $sessionId) {
        $sessionId = "manual-" + (Get-Date -Format "yyyyMMdd-HHmmss") + "-" + [System.Environment]::ProcessId
    }

    # Read JSON from stdin
    $raw = [Console]::In.ReadToEnd()
    $reason = "unknown"
    if ($raw) {
        try {
            $json = $raw | ConvertFrom-Json
            if ($json.reason) { $reason = $json.reason }
        }
        catch { }
    }

    # ============ Memory API (existing) ============
    $bodyObj = @{
        files    = @()
        summary  = "Session ended: $reason"
        category = "session"
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

    # ============ Code-Intel: Session Complete ============
    $sessionBody = @{
        session_id  = $sessionId
        project     = $project
        exit_reason = $reason
        branch      = $branchName
        ended_at    = (Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ")
    }
    if ($taskId) { $sessionBody.task_id = $taskId }

    # Try to get files changed from git
    try {
        $gitDiff = git diff --name-only HEAD 2>$null
        if ($gitDiff) {
            $filesChanged = ($gitDiff -split "`n" | Where-Object { $_ })
            $sessionBody.files_changed = $filesChanged
        }
    } catch {}

    # Try to read sessions-index.json for session metadata
    try {
        $claudeDir = Join-Path $env:USERPROFILE ".claude"
        $sessionsIndex = Join-Path $claudeDir "sessions-index.json"
        if (Test-Path $sessionsIndex) {
            $sessionsData = Get-Content $sessionsIndex -Raw | ConvertFrom-Json
            if ($sessionsData -and $sessionsData.Count -gt 0) {
                # Get the most recent session
                $latestSession = $sessionsData | Sort-Object -Property modified -Descending | Select-Object -First 1
                if ($latestSession) {
                    if ($latestSession.summary) {
                        $sessionBody.summary = $latestSession.summary
                    }
                    if ($latestSession.created -and $latestSession.modified) {
                        $created = [DateTimeOffset]::Parse($latestSession.created)
                        $modified = [DateTimeOffset]::Parse($latestSession.modified)
                        $sessionBody.duration_ms = [int](($modified - $created).TotalMilliseconds)
                        $sessionBody.started_at = $latestSession.created
                    }
                }
            }
        }
    } catch {}

    $sessionJson = $sessionBody | ConvertTo-Json -Compress

    try {
        Invoke-RestMethod -Uri "$SESSION_API/complete" `
            -Method Post `
            -Headers $authHeaders `
            -Body $sessionJson `
            -TimeoutSec 10 | Out-Null
    } catch {}

    # ============ Extract Insights from Transcript (background) ============
    try {
        $cwd = (Get-Location).Path
        $insightsScript = @"
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

// Compute transcript path: ~/.claude/projects/{encoded-cwd}/{session-id}.jsonl
// Encoding: replace : with empty, \ and / with --, strip trailing --
function encodeCwd(p) {
    return p.replace(/:/g, '').replace(/[\\/]/g, '--').replace(/^-+|-+$/g, '');
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

        // Find the transcript JSONL — try session ID first, then find most recent
        const projectDir = path.join(claudeDir, encodedCwd);
        if (!fs.existsSync(projectDir)) return;

        let transcriptPath = null;
        // Try direct session ID match
        const directPath = path.join(projectDir, sessionId + '.jsonl');
        if (fs.existsSync(directPath)) {
            transcriptPath = directPath;
        } else {
            // Find most recently modified .jsonl file
            const files = fs.readdirSync(projectDir)
                .filter(f => f.endsWith('.jsonl'))
                .map(f => ({ name: f, mtime: fs.statSync(path.join(projectDir, f)).mtimeMs }))
                .sort((a, b) => b.mtime - a.mtime);
            if (files.length > 0) {
                transcriptPath = path.join(projectDir, files[0].name);
            }
        }

        if (!transcriptPath) return;

        // Read and parse JSONL, extract assistant messages
        const content = fs.readFileSync(transcriptPath, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        const assistantTexts = [];

        for (const line of lines) {
            try {
                const entry = JSON.parse(line);
                if (entry.type === 'assistant' && entry.message && entry.message.content) {
                    const textParts = Array.isArray(entry.message.content)
                        ? entry.message.content.filter(c => c.type === 'text').map(c => c.text).join(' ')
                        : (typeof entry.message.content === 'string' ? entry.message.content : '');
                    if (textParts.length > 50) {
                        assistantTexts.push(textParts);
                    }
                }
            } catch {}
        }

        if (assistantTexts.length === 0) return;

        // Concatenate and truncate to 4000 chars
        const conversationText = assistantTexts.join('\n---\n').substring(0, 4000);

        await httpPost(sessionApi + '/extract-insights', {
            session_id: sessionId,
            project: project,
            conversation_text: conversationText,
            files_changed: filesChanged,
            summary: summary,
            duration_ms: durationMs
        });
    } catch(e) {}
})();
"@
        $filesArg = if ($sessionBody.files_changed) { ($sessionBody.files_changed -join ",") } else { "" }
        $summaryArg = if ($sessionBody.summary) { $sessionBody.summary } else { "" }
        $durationArg = if ($sessionBody.duration_ms) { $sessionBody.duration_ms.ToString() } else { "0" }

        # Run in background (fire and forget)
        Start-Process -NoNewWindow -FilePath "node" -ArgumentList @(
            "-e", $insightsScript,
            $sessionId, $project, $cwd, $SESSION_API,
            $summaryArg, $durationArg, $filesArg
        ) -RedirectStandardOutput "NUL" -RedirectStandardError "NUL"
    } catch {}
}
catch {
    # Silently ignore
}

exit 0
