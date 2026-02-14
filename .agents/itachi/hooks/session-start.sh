#!/bin/bash
# Itachi Memory - Unified SessionStart Hook
# Works with any agent CLI: Claude, Codex, Aider, etc.
# Client-specific behavior controlled by ITACHI_CLIENT env var
#
# Context injection target:
#   - claude  → ~/.claude/projects/{encoded-cwd}/memory/MEMORY.md
#   - others  → {cwd}/AGENTS.md

[ "$ITACHI_DISABLED" = "1" ] && exit 0

CLIENT="${ITACHI_CLIENT:-generic}"

BASE_API="${ITACHI_API_URL:-https://itachisbrainserver.online}"
MEMORY_API="$BASE_API/api/memory"
SYNC_API="$BASE_API/api/sync"
SESSION_API="$BASE_API/api/session"
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

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
[ -z "$BRANCH" ] && BRANCH="main"

# ============ Auto-register repo URL ============
REPO_URL=$(git remote get-url origin 2>/dev/null)
if [ -n "$REPO_URL" ] && [ -n "$PROJECT_NAME" ]; then
    curl -s -k -X POST "${BASE_API}/api/repos/register" \
      -H "Content-Type: application/json" \
      -H "$AUTH_HEADER" \
      -d "{\"name\":\"${PROJECT_NAME}\",\"repo_url\":\"${REPO_URL}\"}" \
      --max-time 5 > /dev/null 2>&1 &
fi

# ============ Encrypted File Sync (Pull) ============
ITACHI_KEY_FILE="$HOME/.itachi-key"

if [ -f "$ITACHI_KEY_FILE" ]; then
    SYNC_OUTPUT=$(node -e "
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const project = process.argv[1];
const keyFile = process.argv[2];
const syncApi = process.argv[3];
const cwd = process.argv[4];
const machineKeys = ['ITACHI_ORCHESTRATOR_ID', 'ITACHI_WORKSPACE_DIR', 'ITACHI_PROJECT_PATHS'];

function httpGet(url) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const mod = u.protocol === 'https:' ? https : http;
        mod.get(u, { rejectUnauthorized: false, timeout: 10000, headers: { 'Authorization': 'Bearer ' + (process.env.ITACHI_API_KEY || '') } }, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                if (res.statusCode >= 400) reject(new Error(d));
                else resolve(JSON.parse(d));
            });
        }).on('error', reject);
    });
}
function decrypt(encB64, saltB64, passphrase) {
    const packed = Buffer.from(encB64, 'base64');
    const salt = Buffer.from(saltB64, 'base64');
    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const ct = packed.subarray(28);
    const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ct, null, 'utf8') + decipher.final('utf8');
}
function stripMachineKeys(content) {
    return content.replace(new RegExp('^(' + machineKeys.join('|') + ')=.*\$', 'gm'), '').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
function mergeEnv(localContent, remoteContent) {
    const localKV = {}, localLines = localContent.split('\n');
    for (const line of localLines) { const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) localKV[m[1]] = m[2]; }
    const remoteKV = {};
    for (const line of remoteContent.split('\n')) { const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) remoteKV[m[1]] = m[2]; }
    Object.assign(localKV, remoteKV);
    for (const line of localLines) { const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m && machineKeys.includes(m[1])) localKV[m[1]] = m[2]; }
    return Object.entries(localKV).map(([k, v]) => k + '=' + v).join('\n') + '\n';
}
(async () => {
    try {
        const passphrase = fs.readFileSync(keyFile, 'utf8').trim();
        const list = await httpGet(syncApi + '/list/' + encodeURIComponent(project));
        if (!list.files || list.files.length === 0) return;
        const output = [];
        for (const f of list.files) {
            const localPath = path.join(cwd, f.file_path);
            let localHash = null;
            if (fs.existsSync(localPath)) {
                let lc = fs.readFileSync(localPath, 'utf8');
                const fn = path.basename(localPath);
                if (fn === '.env' || fn.startsWith('.env.')) lc = stripMachineKeys(lc);
                localHash = crypto.createHash('sha256').update(lc).digest('hex');
            }
            if (localHash === f.content_hash) continue;
            const fileData = await httpGet(syncApi + '/pull/' + encodeURIComponent(project) + '/' + f.file_path);
            const rc = decrypt(fileData.encrypted_data, fileData.salt, passphrase);
            const fn = path.basename(f.file_path);
            if ((fn === '.env' || fn.startsWith('.env.')) && fs.existsSync(localPath)) {
                fs.writeFileSync(localPath, mergeEnv(fs.readFileSync(localPath, 'utf8'), rc));
            } else {
                fs.mkdirSync(path.dirname(localPath), { recursive: true });
                fs.writeFileSync(localPath, rc);
            }
            output.push('[sync] Updated ' + f.file_path + ' (v' + f.version + ' by ' + f.updated_by + ')');
        }
        if (output.length > 0) console.log(output.join('\n'));
    } catch(e) {}
})();
" "$PROJECT_NAME" "$ITACHI_KEY_FILE" "$SYNC_API" "$PWD" 2>/dev/null)

    [ -n "$SYNC_OUTPUT" ] && echo "$SYNC_OUTPUT"

    # ============ Global Sync ============
    # Target dir depends on client
    case "$CLIENT" in
        claude) GLOBAL_TARGET="$HOME/.claude" ;;
        codex)  GLOBAL_TARGET="$HOME/.codex" ;;
        gemini) GLOBAL_TARGET="$HOME/.gemini" ;;
        *)      GLOBAL_TARGET="$HOME/.agents" ;;
    esac

    GLOBAL_SYNC_OUTPUT=$(node -e "
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const repoName = '_global', keyFile = process.argv[1], syncApi = process.argv[2], targetDir = process.argv[3];
function httpGet(url) { return new Promise((resolve, reject) => { const u = new URL(url); const mod = u.protocol === 'https:' ? https : http; mod.get(u, { rejectUnauthorized: false, timeout: 10000, headers: { 'Authorization': 'Bearer ' + (process.env.ITACHI_API_KEY || '') } }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { if (res.statusCode >= 400) reject(new Error(d)); else resolve(JSON.parse(d)); }); }).on('error', reject); }); }
function decrypt(e, s, p) { const pk = Buffer.from(e, 'base64'), sl = Buffer.from(s, 'base64'), iv = pk.subarray(0,12), tg = pk.subarray(12,28), ct = pk.subarray(28), k = crypto.pbkdf2Sync(p, sl, 100000, 32, 'sha256'), d = crypto.createDecipheriv('aes-256-gcm', k, iv); d.setAuthTag(tg); return d.update(ct, null, 'utf8') + d.final('utf8'); }
(async () => { try { const pp = fs.readFileSync(keyFile, 'utf8').trim(); const list = await httpGet(syncApi + '/list/' + encodeURIComponent(repoName)); if (!list.files || !list.files.length) return; const out = []; for (const f of list.files) { const lp = path.join(targetDir, f.file_path); let lh = null; if (fs.existsSync(lp)) lh = crypto.createHash('sha256').update(fs.readFileSync(lp, 'utf8')).digest('hex'); if (lh === f.content_hash) continue; const fd = await httpGet(syncApi + '/pull/' + encodeURIComponent(repoName) + '/' + f.file_path); const rc = decrypt(fd.encrypted_data, fd.salt, pp); fs.mkdirSync(path.dirname(lp), { recursive: true }); fs.writeFileSync(lp, rc); out.push('[sync] Updated ' + path.relative(require('os').homedir(), lp) + ' (v' + f.version + ')'); } if (out.length) console.log(out.join('\n')); } catch(e) {} })();
" "$ITACHI_KEY_FILE" "$SYNC_API" "$GLOBAL_TARGET" 2>/dev/null)

    [ -n "$GLOBAL_SYNC_OUTPUT" ] && echo "$GLOBAL_SYNC_OUTPUT"
fi

# ============ Settings Hooks Merge (Claude only) ============
if [ "$CLIENT" = "claude" ] && [ -f "$ITACHI_KEY_FILE" ]; then
    SETTINGS_MERGE_OUTPUT=$(node -e "
const crypto=require('crypto'),fs=require('fs'),path=require('path'),https=require('https'),http=require('http'),os=require('os');
const keyFile=process.argv[1],syncApi=process.argv[2],platform=process.argv[3];
function httpGet(url){return new Promise((r,j)=>{const u=new URL(url),m=u.protocol==='https:'?https:http;m.get(u,{rejectUnauthorized:false,timeout:10000,headers:{'Authorization':'Bearer '+(process.env.ITACHI_API_KEY||'')}},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{if(res.statusCode>=400)j(new Error(d));else r(JSON.parse(d));});}).on('error',j);});}
function decrypt(e,s,p){const pk=Buffer.from(e,'base64'),sl=Buffer.from(s,'base64'),iv=pk.subarray(0,12),tg=pk.subarray(12,28),ct=pk.subarray(28),k=crypto.pbkdf2Sync(p,sl,100000,32,'sha256'),d=crypto.createDecipheriv('aes-256-gcm',k,iv);d.setAuthTag(tg);return d.update(ct,null,'utf8')+d.final('utf8');}
(async()=>{try{const pp=fs.readFileSync(keyFile,'utf8').trim();const hd=path.join(os.homedir(),'.claude','hooks'),sf=path.join(os.homedir(),'.claude','settings.json');const fd=await httpGet(syncApi+'/pull/_global/settings-hooks.json');const t=JSON.parse(decrypt(fd.encrypted_data,fd.salt,pp));if(!t.hooks||!Object.keys(t.hooks).length)return;let s={};if(fs.existsSync(sf))s=JSON.parse(fs.readFileSync(sf,'utf8'));if(!s.hooks)s.hooks={};const mk=['session-start','after-edit','session-end','user-prompt-submit'];const isI=c=>mk.some(m=>c&&c.toLowerCase().includes(m));for(const[ev,te]of Object.entries(t.hooks)){const ex=s.hooks[ev]||[];const ni=ex.filter(e=>!e.hooks||!e.hooks.some(h=>isI(h.command)));const ne=te.map(e=>{const c=JSON.parse(JSON.stringify(e));for(const h of(c.hooks||[])){if(h.command_template){h.command=(h.command_template[platform]||h.command_template.unix).replace(/__HOOKS_DIR__/g,hd);delete h.command_template;}}return c;});s.hooks[ev]=[...ni,...ne];}fs.writeFileSync(sf,JSON.stringify(s,null,2));console.log('[sync] Merged Itachi hooks into settings.json');}catch(e){}})();
" "$ITACHI_KEY_FILE" "$SYNC_API" "unix" 2>/dev/null)
    [ -n "$SETTINGS_MERGE_OUTPUT" ] && echo "$SETTINGS_MERGE_OUTPUT"
fi

# ============ API Keys Merge ============
if [ -f "$ITACHI_KEY_FILE" ]; then
    API_KEYS_OUTPUT=$(node -e "
const crypto=require('crypto'),fs=require('fs'),path=require('path'),https=require('https'),http=require('http'),os=require('os');
const keyFile=process.argv[1],syncApi=process.argv[2];
const machineKeys=['ITACHI_ORCHESTRATOR_ID','ITACHI_WORKSPACE_DIR','ITACHI_PROJECT_PATHS'];
function httpGet(url){return new Promise((r,j)=>{const u=new URL(url),m=u.protocol==='https:'?https:http;m.get(u,{rejectUnauthorized:false,timeout:10000,headers:{'Authorization':'Bearer '+(process.env.ITACHI_API_KEY||'')}},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{if(res.statusCode>=400)j(new Error(d));else r(JSON.parse(d));});}).on('error',j);});}
function decrypt(e,s,p){const pk=Buffer.from(e,'base64'),sl=Buffer.from(s,'base64'),iv=pk.subarray(0,12),tg=pk.subarray(12,28),ct=pk.subarray(28),k=crypto.pbkdf2Sync(p,sl,100000,32,'sha256'),d=crypto.createDecipheriv('aes-256-gcm',k,iv);d.setAuthTag(tg);return d.update(ct,null,'utf8')+d.final('utf8');}
(async()=>{try{const pp=fs.readFileSync(keyFile,'utf8').trim();const af=path.join(os.homedir(),'.itachi-api-keys');const fd=await httpGet(syncApi+'/pull/_global/api-keys');const rc=decrypt(fd.encrypted_data,fd.salt,pp);const rKV={};for(const l of rc.split('\n')){const m=l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);if(m)rKV[m[1]]=m[2];}const lKV={};if(fs.existsSync(af)){for(const l of fs.readFileSync(af,'utf8').split('\n')){const m=l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);if(m)lKV[m[1]]=m[2];}}const mg={...lKV,...rKV};for(const mk of machineKeys){if(lKV[mk])mg[mk]=lKV[mk];else delete mg[mk];}fs.writeFileSync(af,Object.entries(mg).map(([k,v])=>k+'='+v).join('\n')+'\n');console.log('[sync] Merged API keys');}catch(e){}})();
" "$ITACHI_KEY_FILE" "$SYNC_API" 2>/dev/null)
    [ -n "$API_KEYS_OUTPUT" ] && echo "$API_KEYS_OUTPUT"
fi

# ============ Session Briefing ============
BRIEFING=$(curl -s -k -H "$AUTH_HEADER" "${SESSION_API}/briefing?project=${PROJECT_NAME}&branch=${BRANCH}" --max-time 10 2>/dev/null)

if [ -n "$BRIEFING" ]; then
    BRIEFING_OUTPUT=$(node -e "
try{const d=JSON.parse(process.argv[1]);const l=[];l.push('');l.push('=== Session Briefing for ${PROJECT_NAME} (${BRANCH}) ===');if(d.recentSessions&&d.recentSessions.length>0){l.push('Recent sessions:');d.recentSessions.forEach(s=>{const f=(s.filesChanged||[]).join(', ');l.push('  - '+(s.summary||'(no summary)')+(f?' ['+f+']':''));});}if(d.hotFiles&&d.hotFiles.length>0){l.push('Hot files (last 7d):');d.hotFiles.slice(0,5).forEach(f=>l.push('  - '+f.path+' ('+f.editCount+' edits)'));}if(d.activePatterns&&d.activePatterns.length>0){l.push('Active patterns:');d.activePatterns.forEach(p=>l.push('  - '+p));}if(d.activeTasks&&d.activeTasks.length>0){l.push('Active tasks:');d.activeTasks.forEach(t=>l.push('  - ['+t.status+'] '+t.description));}if(d.warnings&&d.warnings.length>0){d.warnings.forEach(w=>l.push('  [warn] '+w));}l.push('=== End Briefing ===');l.push('');console.log(l.join('\n'));}catch(e){}
" "$BRIEFING" 2>/dev/null)
    [ -n "$BRIEFING_OUTPUT" ] && echo "$BRIEFING_OUTPUT"
fi

# ============ Memory Context ============
RECENT=$(curl -s -k -H "$AUTH_HEADER" "${MEMORY_API}/recent?project=${PROJECT_NAME}&limit=5&branch=${BRANCH}" --max-time 10 2>/dev/null)

if [ -n "$RECENT" ]; then
    OUTPUT=$(node -e "
try{const d=JSON.parse(process.argv[1]);if(d.recent&&d.recent.length>0){console.log('');console.log('=== Recent Memory Context for ${PROJECT_NAME} (${BRANCH}) ===');d.recent.forEach(m=>{const f=(m.files||[]).join(', ')||'none';console.log('['+m.category+'] '+m.summary+' (Files: '+f+')');});console.log('=== End Memory Context ===');console.log('');}}catch(e){}
" "$RECENT" 2>/dev/null)
    [ -n "$OUTPUT" ] && echo "$OUTPUT"
fi

# ============ Fetch Learnings ============
LEARNINGS=$(curl -s -k -H "$AUTH_HEADER" "${BASE_API}/api/project/learnings?project=${PROJECT_NAME}&limit=15" --max-time 10 2>/dev/null)

# ============ Write to Context File ============
if [ -n "$BRIEFING" ] || [ -n "$LEARNINGS" ]; then
    node -e "
const fs=require('fs'),path=require('path'),os=require('os');
const client=process.argv[1],cwd=process.argv[2],bj=process.argv[3],lj=process.argv[4];
try{
    const briefing=bj?JSON.parse(bj):null;
    let learnings=null;try{learnings=lj?JSON.parse(lj):null;}catch{}
    if(!briefing&&(!learnings||!learnings.rules||!learnings.rules.length))return;
    let targetFile;
    if(client==='claude'){
        function enc(p){return p.replace(/:/g,'').replace(/[\\\\/]/g,'--').replace(/^-+|-+\$/g,'');}
        const md=path.join(os.homedir(),'.claude','projects',enc(cwd),'memory');
        fs.mkdirSync(md,{recursive:true});
        targetFile=path.join(md,'MEMORY.md');
    }else if(client==='gemini'){
        targetFile=path.join(cwd,'GEMINI.md');
    }else{
        targetFile=path.join(cwd,'AGENTS.md');
    }
    const lines=['## Itachi Session Context','<!-- auto-updated by itachi session-start hook -->',''];
    if(briefing){
        if(briefing.hotFiles&&briefing.hotFiles.length>0)lines.push('**Hot files**: '+briefing.hotFiles.slice(0,5).map(f=>f.path+' ('+f.editCount+' edits)').join(', '));
        if(briefing.activePatterns&&briefing.activePatterns.length>0)lines.push('**Active patterns**: '+briefing.activePatterns.join(', '));
        if(briefing.stylePreferences&&Object.keys(briefing.stylePreferences).length>0)lines.push('**Style**: '+Object.entries(briefing.stylePreferences).map(([k,v])=>k+'='+v).join(', '));
        if(briefing.recentSessions&&briefing.recentSessions.length>0){const dec=briefing.recentSessions.filter(s=>s.summary&&s.summary.length>10).slice(0,3).map(s=>s.summary);if(dec.length)lines.push('**Recent decisions**: '+dec.join('; '));}
        if(briefing.activeTasks&&briefing.activeTasks.length>0)lines.push('**Active tasks**: '+briefing.activeTasks.map(t=>'['+t.status+'] '+t.description).join('; '));
    }
    let existing='';if(fs.existsSync(targetFile))existing=fs.readFileSync(targetFile,'utf8');
    function upsert(c,h,b){const i=c.indexOf(h);if(i!==-1){const a=c.substring(i+h.length);const n=a.match(/\n## /);const e=n?i+h.length+n.index:c.length;return c.substring(0,i)+b+c.substring(e);}else{const s=c.length>0&&!c.endsWith('\n\n')?'\n\n':(c.length>0&&!c.endsWith('\n')?'\n':'');return c+s+b;}}
    if(lines.length>3){lines.push('');existing=upsert(existing,'## Itachi Session Context',lines.join('\n'));}
    if(learnings&&learnings.rules&&learnings.rules.length>0){const rl=['## Project Rules','<!-- auto-updated by itachi session-start hook -->',''];for(const r of learnings.rules){const rf=r.times_reinforced>1?' (reinforced '+r.times_reinforced+'x)':'';rl.push('- '+r.rule+rf);}rl.push('');existing=upsert(existing,'## Project Rules',rl.join('\n'));}
    fs.writeFileSync(targetFile,existing);
}catch(e){}
" "$CLIENT" "$PWD" "$BRIEFING" "$LEARNINGS" 2>/dev/null
fi

exit 0
