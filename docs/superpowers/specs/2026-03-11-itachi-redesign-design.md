# Itachi Architecture Redesign — Design Spec

**Date:** 2026-03-11
**Status:** Draft
**Author:** Itachisan + Claude

## Vision

Itachi is a personal AI clone and autonomous engineering assistant — a digital extension of Itachisan. It learns from every coding session, converses naturally on Telegram, executes tasks by operating Claude Code sessions like a developer, and gets smarter over time. In one month it should be a better coder than Itachisan, while maintaining his personality, values, and decision-making style.

## Core Principles

1. **Natural language only** — No command syntax. Every Telegram message is natural conversation.
2. **Session operator, not task dispatcher** — Itachi runs multi-turn Claude Code sessions, evaluates output, tests, iterates. Not fire-and-forget.
3. **Always learning** — Every session produces learning artifacts. Store everything, surface selectively.
4. **Always verifying** — Itachi tests its own work. Build, run tests, write tests for significant changes, verify behavior. Never self-report success without validation.
5. **Escalate intelligently** — Early on, ask Itachisan more. Over time, handle more autonomously based on learned patterns.
6. **Simplify ruthlessly** — Strip the current 7 plugins and 15+ commands down to what works.

## Architecture: Simplified ElizaOS

### Plugins (3, down from 7)

#### 1. itachi-memory (keep, clean up, absorb itachi-code-intel)
- Memory service with hybrid vector + full-text search (working)
- Conversation memory evaluator (working)
- Transcript indexer worker (fixed this session)
- Identity/fact storage and retrieval (working)
- Session/insight extraction routes (merged from itachi-code-intel)
- **New:** Structured memory blocks (replaces flat MEMORY.md)
- **New:** Automatic session summaries
- **New:** Signal keyword filtering for transcript processing
- **New:** Trust-scored memory tiers
- **New:** Differential context injection

#### 2. itachi-tasks (major rework)
- **Session Operator Service** (NEW — the core of the redesign)
- Task creation from natural language
- Machine management (SSH connectivity)
- **New:** PostToolUse observation hook integration
- **Remove:** All command-based task creation, manual dispatch logic

#### 3. itachi-self-improve (keep, tune)
- Personality extractor (working)
- Lesson extractor (fixed — now samples every 5th message)
- Reflection worker (working, needs data)
- Effectiveness worker (fixed — lowered thresholds)
- Personality/lessons providers (working)
- **New:** RLM failure-to-guardrail pipeline
- **New:** Prediction-outcome calibration
- **Remove:** Nothing else — this plugin is clean

### Plugins to eliminate or merge

- **itachi-code-intel** → Merge session/insight extraction into itachi-memory. The brain server API routes stay but the plugin wrapper is unnecessary.
- **itachi-tester** → Fold into session operator. Itachi tests as part of every session, not as a separate scheduled suite.
- **itachi-agents** → Remove entirely. Subagent spawning is over-engineered. Itachi IS the agent.
- **itachi-sync** → Remove or reduce to a single file-sync utility if needed.

### Telegram Interface

**Kill all commands except:**
- Natural language (default) — Talk, ask questions, give tasks
- `/brain` — Toggle autonomous mode on/off
- `/status` — What's running right now

**Intent Router** (replaces command parsing):
Every message goes through the LLM with Itachi's full context. Classification:
- **conversation** — Respond naturally, store in memory
- **task** — Spawn a session operator instance
- **question-about-code** — Search memory + codebase knowledge, answer grounded in history
- **feedback** — Extract lesson, update preferences

No regex. No command parsing. The LLM IS the router.

## Session Operator Service (the big new piece)

### What it does

Operates Claude Code sessions the way a developer would — multi-turn conversations, evaluation, testing, iteration.

### Session lifecycle

1. **Receive task** from intent router (natural language, already parsed)

2. **Build context package:**
   - Repo structure and recent changes (from memory + git)
   - Relevant past sessions and lessons
   - Itachisan's preferences for this codebase
   - Known footguns and patterns (from guardrail pipeline)
   - Active related work
   - Trust-filtered memories relevant to the task

3. **Spawn Claude Code session** on the appropriate machine via SSH/local:
   - No flags by default. Itachi drives the session conversationally.
   - Itachi decides when to request plan mode based on task complexity and its learned judgment.
   - Itachi decides when to ask Claude to think harder based on the problem.

4. **Multi-turn conversation with Claude:**
   - Start by understanding the codebase: "Look at X and tell me what we have"
   - Give incremental instructions based on Claude's responses
   - Push back when Claude's approach doesn't match known patterns: "That's not right, look at src/auth/token.ts"
   - Evaluate intermediate outputs before proceeding

5. **Escalation to Itachisan** (via Telegram):
   - Architectural decisions Itachi hasn't seen approved before
   - Multiple valid approaches where preference matters
   - Itachi is unsure or Claude is stuck
   - Always includes Itachi's own recommendation alongside options
   - As confidence builds, Itachi handles more autonomously

6. **Verification — ALWAYS:**
   - Build/compile the project
   - Run existing test suites
   - Write new tests for significant changes
   - Verify the feature actually works (not just "no errors")
   - If anything fails, iterate with Claude to fix it

7. **Completion:**
   - Commit/PR with meaningful message
   - Send Itachisan a summary: what changed, diff link, anything notable
   - Extract lessons from the session for future learning
   - Record prediction vs outcome for calibration

### Judgment layer

Itachi learns when to:
- Use plan mode (complex multi-file changes, unfamiliar code, architectural decisions)
- Use extended thinking (debugging, complex logic, design decisions)
- Escalate to Itachisan (unknown territory, preference-dependent choices)
- Push back on Claude (output doesn't match codebase patterns)
- Run additional tests (significant changes, areas with known fragility)

This judgment improves over time by observing Itachisan's own session patterns and recording which approaches succeed.

## The Four Session Shadow Layers

### (a) Pre-session briefing
Session-start hook generates a **dynamic, structured briefing** injected into Claude Code context:
- What repo, what was last worked on
- Relevant lessons: "last time auth was touched, X broke — the fix was Y"
- Active tasks and priorities from Telegram
- Known footguns and guardrails for this codebase
- Only injects relevant memory blocks, not everything (differential injection)

Generated by querying itachi_memories for the current repo/project with trust-filtered retrieval. Uses structured memory blocks instead of flat MEMORY.md.

### (b) Post-session review
Session-end hook extracts a **structured summary**:
```json
{
  "request": "What Itachisan asked for",
  "investigated": "What was explored",
  "learned": "Key discoveries",
  "completed": "What was accomplished",
  "next_steps": "What remains",
  "files_changed": ["list of files"],
  "decisions": ["key decisions made"],
  "prediction_accuracy": "how close was the pre-session estimate"
}
```

Itachi sends a Telegram message:
- What was accomplished
- Inefficiencies spotted: "spent 20 min debugging X but the answer was in the error message"
- Suggestions for next time
- Questions to learn from (optional, not every session)

Summary stored in session-log block with timestamp. Brain processes into permanent knowledge.

### (c) Real-time shadow
Lightweight file watcher tails the active `.jsonl` transcript on the local machine. When it detects:
- Repeated errors / stuck loops
- Approaching a known footgun from memory
- A pattern that failed in past sessions
- Signal keywords indicating important decisions being made

It sends a Telegram nudge. Not every message — only when it has genuine signal.

### (d) On-demand consult
Itachisan messages Itachi on Telegram mid-session: "how should I handle X?"
Itachi searches memory — past sessions, lessons, code patterns — and gives an answer grounded in Itachisan's own codebases and history. Uses trust-scored retrieval so only reliable memories inform the answer.

## Memory System (merged from memory-improvement-plan.md)

### Structured Memory Blocks

Replace flat MEMORY.md with typed sections:

```
~/.claude/projects/<project>/memory/
  core.md           # Architecture, key decisions, critical config
  machine-state.md  # Per-machine state (SSH, services, auth)
  patterns.md       # Recurring patterns, debugging insights, guardrails
  preferences.md    # Itachisan's workflow preferences
  pending.md        # Unfinished work, TODOs
  session-log.md    # Recent session summaries (rolling, capped at ~50)
```

Each block has a **max line limit** (e.g., 200 lines). When a block exceeds its limit, older entries are archived or pruned. Session-start hook injects only relevant blocks based on project context instead of dumping everything.

### Signal Keyword Filtering

Only capture "important" turns from transcripts:
```
SIGNAL_KEYWORDS = [
  "remember", "important", "bug", "fix", "solution", "decision",
  "pattern", "convention", "gotcha", "workaround", "TODO", "FIXME",
  "never", "always", "critical", "root cause", "discovered"
]
```

When a signal keyword is detected, capture that turn plus 2-3 turns of surrounding context. Reduces transcript volume by ~70% while keeping the important parts.

### Automatic Session Summaries

Every session-end produces a structured summary (see section b above). No significance threshold for storage — every session gets summarized. The summary is stored in `session-log.md` and in Supabase. Brain processes summaries into permanent knowledge.

### Trust-Scored Memory Tiers

All memories get a trust score:
- New observations start at trust=0.5
- Confirmed across multiple sessions: trust increases
- Contradicted or corrected: trust decreases
- Only high-trust memories (>0.7) get injected into context by default
- Low-trust memories are still stored and available via explicit search

### Differential Context Injection

Track what was injected at session start. On subsequent prompts (if using UserPromptSubmit hook), only inject changes:
- First prompt: Inject all relevant memory blocks (full context)
- Later prompts: Inject only blocks that changed since last injection

### PostToolUse Observation Hook

Lightweight hook matched on `Write|Edit|Bash` that logs:
- What file was changed and why
- What commands were run
- Key decisions made during tool use

Structured logging to `~/.claude/observations.jsonl`. Session-end hook reads observations and includes them in the summary.

### RLM Feedback Loops

#### Failure-to-Guardrail Pipeline
When a session fails or a task outcome is negative:
1. Extract the failure pattern
2. Convert to a guardrail: "When doing X, always check Y first"
3. Store in `patterns.md` with a confidence score
4. Inject at session start for relevant projects
5. Over time, Itachi avoids known failure modes automatically

#### Prediction-Outcome Calibration
- Session-start briefing includes predictions: "This task should take ~30 min and modify files X, Y"
- Session-end compares: actual duration, actual files changed
- Over time, calibrate prediction accuracy
- Feeds into the judgment layer — Itachi gets better at estimating complexity

### Storage

All in Supabase `itachi_memories` table with categories:
- `identity` — Permanent core facts about Itachisan
- `conversation` — Telegram conversation summaries
- `personality_trait` — Learned communication/decision traits
- `task_lesson` — What works, what doesn't
- `project_rule` — Explicit rules from Itachisan
- `strategy_document` — Weekly synthesis
- `session_transcript` — Chunked indexed transcripts
- `session_summary` — Structured per-session summaries
- `guardrail` — Failure-derived guardrails with confidence scores
- `fact` — Time-windowed project details
- `observation` — PostToolUse structured logs

### Learning Cycle
- **Per-session:** Extract structured summary, observations, facts, decisions, patterns, mistakes. Every session produces at least one artifact. No significance threshold for storage.
- **Daily:** Synthesize patterns, update project knowledge, generate guardrails from failures
- **Weekly:** Reflection — strategy documents, prune stale lessons, boost proven patterns, calibrate predictions

### Retrieval
Hybrid vector + full-text search with:
- Trust-score filtering (only high-trust by default)
- Outcome-based reranking (success boosted, failure demoted)
- Recency weighting
- Category-based boosting (guardrails and project_rules ranked higher)

Significance threshold only applies to context injection, not storage.

## Migration Path

### Phase 1: Strip, stabilize, and structure memory (immediate)
- Remove itachi-agents plugin entirely
- Remove itachi-sync plugin (or reduce to single utility)
- Merge itachi-code-intel into itachi-memory
- Kill all Telegram commands except natural language + /brain + /status
- Build intent router to replace command parsing
- Fix the `identity` memories: update "Newman" references to "Itachisan"
- **Replace flat MEMORY.md with structured memory blocks**
- **Implement automatic session summaries in session-end hook**
- **Add signal keyword filtering to transcript processing**

### Phase 2: Session operator + RLM loops (next)
- Build SessionOperatorService in itachi-tasks
- Implement multi-turn Claude Code conversation via stdin/stdout proxy
- Implement escalation flow (Claude → Itachi → Telegram → Itachisan → back)
- Implement verification step (build, test, validate)
- **Implement trust-scored memory tiers**
- **Implement failure-to-guardrail pipeline**
- **Add PostToolUse observation hook**
- Test with real tasks end-to-end

### Phase 3: Session shadow + smart retrieval (after Phase 2 works)
- Dynamic pre-session briefing generation with **differential injection**
- Post-session review with Telegram summary
- Real-time transcript watcher with nudges
- On-demand consult grounding in memory
- **Prediction-outcome calibration**

### Phase 4: Autonomous growth + knowledge graph (later)
- Itachi learns when to escalate vs handle autonomously
- Codebase indexing for active repos
- Daily/weekly synthesis workers tuned with real data
- Itachi proposes its own improvements to its codebase
- **Entity-based knowledge notes** (per-machine, per-project, per-service structured notes)
- **Cross-machine memory sync** (Supabase as source of truth, local caches)
- **Memory web dashboard** (browse, search, edit memories via web UI)

## Success Criteria

**After Phase 1:**
- Memory is structured and browsable, not a flat dump
- Every session produces a structured summary automatically
- Telegram works with natural language — no commands needed
- Plugins reduced from 7 to 3

**After Phase 2:**
- Itachisan says "implement X for Y repo" on Telegram → Itachi handles it end-to-end
- Tasks that currently fail succeed >80% of the time
- Itachi tests its own work before reporting success
- Guardrails prevent repeated failures
- Trust scores filter noisy/unreliable memories from context

**After Phase 3:**
- Pre-session briefings are noticeably useful (not generic)
- Post-session reviews catch real inefficiencies
- On-demand consult gives better answers than fresh Claude
- Prediction accuracy improves measurably over time

**After Phase 4:**
- Itachi handles routine tasks without escalation
- Learning is visible — answers and approaches improve week over week
- Itachi is genuinely smarter about Itachisan's codebases than a fresh Claude session
- Entity knowledge graph provides structured, queryable project knowledge
- All machines share the same memory state
