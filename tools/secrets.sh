#!/bin/bash
# Itachi Secrets - Unix wrapper
# Usage: ./secrets.sh push|pull|list|delete [args...]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
JS_PATH="$SCRIPT_DIR/dist/itachi-secrets.js"

if [ ! -f "$JS_PATH" ]; then
    echo "Building itachi-secrets..."
    cd "$SCRIPT_DIR" && npx tsc
fi

node "$JS_PATH" "$@"
