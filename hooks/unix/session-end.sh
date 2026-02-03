#!/bin/bash
# Itachi Memory - SessionEnd Hook
# Fixed: uses node instead of jq for JSON parsing

MEMORY_API="https://eliza-claude-production.up.railway.app/api/memory"
PROJECT_NAME=$(basename "$PWD")

# Detect git branch
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
[ -z "$BRANCH" ] && BRANCH="main"

# Task ID from orchestrator (empty for manual sessions)
TASK_ID="${ITACHI_TASK_ID:-}"

# Read JSON input from stdin
INPUT=$(cat)

# Extract reason using node (no jq dependency)
REASON=$(node -e "try{const j=JSON.parse(process.argv[1]);console.log(j.reason||'unknown')}catch(e){console.log('unknown')}" "$INPUT" 2>/dev/null)

# Build JSON body with optional task_id
TASK_FIELD=""
if [ -n "$TASK_ID" ]; then
    TASK_FIELD=",\"task_id\":\"${TASK_ID}\""
fi

curl -s -k -X POST "${MEMORY_API}/code-change" \
  -H "Content-Type: application/json" \
  -d "{\"files\":[],\"summary\":\"Session ended: ${REASON}\",\"category\":\"session\",\"project\":\"${PROJECT_NAME}\",\"branch\":\"${BRANCH}\"${TASK_FIELD}}" \
  --max-time 10 > /dev/null 2>&1

exit 0
