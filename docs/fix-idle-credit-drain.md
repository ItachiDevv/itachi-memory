# Fix: Idle LLM Credit Drain

## Problem

The ElizaOS server was consuming Anthropic API credits continuously even when no one was actively using the system. Three separate issues contributed to unnecessary LLM calls.

---

## Issue 1: Session Synthesizer Processing Empty Sessions

**File**: `eliza/src/plugins/itachi-code-intel/workers/session-synthesizer.ts`

**Root cause**: The session synthesizer worker runs on a timer, finds sessions in `session_summaries` where `embedding IS NULL`, and calls the LLM to generate a summary for each. When a Claude Code session starts (hook fires, creates a session record) but ends without any file edits, the synthesizer still burned a Haiku call + embedding call to "summarize" nothing.

**Evidence**: Session briefing showed 5 consecutive sessions all summarized as _"This appears to be an empty or initialization session where no actual coding work was recorded."_ Each of these cost an LLM call that produced no useful information.

**Fix**: Added an early guard after fetching edits. If `edits.length === 0`, the session is marked with a placeholder summary (`"Empty session -- no edits recorded"`) and a zero-vector embedding so it's never re-processed. The LLM call is skipped entirely.

```typescript
if (!edits || edits.length === 0) {
  const zeroEmbedding = new Array(1536).fill(0);
  await supabase.from('session_summaries')
    .update({ summary: 'Empty session -- no edits recorded', embedding: zeroEmbedding })
    .eq('id', session.id);
  continue;
}
```

**Impact**: Eliminates all LLM calls for empty/abandoned sessions. These were the most frequent drain since every session-start hook creates a record, and sessions are often started briefly (e.g., running `/itachi-init`, quick checks).

---

## Issue 2: Session Synthesizer Interval Too Aggressive

**File**: `eliza/src/plugins/itachi-code-intel/workers/session-synthesizer.ts`

**Root cause**: The worker was configured to run every **5 minutes** (288 checks/day). Sessions typically complete 1-10 times per day. Each run makes a database query even when nothing needs processing, and when sessions do exist, the tight interval means wasted checks between infrequent completions.

**Fix**: Changed interval from `5 * 60 * 1000` (5 min) to `30 * 60 * 1000` (30 min).

**Impact**: 6x reduction in polling frequency. Combined with the empty session guard, this makes the synthesizer nearly free when idle. A 30-minute delay before session enrichment is negligible since the data is only consumed at the start of the *next* session.

---

## Issue 3: Duplicate LLM Calls Per Telegram Message

**Files**:
- `eliza/src/plugins/itachi-memory/evaluators/conversation-memory.ts`
- `eliza/src/plugins/itachi-memory/evaluators/fact-extractor.ts`
- `eliza/src/plugins/itachi-memory/index.ts`

**Root cause**: Two separate evaluators (`conversationMemoryEvaluator` + `factExtractorEvaluator`) both ran with `alwaysRun: true` on every Telegram bot response. Each made its own LLM call (Haiku), resulting in **2 LLM calls per message**. ElizaOS evaluators run independently with no shared state, so the fact extractor couldn't know the conversation evaluator had already scored the message as low-significance (< 0.3).

**Fix**: Merged fact extraction into the conversation memory evaluator's single LLM prompt. The combined prompt now asks for significance scoring, summary extraction, AND fact extraction in one call. Facts are only stored when `significance >= 0.3` (skip trivial exchanges). The standalone `factExtractorEvaluator` is removed from the plugin registration.

**Key changes**:
- Prompt now includes: `"facts": [{"fact": "...", "project": "..."}]` in the JSON response
- Facts gated on significance: `if (significance >= 0.3)` before processing facts array
- `fact-extractor.ts` file retained but no longer registered in plugin (available for re-use if needed)

**Impact**: 50% reduction in per-message LLM cost. For active Telegram groups (50-100+ messages/day), this saves 50-100+ Haiku calls daily.

---

## Summary of Credit Savings

| Source | Before | After | Reduction |
|--------|--------|-------|-----------|
| Session synthesizer (empty sessions) | ~5-20 Haiku calls/day | 0 | 100% |
| Session synthesizer (polling) | 288 checks/day | 48 checks/day | 83% |
| Telegram evaluators | 2 Haiku calls/message | 1 Haiku call/message | 50% |

## Files Changed

| File | Change |
|------|--------|
| `eliza/src/plugins/itachi-code-intel/workers/session-synthesizer.ts` | Empty session guard + interval 5min -> 30min |
| `eliza/src/plugins/itachi-memory/evaluators/conversation-memory.ts` | Merged fact extraction into single LLM call |
| `eliza/src/plugins/itachi-memory/index.ts` | Removed `factExtractorEvaluator` from plugin registration |
