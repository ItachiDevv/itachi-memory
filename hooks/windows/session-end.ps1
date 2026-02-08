# Itachi Memory - SessionEnd Hook
# 1) Logs session end to memory API
# 2) Posts session complete to code-intel API
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
}
catch {
    # Silently ignore
}

exit 0
