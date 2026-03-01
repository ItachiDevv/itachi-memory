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

### 1. ~~Low code_change count~~ RESOLVED
**Severity**: ~~Medium~~ → Not an issue
**Previous finding**: Only 5 code_change entries visible.
**Actual status**: The after-edit hook is **working correctly**. There are 65+ code_change entries across projects. The initial low count was due to querying without project scope — the `/api/memory/recent` endpoint returns differently when `project` is omitted.
**Diagnostics added**: `~/.itachi-hook-diag.log` now logs every after-edit hook invocation with file path, tool name, API response status.

### 2. No reinforcement happening
**Severity**: Medium
**Impact**: All lessons stay at initial confidence. The reinforcement loop (the "R" in RLM) isn't cycling.
**Root cause**: `/feedback` command not used. No automatic reinforcement on task re-execution.
**Fix**: Consider auto-reinforcing lessons when similar tasks succeed. Encourage `/feedback` usage.

### 3. Local sessions don't produce lesson-quality insights — FIXED
**Severity**: ~~High~~ → Fixed
**Previous state**: Windows session-end hook only called `extract-insights` (significance >= 0.7 threshold). Unix session-end hook already had the fix.
**Fix applied**: Windows session-end hook now also calls `/api/session/contribute-lessons` after `extract-insights`. This endpoint has a lower confidence threshold (0.4) and always stores qualifying lessons.
**Additional fixes**:
  - Windows transcript extraction now includes `[USER]` text (was assistant-only)
  - Transcript context increased from 4000 to 6000 chars (matches unix)
  - `[ASSISTANT]`/`[USER]` prefixes added for clearer lesson extraction context

### 4. Session entries are low-value ("Session ended: other")
**Severity**: Low
**Impact**: Many session entries just say "Session ended: other" with no useful context.
**Root cause**: Claude's session-end reason is often "other" for normal exits. The summary and duration fields are populated when transcript data is available.
**Mitigated by**: The `contribute-lessons` call now extracts actionable lessons from the same transcript data, so even if the session entry is low-value, lessons are still captured.

### 5. Duplicate/near-duplicate project rules
**Severity**: Low
**Impact**: 8 project_rules but some may overlap.
**Root cause**: Dedup similarity threshold (0.85) may allow near-duplicates.
**Fix**: Consider running a dedup pass on existing rules.

---

## Fixes Applied (Feb 25, 2026)

### Windows session-end hook (`hooks/windows/session-end.ps1`)
1. **Added `contribute-lessons` API call** — mirrors what the unix hook already had. After calling `extract-insights`, the hook now also calls `/api/session/contribute-lessons` with the conversation text to generate task_lesson entries.
2. **Added user text extraction** — `extractClaudeTexts()` now captures `[USER]` messages (min 10 chars) in addition to `[ASSISTANT]` messages. This gives the lesson extraction LLM both sides of the conversation for better insights.
3. **Increased context window** — transcript truncation increased from 4000 to 6000 chars.
4. **Added `[ASSISTANT]`/`[USER]` prefixes** to Codex transcript extraction for parity.

### After-edit hooks (`hooks/windows/after-edit.ps1`, `hooks/unix/after-edit.sh`)
1. **Added diagnostic logging** — both hooks now log to `~/.itachi-hook-diag.log` with timestamps, file paths, tool names, and API response status.
2. **Confirmed working** — diagnostic logs show the hook fires correctly, receives stdin JSON, extracts file paths, and gets successful API responses.

### Active hooks deployed
- Updated hooks copied to `~/.claude/hooks/` (the active hook directory referenced by `settings.json`).

---

## Recommendations (Priority Order)

### P0: ~~Fix after-edit hook reliability~~ DONE
- ✅ Diagnostic logging added to both Windows and Unix hooks
- ✅ Confirmed hook fires, API responds successfully
- ✅ PostToolUse matcher `"Write|Edit"` verified working

### P1: ~~Enrich local session → RLM pipeline~~ DONE
- ✅ Session-end hook now calls `contribute-lessons` (lower threshold lesson extraction)
- ✅ User text included in transcript (both sides of conversation)
- ✅ Context window increased to 6000 chars
- Remaining: Could lower `extract-insights` significance threshold from 0.7 to 0.5 for local sessions

### P2: Enable automatic reinforcement
- When a task succeeds and its description matches existing task_lessons (>0.8 similarity), auto-reinforce those lessons
- Track lesson_application entries to measure actual usage

### P3: Cross-validate hook execution across platforms
- Create a simple test: `itachi --ds -p "echo hello"` → verify all 4 hooks fire
- Verify hooks work identically on Windows (itachi.ps1) and Mac (itachi wrapper)
- Monitor `~/.itachi-hook-diag.log` for errors

---

## Updates Since Initial Evaluation (Feb 27 - Mar 1, 2026)

### Reinforcement Loop — NOW ACTIVE
- `reinforceLessonsForTask()` adjusts confidence: success += 0.10 (cap 0.99), failure -= 0.15 (floor 0.05)
- `reinforceLessonsForSegments()` handles per-segment outcome tracking
- Automatic reinforcement on task completion (no longer depends on `/feedback`)

### Tool Call Capture
- `extractClaudeTexts()` and `extractCodexTexts()` now capture `[TOOL_USE]`, `[TOOL_RESULT]`, `[TOOL_ERROR]` entries
- Gives extract-insights full context about what actions were taken during sessions

### Outcome Metadata
- All 3 engines (claude/codex/gemini) add `metadata.outcome` and `metadata.exit_reason` to session-end hooks
- `user-prompt-submit.ps1` shows `[category|outcome]` with `AVOID:` prefix for failure-tagged memories

### Category-Aware Reranking
- Memory search results reranked by category: `project_rule` x1.25, `task_lesson` x1.20, `error_recovery` x1.15, `code_change` x0.85, `session` x0.80
- Ensures actionable lessons surface above raw session logs

### Conversation Text Limit
- Unified 8000-char limit across all engines (up from 4000-6000)

### Silent Catch Fixes
- 16 empty `catch {}` blocks in critical RLM paths now log warnings
- Previously, lesson reinforcement failures, memory dedup errors, and health alerts were silently swallowed

---

## Conclusion

The RLM pipeline is **architecturally complete** and now **operationally functional across both Telegram and local sessions**:

- **Telegram → RLM**: Strong. Conversations, facts, lessons, and personality are all captured via ElizaOS evaluators.
- **Task execution → RLM**: Strong. Transcript insights, project rules, and patterns are extracted via session-end hooks.
- **Local sessions → RLM**: **Fixed**. Session-end hook now calls both `extract-insights` (rich analysis with rules) AND `contribute-lessons` (direct lesson extraction). User text is now included in transcripts for better context.
- **After-edit hook**: **Confirmed working**. 65+ code_change entries. Diagnostic logging enabled.
- **Reinforcement loop**: Not yet cycling. Lessons are stored but never reinforced through outcomes. This is the remaining gap.

The primary remaining gap is the **reinforcement loop** — lessons are extracted from both Telegram and local sessions, but there's no automatic mechanism to reinforce lessons when they're successfully applied in subsequent sessions.
