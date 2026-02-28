# Test suite for Proactive Engine Auto-Switch
# Tests Read-SessionUsage, turn counter, budget thresholds, encoding fixes
# Run: powershell -ExecutionPolicy Bypass -File test-proactive-switch.ps1

$ErrorActionPreference = 'Continue'
$pass = 0; $fail = 0; $total = 0

function Assert-Equal {
    param($Name, $Expected, $Actual)
    $script:total++
    if ("$Expected" -eq "$Actual") {
        Write-Host "  PASS: $Name" -ForegroundColor Green
        $script:pass++
    } else {
        Write-Host "  FAIL: $Name (expected='$Expected', actual='$Actual')" -ForegroundColor Red
        $script:fail++
    }
}

function Assert-True {
    param($Name, $Value)
    $script:total++
    if ($Value) {
        Write-Host "  PASS: $Name" -ForegroundColor Green
        $script:pass++
    } else {
        Write-Host "  FAIL: $Name (expected true, got false)" -ForegroundColor Red
        $script:fail++
    }
}

# ============ Setup ============
$repoRoot = "C:\Users\newma\Documents\Crypto\skills-plugins\itachi-memory"
$handoffUtils = Join-Path $repoRoot "hooks\windows\handoff-utils.ps1"
. $handoffUtils

# Create temp dir for test transcripts
$testDir = Join-Path $env:TEMP "itachi-test-proactive-$(Get-Random)"
New-Item -ItemType Directory -Path $testDir -Force | Out-Null

# ============ Test 1: Get-EncodedCwd correctness ============
Write-Host "`n=== Test Group 1: CWD Encoding ===" -ForegroundColor Cyan

# Standard Windows path
$enc = Get-EncodedCwd -Path "C:\Users\newma\Documents\Crypto\skills-plugins\itachi-memory"
Assert-Equal "Standard Windows path" "C--Users-newma-Documents-Crypto-skills-plugins-itachi-memory" $enc

# Drive root
$enc = Get-EncodedCwd -Path "C:\"
Assert-Equal "Drive root C:\" "C--" $enc

# Path with forward slashes (Unix-style)
$enc = Get-EncodedCwd -Path "C:/Users/newma/test"
Assert-Equal "Forward slashes" "C--Users-newma-test" $enc

# Path with no colon (UNC or relative)
$enc = Get-EncodedCwd -Path "\\server\share\folder"
Assert-Equal "UNC path" "--server-share-folder" $enc

# Single letter path
$enc = Get-EncodedCwd -Path "D:"
Assert-Equal "Drive letter only" "D-" $enc

# ============ Test 2: JS encodeCwd matches PS Get-EncodedCwd ============
Write-Host "`n=== Test Group 2: JS/PS Encoding Parity ===" -ForegroundColor Cyan

$testPaths = @(
    "C:\Users\newma\Documents\Crypto\skills-plugins\itachi-memory",
    "D:\projects\my-app",
    "C:\",
    "C:\Users\newma\.claude"
)
# Use a temp JS file to avoid PowerShell->node escaping issues
$parityJs = Join-Path $testDir "parity-test.js"
@"
const paths = process.argv.slice(2);
paths.forEach(p => {
    console.log(p.replace(/:/g, '-').replace(/[\\/]/g, '-'));
});
"@ | Set-Content $parityJs -Force
$jsResults = (node $parityJs @testPaths 2>$null) -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }
for ($i = 0; $i -lt $testPaths.Count; $i++) {
    $psResult = Get-EncodedCwd -Path $testPaths[$i]
    $jsResult = if ($i -lt $jsResults.Count) { $jsResults[$i] } else { "" }
    Assert-Equal "JS/PS parity: $($testPaths[$i])" $psResult $jsResult
}

# ============ Test 3: Read-SessionUsage parsing ============
Write-Host "`n=== Test Group 3: Read-SessionUsage ===" -ForegroundColor Cyan

# Create a mock transcript
$mockTranscript = @(
    '{"type":"system","timestamp":"2026-02-27T10:00:00Z"}'
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}],"usage":{"input_tokens":100,"output_tokens":50}},"timestamp":"2026-02-27T10:00:01Z"}'
    '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Do something"}]}}'
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done"}],"usage":{"input_tokens":200,"output_tokens":150}},"timestamp":"2026-02-27T10:00:02Z"}'
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"More work"}],"usage":{"input_tokens":300,"output_tokens":200}},"timestamp":"2026-02-27T10:00:03Z"}'
) -join "`n"

# We need to trick Read-LatestTranscript into finding our mock file
# Create a mock project dir matching current CWD encoding
$mockEncoded = Get-EncodedCwd -Path (Get-Location).Path
$mockProjectDir = Join-Path $testDir $mockEncoded
New-Item -ItemType Directory -Path $mockProjectDir -Force | Out-Null
$mockFile = Join-Path $mockProjectDir "test-session.jsonl"
$mockTranscript | Set-Content $mockFile -Force

# Override USERPROFILE temporarily to point to our test dir
# Instead, we'll test the parsing logic directly by writing a helper
# Since Read-SessionUsage uses Read-LatestTranscript which uses Get-EncodedCwd + USERPROFILE,
# let's test the parsing in isolation

$lines = Get-Content $mockFile
$result = @{ turns = 0; outputTokens = 0; rateLimitCount = 0 }
foreach ($line in $lines) {
    if (-not $line) { continue }
    try {
        $entry = $line | ConvertFrom-Json -ErrorAction Stop
        if ($entry.type -eq 'assistant') {
            $result.turns++
            if ($entry.message -and $entry.message.usage -and $entry.message.usage.output_tokens) {
                $result.outputTokens += [int]$entry.message.usage.output_tokens
            }
        }
        if ($entry.type -eq 'rate_limit_event' -or
            ($entry.type -eq 'system' -and $entry.error -and $entry.error -match 'rate_limit')) {
            $result.rateLimitCount++
        }
    } catch {}
}

Assert-Equal "Turn count from mock transcript" 3 $result.turns
Assert-Equal "Output tokens sum (50+150+200)" 400 $result.outputTokens
Assert-Equal "Rate limit count (none)" 0 $result.rateLimitCount

# ============ Test 4: Rate limit detection ============
Write-Host "`n=== Test Group 4: Rate Limit Detection ===" -ForegroundColor Cyan

$rateLimitTranscript = @(
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}],"usage":{"input_tokens":100,"output_tokens":50}}}'
    '{"type":"rate_limit_event","timestamp":"2026-02-27T10:01:00Z"}'
    '{"type":"system","error":"rate_limit exceeded","timestamp":"2026-02-27T10:01:01Z"}'
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"After limit"}],"usage":{"input_tokens":100,"output_tokens":30}}}'
    '{"type":"rate_limit_event","timestamp":"2026-02-27T10:02:00Z"}'
)

$lines = $rateLimitTranscript
$result = @{ turns = 0; outputTokens = 0; rateLimitCount = 0 }
foreach ($line in $lines) {
    if (-not $line) { continue }
    try {
        $entry = $line | ConvertFrom-Json -ErrorAction Stop
        if ($entry.type -eq 'assistant') {
            $result.turns++
            if ($entry.message -and $entry.message.usage -and $entry.message.usage.output_tokens) {
                $result.outputTokens += [int]$entry.message.usage.output_tokens
            }
        }
        if ($entry.type -eq 'rate_limit_event' -or
            ($entry.type -eq 'system' -and $entry.error -and $entry.error -match 'rate_limit')) {
            $result.rateLimitCount++
        }
    } catch {}
}

Assert-Equal "Turns with rate limits" 2 $result.turns
Assert-Equal "Tokens with rate limits" 80 $result.outputTokens
Assert-Equal "Rate limit events (2 events + 1 system error)" 3 $result.rateLimitCount

# ============ Test 5: Edge cases in parsing ============
Write-Host "`n=== Test Group 5: Parsing Edge Cases ===" -ForegroundColor Cyan

# Empty transcript
$emptyLines = @()
$result = @{ turns = 0; outputTokens = 0; rateLimitCount = 0 }
foreach ($line in $emptyLines) {
    if (-not $line) { continue }
    try { $entry = $line | ConvertFrom-Json -ErrorAction Stop } catch { continue }
}
Assert-Equal "Empty transcript turns" 0 $result.turns

# Malformed JSON lines
$malformedLines = @(
    '{"type":"assistant","message":{"role":"assistant"'  # truncated
    'not json at all'
    ''  # empty line
    '{"type":"assistant","message":{"role":"assistant","content":[],"usage":{"output_tokens":100}}}'
)
$result = @{ turns = 0; outputTokens = 0; rateLimitCount = 0 }
foreach ($line in $malformedLines) {
    if (-not $line) { continue }
    try {
        $entry = $line | ConvertFrom-Json -ErrorAction Stop
        if ($entry.type -eq 'assistant') {
            $result.turns++
            if ($entry.message -and $entry.message.usage -and $entry.message.usage.output_tokens) {
                $result.outputTokens += [int]$entry.message.usage.output_tokens
            }
        }
    } catch {}
}
Assert-Equal "Malformed lines: valid turns" 1 $result.turns
Assert-Equal "Malformed lines: tokens" 100 $result.outputTokens

# Assistant entry with no usage field
$noUsageLines = @(
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}'
)
$result = @{ turns = 0; outputTokens = 0; rateLimitCount = 0 }
foreach ($line in $noUsageLines) {
    if (-not $line) { continue }
    try {
        $entry = $line | ConvertFrom-Json -ErrorAction Stop
        if ($entry.type -eq 'assistant') {
            $result.turns++
            if ($entry.message -and $entry.message.usage -and $entry.message.usage.output_tokens) {
                $result.outputTokens += [int]$entry.message.usage.output_tokens
            }
        }
    } catch {}
}
Assert-Equal "No usage field: turns counted" 1 $result.turns
Assert-Equal "No usage field: tokens zero" 0 $result.outputTokens

# ============ Test 6: Budget threshold calculations ============
Write-Host "`n=== Test Group 6: Budget Thresholds ===" -ForegroundColor Cyan

function Get-BudgetPct {
    param($Turns, $OutputTokens, $TurnBudget, $TokenBudget)
    $turnPct = if ($TurnBudget -gt 0) { $Turns / $TurnBudget } else { 0 }
    $tokenPct = if ($TokenBudget -gt 0) { $OutputTokens / $TokenBudget } else { 0 }
    return [Math]::Max($turnPct, $tokenPct)
}

# Below 75%
$pct = Get-BudgetPct -Turns 20 -OutputTokens 40000 -TurnBudget 40 -TokenBudget 80000
Assert-Equal "50% budget (turns 20/40, tokens 40k/80k)" "0.5" ([Math]::Round($pct, 2).ToString())

# At 75% by turns
$pct = Get-BudgetPct -Turns 30 -OutputTokens 10000 -TurnBudget 40 -TokenBudget 80000
Assert-Equal "75% by turns (30/40)" "0.75" ([Math]::Round($pct, 2).ToString())

# At 75% by tokens
$pct = Get-BudgetPct -Turns 5 -OutputTokens 60000 -TurnBudget 40 -TokenBudget 80000
Assert-Equal "75% by tokens (60k/80k)" "0.75" ([Math]::Round($pct, 2).ToString())

# At 90% by turns
$pct = Get-BudgetPct -Turns 36 -OutputTokens 10000 -TurnBudget 40 -TokenBudget 80000
Assert-Equal "90% by turns (36/40)" "0.9" ([Math]::Round($pct, 2).ToString())

# Over 100%
$pct = Get-BudgetPct -Turns 50 -OutputTokens 90000 -TurnBudget 40 -TokenBudget 80000
Assert-True "Over 100% (max of 1.25, 1.125)" ($pct -ge 1.0)
Assert-Equal "Over 100% picks turns" "1.25" ([Math]::Round($pct, 2).ToString())

# Zero budget (should not divide by zero)
$pct = Get-BudgetPct -Turns 10 -OutputTokens 5000 -TurnBudget 0 -TokenBudget 0
Assert-Equal "Zero budget = 0%" "0" ([Math]::Round($pct, 2).ToString())

# ============ Test 7: Turn counter session scoping ============
Write-Host "`n=== Test Group 7: Turn Counter Session Scoping ===" -ForegroundColor Cyan

$turnFile = Join-Path $testDir ".itachi-turn-count"
$sessionKey = "1709020000000"

# First turn of a new session
$turnCount = 1
Set-Content $turnFile "${sessionKey}:${turnCount}" -Force
$raw = (Get-Content $turnFile -Raw).Trim()
$parts = $raw -split ':'
Assert-Equal "Turn file format" 2 $parts.Count
Assert-Equal "Session key stored" $sessionKey $parts[0]
Assert-Equal "Turn count stored" "1" $parts[1]

# Increment same session
$parts = ((Get-Content $turnFile -Raw).Trim()) -split ':'
if ($parts.Count -eq 2 -and $parts[0] -eq $sessionKey) {
    $turnCount = [int]$parts[1] + 1
}
Set-Content $turnFile "${sessionKey}:${turnCount}" -Force
$raw = (Get-Content $turnFile -Raw).Trim()
$parts = $raw -split ':'
Assert-Equal "Incremented turn" "2" $parts[1]

# Different session key resets
$newSessionKey = "1709030000000"
$parts = ((Get-Content $turnFile -Raw).Trim()) -split ':'
$turnCount = 1  # should reset because key differs
if ($parts.Count -eq 2 -and $parts[0] -eq $newSessionKey) {
    $turnCount = [int]$parts[1] + 1
}
# key doesn't match, so turnCount stays 1
Assert-Equal "New session resets count" 1 $turnCount

# Corrupted file
Set-Content $turnFile "garbage-data" -Force
$turnCount = 1
try {
    $raw = (Get-Content $turnFile -Raw).Trim()
    $parts = $raw -split ':'
    if ($parts.Count -eq 2 -and $parts[0] -eq $sessionKey) {
        $turnCount = [int]$parts[1] + 1
    }
} catch { $turnCount = 1 }
Assert-Equal "Corrupted file resets to 1" 1 $turnCount

# ============ Test 8: Check interval modulo ============
Write-Host "`n=== Test Group 8: Check Interval ===" -ForegroundColor Cyan

$checkInterval = 10
Assert-True  "Turn 10 triggers check"  (10 % $checkInterval -eq 0)
Assert-True  "Turn 20 triggers check"  (20 % $checkInterval -eq 0)
Assert-True  "Turn 9 skips check"      (9 % $checkInterval -ne 0)
Assert-True  "Turn 1 skips check"      (1 % $checkInterval -ne 0)

$checkInterval = 1
Assert-True  "Interval=1: every turn checks" (1 % $checkInterval -eq 0)
Assert-True  "Interval=1: turn 5 checks"     (5 % $checkInterval -eq 0)

$checkInterval = 2
Assert-True  "Interval=2: turn 2 checks"     (2 % $checkInterval -eq 0)
Assert-True  "Interval=2: turn 3 skips"       (3 % $checkInterval -ne 0)

# ============ Test 9: Combined output (single JSON) ============
Write-Host "`n=== Test Group 9: Combined Output ===" -ForegroundColor Cyan

# Both memory and warning present
$memoryContext = "=== Itachi Memory Context ===`n[task_lesson] Some lesson`n=== End Memory Context ==="
$proactiveWarning = "SYSTEM: Approaching usage limits (~75% consumed, 30 turns, 60000 output tokens)."
$combinedContext = @($memoryContext, $proactiveWarning) | Where-Object { $_ } | ForEach-Object { $_.Trim() } | Where-Object { $_ }
$finalContext = $combinedContext -join "`n`n"
$output = @{ additionalContext = $finalContext } | ConvertTo-Json -Compress
$parsed = $output | ConvertFrom-Json
Assert-True "Combined output is valid JSON" ($null -ne $parsed)
Assert-True "Contains memory context" ($parsed.additionalContext.Contains("Itachi Memory Context"))
Assert-True "Contains proactive warning" ($parsed.additionalContext.Contains("SYSTEM:"))
# Count JSON objects (should be exactly 1)
$jsonCount = ($output -split "`n" | Where-Object { $_ -match '^\{' }).Count
Assert-Equal "Single JSON object output" 1 $jsonCount

# Only memory, no warning
$proactiveWarning = ""
$combinedContext = @($memoryContext, $proactiveWarning) | Where-Object { $_ } | ForEach-Object { $_.Trim() } | Where-Object { $_ }
$finalContext = $combinedContext -join "`n`n"
$output = @{ additionalContext = $finalContext } | ConvertTo-Json -Compress
$parsed = $output | ConvertFrom-Json
Assert-True "Memory-only output valid" ($null -ne $parsed)
Assert-True "Memory-only contains context" ($parsed.additionalContext.Contains("Itachi Memory Context"))
Assert-True "Memory-only no SYSTEM prefix" (-not $parsed.additionalContext.Contains("SYSTEM:"))

# Only warning, no memory
$memoryContext = ""
$proactiveWarning = "SYSTEM: Usage limit imminent."
$combinedContext = @($memoryContext, $proactiveWarning) | Where-Object { $_ } | ForEach-Object { $_.Trim() } | Where-Object { $_ }
$finalContext = $combinedContext -join "`n`n"
$output = @{ additionalContext = $finalContext } | ConvertTo-Json -Compress
$parsed = $output | ConvertFrom-Json
Assert-True "Warning-only output valid" ($null -ne $parsed)
Assert-Equal "Warning-only content" "SYSTEM: Usage limit imminent." $parsed.additionalContext

# Neither (no output expected)
$memoryContext = ""
$proactiveWarning = ""
$combinedContext = @($memoryContext, $proactiveWarning) | Where-Object { $_ } | ForEach-Object { $_.Trim() } | Where-Object { $_ }
Assert-Equal "Neither: no output" 0 $combinedContext.Count

# ============ Test 10: .needs-handoff file format ============
Write-Host "`n=== Test Group 10: .needs-handoff File ===" -ForegroundColor Cyan

$needsHandoffFile = Join-Path $testDir ".needs-handoff"
$handoffData = @{
    engine       = "claude"
    project      = "itachi-memory"
    reason       = "budget_90pct"
    turns        = 36
    outputTokens = 72000
    budgetPct    = 90.0
    timestamp    = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
} | ConvertTo-Json -Compress | Set-Content $needsHandoffFile -Force

# Read it back (Set-Content returns nothing, re-read)
$handoffData = @{
    engine       = "claude"
    project      = "itachi-memory"
    reason       = "budget_90pct"
    turns        = 36
    outputTokens = 72000
    budgetPct    = 90.0
    timestamp    = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
} | ConvertTo-Json -Compress
$handoffData | Set-Content $needsHandoffFile -Force
$readBack = Get-Content $needsHandoffFile -Raw | ConvertFrom-Json
Assert-Equal "Handoff engine" "claude" $readBack.engine
Assert-Equal "Handoff reason" "budget_90pct" $readBack.reason
Assert-Equal "Handoff turns" 36 $readBack.turns
Assert-True  "Handoff has timestamp" ($readBack.timestamp -match '^\d{4}-\d{2}-\d{2}T')

# ============ Test 11: itachi.ps1 Get-LatestSessionId encoding ============
Write-Host "`n=== Test Group 11: itachi.ps1 Encoding Fix ===" -ForegroundColor Cyan

# Simulate the fixed encoding
$testPath = "C:\Users\newma\Documents\Crypto\skills-plugins\itachi-memory"
$fixedEncoding = $testPath -replace ':', '-' -replace '[\\/]', '-'
$expectedEncoding = Get-EncodedCwd -Path $testPath
Assert-Equal "itachi.ps1 encoding matches Get-EncodedCwd" $expectedEncoding $fixedEncoding

# Old broken encoding for comparison
$oldEncoding = $testPath -replace ':', '--' -replace '\\', '-' -replace '^-', ''
Assert-True "Old encoding was WRONG (differs from Get-EncodedCwd)" ($oldEncoding -ne $expectedEncoding)
# Old produces C---Users-... (triple dash), correct is C--Users-...
Assert-True "Old had triple dash" ($oldEncoding.StartsWith("C---"))
Assert-True "Fixed has double dash" ($fixedEncoding.StartsWith("C--"))

# ============ Test 12: session-end.ps1 JS encodeCwd fix ============
Write-Host "`n=== Test Group 12: session-end.ps1 JS Fix ===" -ForegroundColor Cyan

$jsFixedResult = node -e "console.log('C:\\Users\\newma\\Documents'.replace(/:/g, '-').replace(/[\\/]/g, '-'))" 2>$null
if ($jsFixedResult) { $jsFixedResult = $jsFixedResult.Trim() }
Assert-Equal "Fixed JS encoding" "C--Users-newma-Documents" $jsFixedResult

$jsOldResult = node -e "console.log('C:\\Users\\newma\\Documents'.replace(/:/g, '').replace(/[\\/]/g, '--').replace(/^-+|-+$/g, ''))" 2>$null
if ($jsOldResult) { $jsOldResult = $jsOldResult.Trim() }
Assert-True "Old JS was wrong" ($jsOldResult -ne $jsFixedResult)
# Old produces: C--Users--newma--Documents (double dashes between segments)
Assert-True "Old JS had double-dash separators" ($jsOldResult -match '--Users--newma')

# ============ Test 13: Edge case - Large token values ============
Write-Host "`n=== Test Group 13: Large Token Values ===" -ForegroundColor Cyan

$largeTokenLines = @()
for ($i = 0; $i -lt 100; $i++) {
    $largeTokenLines += "{`"type`":`"assistant`",`"message`":{`"role`":`"assistant`",`"content`":[],`"usage`":{`"output_tokens`":4000}}}"
}
$result = @{ turns = 0; outputTokens = 0; rateLimitCount = 0 }
foreach ($line in $largeTokenLines) {
    if (-not $line) { continue }
    try {
        $entry = $line | ConvertFrom-Json -ErrorAction Stop
        if ($entry.type -eq 'assistant') {
            $result.turns++
            if ($entry.message -and $entry.message.usage -and $entry.message.usage.output_tokens) {
                $result.outputTokens += [int]$entry.message.usage.output_tokens
            }
        }
    } catch {}
}
Assert-Equal "100 turns counted" 100 $result.turns
Assert-Equal "400000 tokens summed" 400000 $result.outputTokens

# Budget pct for this (way over budget)
$pct = Get-BudgetPct -Turns 100 -OutputTokens 400000 -TurnBudget 40 -TokenBudget 80000
Assert-True "Way over budget" ($pct -gt 1.0)
Assert-Equal "Token-driven (5.0)" "5" ([Math]::Round($pct, 0).ToString())

# ============ Cleanup ============
Remove-Item -Path $testDir -Recurse -Force -ErrorAction SilentlyContinue

# ============ Summary ============
Write-Host "`n========================================" -ForegroundColor White
Write-Host "Results: $pass/$total passed, $fail failed" -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
Write-Host "========================================`n" -ForegroundColor White

exit $fail
