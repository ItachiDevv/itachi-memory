# Session Memory Utilization & RLM Bridge

How manual Claude Code sessions automatically consume and produce memories, and how session insights feed the Recursive Learning Model.

---

## Problem

Manual Claude Code sessions (non-Telegram) captured data into ElizaOS via hooks but never *consumed* it mid-session. The MCP tools existed but Claude had no automated trigger to use them. Telegram sessions got conversation scoring, memory injection via providers, and task classification -- manual sessions got none of this.

## Solution: 4 Hook Enhancements + 2 API Endpoints + RLM Bridge + Project Rules

### 1. Per-Prompt Memory Search (`UserPromptSubmit` hook)

Every user prompt automatically triggers a semantic memory search against `itachi_memories`.

```
User types prompt
    |
    v
user-prompt-submit hook
    |-- Skip if prompt < 30 chars
    |-- GET /api/memory/search?query={prompt}&project={project}&limit=3
    |-- Output: { "additionalContext": "=== Itachi Memory Context ===\n..." }
    v
Claude sees relevant past decisions, patterns, code changes
```

- **Timeout**: 5s (graceful fail -- no output if API unreachable)
- **Injection method**: `additionalContext` JSON field (discrete, not shown as hook output)
- **Files**: `hooks/windows/user-prompt-submit.ps1`, `hooks/unix/user-prompt-submit.sh`

### 2. Auto-Memory MEMORY.md (`SessionStart` hook enhancement)

Session-start now writes briefing data to Claude's auto-memory file, which is loaded into every system prompt automatically.

```
Session starts
    |
    v
session-start hook (existing sync + briefing)
    |
    +-- NEW: Write to ~/.claude/projects/{encoded-cwd}/memory/MEMORY.md
    |
    |   ## Itachi Session Context
    |   <!-- auto-updated by itachi session-start hook -->
    |
    |   **Hot files**: path1 (5 edits), path2 (3 edits)
    |   **Active patterns**: pattern1, pattern2
    |   **Style**: naming=camelCase, imports=named
    |   **Recent decisions**: decision1, decision2
    |   **Active tasks**: [running] task description
```

- Only replaces the `## Itachi Session Context` section; preserves all other sections Claude has written
- Kept under 40 lines (well within 200-line MEMORY.md limit)
- **Path encoding**: `C:\Users\foo\my-project` -> `C--Users--foo--my-project`

### 3. Transcript Insight Extraction (`SessionEnd` hook enhancement)

Session-end now reads the JSONL transcript and posts it for LLM analysis.

```
Session ends
    |
    v
session-end hook (existing memory + complete)
    |
    +-- NEW: Read transcript JSONL
    |   ~/.claude/projects/{encoded-cwd}/{session-id}.jsonl
    |   Extract assistant messages (type: "assistant", content > 50 chars)
    |   Concatenate, truncate to 4000 chars
    |
    +-- POST /api/session/extract-insights (background process)
        {
          session_id, project, conversation_text,
          files_changed, summary, duration_ms
        }
```

- Runs as a background node process (fire-and-forget, same pattern as existing session-complete call)
- Falls back to most recently modified `.jsonl` if session ID doesn't match a file directly

### 4. Extract-Insights Endpoint

`POST /api/session/extract-insights` in `itachi-code-intel` plugin.

```
Request arrives
    |
    v
LLM (TEXT_SMALL, temperature 0.2) scores significance and extracts insights
    |
    +-- Significance scoring:
    |   0.0-0.2: Trivial changes, greetings
    |   0.3-0.5: Bug fixes, minor features
    |   0.6-0.8: Technical decisions, architectural choices
    |   0.9-1.0: Critical decisions, project pivots
    |
    +-- Insight categories: decision, pattern, bugfix, architecture, preference, learning
    |
    +-- Store each insight in itachi_memories via MemoryService
    |   (searchable by hooks, MCP tools, session briefings)
    |
    +-- RLM Bridge (if significance >= 0.7):
        Promote qualifying insights to ElizaOS native CUSTOM memories
```

**Response**: `{ success: true, significance: 0.82, insights_stored: 4, rlm_promoted: 2 }`

### 5. Metadata Pass-Through

`POST /api/memory/code-change` now accepts an optional `metadata` field, passed through to `MemoryService.storeMemory()`. This lets hooks attach significance scores and source tags directly.

---

## RLM Bridge

The Recursive Learning Model is the `itachi-self-improve` plugin's feedback loop:

```
Lesson Extractor (evaluator)  -->  ElizaOS CUSTOM memories (type: management-lesson)
                                          |
                                          v
Lessons Provider (provider)   <--  searchMemories(CUSTOM, threshold: 0.6)
                                          |
                                          v
                                   Injected into Telegram LLM context
                                          |
                                          v
                                   Better decisions over time
```

### The Problem

Session insights were stored only in `itachi_memories` (the custom table). The RLM's lessons provider searches ElizaOS's native `memories` table (`MemoryType.CUSTOM` with `metadata.type: 'management-lesson'`). Two separate memory systems, no bridge.

### The Bridge

The `extract-insights` endpoint now promotes qualifying session insights into both systems:

| Criterion | Threshold | Rationale |
|-----------|-----------|-----------|
| Significance | >= 0.7 | "Technical decisions / architectural choices" tier and above |
| Category: `preference` | -> `user-preference` | How the user likes things done (naming, tooling, workflow) |
| Category: `learning` | -> `error-handling` | What went wrong and how it was resolved |
| Category: `decision` | -> `project-selection` | Choices about approach, scope, or direction |

### Excluded from RLM

| Category | Reason |
|----------|--------|
| `pattern` | Project-specific coding patterns -- useful as itachi_memories search context, but not actionable guidance for management decisions |
| `architecture` | Structural choices -- important project facts, but the lessons provider works better with reusable heuristics, not one-off architectural records |
| `bugfix` | Routine fixes rarely produce reusable management lessons |

### Constants

```typescript
// code-intel-routes.ts
const RLM_CATEGORY_MAP: Record<string, string> = {
  preference: 'user-preference',
  learning: 'error-handling',
  decision: 'project-selection',
};
const RLM_SIGNIFICANCE_THRESHOLD = 0.7;
```

---

## Memory Dual-Write Summary

After a session with significance >= 0.7 and a `decision` insight:

| System | Table | Type | Searchable by |
|--------|-------|------|---------------|
| itachi_memories | `itachi_memories` | category: `decision` | Hooks (`/api/memory/search`), MCP tools, session briefings |
| ElizaOS native | `memories` | `CUSTOM` / `management-lesson` | Lessons provider (Telegram LLM context), reflection worker |

---

## Config

`settings.json` hook entry (installed automatically by `install.mjs`):

```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "powershell.exe -ExecutionPolicy Bypass -NoProfile -File \"~/.claude/hooks/user-prompt-submit.ps1\"",
        "timeout": 8
      }]
    }]
  }
}
```

Timeout is 8s (vs 30s for other hooks) because this runs on every prompt and must not add perceptible latency. The hook itself has a 5s HTTP timeout.

---

## Project Rules (Compaction-Resistant Learning)

Prescriptive project-specific rules that survive context compaction and persist across sessions.

### Capture

The `extract-insights` LLM prompt now also produces a `rules` array:

```json
{
  "significance": 0.7,
  "insights": [...],
  "rules": [{"rule": "Always use yarn, not npm", "confidence": 0.8}]
}
```

Rules are stored in `itachi_memories` with `category: 'project_rule'` and metadata:
- `confidence`: 0.0-1.0 (from LLM)
- `times_reinforced`: increments when the same rule is re-extracted
- `source`: `'session'`
- `first_seen` / `last_reinforced`: timestamps

### Deduplication

Before storing a new rule, semantic search existing `project_rule` entries for the same project. If the top match has similarity > 0.85, the existing rule is reinforced (counter incremented, timestamp updated, wording updated if the new version is more specific).

### Delivery

Session-start hook fetches `GET /api/project/learnings?project={project}&limit=15` and writes a `## Project Rules` section to MEMORY.md:

```markdown
## Project Rules
<!-- auto-updated by itachi session-start hook -->

- Always use yarn, not npm (reinforced 3x)
- Run tests with --no-cache flag
- The auth module requires Redis for integration tests
```

Rules are sorted by `confidence * times_reinforced` (most important first) and capped at 15.

### Why This Works

MEMORY.md is always loaded into Claude Code's system prompt, even after context compaction. This means project rules persist throughout the entire session regardless of how many compactions occur.

---

## Verification

1. **UserPromptSubmit**: Start a session, type a prompt about something worked on before -> should see memory context in transcript JSONL or via `--verbose`
2. **MEMORY.md**: After session-start, check `~/.claude/projects/{project}/memory/MEMORY.md` for `## Itachi Session Context`
3. **Session-end insights**: End a session after substantive work -> `curl /api/memory/recent?project=X` shows new `decision`/`pattern` memories with significance metadata
4. **RLM bridge**: Check ElizaOS memories table for new `management-lesson` CUSTOM entries after a high-significance session
5. **API endpoint**: `curl -X POST /api/session/extract-insights -d '{"project":"test","conversation_text":"I decided to use pgvector...","session_id":"test-1"}' -H 'Content-Type: application/json'` -> returns `{ success, significance, insights_stored, rlm_promoted, rules_stored, rules_reinforced }`
6. **Rule extraction**: End a session where you established a convention -> check `curl /api/memory/recent?project=X&category=project_rule` for new rule
7. **Rule deduplication**: End two sessions discussing the same convention -> check that `times_reinforced` incremented rather than creating a duplicate
8. **Project rules in MEMORY.md**: Start a new session -> check `~/.claude/projects/{project}/memory/MEMORY.md` for `## Project Rules` section
9. **Learnings API**: `curl /api/project/learnings?project=my-project` -> returns sorted rules
