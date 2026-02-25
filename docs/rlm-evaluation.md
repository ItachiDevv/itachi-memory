# RLM Pipeline Evaluation — Feb 25, 2026

## Overview

This document evaluates the effectiveness of the Recursive Learning Model (RLM) pipeline across both **Telegram-initiated sessions** and **local Claude Code sessions** started via the `itachi` wrapper.

---

## Memory Store Status

**Total memories**: 201 (itachi-memory project)

| Category | Count | Source | Healthy? |
|----------|-------|--------|----------|
| session | 58 | SessionEnd hook | Yes — logs every session exit |
| conversation | 49 | Telegram conversationMemory evaluator | Yes — captures Telegram exchanges |
| fact | 33 | conversationMemory evaluator (deduped) | Yes — identity + contextual facts |
| task_lesson | 15 | lessonExtractor + extract-insights | Partial — see below |
| project_rule | 10 | /learn + task_transcript extraction | Yes |
| workflow | 7 | task_transcript extraction | Yes |
| code_change | 5 | after-edit hook | **LOW** — see issues |
| error_recovery | 4 | task_transcript extraction | Yes |
| pattern / pattern_observation | 6 | task_transcript + code-intel | Yes |
| documentation | 3 | after-edit hook | Yes |
| test | 2 | after-edit hook | Yes |
| identity | 2 | conversationMemory (promoted facts) | Yes |
| repo_expertise | 1 | repoExpertise worker | Yes |
| Others (cli_pattern, architecture, bug_fix, decision, learning) | 6 | Various | Yes |

---

## Pipeline Health by Stage

### 1. Data Ingestion — SessionStart Hook

**Status: WORKING**

- Fetches briefing, project rules, recent memories
- Writes MEMORY.md with structured context
- Syncs encrypted files on pull

**Evidence**: Every session starts with briefing data. Session-start hook runs for both:
- Local `itachi` wrapper sessions (native Claude hooks in settings.json)
- SSH/headless sessions via `itachi.cmd` (wrapper runs hook explicitly)

### 2. Data Ingestion — UserPromptSubmit Hook

**Status: WORKING for local sessions, NOT APPLICABLE for Telegram sessions**

- Searches semantic memory on each user prompt (>30 chars)
- Injects top 5 results as `additionalContext`

**Key point**: This hook only fires for **local Claude Code sessions**. Telegram sessions get context via ElizaOS providers (positions 3-20), not via this hook.

### 3. Data Ingestion — PostToolUse (after-edit) Hook

**Status: PARTIALLY WORKING — Low code_change count (only 5)**

- Fires on every Write/Edit in Claude Code
- Posts to `/api/memory/code-change` and `/api/session/edit`

**Issue**: Only 5 `code_change` memories in the entire database despite hundreds of edits over 2+ weeks. Possible causes:
1. **Hook timeout** (30s) may be too short for large edits
2. **API errors silently swallowed** — hooks catch all errors silently
3. **Hook may not fire for SSH sessions** — `itachi.cmd` doesn't configure native PostToolUse hooks (only runs SessionStart/End manually). The native hooks from `settings.json` only apply when Claude reads the settings file at startup, which requires the settings.json to be present on the target machine.

**Recommendation**: Add logging/diagnostics to after-edit hook. Verify it fires on Windows interactive sessions.

### 4. Data Ingestion — SessionEnd Hook

**Status: WORKING**

- 58 session entries logged
- Posts session completion metadata
- Extracts transcript insights (background)

**Evidence**: Session entries from multiple branches (master, task/* branches) confirm both local and task-initiated sessions are logging.

### 5. Transcript Insight Extraction

**Status: WORKING for task sessions, UNCLEAR for local sessions**

- `source=task_transcript` entries exist (project_rule, pattern, error_recovery, workflow)
- These come from the session-end hook's background POST to `/api/session/extract-insights`

**Issue**: Most `task_transcript` entries are from Feb 24 (task-initiated sessions). No visible `task_transcript` entries from local interactive sessions. The session-end hook DOES attempt transcript extraction, but:
1. It finds the latest `.jsonl` transcript file
2. Extracts assistant text blocks
3. Posts to extract-insights API
4. The API runs LLM analysis and stores if significance >= 0.7

**Possible gap**: Local sessions on Windows may have transcripts in a different path encoding than what the hook expects, or the transcript may be too short to score >= 0.7 significance.

### 6. Lesson Extraction (Telegram)

**Status: WORKING**

- 15 `task_lesson` entries from `lesson_extractor` evaluator
- Includes confidence scores, outcomes (success/partial/failure), lesson categories
- Categories: project-selection, tool-selection, error-handling, task-estimation

### 7. Lesson Recall (lessonsProvider)

**Status: WORKING**

- Provider injects top lessons into every LLM call
- Ranking formula: `relevance × confidence × recency_decay × reinforcement_bonus`
- Caps at 8 task_lessons + 3 project_rules

### 8. Lesson Reinforcement

**Status: NOT ACTIVELY REINFORCING**

- All project_rules have `times_reinforced: 1` (initial)
- All task_lessons have base confidence (0.67-0.95) but no reinforcement increments
- The `/feedback` command exists but isn't being used regularly

**Recommendation**: Track reinforcement metrics. Consider auto-reinforcement when lessons are successfully applied (detected via follow-up task outcomes).

### 9. Weekly Workers (Reflection, Effectiveness Decay)

**Status: REGISTERED but effectiveness unclear**

- `reflection` worker: weekly synthesis of lessons into strategy documents
- `effectivenessDecay` worker: decay/boost lessons based on application success rate
- Only 1 `strategy_document` would be expected after 2 weeks

**Recommendation**: Add logging to confirm these workers execute and produce output.

---

## Telegram vs Local Session Comparison

| Feature | Telegram Sessions | Local Sessions (itachi wrapper) |
|---------|-------------------|-------------------------------|
| **SessionStart briefing** | Via SSHService → hooks on target | Native hooks (settings.json) |
| **Per-prompt memory recall** | ElizaOS providers (positions 3-20) | UserPromptSubmit hook (additionalContext) |
| **Edit tracking** | PostToolUse hook on target machine | PostToolUse hook (native) |
| **Session-end logging** | SessionEnd hook on target | SessionEnd hook (native) |
| **Transcript extraction** | SessionEnd hook (background) | SessionEnd hook (background) |
| **Lesson extraction** | lessonExtractor evaluator (Telegram side) | NOT AVAILABLE (no evaluator) |
| **Conversation memory** | conversationMemory evaluator | NOT AVAILABLE (no evaluator) |
| **Personality extraction** | personalityExtractor evaluator | NOT AVAILABLE (no evaluator) |
| **MEMORY.md context** | Written by session-start hook on target | Written by session-start hook |

### Key Gap: Local Sessions Don't Feed Lesson Extraction

**The biggest gap in the RLM pipeline**: Local Claude Code sessions produce session-end summaries and transcript insights, but they **don't trigger the ElizaOS evaluators** (lessonExtractor, personalityExtractor, conversationMemory). These evaluators only run when messages flow through the ElizaOS Telegram pipeline.

This means:
- A bug you fix locally → hook logs the edits → transcript extracted → stored as pattern/fact
- But: NO task_lesson is created, NO personality trait extracted, NO confidence reinforcement happens

The only RLM feedback from local sessions comes through the `extract-insights` API endpoint (called by session-end hook), which stores insights as `task_lesson` if significance >= 0.7. This is the weakest part of the pipeline.

---

## Issues Found

### 1. Low code_change count (5 out of 201)
**Severity**: Medium
**Impact**: Edit-level memory barely exists. The recentMemoriesProvider has almost no code changes to surface.
**Root cause**: Likely after-edit hook failures being silently swallowed, or hook not firing on SSH sessions.
**Fix**: Add diagnostic logging to after-edit.ps1. Verify PostToolUse matcher is correct.

### 2. No reinforcement happening
**Severity**: Medium
**Impact**: All lessons stay at initial confidence. The reinforcement loop (the "R" in RLM) isn't cycling.
**Root cause**: `/feedback` command not used. No automatic reinforcement on task re-execution.
**Fix**: Consider auto-reinforcing lessons when similar tasks succeed. Encourage `/feedback` usage.

### 3. Local sessions don't produce lesson-quality insights
**Severity**: High
**Impact**: Most development happens locally, but those sessions barely feed the RLM.
**Root cause**: ElizaOS evaluators (lessonExtractor, personalityExtractor) only run on Telegram messages. Local sessions only feed through hooks → extract-insights API.
**Fix options**:
  - A) Improve extract-insights to produce richer task_lesson entries from transcripts
  - B) Have session-end hook explicitly call a "lesson extraction" API endpoint
  - C) Lower the significance threshold from 0.7 to 0.5 for local session insights

### 4. Session entries are low-value ("Session ended: other")
**Severity**: Low
**Impact**: 58 session entries but most just say "Session ended: other" with no useful context.
**Root cause**: Claude's session-end reason is often "other" for normal exits. The summary field isn't populated.
**Fix**: Enrich session-end entries with file list, duration, or prompt summary.

### 5. Duplicate/near-duplicate project rules
**Severity**: Low
**Impact**: 10 project_rules but some are near-duplicates (e.g., "documentation in /memory directory" appears twice with slight wording differences).
**Root cause**: Dedup threshold may be too low, or dedup isn't applied to project_rules.
**Fix**: Run dedup pass on existing rules. Ensure storeFact-style dedup applies to project_rules.

---

## Recommendations (Priority Order)

### P0: Fix after-edit hook reliability
- Add a diagnostic mode that logs to a local file when the hook fires
- Verify PostToolUse matcher `"Write|Edit"` works on current Claude Code version
- Test: make an edit, check if code_change memory is created within 5s

### P1: Enrich local session → RLM pipeline
- Have session-end hook extract a richer summary (not just "Session ended: other")
- Include: files changed (from git diff), session duration, first/last prompt
- Lower extract-insights significance threshold for local sessions

### P2: Enable automatic reinforcement
- When a task succeeds and its description matches existing task_lessons (>0.8 similarity), auto-reinforce those lessons
- Track lesson_application entries to measure actual usage

### P3: Cross-validate hook execution
- Create a simple test: `itachi --ds -p "echo hello"` → verify all 4 hooks fire
- Log hook execution timestamps to a local file for debugging
- Verify hooks work identically on Windows (itachi.ps1) and Mac (itachi wrapper)

---

## Conclusion

The RLM pipeline is **architecturally complete** but **operationally weak in key areas**:

- **Telegram → RLM**: Strong. Conversations, facts, lessons, and personality are all captured.
- **Task execution → RLM**: Strong. Transcript insights, project rules, and patterns are extracted.
- **Local sessions → RLM**: Weak. Only session-end logging and (sometimes) transcript insights make it through. The main learning evaluators don't fire for local sessions.
- **Reinforcement loop**: Not cycling. Lessons are stored but never reinforced through outcomes.

The system learns from Telegram interactions but barely learns from local development sessions — which is where most of the actual coding happens. Fixing the after-edit hook reliability and enriching the local session → extract-insights pipeline would have the highest impact on overall RLM effectiveness.
