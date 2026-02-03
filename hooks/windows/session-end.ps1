# Itachi Memory - SessionEnd Hook
# Logs session end to memory API
# Only runs when launched via `itachi` (ITACHI_ENABLED=1)

if (-not $env:ITACHI_ENABLED) { exit 0 }

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    $MEMORY_API = "https://eliza-claude-production.up.railway.app/api/memory"
    $project = Split-Path -Leaf (Get-Location)

    # Detect git branch
    $branchName = "main"
    try { $branchName = (git rev-parse --abbrev-ref HEAD 2>$null) } catch {}
    if (-not $branchName) { $branchName = "main" }

    # Task ID from orchestrator (null for manual sessions)
    $taskId = $env:ITACHI_TASK_ID

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
        -ContentType "application/json" `
        -Body $body `
        -TimeoutSec 10 | Out-Null
}
catch {
    # Silently ignore
}

exit 0
