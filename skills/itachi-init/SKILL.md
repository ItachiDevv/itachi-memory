# Itachi Init Skill

Use this skill when the user runs /itachi-init to add memory system documentation to their project's CLAUDE.md file.

## When to Use

- User runs /itachi-init
- User wants to add memory system docs to CLAUDE.md
- User wants to initialize Itachi memory for a project

## Instructions

When the user runs /itachi-init:

1. Check if CLAUDE.md exists in the current project root directory (NOT .claude/CLAUDE.md — the file lives at the project root)
2. If it does not exist, tell the user: "No CLAUDE.md found. Run /init first to generate project context, then run /itachi-init to add memory system docs."
3. If it exists, check if it already contains the text "## Memory System"
4. If it already contains "## Memory System", tell the user: "Memory system section already present in CLAUDE.md"
5. If it does not contain "## Memory System", append the following section to the end of CLAUDE.md (in the project root):

---

## Memory System

This project uses the Itachi Memory System for persistent context across Claude Code sessions.

### How It Works

- All file edits are automatically synced to a cloud database
- Memories are searchable using semantic search (OpenAI embeddings)
- Context persists across sessions, computers, and time

### Commands

- /recall <query> - Search memories semantically
- /recent [limit] - Show recent changes (default: 10)
- /itachi-init - Add memory docs to CLAUDE.md

### Memory Categories

Changes are auto-categorized:
- code_change - Default for code files
- test - Test/spec files
- documentation - README, .md files
- dependencies - package.json, requirements.txt, etc.

### Disable Memory

To disable memory for this project, create a file called .no-memory in the project root.

6. After appending, register the project with the Itachi server so it appears in `/repos` and `/task`. Use Bash to run:

First, load ITACHI_API_URL from the env file if it's not already set. Use Bash (works on all platforms since Claude Code uses bash):

```bash
# Load ITACHI_API_URL from ~/.itachi-api-keys if not in environment
if [ -z "$ITACHI_API_URL" ] && [ -f "$HOME/.itachi-api-keys" ]; then
  ITACHI_API_URL=$(grep '^ITACHI_API_URL=' "$HOME/.itachi-api-keys" | cut -d= -f2-)
fi
# Fallback to orchestrator-env
if [ -z "$ITACHI_API_URL" ] && [ -f "$HOME/.claude/orchestrator-env" ]; then
  ITACHI_API_URL=$(grep '^ITACHI_API_URL=' "$HOME/.claude/orchestrator-env" | cut -d= -f2-)
fi

REPO_NAME="$(basename "$(pwd)")"
REPO_URL="$(git remote get-url origin 2>/dev/null || echo "")"
if [ -n "$ITACHI_API_URL" ]; then
  if [ -n "$REPO_URL" ]; then
    curl -sk -X POST "$ITACHI_API_URL/api/repos/register" \
      -H "Content-Type: application/json" \
      -d "{\"name\": \"$REPO_NAME\", \"repo_url\": \"$REPO_URL\"}"
  else
    curl -sk -X POST "$ITACHI_API_URL/api/repos/register" \
      -H "Content-Type: application/json" \
      -d "{\"name\": \"$REPO_NAME\"}"
  fi
else
  echo "Warning: ITACHI_API_URL not found, skipping repo registration"
fi
```

If the request fails (e.g. offline), continue — the registration is not blocking.

7. After registering, confirm to the user: "Memory system section added to CLAUDE.md and project registered with Itachi."
