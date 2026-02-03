# Itachi Init Skill

Use this skill when the user runs /itachi-init to add memory system documentation to their project's CLAUDE.md file.

## When to Use

- User runs /itachi-init
- User wants to add memory system docs to CLAUDE.md
- User wants to initialize Itachi memory for a project

## Instructions

When the user runs /itachi-init:

1. Check if .claude/CLAUDE.md exists in the current project directory
2. If it does not exist, tell the user: "No CLAUDE.md found. Run /init first to generate project context, then run /itachi-init to add memory system docs."
3. If it exists, check if it already contains the text "## Memory System"
4. If it already contains "## Memory System", tell the user: "Memory system section already present in CLAUDE.md"
5. If it does not contain "## Memory System", append the following section to the end of .claude/CLAUDE.md:

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

6. After appending, confirm to the user: "Memory system section added to CLAUDE.md"
