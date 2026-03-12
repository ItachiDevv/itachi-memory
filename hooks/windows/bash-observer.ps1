# Itachi Memory - PostToolUse Bash Observer (Windows)
# Lightweight local-only hook that logs Bash tool uses to observations.jsonl
# MUST complete in <100ms. No network calls. No LLM calls.

try {
    $input = $null
    if ($MyInvocation.ExpectingInput -or -not [Console]::IsInputRedirected) {
        $input = [Console]::In.ReadToEnd()
    } else {
        $input = $input | Out-String
    }
    if (-not $input) { exit 0 }

    $obsFile = Join-Path $env:USERPROFILE ".claude\observations.jsonl"
    $obsDir = Split-Path $obsFile -Parent
    if (-not (Test-Path $obsDir)) { New-Item -ItemType Directory -Path $obsDir -Force | Out-Null }

    $json = $input | ConvertFrom-Json

    $toolName = if ($json.tool_name) { $json.tool_name } else { "Bash" }
    $command = ""
    if ($json.tool_input -and $json.tool_input.command) {
        $command = $json.tool_input.command
        if ($command.Length -gt 300) { $command = $command.Substring(0, 300) }
    }
    if (-not $command) { exit 0 }

    $exitCode = $null
    if ($null -ne $json.exit_code) { $exitCode = $json.exit_code }
    elseif ($json.tool_output_metadata -and $null -ne $json.tool_output_metadata.exit_code) {
        $exitCode = $json.tool_output_metadata.exit_code
    }

    $outputPreview = ""
    if ($json.tool_output -is [string]) {
        $outputPreview = $json.tool_output
        if ($outputPreview.Length -gt 200) { $outputPreview = $outputPreview.Substring(0, 200) }
    }

    $sessionId = $env:ITACHI_SESSION_ID
    if (-not $sessionId) { $sessionId = $null }

    $entry = @{
        ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        tool = $toolName
        command = $command
        exit_code = $exitCode
        output_preview = $outputPreview
        cwd = (Get-Location).Path
        session_id = $sessionId
    } | ConvertTo-Json -Compress

    $entry | Out-File -Append -FilePath $obsFile -Encoding utf8 -NoNewline
    "`n" | Out-File -Append -FilePath $obsFile -Encoding utf8 -NoNewline

    # Rotate if over 1000 lines: keep newest 500
    if (Test-Path $obsFile) {
        $lines = Get-Content $obsFile | Where-Object { $_.Trim() }
        if ($lines.Count -gt 1000) {
            $kept = $lines | Select-Object -Last 500
            $kept | Set-Content $obsFile -Encoding utf8
        }
    }
} catch {
    # Silent fail — this hook must never block
}
exit 0
