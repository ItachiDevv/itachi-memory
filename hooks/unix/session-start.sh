#!/bin/bash
# Itachi Memory - SessionStart Hook
# Fixed: uses node instead of jq for JSON parsing

MEMORY_API="https://eliza-claude-production.up.railway.app/api/memory"
PROJECT_NAME=$(basename "$PWD")

# Fetch recent memories
RECENT=$(curl -s -k "${MEMORY_API}/recent?project=${PROJECT_NAME}&limit=5" --max-time 10 2>/dev/null)

if [ -n "$RECENT" ]; then
    # Use node to parse and format (no jq dependency)
    OUTPUT=$(node -e "
try {
    const d = JSON.parse(process.argv[1]);
    if (d.recent && d.recent.length > 0) {
        console.log('');
        console.log('=== Recent Memory Context for ${PROJECT_NAME} ===');
        d.recent.forEach(m => {
            const files = (m.files || []).join(', ') || 'none';
            console.log('[' + m.category + '] ' + m.summary + ' (Files: ' + files + ')');
        });
        console.log('=== End Memory Context ===');
        console.log('');
    }
} catch(e) {}
" "$RECENT" 2>/dev/null)

    if [ -n "$OUTPUT" ]; then
        echo "$OUTPUT"
    fi
fi

exit 0
