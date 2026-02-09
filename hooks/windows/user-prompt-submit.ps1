# Itachi Memory - UserPromptSubmit Hook
# Searches semantic memory for context relevant to the user's prompt.
# Outputs additionalContext JSON for discrete injection into the conversation.
# Runs for ALL Claude sessions (manual + orchestrator). Set ITACHI_DISABLED=1 to opt out.

if ($env:ITACHI_DISABLED -eq '1') { exit 0 }

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    $BASE_API = if ($env:ITACHI_API_URL) { $env:ITACHI_API_URL } else { "https://itachisbrainserver.online" }
    $MEMORY_API = "$BASE_API/api/memory"
    $authHeaders = @{}
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

    # Read JSON from stdin
    $raw = [Console]::In.ReadToEnd()
    if (-not $raw) { exit 0 }

    $prompt = $null
    try {
        $json = $raw | ConvertFrom-Json
        if ($json.prompt) { $prompt = $json.prompt }
    } catch { exit 0 }

    if (-not $prompt) { exit 0 }

    # Skip trivial/short prompts
    if ($prompt.Length -lt 30) { exit 0 }

    # Query memory search API (5s timeout)
    $encodedQuery = [System.Uri]::EscapeDataString($prompt.Substring(0, [Math]::Min($prompt.Length, 500)))
    $encodedProject = [System.Uri]::EscapeDataString($project)
    $searchUrl = "$MEMORY_API/search?query=$encodedQuery&project=$encodedProject&limit=3"

    $response = Invoke-RestMethod -Uri $searchUrl `
        -Method Get `
        -Headers $authHeaders `
        -TimeoutSec 5

    if ($response.results -and $response.results.Count -gt 0) {
        $contextLines = @("=== Itachi Memory Context ===")
        foreach ($mem in $response.results) {
            $files = if ($mem.files -and $mem.files.Count -gt 0) { " (" + ($mem.files -join ", ") + ")" } else { "" }
            $cat = if ($mem.category) { "[$($mem.category)] " } else { "" }
            $contextLines += "$cat$($mem.summary)$files"
        }
        $contextLines += "=== End Memory Context ==="

        $contextText = $contextLines -join "`n"
        $output = @{ additionalContext = $contextText } | ConvertTo-Json -Compress
        Write-Output $output
    }
}
catch {
    # Silently ignore - don't block the prompt
}

exit 0
