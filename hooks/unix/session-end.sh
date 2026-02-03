#!/bin/bash
# Itachi Memory - SessionEnd Hook
# Fixed: uses node instead of jq for JSON parsing

MEMORY_API="https://eliza-claude-production.up.railway.app/api/memory"
PROJECT_NAME=$(basename "$PWD")

# Read JSON input from stdin
INPUT=$(cat)

# Extract reason using node (no jq dependency)
REASON=$(node -e "try{const j=JSON.parse(process.argv[1]);console.log(j.reason||'unknown')}catch(e){console.log('unknown')}" "$INPUT" 2>/dev/null)

curl -s -k -X POST "${MEMORY_API}/code-change" \
  -H "Content-Type: application/json" \
  -d "{\"files\":[],\"summary\":\"Session ended: ${REASON}\",\"category\":\"session\",\"project\":\"${PROJECT_NAME}\"}" \
  --max-time 10 > /dev/null 2>&1

exit 0
