# Itachi Memory - SessionStart Hook
# Fetches recent memories for the current project and outputs context
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
