# Itachi Memory & RLM Improvement Plan

## Research Sources Analyzed

| Source | Type | Key Insight |
|--------|------|-------------|
| [claude-subconscious](https://github.com/letta-ai/claude-subconscious) | Claude Code plugin | Structured memory blocks + async transcript processing via Letta agent |
| [claude-supermemory](https://github.com/supermemoryai/claude-supermemory) | Claude Code plugin | Signal keyword filtering + automatic session summarization |
| [claude-mem](https://github.com/thedotmack/claude-mem/) | Claude Code plugin | AI-compressed observations + 3-layer progressive disclosure + SQLite/ChromaDB |
| [Rowboat](https://github.com/rowboatlabs/rowboat) | Knowledge graph | Pre-computed structured notes + entity resolution + tiered strictness |
| [@chiefofautism tweet](https://x.com/chiefofautism/status/2029117265141252556) | Discussion | Autonomous memory injection |
| [@atlasforgeai tweet](https://x.com/atlasforgeai/status/2026380335249002843) | Article | Nine Meta-Learning Loops: failure-to-guardrail, trust-scored memory, prediction-outcome calibration |

---

## Current System Assessment

### What itachi-memory already does well
- **Cross-machine orchestration**: Supabase + Hetzner VPS + multiple executor targets (mac, surface, coolify)
- **No external dependency**: Local MEMORY.md works offline, zero latency
- **Transparent and editable**: Users can directly read/edit memory files
- **Session hooks**: Start/end hooks capture session context, inject briefings
- **Task pipeline**: Telegram -> Supabase queue -> SSH executor -> result notification
- **Transcript analysis**: `analyzeAndStoreTranscript()` extracts insights post-session

### What's missing
1. **Memory is flat and unstructured**: Single MEMORY.md grows unboundedly, all injected every session
2. **No automatic observation capture**: Relies on manual memory writes during sessions
3. **No semantic search**: Can't query past sessions by meaning, only by keyword
4. **No signal filtering**: No distinction between important vs routine information
5. **No differential injection**: Full MEMORY.md injected every prompt, wasting context tokens
6. **No cross-session learning loop**: RLM service exists but isn't deeply integrated with memory
7. **Session-end hook is fragile**: 1.5s timeout + stdin blocking issues (partially fixed)
8. **No structured session summaries**: Session end captures minimal metadata

---

## Improvement Plan: 3 Phases

### Phase 1: Structured Memory & Automatic Capture (1-2 weeks)

**Goal**: Replace flat MEMORY.md with structured, typed memory blocks and automate capture.

#### 1.1 Structured Memory Blocks (inspired by claude-subconscious)

Replace single MEMORY.md with typed sections in a `memory/` directory:

```
~/.claude/projects/<project>/memory/
  core.md           # Architecture, key decisions, critical config
  machine-state.md  # Per-machine state (SSH, services, auth)
  patterns.md       # Recurring patterns, debugging insights
  preferences.md    # User workflow preferences
  pending.md        # Unfinished work, TODOs
  session-log.md    # Recent session summaries (rolling, capped at ~50)
```

Each block has a **max line limit** (e.g., 200 lines). When a block exceeds its limit, older entries are archived or pruned.

**Implementation**:
- Update `session-start.sh` to inject only relevant blocks based on project context
- Update `session-end.sh` to route extracted insights to the appropriate block file
- Keep backward-compatible MEMORY.md as an auto-generated index linking to block files

#### 1.2 Automatic Session Summaries (inspired by claude-mem + supermemory)

On session end, extract structured summaries from the transcript:

```json
{
  "request": "What the user asked for",
  "investigated": "What was explored",
  "learned": "Key discoveries",
  "completed": "What was accomplished",
  "next_steps": "What remains",
  "files_changed": ["list of files"],
  "decisions": ["key decisions made"]
}
```

**Implementation**:
- The session-end hook already reads the transcript and sends it to the brain server
- Enhance `code-intel/extract-insights` endpoint to return structured summaries
- Store summaries in `session-log.md` with timestamps
- The Eliza brain can process these summaries into permanent knowledge

#### 1.3 Signal Keyword Filtering (inspired by supermemory)

Only capture "important" turns from transcripts. Scan for signal keywords:

```
SIGNAL_KEYWORDS = [
  "remember", "important", "bug", "fix", "solution", "decision",
  "pattern", "convention", "gotcha", "workaround", "TODO", "FIXME",
  "never", "always", "critical", "root cause", "discovered"
]
```

When a signal keyword is detected, capture that turn plus 2-3 turns of surrounding context.

**Implementation**:
- Add to `transcript-analyzer.ts` as a filtering step before sending to the API
- Reduces transcript volume by ~70% while keeping the important parts

#### 1.4 PostToolUse Hook for Automatic Observation (inspired by claude-mem)

Add a lightweight `PostToolUse` hook (matched on `Write|Edit|Bash`) that logs:
- What file was changed and why
- What commands were run
- Key decisions made during tool use

This doesn't need AI compression initially -- just structured logging to a local `.claude/observations.jsonl` file that the session-end hook can reference.

**Implementation**:
- Create `hooks/unix/after-edit.sh` (already exists for file sync)
- Extend it to append a one-line JSON observation to `~/.claude/observations.jsonl`
- Session-end hook reads observations and includes them in the summary

---

### Phase 2: Smart Retrieval & RLM Integration (2-3 weeks)

**Goal**: Move from "inject everything" to "inject what's relevant" and close the learning loop.

#### 2.1 Differential Injection (inspired by claude-subconscious)

Track what was injected at session start. On subsequent prompts (UserPromptSubmit hook), only inject changes:

```
First prompt:  Inject all memory blocks (full context)
Later prompts: Inject only blocks that changed since last injection (diff)
```

**Implementation**:
- `UserPromptSubmit` hook: compare current block files against cached versions
- Only inject changed sections, formatted as diffs
- Cache current state in a session-scoped temp file

#### 2.2 Supabase Vector Search (inspired by claude-mem)

Use Supabase's built-in pgvector extension for semantic memory search:

```sql
-- Store memory embeddings
CREATE TABLE memory_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  embedding VECTOR(1536),
  project TEXT,
  category TEXT, -- 'observation', 'decision', 'pattern', 'fact'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Semantic search function
CREATE FUNCTION search_memories(query_embedding VECTOR(1536), match_count INT)
RETURNS TABLE (content TEXT, similarity FLOAT)
AS $$
  SELECT content, 1 - (embedding <=> query_embedding) AS similarity
  FROM memory_embeddings
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$ LANGUAGE SQL;
```

**Implementation**:
- Use the existing OpenAI API key (already configured for embeddings) to generate vectors
- Session-end hook: embed extracted insights and store in Supabase
- Session-start hook: embed the project context + recent changes, retrieve top-N relevant memories
- This replaces the "inject everything" approach with targeted retrieval

#### 2.3 RLM Feedback Loop (inspired by @atlasforgeai's Nine Meta-Learning Loops)

Close the reinforcement learning loop between the Eliza brain and Claude Code sessions:

**Loop 1: Failure-to-Guardrail Pipeline**
- When a session fails (exit code != 0, error in transcript), extract the failure pattern
- Convert to a guardrail: "When doing X, always check Y first"
- Store in `patterns.md` with a confidence score
- Inject at session start for relevant projects

**Loop 2: Prediction-Outcome Calibration**
- Session-start hook injects predictions: "This task should take ~30 min and modify files X, Y"
- Session-end hook compares: actual duration, actual files changed
- Over time, calibrate prediction accuracy
- Store calibration data in Supabase for the brain to learn from

**Loop 3: Trust-Scored Memory Tiers**
- New observations start at trust=0.5
- Confirmed across multiple sessions: trust increases
- Contradicted or corrected: trust decreases
- Only high-trust memories (>0.7) get injected by default
- Low-trust memories require explicit search

**Implementation**:
- Extend the existing `rlm-service.ts` in the Eliza brain
- Add a `memory_trust_scores` table in Supabase
- Session hooks read/write trust scores alongside memories

#### 2.4 Eliza Brain Integration

The Eliza brain should actively process memories, not just store them:

**Brain Loop Enhancement** (extend existing `brain-loop-service.ts`):
- Every cycle, the brain reviews recent session summaries
- Identifies cross-session patterns: "User keeps fixing the same bug in module X"
- Generates improvement proposals: "Add a lint rule for pattern Y"
- Creates guardrails from repeated failures
- Updates memory blocks with synthesized knowledge

**Implementation**:
- Add a `processSessions` step to the brain loop
- Use the existing task system to queue brain-generated improvement tasks
- Eliza can create "self-improvement" tasks that update hooks, CLAUDE.md, or memory files

---

### Phase 3: Knowledge Graph & Advanced Features (3-4 weeks)

**Goal**: Build a connected knowledge graph across all machines, projects, and sessions.

#### 3.1 Entity-Based Knowledge Notes (inspired by Rowboat)

Instead of flat memory files, maintain structured notes per entity:

```
memory/entities/
  machines/
    mac.md           # State, config, recent sessions, known issues
    surface-win.md   # State, config, recent sessions, known issues
    hetzner-vps.md   # State, config, recent sessions, known issues
  projects/
    itachi-memory.md # Architecture, conventions, recent changes
    elizapets.md     # Architecture, conventions, recent changes
  services/
    supabase.md      # Config, endpoints, known gotchas
    coolify.md       # Deployment config, container IDs
  topics/
    ssh-auth.md      # Everything learned about SSH auth across machines
    hook-system.md   # Everything about Claude Code hooks
```

Each entity note follows a template:
- **Summary**: What this is, current state
- **Key Facts**: Verified, specific information
- **Activity Log**: Recent changes (reverse-chronological)
- **Decisions**: Why things are the way they are
- **Open Items**: Unresolved issues
- **Connections**: Links to related entities

**Implementation**:
- Session-end hook identifies entities mentioned in the session
- Updates the appropriate entity notes with new information
- Cross-references between notes use wiki-link syntax `[[machines/mac]]`
- Brain loop periodically reviews entity notes for staleness

#### 3.2 Cross-Machine Memory Sync

Currently each machine has its own MEMORY.md. Implement a sync mechanism:

- **Source of truth**: Supabase `memories` table
- **Local cache**: Auto-generated memory files per machine
- **Sync direction**: Bidirectional — local changes push to Supabase, remote changes pull on session start
- **Conflict resolution**: Last-write-wins with merge for non-overlapping changes

**Implementation**:
- Session-start hook pulls latest memories from Supabase
- Session-end hook pushes local memory changes to Supabase
- The existing `install.mjs` sync mechanism can be extended

#### 3.3 Memory Web Dashboard

Build a simple web interface for browsing and managing memories:

- View all memory entities and their relationships
- Search memories semantically
- Edit memory entries manually
- View session history and summaries
- Monitor the RLM feedback loop

**Implementation**:
- Extend the existing brain server with a web UI
- Use the Supabase data layer for backend
- Simple React app hosted on Coolify

---

## Priority Matrix

| Improvement | Impact | Effort | Priority |
|-------------|--------|--------|----------|
| 1.2 Automatic session summaries | HIGH | LOW | **P0** |
| 1.1 Structured memory blocks | HIGH | MEDIUM | **P0** |
| 1.3 Signal keyword filtering | MEDIUM | LOW | **P1** |
| 2.3 RLM failure-to-guardrail | HIGH | MEDIUM | **P1** |
| 2.1 Differential injection | MEDIUM | MEDIUM | **P1** |
| 1.4 PostToolUse observation hook | MEDIUM | LOW | **P2** |
| 2.2 Supabase vector search | HIGH | HIGH | **P2** |
| 2.4 Brain loop enhancement | HIGH | HIGH | **P2** |
| 3.1 Entity-based notes | MEDIUM | HIGH | **P3** |
| 3.2 Cross-machine sync | MEDIUM | HIGH | **P3** |
| 3.3 Memory dashboard | LOW | MEDIUM | **P3** |

---

## Quick Wins (can implement today)

1. **Structured session summaries in session-end hook**: Extract `investigated/learned/completed/next_steps` from transcript before sending to brain server
2. **Signal keyword filtering**: Add keyword list to transcript-analyzer.ts, skip turns without signals
3. **Memory block structure**: Split MEMORY.md into 5 typed files, update session-start hook to inject them
4. **Trust scoring**: Add a `confidence` field to memory entries, decay over time, boost when confirmed

---

## Architecture Diagram

```
                                    ┌─────────────────────────┐
                                    │     Supabase Cloud      │
                                    │  ┌─────────────────┐    │
                                    │  │ memory_embeddings│    │
                                    │  │ (pgvector)       │    │
                                    │  ├─────────────────┤    │
                                    │  │ memory_trust     │    │
                                    │  │ (scores + decay) │    │
                                    │  ├─────────────────┤    │
                                    │  │ session_summaries│    │
                                    │  │ (structured)     │    │
                                    │  ├─────────────────┤    │
                                    │  │ itachi_tasks     │    │
                                    │  │ (orchestration)  │    │
                                    │  └─────────────────┘    │
                                    └───────────┬─────────────┘
                                                │
                    ┌───────────────────────────┼───────────────────────────┐
                    │                           │                           │
              ┌─────▼─────┐             ┌──────▼──────┐             ┌──────▼──────┐
              │  Mac Air   │             │ Surface Win │             │ Hetzner VPS │
              │            │             │             │             │             │
              │ SessionStart│             │ SessionStart │            │ SessionStart│
              │  → inject  │             │  → inject   │             │  → inject   │
              │  memory    │             │  memory     │             │  memory     │
              │            │             │             │             │             │
              │ PostToolUse│             │ PostToolUse │             │ PostToolUse │
              │  → observe │             │  → observe  │             │  → observe  │
              │            │             │             │             │             │
              │ SessionEnd │             │ SessionEnd  │             │ SessionEnd  │
              │  → extract │             │  → extract  │             │  → extract  │
              │  → embed   │             │  → embed    │             │  → embed    │
              │  → store   │             │  → store    │             │  → store    │
              └─────┬──────┘             └──────┬──────┘             └──────┬──────┘
                    │                           │                           │
                    └───────────────────────────┼───────────────────────────┘
                                                │
                                    ┌───────────▼───────────┐
                                    │   Eliza Brain (Coolify)│
                                    │                        │
                                    │ ┌────────────────────┐ │
                                    │ │ RLM Service        │ │
                                    │ │ - failure→guardrail│ │
                                    │ │ - trust scoring    │ │
                                    │ │ - pattern mining   │ │
                                    │ ├────────────────────┤ │
                                    │ │ Brain Loop         │ │
                                    │ │ - review sessions  │ │
                                    │ │ - synthesize       │ │
                                    │ │ - propose tasks    │ │
                                    │ ├────────────────────┤ │
                                    │ │ Memory Service     │ │
                                    │ │ - store/retrieve   │ │
                                    │ │ - embed/search     │ │
                                    │ └────────────────────┘ │
                                    └────────────────────────┘
```

---

## Key Takeaways From Research

1. **claude-subconscious**: Structured memory blocks > flat files. Async transcript processing via detached workers. Differential injection saves tokens.

2. **claude-supermemory**: Signal keyword filtering keeps memory lean. Separate personal vs project memory. Automatic session summarization is the highest-impact feature.

3. **claude-mem**: AI-compressed observations (raw tool output -> structured notes) give 10x token savings. 3-layer progressive disclosure (search -> timeline -> full). SQLite + vector search is the right local stack.

4. **Rowboat**: Pre-computed entity notes beat on-demand retrieval. Knowledge index injection eliminates search latency. Tiered strictness (high/medium/low) prevents noise.

5. **Nine Meta-Learning Loops**: Failure-to-guardrail is the most actionable loop. Trust-scored memory tiers prevent unreliable information from being injected. Prediction-outcome calibration enables self-correction.

---

*Generated by Claude Opus 4.6 on 2026-03-11 based on deep analysis of 6 memory/learning system sources.*
