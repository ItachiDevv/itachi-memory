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
                $project = ($remoteUrl -replace '\.git$','') -replace '.*/',''
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

    # ============ Differential Context Injection ============
    # Re-query brain API, compare hashes with session-start state.
    # Only inject changed blocks into MEMORY.md.
    try {
        $cwd = (Get-Location).Path
        $diffScript = @"
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const cwd=process.argv[1],project=process.argv[2],baseApi=process.argv[3];
const apiKey=process.env.ITACHI_API_KEY||'';
function enc(p){return p.replace(/:/g,'').replace(/[\\/]/g,'-');}
const stateDir=path.join(os.homedir(),'.claude','projects',enc(cwd));
const stateFile=path.join(stateDir,'.injection-state.json');
if(!fs.existsSync(stateFile)){process.exit(0);}
let state;try{state=JSON.parse(fs.readFileSync(stateFile,'utf8'));}catch{process.exit(0);}
if(!state.block_hashes){process.exit(0);}
const memoryApi=baseApi+'/api/memory';
const httpMod=require(memoryApi.startsWith('https')?'https':'http');
function postSearch(category,query){
    return new Promise((resolve)=>{
        const body=JSON.stringify({project,category,limit:category==='project_rule'?10:8,query});
        const u=new URL(memoryApi+'/search');
        const opts={method:'POST',hostname:u.hostname,port:u.port,path:u.pathname,rejectUnauthorized:false,timeout:4000,
            headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}};
        if(apiKey)opts.headers['Authorization']='Bearer '+apiKey;
        const req=httpMod.request(opts,(res)=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve(d));});
        req.on('error',()=>resolve(''));req.on('timeout',()=>{req.destroy();resolve('');});
        req.write(body);req.end();
    });
}
function hashBlock(raw){return crypto.createHash('sha256').update(raw||'').digest('hex');}
function parseBrain(raw){try{const d=JSON.parse(raw);const r=d.results||d.memories||[];return r.filter(m=>{const c=(m.metadata&&m.metadata.confidence!=null)?m.metadata.confidence:(m.confidence!=null?m.confidence:1);return c>=0.4;});}catch{return[];}}
function fmtMem(m){const s=m.summary||m.content||'';return s.length>150?s.substring(0,147)+'...':s;}
(async()=>{
    try{
        const[rulesRaw,lessonsRaw,guardrailsRaw,generalRaw]=await Promise.all([
            postSearch('project_rule','project rules and conventions'),
            postSearch('task_lesson','recent task lessons and outcomes'),
            postSearch('guardrail','guardrails warnings pitfalls'),
            postSearch('general','recent context and activity')
        ]);
        const newH={brain_rules:hashBlock(rulesRaw),brain_lessons:hashBlock(lessonsRaw),brain_guardrails:hashBlock(guardrailsRaw),brain_general:hashBlock(generalRaw)};
        const changed={};let any=false;
        for(const k of Object.keys(newH)){if(newH[k]!==state.block_hashes[k]){changed[k]=true;any=true;}}
        if(!any){process.exit(0);}
        const rawMap={brain_rules:rulesRaw,brain_lessons:lessonsRaw,brain_guardrails:guardrailsRaw,brain_general:generalRaw};
        const labelMap={brain_rules:'Project Rules',brain_lessons:'Recent Lessons',brain_guardrails:'Active Guardrails',brain_general:'Recent Context'};
        const lines=['## Updated Brain Context','<!-- differential injection: only changed blocks since session start -->',''];
        for(const k of Object.keys(changed)){const p=parseBrain(rawMap[k]);if(p.length>0){lines.push('### '+labelMap[k]+' (updated)');p.forEach(m=>lines.push('- '+fmtMem(m)));lines.push('');}}
        if(lines.length<=3){process.exit(0);}
        const memDir=path.join(stateDir,'memory');const memFile=path.join(memDir,'MEMORY.md');
        let existing='';if(fs.existsSync(memFile)){existing=fs.readFileSync(memFile,'utf8');}
        const heading='## Updated Brain Context';const idx=existing.indexOf(heading);const sectionBody=lines.join('\n');
        if(idx!==-1){const after=existing.substring(idx+heading.length);const nextH=after.match(/\n## /);const endIdx=nextH?idx+heading.length+nextH.index:existing.length;existing=existing.substring(0,idx)+sectionBody+existing.substring(endIdx);}
        else{const sep=existing.length>0&&!existing.endsWith('\n\n')?'\n\n':(existing.length>0&&!existing.endsWith('\n')?'\n':'');existing+=sep+sectionBody;}
        fs.writeFileSync(memFile,existing);
        state.last_injected_at=new Date().toISOString();state.block_hashes=newH;
        fs.writeFileSync(stateFile,JSON.stringify(state,null,2));
    }catch(e){process.exit(0);}
})();
"@
        node -e $diffScript $cwd $project $BASE_API 2>$null
    } catch {}

    # Query memory search API (5s timeout) - project-scoped
    $searchBody = @{
        query = $prompt.Substring(0, [Math]::Min($prompt.Length, 500))
        project = $project
        limit = 3
    } | ConvertTo-Json

    $response = Invoke-RestMethod -Uri "$MEMORY_API/search" `
        -Method Post `
        -Headers $authHeaders `
        -Body $searchBody `
        -ContentType "application/json" `
        -TimeoutSec 5

    # Query global memory search (cross-project operational knowledge)
    $globalResults = @()
    try {
        $globalSearchBody = @{
            query = $prompt.Substring(0, [Math]::Min($prompt.Length, 500))
            project = "_global"
            limit = 2
        } | ConvertTo-Json
        $globalResponse = Invoke-RestMethod -Uri "$MEMORY_API/search" `
            -Method Post `
            -Body $globalSearchBody `
            -ContentType "application/json" `
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
            $prefix = if ($idx -ge $projectResultCount) { "[GLOBAL] " } else { "" }
            # Format: [category|outcome] with AVOID prefix for failures
            $catName = if ($mem.category) { $mem.category } else { "general" }
            $outcomeName = ""
            if ($mem.metadata -and $mem.metadata.outcome) {
                $outcomeName = "|$($mem.metadata.outcome)"
            }
            $catTag = "[$catName$outcomeName] "
            $avoidPrefix = ""
            if ($mem.metadata -and $mem.metadata.outcome -eq "failure") {
                $avoidPrefix = "AVOID: "
            }
            $contextLines += "$prefix$catTag$avoidPrefix$($mem.summary)$files"
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
