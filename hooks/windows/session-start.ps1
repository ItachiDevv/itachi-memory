# Itachi Memory - SessionStart Hook
# Fetches recent memories for the current project and outputs context

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    $MEMORY_API = "https://eliza-claude-production.up.railway.app/api/memory"
    $project = Split-Path -Leaf (Get-Location)

    $response = Invoke-RestMethod -Uri "$MEMORY_API/recent?project=$project&limit=5" `
        -Method Get `
        -TimeoutSec 10

    if ($response.recent -and $response.recent.Count -gt 0) {
        Write-Output ""
        Write-Output "=== Recent Memory Context for $project ==="
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
