# Conversation Memory — 3-Branch Comparison

Telegram conversations are stored in ElizaOS's native `messages` table (short-term), but never flow into Supabase `itachi_memories`. This means `/recall`, MCP tools, and cross-session memory can't find them. These 3 branches solve this with different trade-offs.

## Shared Changes (All Branches)

1. **store-memory.ts validate() fix** — removed `text.length > 20` catch-all that made STORE_MEMORY compete with REPLY. Now only fires on explicit keywords: `remember`, `note`, `store`, `save`, `don't forget`, `keep in mind`, `log this`.
2. **character.ts** — added `SHOULD_RESPOND_BYPASS_SOURCES: 'telegram'` so Itachi responds to all Telegram messages in the supergroup (not just DMs/@mentions).

---

## Branch 1: `feature/conv-memory-smart-filter` — LLM-Filtered

**Strategy**: After each Telegram exchange, haiku evaluates whether the conversation is worth storing. Only significant exchanges (decisions, preferences, facts, outcomes) are promoted to `itachi_memories`.

**Evaluator logic**:
- validate: source=telegram, agent's own response, text > 50 chars
- handler: fetch last 6 messages → LLM asks "is this worth remembering?" → if yes, extract summary + project → `storeMemory()` with category `conversation`

| Aspect | Value |
|--------|-------|
| Storage growth | ~5-15 memories/day |
| Cost per message | ~$0.001 (haiku eval) |
| Recall quality | High signal, low noise |
| Risk | May filter out something the user wanted remembered |
| `/recall` results | Clean, relevant, mixed with code memories |

---

## Branch 2: `feature/conv-memory-scored` — Store All + Significance Score (RECOMMENDED)

**Strategy**: Every Telegram exchange gets stored with a `significance` score (0.0-1.0). Search results are weighted by significance, so casual chat ranks lower than important decisions.

**Evaluator logic**:
- validate: source=telegram, agent's own response, text > 30 chars
- handler: fetch last 6 messages → LLM scores 0.0-1.0 for significance + extracts summary/project → always store with category `conversation` and significance in metadata

**Additional components**:
- `memory-service.ts` — `storeMemory()` accepts optional `metadata` field, `searchMemories()` weights by significance
- `conversation-context.ts` provider (position 11) — injects recent conversation memories into LLM context, hides significance < 0.3

| Aspect | Value |
|--------|-------|
| Storage growth | ~30-100 memories/day |
| Cost per message | ~$0.001 (haiku scoring) |
| Recall quality | Everything searchable, ranked by significance |
| Risk | More storage, but nothing lost |
| `/recall` results | Comprehensive, significance-weighted |

---

## Branch 3: `feature/conv-memory-store-all` — Store Everything Equally

**Strategy**: Every Telegram exchange gets stored with a simple summary. No LLM filtering or scoring — just extract + store.

**Evaluator logic**:
- validate: source=telegram, agent's own response, text > 20 chars
- handler: fetch last 4 messages → LLM summarizes in 1-2 sentences → always store with category `conversation`

| Aspect | Value |
|--------|-------|
| Storage growth | ~50-150 memories/day |
| Cost per message | ~$0.001 (haiku summary) |
| Recall quality | Everything searchable, but noisy |
| Risk | `/recall` flooded with trivial entries |
| `/recall` results | High volume, unweighted |

---

## Files Changed Per Branch

| File | Branch 1 | Branch 2 | Branch 3 |
|------|----------|----------|----------|
| `actions/store-memory.ts` | Fix validate | Fix validate | Fix validate |
| `evaluators/conversation-memory.ts` | NEW (filter) | NEW (scored) | NEW (store all) |
| `providers/conversation-context.ts` | — | NEW (pos 11) | — |
| `services/memory-service.ts` | — | +metadata +weighted search | — |
| `index.ts` (plugin) | +evaluator | +evaluator +provider | +evaluator |
| `character.ts` | +bypass | +bypass | +bypass |

---

## Recommendation

**Branch 2 (scored)** is the recommended default because:
- Nothing is lost — every conversation is searchable
- Significance scoring prevents noise in `/recall` results
- The conversation-context provider gives Itachi ongoing awareness of recent chats
- Low marginal cost (~$0.001/message for haiku scoring)
- Can always increase/decrease the significance threshold later
