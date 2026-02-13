#!/bin/bash
# Itachi Memory - Unified SessionEnd Hook
# Works with any agent CLI: Claude, Codex, Aider, etc.
# Client-specific behavior controlled by ITACHI_CLIENT env var

[ "$ITACHI_DISABLED" = "1" ] && exit 0

CLIENT="${ITACHI_CLIENT:-generic}"

BASE_API="${ITACHI_API_URL:-https://itachisbrainserver.online}"
MEMORY_API="$BASE_API/api/memory"
SESSION_API="$BASE_API/api/session"
AUTH_HEADER="Authorization: Bearer ${ITACHI_API_KEY:-}"

# ============ Project Resolution ============
PROJECT_NAME=""
[ -n "$ITACHI_PROJECT_NAME" ] && PROJECT_NAME="$ITACHI_PROJECT_NAME"
[ -z "$PROJECT_NAME" ] && [ -f ".itachi-project" ] && PROJECT_NAME=$(cat .itachi-project | tr -d '\n\r')
if [ -z "$PROJECT_NAME" ]; then
    REMOTE_URL=$(git remote get-url origin 2>/dev/null)
    [ -n "$REMOTE_URL" ] && PROJECT_NAME=$(echo "$REMOTE_URL" | sed 's/\.git$//' | sed 's/.*[/:]//')
fi
[ -z "$PROJECT_NAME" ] && PROJECT_NAME=$(basename "$PWD")

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
[ -z "$BRANCH" ] && BRANCH="main"

TASK_ID="${ITACHI_TASK_ID:-}"
SESSION_ID="${ITACHI_SESSION_ID:-}"
[ -z "$SESSION_ID" ] && SESSION_ID="${CLIENT}-manual-$(date +%Y%m%d-%H%M%S)-$$"

# ============ Determine exit reason (client-specific) ============
if [ "$CLIENT" = "claude" ]; then
    # Claude pipes JSON to stdin with {reason: "..."}
    INPUT=$(cat)
    REASON=$(node -e "try{const j=JSON.parse(process.argv[1]);console.log(j.reason||'unknown')}catch(e){console.log('unknown')}" "$INPUT" 2>/dev/null)
else
    # Other clients: wrapper sets ITACHI_EXIT_CODE or ITACHI_CODEX_EXIT_CODE
    EXIT_CODE="${ITACHI_EXIT_CODE:-${ITACHI_CODEX_EXIT_CODE:-0}}"
    if [ "$EXIT_CODE" = "0" ]; then REASON="completed"; else REASON="error"; fi
fi

# ============ Memory API ============
TASK_FIELD=""
[ -n "$TASK_ID" ] && TASK_FIELD=",\"task_id\":\"${TASK_ID}\""

curl -s -k -X POST "${MEMORY_API}/code-change" \
  -H "Content-Type: application/json" \
  -H "$AUTH_HEADER" \
  -d "{\"files\":[],\"summary\":\"Session ended: ${REASON}\",\"category\":\"session\",\"project\":\"${PROJECT_NAME}\",\"branch\":\"${BRANCH}\"${TASK_FIELD}}" \
  --max-time 10 > /dev/null 2>&1

# ============ Code-Intel: Session Complete ============
node -e "
try {
    const https=require('https'),http=require('http'),fs=require('fs'),path=require('path'),os=require('os');
    const body = {
        session_id: process.argv[1], project: process.argv[2],
        exit_reason: process.argv[3], branch: process.argv[4],
        ended_at: new Date().toISOString()
    };
    if (process.argv[5]) body.task_id = process.argv[5];
    try { const {execSync}=require('child_process'); const diff=execSync('git diff --name-only HEAD',{encoding:'utf8',timeout:5000}).trim(); if(diff)body.files_changed=diff.split('\n').filter(Boolean); } catch(e){}

    // Claude-specific: read sessions-index.json
    if (process.argv[6] === 'claude') {
        try {
            const indexPath=path.join(os.homedir(),'.claude','sessions-index.json');
            if(fs.existsSync(indexPath)){
                const sessions=JSON.parse(fs.readFileSync(indexPath,'utf8'));
                if(Array.isArray(sessions)&&sessions.length>0){
                    const latest=sessions.sort((a,b)=>(b.modified||'').localeCompare(a.modified||''))[0];
                    if(latest){
                        if(latest.summary)body.summary=latest.summary;
                        if(latest.created&&latest.modified){body.started_at=latest.created;body.duration_ms=new Date(latest.modified).getTime()-new Date(latest.created).getTime();}
                    }
                }
            }
        } catch(e){}
    }

    const jsonBody=JSON.stringify(body);
    const url=new URL(process.argv[7]+'/complete');
    const mod=url.protocol==='https:'?https:http;
    const req=mod.request(url,{method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(jsonBody),'Authorization':'Bearer '+(process.env.ITACHI_API_KEY||'')},timeout:10000,rejectUnauthorized:false},(res)=>{res.resume();});
    req.on('error',()=>{});req.write(jsonBody);req.end();
} catch(e) {}
" "$SESSION_ID" "$PROJECT_NAME" "$REASON" "$BRANCH" "$TASK_ID" "$CLIENT" "$SESSION_API" 2>/dev/null &

# ============ Extract Insights from Transcript (background) ============
FILES_CHANGED=$(git diff --name-only HEAD 2>/dev/null | tr '\n' ',' | sed 's/,$//')

node -e "
const fs=require('fs'),path=require('path'),os=require('os'),https=require('https'),http=require('http');
const client=process.argv[1],sessionId=process.argv[2],project=process.argv[3],cwd=process.argv[4],sessionApi=process.argv[5];
const summary=process.argv[6]||'',durationMs=parseInt(process.argv[7])||0,filesChanged=process.argv[8]?process.argv[8].split(',').filter(Boolean):[];

function httpPost(url,body){return new Promise((r,j)=>{const jb=JSON.stringify(body);const u=new URL(url);const m=u.protocol==='https:'?https:http;const req=m.request(u,{method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(jb),'Authorization':'Bearer '+(process.env.ITACHI_API_KEY||'')},timeout:30000,rejectUnauthorized:false},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{if(res.statusCode>=400)j(new Error(d));else{try{r(JSON.parse(d));}catch{r(d);}}});});req.on('error',j);req.write(jb);req.end();});}

function findClaudeTranscript(cwd,sid){
    function enc(p){return p.replace(/:/g,'').replace(/[\\\\/]/g,'--').replace(/^-+|-+\$/g,'');}
    const pd=path.join(os.homedir(),'.claude','projects',enc(cwd));
    if(!fs.existsSync(pd))return null;
    const dp=path.join(pd,sid+'.jsonl');if(fs.existsSync(dp))return dp;
    const files=fs.readdirSync(pd).filter(f=>f.endsWith('.jsonl')).map(f=>({n:f,m:fs.statSync(path.join(pd,f)).mtimeMs})).sort((a,b)=>b.m-a.m);
    return files.length?path.join(pd,files[0].n):null;
}
function findCodexTranscript(){
    const cd=path.join(os.homedir(),'.codex','sessions');if(!fs.existsSync(cd))return null;
    const now=new Date();let best=null,bm=0;
    for(let o=0;o<=1;o++){const d=new Date(now.getTime()-o*86400000);const dir=path.join(cd,d.getFullYear().toString(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0'));if(!fs.existsSync(dir))continue;for(const f of fs.readdirSync(dir).filter(f=>f.endsWith('.jsonl'))){const fp=path.join(dir,f),mt=fs.statSync(fp).mtimeMs;if(mt>bm){bm=mt;best=fp;}}}
    return best;
}
function extractClaudeTexts(lines){const t=[];for(const l of lines){try{const e=JSON.parse(l);if(e.type==='assistant'&&e.message&&e.message.content){const tp=Array.isArray(e.message.content)?e.message.content.filter(c=>c.type==='text').map(c=>c.text).join(' '):(typeof e.message.content==='string'?e.message.content:'');if(tp.length>50)t.push(tp);}}catch{}}return t;}
function extractCodexTexts(lines){const t=[];for(const l of lines){try{const e=JSON.parse(l);if(e.type==='response_item'&&e.payload){const p=e.payload;if(p.role==='assistant'&&p.content){const tp=Array.isArray(p.content)?p.content.filter(c=>c.type==='output_text'||c.type==='text').map(c=>c.text).join(' '):(typeof p.content==='string'?p.content:'');if(tp.length>50)t.push(tp);}}if(e.type==='event_msg'&&e.payload&&e.payload.agent_reasoning&&e.payload.agent_reasoning.length>50)t.push(e.payload.agent_reasoning);}catch{}}return t;}

(async()=>{try{
    let tp=null;
    if(client==='claude')tp=findClaudeTranscript(cwd,sessionId);
    else if(client==='codex')tp=findCodexTranscript();
    if(!tp)return;
    const content=fs.readFileSync(tp,'utf8'),lines=content.split('\n').filter(Boolean);
    const texts=client==='claude'?extractClaudeTexts(lines):extractCodexTexts(lines);
    if(!texts.length)return;
    await httpPost(sessionApi+'/extract-insights',{session_id:sessionId,project:project,conversation_text:texts.join('\n---\n').substring(0,4000),files_changed:filesChanged,summary:summary,duration_ms:durationMs});
}catch(e){}})();
" "$CLIENT" "$SESSION_ID" "$PROJECT_NAME" "$PWD" "$SESSION_API" "" "0" "$FILES_CHANGED" 2>/dev/null &

exit 0
