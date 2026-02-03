# Itachi Memory - PostToolUse Hook (Write|Edit)
# Sends file change notifications to memory API
# Must never block Claude Code - all errors silently caught
# Only runs when launched via `itachi` (ITACHI_ENABLED=1)

if (-not $env:ITACHI_ENABLED) { exit 0 }

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    $MEMORY_API = "https://eliza-claude-production.up.railway.app/api/memory"

    # Read JSON from stdin
    $raw = [Console]::In.ReadToEnd()
    if (-not $raw) { exit 0 }

    $json = $raw | ConvertFrom-Json

    # Extract file_path from tool_input
    $filePath = $null
    if ($json.tool_input -and $json.tool_input.file_path) {
        $filePath = $json.tool_input.file_path
    }
    if (-not $filePath) { exit 0 }

    # Get filename and project
    $fileName = Split-Path $filePath -Leaf
    $project = Split-Path -Leaf (Get-Location)

    # Detect git branch
    $branchName = "main"
    try { $branchName = (git rev-parse --abbrev-ref HEAD 2>$null) } catch {}
    if (-not $branchName) { $branchName = "main" }

    # Task ID from orchestrator (null for manual sessions)
    $taskId = $env:ITACHI_TASK_ID

    # Auto-categorize based on file
    $category = "code_change"
    if ($fileName -match '\.(test|spec)\.' -or $fileName -match '^test[_-]') {
        $category = "test"
    }
    elseif ($fileName -match '\.(md|rst|txt)$' -or $fileName -eq 'README' -or $fileName -match '^docs[/\\]') {
        $category = "documentation"
    }
    elseif ($fileName -match '(package\.json|requirements\.txt|Cargo\.toml|go\.mod|pom\.xml|Gemfile|\.csproj)$') {
        $category = "dependencies"
    }

    $summary = "Updated $fileName"

    $bodyObj = @{
        files    = @($fileName)
        summary  = $summary
        category = $category
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
    # Silently ignore all errors - hooks must never block Claude Code
}

exit 0
