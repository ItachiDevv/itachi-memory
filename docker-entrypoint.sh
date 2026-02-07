#!/bin/bash
set -e

echo "========================================"
echo "  Itachi Memory System"
echo "  ElizaOS + Orchestrator"
echo "========================================"
echo ""

# --- Pull CLI auth credentials from sync ---
# Both Claude and Codex use subscription login. Credentials are synced
# via the Itachi sync system (encrypted in Supabase). The setup script
# on a local PC pushes them; this container pulls them on startup.
if [ -n "$ITACHI_API_URL" ] && [ -n "$ITACHI_KEY" ]; then
  echo "[entrypoint] Pulling CLI auth credentials from sync..."

  # Pull Claude and Codex auth from sync (encrypted with the same passphrase in ~/.itachi-key)
  if [ ! -f /root/.claude/.credentials.json ] || [ ! -f /root/.codex/auth.json ]; then
    node -e "
      const http = require('http'), https = require('https'), crypto = require('crypto'), fs = require('fs');
      const passphrase = process.env.ITACHI_KEY;
      const syncUrl = process.env.ITACHI_API_URL + '/api/sync';
      const decrypt = (enc, salt, pass) => {
        const packed = Buffer.from(enc, 'base64'), s = Buffer.from(salt, 'base64');
        const iv = packed.subarray(0,12), tag = packed.subarray(12,28), ct = packed.subarray(28);
        const key = crypto.pbkdf2Sync(pass, s, 100000, 32, 'sha256');
        const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
        d.setAuthTag(tag);
        return d.update(ct, null, 'utf8') + d.final('utf8');
      };
      const get = (url) => new Promise((res,rej) => {
        const u = new URL(url), mod = u.protocol === 'https:' ? https : http;
        mod.get(u, {timeout:10000}, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{res(JSON.parse(d))}catch{res(d)} }); }).on('error',rej);
      });
      (async () => {
        try {
          const data = await get(syncUrl + '/pull/_global/claude-auth');
          const content = decrypt(data.encrypted_data, data.salt, passphrase);
          fs.mkdirSync('/root/.claude', {recursive:true});
          fs.writeFileSync('/root/.claude/.credentials.json', content);
          console.log('  Claude auth pulled');
        } catch { console.log('  No Claude auth in sync yet'); }
        try {
          const data = await get(syncUrl + '/pull/_global/codex-auth');
          const content = decrypt(data.encrypted_data, data.salt, passphrase);
          fs.mkdirSync('/root/.codex', {recursive:true});
          fs.writeFileSync('/root/.codex/auth.json', content);
          console.log('  Codex auth pulled');
        } catch { console.log('  No Codex auth in sync yet'); }
      })();
    " 2>/dev/null || echo "[entrypoint] Auth pull skipped (sync unavailable)"
  else
    echo "[entrypoint] CLI credentials already present"
  fi
else
  echo "[entrypoint] ITACHI_KEY not set, skipping auth pull"
fi

# --- Start ElizaOS in background ---
echo "[entrypoint] Starting ElizaOS..."
cd /app/eliza
bun run start &
ELIZA_PID=$!
echo "[entrypoint] ElizaOS started (PID: $ELIZA_PID)"

# Wait for ElizaOS to be ready (health check on port 3000)
echo "[entrypoint] Waiting for ElizaOS to be ready..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:3000/ > /dev/null 2>&1; then
    echo "[entrypoint] ElizaOS ready!"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "[entrypoint] WARNING: ElizaOS not responding after 30s, starting orchestrator anyway"
  fi
  sleep 1
done

# --- Start Orchestrator in background ---
if [ -n "$ITACHI_MACHINE_ID" ]; then
  echo "[entrypoint] Starting Orchestrator (machine: $ITACHI_MACHINE_ID)..."
  cd /app/orchestrator
  node dist/index.js &
  ORCH_PID=$!
  echo "[entrypoint] Orchestrator started (PID: $ORCH_PID)"
else
  echo "[entrypoint] ITACHI_MACHINE_ID not set, skipping orchestrator"
  ORCH_PID=""
fi

echo ""
echo "[entrypoint] All services running. Waiting for exit..."

# Trap signals for graceful shutdown
shutdown() {
  echo ""
  echo "[entrypoint] Shutting down..."
  [ -n "$ORCH_PID" ] && kill "$ORCH_PID" 2>/dev/null && wait "$ORCH_PID" 2>/dev/null
  [ -n "$ELIZA_PID" ] && kill "$ELIZA_PID" 2>/dev/null && wait "$ELIZA_PID" 2>/dev/null
  echo "[entrypoint] Shutdown complete"
  exit 0
}

trap shutdown SIGTERM SIGINT

# Wait for either process to exit
wait -n $ELIZA_PID ${ORCH_PID:-}
EXIT_CODE=$?

echo "[entrypoint] A process exited with code $EXIT_CODE"
shutdown
