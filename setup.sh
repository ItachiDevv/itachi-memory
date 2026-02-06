#!/bin/bash
# Itachi Memory System - Setup (delegates to Node.js)
# Usage: bash setup.sh [--hooks-only]
if ! command -v node >/dev/null 2>&1; then echo "Install Node.js first (brew install node / apt install nodejs)"; exit 1; fi
node "$(dirname "$0")/setup.mjs" "$@"
