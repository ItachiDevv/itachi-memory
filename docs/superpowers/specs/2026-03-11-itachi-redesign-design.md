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

#### 1. itachi-memory (keep, clean up)
- Memory service with hybrid vector + full-text search (working)
- Conversation memory evaluator (working)
- Transcript indexer worker (fixed this session)
- Identity/fact storage and retrieval (working)
- **Remove:** Anything redundant with itachi-code-intel (merge relevant parts in)

#### 2. itachi-tasks (major rework)
- **Session Operator Service** (NEW — the core of the redesign)
- Task creation from natural language
- Machine management (SSH connectivity)
- **Remove:** All command-based task creation, manual dispatch logic

#### 3. itachi-self-improve (keep, tune)
- Personality extractor (working)
- Lesson extractor (fixed — now samples every 5th message)
- Reflection worker (working, needs data)
- Effectiveness worker (fixed — lowered thresholds)
- Personality/lessons providers (working)
- **Remove:** Nothing — this plugin is clean

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
   - Known footguns and patterns
   - Active related work

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
Session-start hook generates a dynamic briefing injected into Claude Code context:
- What repo, what was last worked on
- Relevant lessons: "last time auth was touched, X broke — the fix was Y"
- Active tasks and priorities from Telegram
- Known footguns in this codebase

Generated by querying itachi_memories for the current repo/project, not a static file.

### (b) Post-session review
Session-end hook sends transcript to the brain. Itachi sends Itachisan a Telegram message:
- What was accomplished
- Inefficiencies spotted: "spent 20 min debugging X but the answer was in the error message"
- Suggestions for next time
- Questions to learn from (optional, not every session)

### (c) Real-time shadow
Lightweight file watcher tails the active `.jsonl` transcript on the local machine. When it detects:
- Repeated errors / stuck loops
- Approaching a known footgun from memory
- A pattern that failed in past sessions

It sends a Telegram nudge. Not every message — only when it has genuine signal.

### (d) On-demand consult
Itachisan messages Itachi on Telegram mid-session: "how should I handle X?"
Itachi searches memory — past sessions, lessons, code patterns — and gives an answer grounded in Itachisan's own codebases and history. Better than fresh Claude because it has accumulated context.

## Learning Pipeline (Fixed)

### Data sources
1. Session transcripts (all Claude Code sessions, all machines)
2. Telegram conversations (every message)
3. Task outcomes (success/failure tracking + what approach worked)
4. Codebase indexing (periodic git log + structure scans of active repos)

### Storage
All in Supabase `itachi_memories` table with categories:
- `identity` — Permanent core facts about Itachisan
- `conversation` — Telegram conversation summaries
- `personality_trait` — Learned communication/decision traits
- `task_lesson` — What works, what doesn't
- `project_rule` — Explicit rules from Itachisan
- `strategy_document` — Weekly synthesis
- `session_transcript` — Chunked indexed transcripts
- `fact` — Time-windowed project details

### Cycle
- **Per-session:** Extract facts, decisions, patterns, mistakes. Every session produces at least one artifact. No significance threshold for storage.
- **Daily:** Synthesize patterns, update project knowledge
- **Weekly:** Reflection — strategy documents, prune stale lessons, boost proven patterns

### Retrieval
Hybrid vector + full-text search with outcome-based reranking (existing, working). Significance threshold only applies to what gets injected into context, not what gets stored.

## Migration Path

### Phase 1: Strip and stabilize (immediate)
- Remove itachi-agents plugin entirely
- Remove itachi-sync plugin (or reduce to single utility)
- Merge itachi-code-intel into itachi-memory
- Kill all Telegram commands except natural language + /brain + /status
- Build intent router to replace command parsing
- Fix the `identity` memories: update "Newman" references to "Itachisan"

### Phase 2: Session operator (next)
- Build SessionOperatorService in itachi-tasks
- Implement multi-turn Claude Code conversation via stdin/stdout proxy
- Implement escalation flow (Claude → Itachi → Telegram → Itachisan → back)
- Implement verification step (build, test, validate)
- Test with real tasks end-to-end

### Phase 3: Session shadow (after Phase 2 works)
- Dynamic pre-session briefing generation
- Post-session review with Telegram summary
- Real-time transcript watcher with nudges
- On-demand consult grounding in memory

### Phase 4: Autonomous growth
- Itachi learns when to escalate vs handle autonomously
- Codebase indexing for active repos
- Daily/weekly synthesis workers tuned with real data
- Itachi proposes its own improvements to its codebase

## Success Criteria

After Phase 2:
- Itachisan can say "implement X for Y repo" on Telegram and Itachi handles it end-to-end
- Tasks that currently fail at dispatch succeed >80% of the time
- Itachi tests its own work before reporting success

After Phase 3:
- Pre-session briefings are noticeably useful (not generic)
- Post-session reviews catch real inefficiencies
- On-demand consult gives better answers than fresh Claude

After Phase 4:
- Itachi handles routine tasks without escalation
- Learning is visible — answers and approaches improve week over week
- Itachi is genuinely smarter about Itachisan's codebases than a fresh Claude session
