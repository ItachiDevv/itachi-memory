#!/bin/bash
# Itachi Memory - PostToolUse Hook (Write|Edit)
# Fixed: regex handles space after colon, no jq dependency

MEMORY_API="https://eliza-claude-production.up.railway.app/api/memory"
PROJECT_NAME=$(basename "$PWD")

# Read JSON input from stdin
INPUT=$(cat)

# Extract file_path using node (portable, no jq needed)
# Handles both "file_path":"value" and "file_path": "value"
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

# Send to memory API
curl -s -k -X POST "${MEMORY_API}/code-change" \
  -H "Content-Type: application/json" \
  -d "{\"files\":[\"${FILENAME}\"],\"summary\":\"${SUMMARY}\",\"category\":\"${CATEGORY}\",\"project\":\"${PROJECT_NAME}\"}" \
  --max-time 10 > /dev/null 2>&1

exit 0
