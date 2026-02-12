# Eliza x OpenClaw: Improvement Combats

Analysis of OpenClaw (186k+ stars, personal AI assistant) patterns that could improve the Itachi-Memory system running on ElizaOS.

**Our infrastructure**: ElizaOS on Coolify/Hetzner, Supabase (pgvector), Telegram bot, orchestrator machines (Windows + Mac via Tailscale) running Claude Code CLI on subscription (no per-token API costs).

---

## Architecture Context

Itachi-memory runs a **parallel memory system** alongside ElizaOS's built-in memory. All improvements below target the Supabase/itachi layer unless noted.

| System | Storage | Search | Used By |
|--------|---------|--------|---------|
| ElizaOS built-in | Local DB (plugin-sql adapter) | `runtime.searchMemories()` | `lessonExtractor`, `reflectionWorker` |
| Itachi-memory | Supabase `itachi_memories` + pgvector | `memoryService.searchMemories()` → `match_memories` RPC | All itachi providers, evaluators, API routes |

They share the embedding pipeline (`runtime.useModel(TEXT_EMBEDDING)`) but never query each other.

---

## Improvement Combats

### 1. Hybrid Memory Search (Vector + Full-Text)

| | |
|---|---|
| **OpenClaw** | Combines pgvector similarity with BM25 full-text search (SQLite FTS5). Merges results via weighted scoring: `vectorWeight * vectorScore + textWeight * textScore`. |
| **Itachi now** | Pure vector search only (`match_memories` RPC with pgvector cosine similarity). |
| **Effort** | Medium |
| **Impact** | High |
| **ElizaOS impact** | **Additive** — Supabase-only change. Add `tsvector` column + new hybrid RPC. Zero ElizaOS disruption. |
| **Cost impact** | **Saves $** — FTS in Supabase Postgres is free (built-in `to_tsvector`/`to_tsquery`). Reduces embedding API calls for keyword-heavy queries (e.g. searching "SUPABASE_URL" fails in vector search but aces FTS). Fewer wasted embedding calls = lower Gemini/OpenAI embedding costs. |

**What to build**: Add `search_vector tsvector` column to `itachi_memories`, GIN index, trigger to auto-populate from `summary + content`. New `match_memories_hybrid` RPC that fuses vector similarity and FTS rank.

---

### 2. Conversation Compaction

| | |
|---|---|
| **OpenClaw** | Splits long conversations into token-balanced chunks, summarizes each independently, merges summaries. Preserves decisions, TODOs, context. Configurable `BASE_CHUNK_RATIO` (0.4). |
| **Itachi now** | No compaction — relies on ElizaOS default context window. Session insights extracted by workers but live conversation has no compaction. |
| **Effort** | Medium |
| **Impact** | High |
| **ElizaOS impact** | **Potentially disruptive** — Would need to hook into ElizaOS's message pipeline or conversation history. Only improvement that touches framework internals. |
| **Cost impact** | **Neutral** — Orchestrator machines run Claude Code CLI on subscription (no per-token cost). Compaction LLM calls would use Gemini (minimal cost on free/cheap tier). Main value is productivity, not cost savings. |

**What to build**: Compaction evaluator that triggers when token count approaches limit. Summarizes older turns via Gemini, replaces them with condensed summary. Needs careful integration with ElizaOS message handling.

---

### 3. Cron Expressions + Error Tracking

| | |
|---|---|
| **OpenClaw** | Three schedule types: `at` (one-shot), `every` (interval with anchor), `cron` (standard cron expressions with timezone via `croner` library). Tracks `consecutiveErrors`, auto-disables broken jobs. |
| **Itachi now** | Simple recurring types (`daily`, `weekly`, `weekdays`) with 60s poller. No cron expressions, no error tracking, no auto-disable. |
| **Effort** | Low |
| **Impact** | Medium |
| **ElizaOS impact** | **Additive** — Changes only to `itachi_reminders` table and `ReminderService`. |
| **Cost impact** | **Saves $** — Auto-disabling broken jobs stops the poller from repeatedly: (1) querying Supabase every 60s for dead items, (2) calling Telegram API with error alerts, (3) spawning LLM pipeline calls for custom actions that will never succeed. A single broken recurring job currently burns ~1,440 Supabase queries/day + 1,440 Telegram API calls/day indefinitely. |

**What to build**: Add `consecutive_errors` and `disabled_at` columns to `itachi_reminders`. Add `croner` dependency for cron expression parsing. Auto-disable after 5 consecutive failures. Add `/enable` command to re-enable.

---

### 4. Embedding Cache + Provider Fallback

| | |
|---|---|
| **OpenClaw** | Multi-provider embedding with auto-fallback (OpenAI -> Gemini -> Voyage -> local). SQLite-backed embedding cache keyed by content hash. |
| **Itachi now** | Single provider via ElizaOS `TEXT_EMBEDDING` model type (currently Gemini). No fallback, no cache. |
| **Effort** | Low |
| **Impact** | Medium |
| **ElizaOS impact** | **Additive** — New Supabase cache table. Intercepts `memoryService` embedding calls only. ElizaOS pipeline unchanged. |
| **Cost impact** | **Saves $** — Session-start hooks re-embed the same project rules on every session start across every machine. With 2 machines doing ~10 sessions/day each, that's ~20 duplicate embedding calls/day for identical content. Cache eliminates these. Fallback to Gemini embedding (free tier) when primary is down avoids failed memory stores. |

**What to build**: `itachi_embedding_cache` table (content_hash -> embedding vector, created_at). Hash content before embedding call, check cache first. Fallback: try Gemini embedding API directly if `runtime.useModel` fails.

---

### 5. Markdown Skills System

| | |
|---|---|
| **OpenClaw** | 60+ skills as `SKILL.md` files with frontmatter metadata. Agent scans descriptions first (cheap), only loads full skill if relevant (saves context window). |
| **Itachi now** | No skill abstraction. Capabilities are hardcoded as TypeScript actions/evaluators/providers in plugins. |
| **Effort** | Medium |
| **Impact** | Medium |
| **ElizaOS impact** | **Additive** — New provider that scans a `skills/` directory and injects relevant skill instructions. Existing plugins unchanged. |
| **Cost impact** | **Neutral** — On subscription model, prompt size doesn't affect cost. Main value is extensibility (add capabilities without writing TypeScript) and keeping context window focused. |

**What to build**: `skills/` directory convention with `SKILL.md` files. New `skillsProvider` that reads frontmatter descriptions, injects only relevant skill content into context based on message intent.

---

### 6. Session Transcript Indexing

| | |
|---|---|
| **OpenClaw** | Automatically indexes past conversation transcripts with delta-reads (only new bytes since last sync). Transcripts become searchable memory. |
| **Itachi now** | Session briefings generated by `sessionSynthesizerWorker` but full transcripts aren't searchable. Past session knowledge only accessible via summaries. |
| **Effort** | Low |
| **Impact** | Medium |
| **ElizaOS impact** | **Additive** — New worker that reads `.jsonl` session files and stores chunks as `itachi_memories` with `category='session_transcript'`. |
| **Cost impact** | **Small increase** — Embedding cost per transcript chunk (~$0.0001/chunk via Gemini). With ~20 sessions/day across machines, maybe $0.01-0.05/day. But prevents re-doing work already solved in past sessions. |

**What to build**: Worker that scans `~/.claude/projects/*/` for `.jsonl` transcripts. Delta-read pattern: store last byte offset per file, only process new content. Chunk by conversation turns, embed, store as `session_transcript` category.

---

### 7. Plugin Lifecycle Hooks / Event Bus

| | |
|---|---|
| **OpenClaw** | 14 lifecycle hooks: `before_agent_start`, `before_tool_call`, `after_tool_call`, `message_received`, `message_sending`, `before_compaction`, `session_start/end`, etc. |
| **Itachi now** | External shell hooks (`session-start.ps1`, `session-end.sh`) and ElizaOS evaluators. No internal event bus. |
| **Effort** | High |
| **Impact** | Medium |
| **ElizaOS impact** | **Additive but complex** — Would need an event emitter wrapping ElizaOS runtime calls. Evaluators could migrate to hooks for cleaner architecture. |
| **Cost impact** | **Saves $ (small)** — Replaces polling workers with event-driven execution. 6 workers currently poll on timers (15min, 5min, daily, weekly, etc.) across all machines even when idle. Events = zero Supabase queries when nothing happens. Savings: ~100-500 unnecessary Supabase queries/day eliminated. |

**What to build**: `EventBus` service with typed events. Plugins subscribe to events instead of polling. Workers like `editAnalyzerWorker` trigger on `edit_received` event instead of 15min timer.

---

### 8. Memory File Watching + Auto-Indexing

| | |
|---|---|
| **OpenClaw** | Uses chokidar to watch memory directories. File changes trigger re-chunking, re-embedding, and indexing automatically. |
| **Itachi now** | Memory stored via API calls and evaluators only. No automatic indexing of local documents. |
| **Effort** | Medium |
| **Impact** | Low-Medium |
| **ElizaOS impact** | **Additive** — New worker watching a local directory, ingesting into `itachi_memories`. |
| **Cost impact** | **Small increase** — Embedding costs for each new/changed file. Supabase storage for indexed chunks. Only justified if regularly dropping docs into a knowledge folder. Estimate: $0.01-0.10/day depending on volume. |

**What to build**: Worker watching `~/.itachi/knowledge/` directory. On file change: chunk markdown, embed, upsert into `itachi_memories` with `category='document'`. Track file hashes to avoid re-indexing unchanged content.

---

### 9. Tool Policy / Access Control

| | |
|---|---|
| **OpenClaw** | Fine-grained tool access control with per-plugin allowlists and conformance testing. |
| **Itachi now** | Single bearer token auth (`ITACHI_API_KEY`). No per-action or per-user access control. |
| **Effort** | Low |
| **Impact** | Low |
| **ElizaOS impact** | **Additive** — Middleware enhancement on existing route auth. |
| **Cost impact** | **Neutral** — Prevents unauthorized actions that could trigger unintended Supabase writes or Telegram messages, but this is an edge case. |

**What to build**: Role field on API keys. Action-level permission checks (e.g., only admin can `/cancel` tasks or `/close_done`).

---

### 10. Config Hot-Reload

| | |
|---|---|
| **OpenClaw** | Watches config file, reloads most settings without restart. Gateway stays up. |
| **Itachi now** | Config read from env vars at startup. Changes require full restart on Coolify. |
| **Effort** | Low |
| **Impact** | Low |
| **ElizaOS impact** | **Additive** — New `/api/config/reload` endpoint. Services re-read settings on signal. |
| **Cost impact** | **Neutral** — Saves a few minutes of downtime per config change. No direct infrastructure cost change. |

**What to build**: `/api/config/reload` endpoint that re-reads `.env` and signals services to refresh settings (Supabase URL, API keys, etc.).

---

## Priority Matrix

| # | Improvement | Effort | Impact | Cost Impact | ElizaOS Risk |
|---|------------|--------|--------|-------------|-------------|
| 1 | Hybrid search (vector + FTS) | Medium | High | Saves $ (fewer embedding calls) | None — Supabase only |
| 2 | Cron expressions + error tracking | Low | Medium | Saves $ (stops broken job waste) | None — itachi tables only |
| 3 | Embedding cache + fallback | Low | Medium | Saves $ (dedupes embeddings) | None — cache layer only |
| 4 | Session transcript indexing | Low | Medium | +$0.01-0.05/day (embeddings) | None — new worker only |
| 5 | Conversation compaction | Medium | High | Neutral (subscription model) | **Disruptive** — touches ElizaOS internals |
| 6 | Markdown skills system | Medium | Medium | Neutral | None — new provider |
| 7 | Plugin lifecycle hooks | High | Medium | Saves $ (small, fewer polls) | Complex — wraps runtime |
| 8 | Memory file watching | Medium | Low-Med | +$0.01-0.10/day (embeddings) | None — new worker |
| 9 | Tool policy | Low | Low | Neutral | None — middleware |
| 10 | Config hot-reload | Low | Low | Neutral | None — new endpoint |

**Recommended order**: 1 -> 2 -> 3 -> 4 -> 6 -> 5 -> 7 -> 8 -> 9 -> 10

The top 4 are all additive (zero ElizaOS disruption risk) and either save money or have minimal cost increase. Compaction (#5) is high-impact but deferred because it's the only one requiring ElizaOS framework-level changes.
