#!/bin/bash
# Itachi Memory - PostToolUse Bash Observer
# Lightweight local-only hook that logs Bash tool uses to observations.jsonl
# MUST complete in <100ms. No network calls. No LLM calls.

OBS_FILE="$HOME/.claude/observations.jsonl"

# Read stdin JSON (tool input/output from Claude Code)
INPUT=$(cat)
[ -z "$INPUT" ] && exit 0

# Use node for fast JSON parsing — extract command, exit code, output snippet
node -e "
try {
    const input = JSON.parse(process.argv[1]);
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    const obsFile = path.join(os.homedir(), '.claude', 'observations.jsonl');

    const toolName = input.tool_name || 'Bash';
    const command = (input.tool_input && input.tool_input.command) || '';
    const exitCode = input.exit_code != null ? input.exit_code : (input.tool_output_metadata && input.tool_output_metadata.exit_code != null ? input.tool_output_metadata.exit_code : null);
    const output = (typeof input.tool_output === 'string' ? input.tool_output : '').substring(0, 200);

    // Skip empty commands
    if (!command) process.exit(0);

    const entry = {
        ts: new Date().toISOString(),
        tool: toolName,
        command: command.substring(0, 300),
        exit_code: exitCode,
        output_preview: output,
        cwd: process.cwd(),
        session_id: process.env.ITACHI_SESSION_ID || null
    };

    const line = JSON.stringify(entry) + '\n';

    // Ensure directory exists
    const dir = path.dirname(obsFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Append to file
    fs.appendFileSync(obsFile, line);

    // Rotate if over 1000 lines: keep newest 500
    try {
        const content = fs.readFileSync(obsFile, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        if (lines.length > 1000) {
            const kept = lines.slice(-500);
            fs.writeFileSync(obsFile, kept.join('\n') + '\n');
        }
    } catch {}
} catch(e) {}
" "$INPUT" 2>/dev/null

exit 0
