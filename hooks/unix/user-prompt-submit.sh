#!/bin/bash
# Itachi Memory - UserPromptSubmit Hook
# Searches semantic memory for context relevant to the user's prompt.
# Outputs additionalContext JSON for discrete injection into the conversation.

[ "$ITACHI_DISABLED" = "1" ] && exit 0

BASE_API="${ITACHI_API_URL:-https://itachisbrainserver.online}"
MEMORY_API="$BASE_API/api/memory"
AUTH_HEADER="Authorization: Bearer ${ITACHI_API_KEY:-}"

# ============ Project Resolution ============
PROJECT_NAME=""
if [ -n "$ITACHI_PROJECT_NAME" ]; then
    PROJECT_NAME="$ITACHI_PROJECT_NAME"
fi
if [ -z "$PROJECT_NAME" ] && [ -f ".itachi-project" ]; then
    PROJECT_NAME=$(cat .itachi-project | tr -d '\n\r')
fi
if [ -z "$PROJECT_NAME" ]; then
    REMOTE_URL=$(git remote get-url origin 2>/dev/null)
    if [ -n "$REMOTE_URL" ]; then
        PROJECT_NAME=$(echo "$REMOTE_URL" | sed 's/\.git$//' | sed 's/.*[/:]//')
    fi
fi
if [ -z "$PROJECT_NAME" ]; then
    PROJECT_NAME=$(basename "$PWD")
fi

# Read JSON input from stdin
INPUT=$(cat)
[ -z "$INPUT" ] && exit 0

# Extract prompt using node
PROMPT=$(node -e "try{const j=JSON.parse(process.argv[1]);console.log(j.prompt||'')}catch(e){}" "$INPUT" 2>/dev/null)
[ -z "$PROMPT" ] && exit 0

# Skip trivial/short prompts
if [ ${#PROMPT} -lt 30 ]; then
    exit 0
fi

# ============ Differential Context Injection ============
# Re-query brain API for the 4 categories, compare hashes with session-start state.
# Only inject changed blocks into MEMORY.md. Fast path: skip if nothing changed.
DIFF_OUTPUT=$(node -e "
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');

const cwd=process.argv[1];
const project=process.argv[2];
const baseApi=process.argv[3];
const apiKey=process.env.ITACHI_API_KEY||'';

function enc(p){return p.replace(/:/g,'').replace(/[\\\\/]/g,'-');}
const stateDir=path.join(os.homedir(),'.claude','projects',enc(cwd));
const stateFile=path.join(stateDir,'.injection-state.json');

// No state file = first prompt handled by session-start, skip
if(!fs.existsSync(stateFile)){process.exit(0);}

let state;
try{state=JSON.parse(fs.readFileSync(stateFile,'utf8'));}catch{process.exit(0);}
if(!state.block_hashes){process.exit(0);}

const memoryApi=baseApi+'/api/memory';
const http=require(memoryApi.startsWith('https')?'https':'http');

function postSearch(category,query){
    return new Promise((resolve)=>{
        const body=JSON.stringify({project,category,limit:category==='project_rule'?10:8,query});
        const u=new URL(memoryApi+'/search');
        const opts={method:'POST',hostname:u.hostname,port:u.port,path:u.pathname,rejectUnauthorized:false,timeout:4000,
            headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}};
        if(apiKey)opts.headers['Authorization']='Bearer '+apiKey;
        const req=http.request(opts,(res)=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve(d));});
        req.on('error',()=>resolve(''));
        req.on('timeout',()=>{req.destroy();resolve('');});
        req.write(body);req.end();
    });
}

function hashBlock(raw){return crypto.createHash('sha256').update(raw||'').digest('hex');}

function parseBrain(raw){
    try{const d=JSON.parse(raw);const results=d.results||d.memories||[];
    return results.filter(m=>{const conf=(m.metadata&&m.metadata.confidence!=null)?m.metadata.confidence:(m.confidence!=null?m.confidence:1);return conf>=0.4;});
    }catch{return[];}
}

function fmtMem(m){const s=m.summary||m.content||'';return s.length>150?s.substring(0,147)+'...':s;}

(async()=>{
    try{
        // Parallel fetch all 4 categories (4s timeout each)
        const [rulesRaw,lessonsRaw,guardrailsRaw,generalRaw]=await Promise.all([
            postSearch('project_rule','project rules and conventions'),
            postSearch('task_lesson','recent task lessons and outcomes'),
            postSearch('guardrail','guardrails warnings pitfalls'),
            postSearch('general','recent context and activity')
        ]);

        // Hash and compare
        const newHashes={
            brain_rules:hashBlock(rulesRaw),
            brain_lessons:hashBlock(lessonsRaw),
            brain_guardrails:hashBlock(guardrailsRaw),
            brain_general:hashBlock(generalRaw)
        };

        const changed={};
        let anyChanged=false;
        for(const key of Object.keys(newHashes)){
            if(newHashes[key]!==state.block_hashes[key]){
                changed[key]=true;
                anyChanged=true;
            }
        }

        if(!anyChanged){process.exit(0);}

        // Build updated context section with only changed blocks
        const rawMap={brain_rules:rulesRaw,brain_lessons:lessonsRaw,brain_guardrails:guardrailsRaw,brain_general:generalRaw};
        const labelMap={brain_rules:'Project Rules',brain_lessons:'Recent Lessons',brain_guardrails:'Active Guardrails',brain_general:'Recent Context'};
        const lines=['## Updated Brain Context','<!-- differential injection: only changed blocks since session start -->',''];
        for(const key of Object.keys(changed)){
            const parsed=parseBrain(rawMap[key]);
            if(parsed.length>0){
                lines.push('### '+labelMap[key]+' (updated)');
                parsed.forEach(m=>lines.push('- '+fmtMem(m)));
                lines.push('');
            }
        }

        if(lines.length<=3){process.exit(0);}

        // Write updated blocks to MEMORY.md
        const memDir=path.join(stateDir,'memory');
        const memFile=path.join(memDir,'MEMORY.md');
        let existing='';
        if(fs.existsSync(memFile)){existing=fs.readFileSync(memFile,'utf8');}

        // Upsert the Updated Brain Context section
        const heading='## Updated Brain Context';
        const idx=existing.indexOf(heading);
        const sectionBody=lines.join('\n');
        if(idx!==-1){
            const after=existing.substring(idx+heading.length);
            const nextH=after.match(/\n## /);
            const endIdx=nextH?idx+heading.length+nextH.index:existing.length;
            existing=existing.substring(0,idx)+sectionBody+existing.substring(endIdx);
        }else{
            const sep=existing.length>0&&!existing.endsWith('\n\n')?'\n\n':(existing.length>0&&!existing.endsWith('\n')?'\n':'');
            existing+=sep+sectionBody;
        }
        fs.writeFileSync(memFile,existing);

        // Update state file
        state.last_injected_at=new Date().toISOString();
        state.block_hashes=newHashes;
        fs.writeFileSync(stateFile,JSON.stringify(state,null,2));

        // Output notice (not as additionalContext, just informational)
        const changedNames=Object.keys(changed).map(k=>labelMap[k]).join(', ');
        console.log('[diff-inject] Updated: '+changedNames);
    }catch(e){
        // Graceful skip — no injection is better than blocking
        process.exit(0);
    }
})();
" "$PWD" "$PROJECT_NAME" "$BASE_API" 2>/dev/null)

# Log differential injection if it happened (non-blocking informational)
# Don't output as JSON — this is just a side-effect log

# ============ Semantic Memory Search ============
# URL-encode the query (truncate to 500 chars for URL safety)
ENCODED_QUERY=$(node -e "console.log(encodeURIComponent(process.argv[1].substring(0,500)))" "$PROMPT" 2>/dev/null)
ENCODED_PROJECT=$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$PROJECT_NAME" 2>/dev/null)

# Query memory search API (5s timeout) — project-scoped
SEARCH_RESULT=$(curl -s -k -H "$AUTH_HEADER" \
    "${MEMORY_API}/search?query=${ENCODED_QUERY}&project=${ENCODED_PROJECT}&limit=3" \
    --max-time 5 2>/dev/null)

# Query global memory search (cross-project operational knowledge, 3s timeout)
GLOBAL_SEARCH_RESULT=$(curl -s -k -H "$AUTH_HEADER" \
    "${MEMORY_API}/search?query=${ENCODED_QUERY}&project=_global&limit=2" \
    --max-time 3 2>/dev/null)

# Format and merge results as additionalContext JSON
OUTPUT=$(node -e "
try {
    const projectData = process.argv[1] ? JSON.parse(process.argv[1]) : {};
    const globalData = process.argv[2] ? JSON.parse(process.argv[2]) : {};

    const projectResults = (projectData.results || []);
    const globalResults = (globalData.results || []);
    const allResults = [...projectResults, ...globalResults].slice(0, 5);

    if (allResults.length === 0) process.exit(0);

    const lines = ['=== Itachi Memory Context ==='];
    for (let i = 0; i < allResults.length; i++) {
        const mem = allResults[i];
        const files = (mem.files && mem.files.length > 0) ? ' (' + mem.files.join(', ') + ')' : '';
        const cat = mem.category ? '[' + mem.category + '] ' : '';
        const prefix = i >= projectResults.length ? '[GLOBAL] ' : '';
        const outcomeTag = (mem.metadata && mem.metadata.outcome) ? '[' + mem.metadata.outcome.toUpperCase() + '] ' : '';
        lines.push(prefix + cat + outcomeTag + mem.summary + files);
    }
    lines.push('=== End Memory Context ===');

    console.log(JSON.stringify({ additionalContext: lines.join('\n') }));
} catch(e) {}
" "$SEARCH_RESULT" "$GLOBAL_SEARCH_RESULT" 2>/dev/null)

if [ -n "$OUTPUT" ]; then
    echo "$OUTPUT"
fi

exit 0
