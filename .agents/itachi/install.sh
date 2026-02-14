#!/bin/bash
# Itachi Memory - Agent Wrapper Installer (Unix/macOS)
# Usage: ./install.sh [client]
#   client: claude, codex, aider, cursor, or any CLI name
#
# What it does:
#   1. Copies unified hooks to ~/.claude/hooks/
#   2. Creates itachi{short} wrapper in ~/.claude/ (add to PATH if not already)
#
# Examples:
#   ./install.sh codex     → creates ~/.claude/itachic with codex flags
#   ./install.sh aider     → creates ~/.claude/itachia with aider flags

set -e

CLIENT="${1:-codex}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOKS_SOURCE="$SCRIPT_DIR/hooks"
CLAUDE_DIR="$HOME/.claude"
HOOKS_DEST="$CLAUDE_DIR/hooks"

# ============ Known client configurations ============
get_config() {
    local client="$1"
    case "$client" in
        claude)
            CLI="claude"; SHORT=""; HAS_NATIVE_HOOKS=1
            # Claude flags are handled by its own wrapper (itachi)
            ;;
        codex)
            CLI="codex"; SHORT="c"; HAS_NATIVE_HOOKS=0
            FLAG_DS="--dangerously-bypass-approvals-and-sandbox"
            FLAG_FA="--full-auto"
            FLAG_C="resume --last"
            FLAG_CDS="resume --last --dangerously-bypass-approvals-and-sandbox"
            ;;
        aider)
            CLI="aider"; SHORT="a"; HAS_NATIVE_HOOKS=0
            FLAG_DS="--yes-always"
            FLAG_FA="--yes-always --auto-commits"
            FLAG_C=""
            ;;
        gemini)
            CLI="gemini"; SHORT="g"; HAS_NATIVE_HOOKS=0
            FLAG_DS="--yolo"
            FLAG_FA=""
            FLAG_C="--resume latest"
            FLAG_CDS="--resume latest --yolo"
            ;;
        cursor)
            CLI="cursor"; SHORT="cur"; HAS_NATIVE_HOOKS=0
            FLAG_DS=""; FLAG_FA=""; FLAG_C=""
            ;;
        *)
            CLI="$client"; SHORT="${client:0:3}"; HAS_NATIVE_HOOKS=0
            FLAG_DS=""; FLAG_FA=""; FLAG_C=""
            echo "[install] Unknown client '$client' — creating generic wrapper"
            ;;
    esac
}

get_config "$CLIENT"
WRAPPER_NAME="itachi${SHORT}"
echo "[install] Installing itachi wrapper for '$CLIENT' as '$WRAPPER_NAME'"

# ============ 1. Deploy unified hooks ============
mkdir -p "$HOOKS_DEST"
cp "$HOOKS_SOURCE/session-start.sh" "$HOOKS_DEST/session-start.sh"
cp "$HOOKS_SOURCE/session-end.sh" "$HOOKS_DEST/session-end.sh"
chmod +x "$HOOKS_DEST/session-start.sh" "$HOOKS_DEST/session-end.sh"

# Also copy PS1 versions for cross-platform support
if [ -f "$HOOKS_SOURCE/session-start.ps1" ]; then
    cp "$HOOKS_SOURCE/session-start.ps1" "$HOOKS_DEST/session-start.ps1"
    cp "$HOOKS_SOURCE/session-end.ps1" "$HOOKS_DEST/session-end.ps1"
fi
echo "[install] Deployed unified hooks to $HOOKS_DEST"

# ============ 2. Skip wrapper for Claude ============
if [ "$HAS_NATIVE_HOOKS" = "1" ]; then
    echo "[install] Claude uses native hooks via settings.json — no external wrapper needed"
    echo "[install] Done! The unified hooks will be called by Claude's hook system."
    exit 0
fi

# ============ 3. Generate bash wrapper ============
WRAPPER_PATH="$CLAUDE_DIR/$WRAPPER_NAME"

cat > "$WRAPPER_PATH" << 'WRAPPER_HEADER'
#!/bin/bash
# Itachi Memory System - CLI wrapper (auto-generated)
# All sessions go through hooks (wrapper-managed lifecycle)

# Utility commands
case "$1" in
    clear-failed) node "$(dirname "$0")/../documents/crypto/skills-plugins/itachi-memory/orchestrator/scripts/clear-tasks.js" failed; exit ;;
    clear-done)   node "$(dirname "$0")/../documents/crypto/skills-plugins/itachi-memory/orchestrator/scripts/clear-tasks.js" completed; exit ;;
esac
WRAPPER_HEADER

# Add flag mappings
cat >> "$WRAPPER_PATH" << WRAPPER_FLAGS
# Map shortcut flags
CLI_ARGS=("\$@")
case "\$1" in
WRAPPER_FLAGS

[ -n "$FLAG_DS" ]  && echo "    --ds)  shift; CLI_ARGS=($FLAG_DS \"\$@\") ;;" >> "$WRAPPER_PATH"
[ -n "$FLAG_FA" ]  && echo "    --fa)  shift; CLI_ARGS=($FLAG_FA \"\$@\") ;;" >> "$WRAPPER_PATH"
[ -n "$FLAG_C" ]   && echo "    --c)   shift; CLI_ARGS=($FLAG_C \"\$@\") ;;" >> "$WRAPPER_PATH"
[ -n "$FLAG_CDS" ] && echo "    --cds) shift; CLI_ARGS=($FLAG_CDS \"\$@\") ;;" >> "$WRAPPER_PATH"

cat >> "$WRAPPER_PATH" << WRAPPER_BODY
esac

# Load env vars
export ITACHI_ENABLED=1
export ITACHI_CLIENT="$CLIENT"
KEYS_FILE="\$HOME/.itachi-api-keys"
if [ -f "\$KEYS_FILE" ]; then
    while IFS='=' read -r key value; do
        [[ "\$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] && export "\$key=\$value"
    done < "\$KEYS_FILE"
fi
[ -z "\$ITACHI_API_URL" ] && export ITACHI_API_URL="https://itachisbrainserver.online"

# Run session-start hook
HOOKS_DIR="\$HOME/.claude/hooks"
[ -x "\$HOOKS_DIR/session-start.sh" ] && "\$HOOKS_DIR/session-start.sh"

# Launch $CLI
$CLI "\${CLI_ARGS[@]}"
export ITACHI_EXIT_CODE=\$?

# Run session-end hook
[ -x "\$HOOKS_DIR/session-end.sh" ] && "\$HOOKS_DIR/session-end.sh"
WRAPPER_BODY

chmod +x "$WRAPPER_PATH"
echo "[install] Created $WRAPPER_PATH"

# ============ 4. Check PATH ============
if ! echo "$PATH" | tr ':' '\n' | grep -q "^$CLAUDE_DIR$"; then
    echo ""
    echo "[install] NOTE: $CLAUDE_DIR is not in your PATH."
    echo "  Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
    echo "    export PATH=\"\$HOME/.claude:\$PATH\""
fi

echo ""
echo "[install] Done! Run '$WRAPPER_NAME --ds' to start a $CLI session with itachi hooks."
