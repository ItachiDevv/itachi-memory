# Itachi Engine Auto-Switch - Shared Utility Functions
# Sourced by generate-handoff.ps1, auto-fallback.ps1, and wrapper scripts.
# Lives in repo (hooks/windows/) and synced to all machines.

# -- Handoff directory management --------------------------------------

function Get-HandoffDir {
    $dir = Join-Path $env:USERPROFILE ".claude\handoffs"
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    return $dir
}

function Get-LatestHandoffFile {
    $dir = Get-HandoffDir
    $latest = Get-ChildItem -Path $dir -Filter "*.md" -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($latest) { return $latest.FullName }
    return $null
}

function New-HandoffFileName {
    param(
        [string]$FromEngine,
        [string]$ProjectName
    )
    $timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm"
    $slug = ($ProjectName -replace '[^a-zA-Z0-9_-]', '-').ToLower()
    return "${timestamp}_${FromEngine}_${slug}.md"
}

# -- Claude Code project directory encoding ----------------------------
# Matches Claude Code's internal encoding for ~/.claude/projects/{encoded-cwd}/

function Get-EncodedCwd {
    param([string]$Path)
    if (-not $Path) { $Path = (Get-Location).Path }
    # Claude Code encodes: remove drive letter colon, replace \ and / with --, strip leading dashes
    $encoded = $Path -replace ':', '' -replace '[\\/]', '--' -replace '^-+', ''
    return $encoded
}

# -- Transcript reading ------------------------------------------------

function Read-LatestTranscript {
    param(
        [int]$MaxLines = 100,
        [string]$Client
    )
    if (-not $Client) { $Client = $env:ITACHI_CLIENT }
    if (-not $Client) { $Client = 'claude' }

    $transcriptPath = $null

    if ($Client -eq 'claude') {
        $encoded = Get-EncodedCwd
        $projectDir = Join-Path $env:USERPROFILE ".claude\projects\$encoded"
        if (Test-Path $projectDir) {
            $latest = Get-ChildItem -Path $projectDir -Filter "*.jsonl" -File -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending |
                Select-Object -First 1
            if ($latest) { $transcriptPath = $latest.FullName }
        }
    }
    elseif ($Client -eq 'codex') {
        $codexDir = Join-Path $env:USERPROFILE ".codex\sessions"
        if (Test-Path $codexDir) {
            $now = Get-Date
            $dirs = @()
            for ($offset = 0; $offset -le 1; $offset++) {
                $d = $now.AddDays(-$offset)
                $dayDir = Join-Path $codexDir "$($d.Year)\$($d.Month.ToString('00'))\$($d.Day.ToString('00'))"
                if (Test-Path $dayDir) { $dirs += $dayDir }
            }
            $best = $null
            foreach ($dir in $dirs) {
                $files = Get-ChildItem -Path $dir -Filter "*.jsonl" -File -ErrorAction SilentlyContinue |
                    Sort-Object LastWriteTime -Descending
                if ($files -and $files.Count -gt 0) {
                    if (-not $best -or $files[0].LastWriteTime -gt $best.LastWriteTime) {
                        $best = $files[0]
                    }
                }
            }
            if ($best) { $transcriptPath = $best.FullName }
        }
    }
    # Gemini: protobuf format, not yet supported

    if (-not $transcriptPath -or -not (Test-Path $transcriptPath)) { return @() }

    # Read last N lines
    $allLines = Get-Content $transcriptPath -Tail $MaxLines -ErrorAction SilentlyContinue
    return $allLines
}

# -- Error detection (ported from orchestrator/src/session-manager.ts) --

function Test-RetriableExit {
    param(
        [int]$ExitCode = 1,
        [string]$Output = ''
    )
    if ($ExitCode -eq 0) { return $false }

    $combined = $Output.ToLower()
    $patterns = @(
        'oauth token has expired',
        'authentication_error',
        'rate_limit',
        'rate limit',
        'too many requests',
        'overloaded',
        '429',
        'insufficient_quota',
        'quota exceeded',
        'add extra usage',
        'usage limit',
        'daily limit',
        'resource exhausted',
        'billing'
    )

    foreach ($p in $patterns) {
        if ($combined.Contains($p)) { return $true }
    }
    return $false
}

function Test-IsWeeklyLimit {
    param(
        [string]$Output = ''
    )
    $lower = $Output.ToLower()
    $weeklyPatterns = @(
        'weekly limit',
        'week limit',
        '7 day',
        '7-day',
        'weekly quota',
        'weekly usage'
    )
    foreach ($p in $weeklyPatterns) {
        if ($lower.Contains($p)) { return $true }
    }
    return $false
}

# -- Engine priority (single source of truth: Supabase via API) --------

function Get-EnginePriority {
    $machineId = $env:ITACHI_MACHINE_ID
    if (-not $machineId) { $machineId = [System.Net.Dns]::GetHostName() }
    $cacheFile = Join-Path $env:USERPROFILE ".claude\.engine-priority-cache"

    # Try API first (Supabase is the source of truth)
    if ($env:ITACHI_API_URL -and $env:ITACHI_API_KEY) {
        try {
            $headers = @{ "Authorization" = "Bearer $env:ITACHI_API_KEY" }
            $uri = "$env:ITACHI_API_URL/api/machines/engine-priority?machine_id=$machineId"
            $resp = Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec 5 -ErrorAction Stop
            if ($resp.engine_priority -and $resp.engine_priority.Count -gt 0) {
                # Cache the API response locally (for offline resilience ONLY)
                $resp.engine_priority -join "`n" | Set-Content $cacheFile -Force
                return $resp.engine_priority
            }
        } catch {
            Write-Host "[itachi] API unreachable, using cached priority" -ForegroundColor Yellow
        }
    }

    # Offline fallback: cached API response (NOT a separate config source)
    if (Test-Path $cacheFile) {
        $cached = Get-Content $cacheFile | Where-Object { $_ -and $_ -notmatch '^\s*#' -and $_.Trim() }
        if ($cached -and $cached.Count -gt 0) { return $cached }
    }

    # Last resort: use orchestrator env var if available
    if ($env:ITACHI_ENGINE_PRIORITY) {
        return ($env:ITACHI_ENGINE_PRIORITY -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    }

    return @('claude', 'codex', 'gemini')
}

# -- Handoff cleanup --------------------------------------------------

function Invoke-HandoffCleanup {
    param([int]$KeepCount = 20)
    $dir = Get-HandoffDir
    $files = Get-ChildItem -Path $dir -Filter "*.md" -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending
    if ($files.Count -gt $KeepCount) {
        $files[$KeepCount..($files.Count - 1)] | Remove-Item -Force -ErrorAction SilentlyContinue
    }
}
