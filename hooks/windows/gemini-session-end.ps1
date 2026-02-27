# Itachi Memory - Gemini SessionEnd Hook
# 1) Logs session end to memory API
# 2) Posts session complete to code-intel API
# 3) Extracts conversation insights from transcript (background)
# Runs for ALL Gemini sessions (manual + orchestrator). Set ITACHI_DISABLED=1 to opt out.

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
        $sessionId = "gemini-manual-" + (Get-Date -Format "yyyyMMdd-HHmmss") + "-" + [System.Environment]::ProcessId
    }

    # Exit code from wrapper (no stdin JSON for Gemini — wrapper sets env var)
    $exitCode = $env:ITACHI_EXIT_CODE
    if (-not $exitCode) { $exitCode = "0" }
    $reason = if ([int]$exitCode -eq 0) { "completed" } else { "error" }

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

        // Find the most recent .jsonl file across all date dirs
        const now = new Date();
        const year = now.getFullYear().toString();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');

        // Check today's dir first, then scan more broadly
        const dirsToCheck = [
            path.join(geminiSessionsDir, year, month, day),
        ];
        // Also check yesterday in case session started before midnight
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

        // Read and parse Gemini JSONL, extract agent/assistant messages
        const content = fs.readFileSync(transcriptPath, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        const assistantTexts = [];

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
                            assistantTexts.push(textParts);
                        }
                    }
                }

                // Codex-compatible format: event_msg/agent_reasoning
                if (entry.type === 'event_msg' && entry.payload && entry.payload.agent_reasoning) {
                    const reasoning = entry.payload.agent_reasoning;
                    if (reasoning.length > 50) {
                        assistantTexts.push(reasoning);
                    }
                }

                // Google AI format: entries with role='model' and parts array
                if (entry.role === 'model' && Array.isArray(entry.parts)) {
                    const textParts = entry.parts
                        .filter(p => typeof p.text === 'string')
                        .map(p => p.text)
                        .join(' ');
                    if (textParts.length > 50) {
                        assistantTexts.push(textParts);
                    }
                }

                // Google AI format: candidates array with content.parts
                if (Array.isArray(entry.candidates)) {
                    for (const candidate of entry.candidates) {
                        if (candidate.content && candidate.content.role === 'model' && Array.isArray(candidate.content.parts)) {
                            const textParts = candidate.content.parts
                                .filter(p => typeof p.text === 'string')
                                .map(p => p.text)
                                .join(' ');
                            if (textParts.length > 50) {
                                assistantTexts.push(textParts);
                            }
                        }
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
            duration_ms: durationMs,
            exit_reason: exitReason
        });
    } catch(e) {}
})();
"@
        $filesArg = if ($sessionBody.files_changed) { ($sessionBody.files_changed -join ",") } else { "" }
        $summaryArg = ""
        $durationArg = "0"

        # Run in background (fire and forget)
        Start-Process -NoNewWindow -FilePath "node" -ArgumentList @(
            "-e", $insightsScript,
            $sessionId, $project, $cwd, $SESSION_API,
            $summaryArg, $durationArg, $filesArg, $reason
        ) -RedirectStandardOutput "NUL" -RedirectStandardError "NUL"
    } catch {}
}
catch {
    # Silently ignore
}

exit 0
