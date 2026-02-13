# Itachi Memory - Unified SessionEnd Hook
# Works with any agent CLI: Claude, Codex, Aider, etc.
# Client-specific behavior is controlled by $env:ITACHI_CLIENT
#
# 1) Logs session end to memory API
# 2) Posts session complete to code-intel API
# 3) Extracts conversation insights from transcript (background)
#
# Exit reason source:
#   - claude  → stdin JSON (Claude pipes {reason: "..."})
#   - others  → $env:ITACHI_EXIT_CODE (set by wrapper)
#
# Transcript location:
#   - claude  → ~/.claude/projects/{encoded-cwd}/*.jsonl
#   - codex   → ~/.codex/sessions/{year}/{month}/{day}/*.jsonl
#
# Set ITACHI_DISABLED=1 to opt out.

if ($env:ITACHI_DISABLED -eq '1') { exit 0 }

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    $client = if ($env:ITACHI_CLIENT) { $env:ITACHI_CLIENT } else { "generic" }

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
        $sessionId = "$client-manual-" + (Get-Date -Format "yyyyMMdd-HHmmss") + "-" + [System.Environment]::ProcessId
    }

    # ============ Determine exit reason (client-specific) ============
    $reason = "unknown"
    if ($client -eq 'claude') {
        # Claude pipes JSON to stdin with {reason: "..."}
        $raw = [Console]::In.ReadToEnd()
        if ($raw) {
            try {
                $json = $raw | ConvertFrom-Json
                if ($json.reason) { $reason = $json.reason }
            } catch {}
        }
    } else {
        # Other clients: wrapper sets ITACHI_EXIT_CODE env var
        $exitCode = $env:ITACHI_EXIT_CODE
        if (-not $exitCode) { $exitCode = $env:ITACHI_CODEX_EXIT_CODE }
        if (-not $exitCode) { $exitCode = "0" }
        $reason = if ([int]$exitCode -eq 0) { "completed" } else { "error" }
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

    # Claude-specific: read sessions-index.json for metadata
    if ($client -eq 'claude') {
        try {
            $claudeDir = Join-Path $env:USERPROFILE ".claude"
            $sessionsIndex = Join-Path $claudeDir "sessions-index.json"
            if (Test-Path $sessionsIndex) {
                $sessionsData = Get-Content $sessionsIndex -Raw | ConvertFrom-Json
                if ($sessionsData -and $sessionsData.Count -gt 0) {
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
    }

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

const client = process.argv[1];
const sessionId = process.argv[2];
const project = process.argv[3];
const cwd = process.argv[4];
const sessionApi = process.argv[5];
const summary = process.argv[6] || '';
const durationMs = parseInt(process.argv[7]) || 0;
const filesChanged = process.argv[8] ? process.argv[8].split(',').filter(Boolean) : [];

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

function findClaudeTranscript(cwd, sessionId) {
    // Claude: ~/.claude/projects/{encoded-cwd}/*.jsonl
    function encodeCwd(p) {
        return p.replace(/:/g, '').replace(/[\\/]/g, '--').replace(/^-+|-+$/g, '');
    }
    const projectDir = path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwd));
    if (!fs.existsSync(projectDir)) return null;

    const directPath = path.join(projectDir, sessionId + '.jsonl');
    if (fs.existsSync(directPath)) return directPath;

    const files = fs.readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(projectDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    return files.length > 0 ? path.join(projectDir, files[0].name) : null;
}

function findCodexTranscript() {
    // Codex: ~/.codex/sessions/{year}/{month}/{day}/*.jsonl
    const codexDir = path.join(os.homedir(), '.codex', 'sessions');
    if (!fs.existsSync(codexDir)) return null;

    const now = new Date();
    const dirsToCheck = [];
    for (let offset = 0; offset <= 1; offset++) {
        const d = new Date(now.getTime() - offset * 86400000);
        dirsToCheck.push(path.join(codexDir,
            d.getFullYear().toString(),
            String(d.getMonth() + 1).padStart(2, '0'),
            String(d.getDate()).padStart(2, '0')
        ));
    }

    let best = null;
    let bestMtime = 0;
    for (const dir of dirsToCheck) {
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
            const fp = path.join(dir, f);
            const mt = fs.statSync(fp).mtimeMs;
            if (mt > bestMtime) { bestMtime = mt; best = fp; }
        }
    }
    return best;
}

function extractClaudeTexts(lines) {
    const texts = [];
    for (const line of lines) {
        try {
            const entry = JSON.parse(line);
            if (entry.type === 'assistant' && entry.message && entry.message.content) {
                const textParts = Array.isArray(entry.message.content)
                    ? entry.message.content.filter(c => c.type === 'text').map(c => c.text).join(' ')
                    : (typeof entry.message.content === 'string' ? entry.message.content : '');
                if (textParts.length > 50) texts.push(textParts);
            }
        } catch {}
    }
    return texts;
}

function extractCodexTexts(lines) {
    const texts = [];
    for (const line of lines) {
        try {
            const entry = JSON.parse(line);
            if (entry.type === 'response_item' && entry.payload) {
                const p = entry.payload;
                if (p.role === 'assistant' && p.content) {
                    const textParts = Array.isArray(p.content)
                        ? p.content.filter(c => c.type === 'output_text' || c.type === 'text').map(c => c.text).join(' ')
                        : (typeof p.content === 'string' ? p.content : '');
                    if (textParts.length > 50) texts.push(textParts);
                }
            }
            if (entry.type === 'event_msg' && entry.payload && entry.payload.agent_reasoning) {
                if (entry.payload.agent_reasoning.length > 50) texts.push(entry.payload.agent_reasoning);
            }
        } catch {}
    }
    return texts;
}

(async () => {
    try {
        // Find transcript based on client
        let transcriptPath = null;
        if (client === 'claude') {
            transcriptPath = findClaudeTranscript(cwd, sessionId);
        } else if (client === 'codex') {
            transcriptPath = findCodexTranscript();
        }
        // Generic clients: no transcript extraction (no known format)
        if (!transcriptPath) return;

        const content = fs.readFileSync(transcriptPath, 'utf8');
        const lines = content.split('\n').filter(Boolean);

        const assistantTexts = client === 'claude'
            ? extractClaudeTexts(lines)
            : extractCodexTexts(lines);

        if (assistantTexts.length === 0) return;

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
            $client, $sessionId, $project, $cwd, $SESSION_API,
            $summaryArg, $durationArg, $filesArg
        ) -RedirectStandardOutput "NUL" -RedirectStandardError "NUL"
    } catch {}
}
catch {
    # Silently ignore
}

exit 0
