#!/bin/bash
# Itachi Memory - PostToolUse Hook (Write|Edit)
# Fixed: regex handles space after colon, no jq dependency

MEMORY_API="https://eliza-claude-production.up.railway.app/api/memory"
PROJECT_NAME=$(basename "$PWD")

# Detect git branch
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
[ -z "$BRANCH" ] && BRANCH="main"

# Task ID from orchestrator (empty for manual sessions)
TASK_ID="${ITACHI_TASK_ID:-}"

# Read JSON input from stdin
INPUT=$(cat)

# Extract file_path using node (portable, no jq needed)
FILE_PATH=$(node -e "try{const j=JSON.parse(process.argv[1]);console.log(j.tool_input&&j.tool_input.file_path||'')}catch(e){}" "$INPUT" 2>/dev/null)

# Skip if no file path
if [ -z "$FILE_PATH" ]; then
    exit 0
fi

# Get just the filename
FILENAME=$(basename "$FILE_PATH")

# Auto-categorize
CATEGORY="code_change"
case "$FILENAME" in
    *.test.*|*.spec.*|test_*|test-*) CATEGORY="test" ;;
    *.md|*.rst|*.txt|README*) CATEGORY="documentation" ;;
    package.json|requirements.txt|Cargo.toml|go.mod|pom.xml|Gemfile|*.csproj) CATEGORY="dependencies" ;;
esac

SUMMARY="Updated $FILENAME"

# Build JSON body with optional task_id
TASK_FIELD=""
if [ -n "$TASK_ID" ]; then
    TASK_FIELD=",\"task_id\":\"${TASK_ID}\""
fi

# Send to memory API
curl -s -k -X POST "${MEMORY_API}/code-change" \
  -H "Content-Type: application/json" \
  -d "{\"files\":[\"${FILENAME}\"],\"summary\":\"${SUMMARY}\",\"category\":\"${CATEGORY}\",\"project\":\"${PROJECT_NAME}\",\"branch\":\"${BRANCH}\"${TASK_FIELD}}" \
  --max-time 10 > /dev/null 2>&1

exit 0
