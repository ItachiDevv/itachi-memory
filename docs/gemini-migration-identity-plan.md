# Gemini Migration + Two-Tier Identity System

**Created**: 2026-02-11
**Status**: Implemented, pending deployment verification
**Review date**: 2026-02-18

---

## 1. Gemini Flash Migration (Cost Optimization)

### Problem
All background workers (evaluators, synthesizers, analyzers) were using Anthropic Haiku via `ModelType.TEXT_SMALL`, burning API credits on low-complexity tasks like JSON extraction, significance scoring, and summary generation.

### Solution
Custom ElizaOS plugin (`itachi-gemini`) routes `TEXT_SMALL` and `OBJECT_SMALL` calls to Gemini 2.5 Flash via `@ai-sdk/google`. Conversation (`TEXT_LARGE`) stays on Claude Sonnet for personality quality.

### Architecture
```
Telegram message in
  → ElizaOS evaluates (TEXT_SMALL → Gemini Flash)
  → ElizaOS generates response (TEXT_LARGE → Claude Sonnet)
  → Background workers run (TEXT_SMALL → Gemini Flash)
```

**Priority routing**: Gemini plugin registers at priority 10, Anthropic at 0. Higher priority wins for TEXT_SMALL. If GEMINI_API_KEY is missing, Gemini throws → falls back to Anthropic.

### Files Changed
| File | Change |
|------|--------|
| `eliza/src/plugins/plugin-gemini/index.ts` | New plugin — TEXT_SMALL/OBJECT_SMALL handlers |
| `eliza/src/index.ts` | Added `itachiGeminiPlugin` to plugins array (first position) |
| `eliza/src/character.ts` | Added GEMINI_API_KEY + GEMINI_SMALL_MODEL settings |
| `eliza/package.json` | Added `@ai-sdk/google` dependency |
| `Dockerfile` | Added GEMINI_SMALL_MODEL env var |
| `~/.itachi-api-keys` | Added GEMINI_API_KEY credential |

### Cost Estimate
| Call type | Before (Anthropic Haiku) | After (Gemini Flash) |
|-----------|--------------------------|---------------------|
| Per-message evaluator | ~$0.001/call | ~$0.0001/call |
| Session synthesizer | ~$0.002/call | ~$0.0002/call |
| Background workers | ~$0.001/call | ~$0.0001/call |
| **Savings** | | **~5-10x on background processing** |

### A/B Testing Plan
1. **Week 1** (current): Deploy with Gemini for all TEXT_SMALL. Monitor:
   - Telegram response quality (subjective — does personality degrade?)
   - JSON parse failures in evaluator logs (`unparseable LLM output`)
   - Fact extraction quality (are facts being stored correctly?)
   - `[Gemini]` log entries to confirm routing
2. **Week 2**: If quality holds, keep Gemini. If issues:
   - Check `runtime.logger` for Gemini errors
   - Temporarily remove `itachiGeminiPlugin` from plugins array to revert
   - Or set `GEMINI_API_KEY=""` to disable (falls back to Anthropic)

### Rollback
Remove `itachiGeminiPlugin` from the `agent.plugins` array in `eliza/src/index.ts`. Everything falls back to Anthropic automatically.

---

## 2. Two-Tier Identity System (Personality Persistence)

### Problem
The Telegram bot's personality degraded over time because:
- `facts-context.ts` only fetched facts from the last 7 days
- Core identity facts (user's name, relationship dynamics, communication style) expired
- `conversation-context.ts` only goes back 24 hours
- Character.ts bio is purely technical (no personality layer)

### Solution
Two-tier fact system:
- **Tier 1: `identity`** — Permanent facts about the user and relationship. Always injected into every conversation. Never expire.
- **Tier 2: `fact`** — Project-specific details, technical decisions. 7-day window + semantic search (existing behavior).

### How Facts Get Classified
1. **LLM classification**: The conversation-memory evaluator prompt now asks the LLM to classify each extracted fact as `identity` or `fact`
2. **Auto-promotion**: Facts from exchanges with significance >= 0.9 are automatically stored as `identity`
3. **Dedup with promotion**: If an `identity` fact matches an existing `fact` (similarity > 0.92), the existing fact gets promoted to `identity` category

### Provider Injection
`facts-context.ts` now fetches three sources in parallel:
1. `identity` facts (all, no time limit, up to 20)
2. Semantic search results for current message (category `fact`)
3. Recent facts from last 7 days (category `fact`)

Output format in provider context:
```
## Core Identity & Relationship
These are permanent facts about the user and your relationship:
- User's name is Newman
- User prefers concise communication
- We work as one entity — user provides vision, Itachi executes

## Known Facts & Preferences
- itachi-memory uses Supabase for storage (itachi-memory)
- Yarn is preferred over npm (my-app)
```

### Files Changed
| File | Change |
|------|--------|
| `eliza/src/plugins/itachi-memory/providers/facts-context.ts` | Added identity tier fetch, restructured output |
| `eliza/src/plugins/itachi-memory/evaluators/conversation-memory.ts` | Added tier classification to prompt, identity storage logic |
| `eliza/src/plugins/itachi-memory/services/memory-service.ts` | `storeFact()` accepts category param, dedup checks both tiers, promotes facts to identity |

### Seeding Identity Facts
Existing personality facts from previous conversations are stored as `category='fact'` in Supabase. To bootstrap the identity tier, run this SQL to promote known identity-level facts:

```sql
UPDATE itachi_memories
SET category = 'identity'
WHERE category = 'fact'
  AND (
    summary ILIKE '%name is%'
    OR summary ILIKE '%prefers%'
    OR summary ILIKE '%personality%'
    OR summary ILIKE '%communication style%'
    OR summary ILIKE '%we are%'
    OR summary ILIKE '%one entity%'
    OR summary ILIKE '%relationship%'
  );
```

### Verification
1. Send a Telegram message with personal context ("Remember that I prefer dark themes")
2. Check Supabase: `SELECT * FROM itachi_memories WHERE category = 'identity' ORDER BY created_at DESC LIMIT 5`
3. Verify it shows up in the bot's next response context
4. Wait 8+ days — identity facts should still appear (unlike regular facts that expire)

---

## 3. Session Synthesizer Interval Fix

### Problem (discovered during this session)
The session-synthesizer interval was fixed in the worker registration function (cosmetic change), but the REAL scheduler in `eliza/src/index.ts` used `setInterval` with `intervalMs: 300_000` (5 minutes).

### Fix
Changed `eliza/src/index.ts` line 98 from `intervalMs: 300_000` to `intervalMs: 1_800_000` (30 minutes).

---

## Monitoring Checklist (Week 1)

- [ ] Verify `[Gemini]` log entries appear on ElizaOS startup
- [ ] Verify conversation-memory evaluator still parses JSON correctly
- [ ] Verify identity facts appear in bot context (check provider output)
- [ ] Check Anthropic dashboard for reduced TEXT_SMALL usage
- [ ] Check Gemini dashboard for corresponding usage increase
- [ ] Test personality: ask the bot about the user — it should recall identity facts
- [ ] Test fact expiry: after 7+ days, ephemeral facts disappear but identity persists
