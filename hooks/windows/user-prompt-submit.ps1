# Itachi Memory - UserPromptSubmit Hook
# Searches semantic memory for context relevant to the user's prompt.
# Outputs additionalContext JSON for discrete injection into the conversation.
# Runs for ALL Claude sessions (manual + orchestrator). Set ITACHI_DISABLED=1 to opt out.

if ($env:ITACHI_DISABLED -eq '1') { exit 0 }

# ============ Turn Tracking (for usage monitoring) ============
# Track turn count - every 5 turns, check for approaching usage limits
try {
    $turnFile = Join-Path $env:USERPROFILE ".claude\.session-turns"
    $turns = 0
    if (Test-Path $turnFile) {
        $raw = (Get-Content $turnFile -ErrorAction SilentlyContinue)
        if ($raw) { $turns = [int]$raw }
    }
    $turns++
    Set-Content $turnFile $turns -Force

    if ($turns % 5 -eq 0) {
        $repoUtils = Join-Path $env:USERPROFILE "Documents\Crypto\skills-plugins\itachi-memory\hooks\windows\handoff-utils.ps1"
        if (Test-Path $repoUtils) {
            . $repoUtils
            $transcript = Read-LatestTranscript -MaxLines 20
            $transcriptText = $transcript -join "`n"
            $rateLimitCount = ($transcriptText | Select-String 'rate_limit_event' -AllMatches).Matches.Count

            if ($rateLimitCount -ge 2) {
                $client = if ($env:ITACHI_CLIENT) { $env:ITACHI_CLIENT } else { 'claude' }
                $projectName = Split-Path (Get-Location) -Leaf
                $generateScript = Join-Path $env:USERPROFILE ".claude\hooks\generate-handoff.ps1"
                if (Test-Path $generateScript) {
                    & $generateScript -FromEngine $client -Reason 'usage_approaching' -ProjectName $projectName 2>$null
                }
                $output = @{ additionalContext = "WARNING: Approaching usage limits ($rateLimitCount rate_limit events detected). Handoff context saved. If session expires, run 'itachic' or 'itachig' to continue." } | ConvertTo-Json -Compress
                Write-Output $output
                exit 0
            }
        }
    }
} catch {
    # Non-critical - don't block the prompt
}

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

    # Query memory search API (5s timeout) - project-scoped
    $encodedQuery = [System.Uri]::EscapeDataString($prompt.Substring(0, [Math]::Min($prompt.Length, 500)))
    $encodedProject = [System.Uri]::EscapeDataString($project)
    $searchUrl = "$MEMORY_API/search?query=$encodedQuery&project=$encodedProject&limit=3"

    $response = Invoke-RestMethod -Uri $searchUrl `
        -Method Get `
        -Headers $authHeaders `
        -TimeoutSec 5

    # Query global memory search (cross-project operational knowledge)
    $globalResults = @()
    try {
        $globalSearchUrl = "$MEMORY_API/search?query=$encodedQuery&project=_global&limit=2"
        $globalResponse = Invoke-RestMethod -Uri $globalSearchUrl `
            -Method Get `
            -Headers $authHeaders `
            -TimeoutSec 3
        if ($globalResponse.results -and $globalResponse.results.Count -gt 0) {
            $globalResults = $globalResponse.results
        }
    } catch {}

    $allResults = @()
    if ($response.results -and $response.results.Count -gt 0) {
        $allResults += $response.results
    }
    $allResults += $globalResults

    # Cap at 5 total results
    if ($allResults.Count -gt 5) {
        $allResults = $allResults[0..4]
    }

    if ($allResults.Count -gt 0) {
        $contextLines = @("=== Itachi Memory Context ===")
        $projectResultCount = if ($response.results) { $response.results.Count } else { 0 }
        $idx = 0
        foreach ($mem in $allResults) {
            $files = if ($mem.files -and $mem.files.Count -gt 0) { " (" + ($mem.files -join ", ") + ")" } else { "" }
            $cat = if ($mem.category) { "[$($mem.category)] " } else { "" }
            $prefix = if ($idx -ge $projectResultCount) { "[GLOBAL] " } else { "" }
            $outcomeTag = ""
            if ($mem.metadata -and $mem.metadata.outcome) {
                $outcomeTag = "[$($mem.metadata.outcome.ToUpper())] "
            }
            $contextLines += "$prefix$cat$outcomeTag$($mem.summary)$files"
            $idx++
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
