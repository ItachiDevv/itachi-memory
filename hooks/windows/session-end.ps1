# Itachi Memory - SessionEnd Hook
# Logs session end to memory API

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    $MEMORY_API = "https://eliza-claude-production.up.railway.app/api/memory"
    $project = Split-Path -Leaf (Get-Location)

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

    $body = @{
        files    = @()
        summary  = "Session ended: $reason"
        category = "session"
        project  = $project
    } | ConvertTo-Json -Compress

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
