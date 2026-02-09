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

# URL-encode the query (truncate to 500 chars for URL safety)
ENCODED_QUERY=$(node -e "console.log(encodeURIComponent(process.argv[1].substring(0,500)))" "$PROMPT" 2>/dev/null)
ENCODED_PROJECT=$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$PROJECT_NAME" 2>/dev/null)

# Query memory search API (5s timeout)
SEARCH_RESULT=$(curl -s -k -H "$AUTH_HEADER" \
    "${MEMORY_API}/search?query=${ENCODED_QUERY}&project=${ENCODED_PROJECT}&limit=3" \
    --max-time 5 2>/dev/null)

[ -z "$SEARCH_RESULT" ] && exit 0

# Format results as additionalContext JSON
OUTPUT=$(node -e "
try {
    const d = JSON.parse(process.argv[1]);
    if (!d.results || d.results.length === 0) process.exit(0);

    const lines = ['=== Itachi Memory Context ==='];
    for (const mem of d.results) {
        const files = (mem.files && mem.files.length > 0) ? ' (' + mem.files.join(', ') + ')' : '';
        const cat = mem.category ? '[' + mem.category + '] ' : '';
        lines.push(cat + mem.summary + files);
    }
    lines.push('=== End Memory Context ===');

    console.log(JSON.stringify({ additionalContext: lines.join('\n') }));
} catch(e) {}
" "$SEARCH_RESULT" 2>/dev/null)

if [ -n "$OUTPUT" ]; then
    echo "$OUTPUT"
fi

exit 0
