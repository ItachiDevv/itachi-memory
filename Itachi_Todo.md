# Itachi Todo

## 1) RLM session-hook leakage + learning gaps — **~80% done**
- This was my attempt at improving the RLM - Analyze it yourself as well, to make sure that it actually improves it, and think if there are better ways to do it, or more alternatives. We want the entire itachi memory system to improve with RLM, I spend almost all my time using the computer with itachi, itachig, and itachic, not the bot, so we need intense RLM for that whole system.
- [x] **Add responses + outcomes to session hooks**
  ~~Current understanding: the RLM training signal is using *prompts* but not sufficiently incorporating **responses** and/or **success signals** when session hooks run.~~
  **DONE**: session-end hooks now add `metadata.outcome` + `metadata.exit_reason`. Tool calls and results captured in transcripts via `extractClaudeTexts`/`extractCodexTexts`. All three engines (claude/codex/gemini) include outcome metadata. 8000-char conversation text limit applied uniformly. Silent catch blocks in RLM reinforcement paths now log warnings (fixed in this session).
- [ ] **Run this across vector search as well**
  Ensure the same enrichment (prompt + response + outcome) is indexed/queried through the vector memory workflow. *Vector search enrichment still pending.*
- [x] **Learn from successful executions**
  **DONE**: `extract-insights` creates `project_rule` (WHEN/DO/AVOID format) and `task_lesson` entries with outcome metadata. `reinforceLessonsForTask` and `reinforceLessonsForSegments` adjust confidence scores based on success/failure. Category-aware reranking boosts `project_rule` (1.25x), `task_lesson` (1.20x), `error_recovery` (1.15x).
- [x] **Unify memory workflow across agents**
  **DONE**: All three engines share the same hooks directory, session-start/session-end scripts, and `itachi_memories` table. `user-prompt-submit` searches both old (`.itachi-memory`) and new (`itachi-memory`) project names for backward compat.

---

## 2) Hallucinating tasks / claiming work completed - Give bot autonomy — **Pending investigation**

- Why Doesn't this agent have autonomy? Why can't it just actually do the tasks that I ask?
- Can we give itachi his own Linux environment to do work on in the VPS? (This would include installing itachi, itachic, and itachig hooks and whatnot )
- Reference Todo1TgLogs.md in the root folder for the logs of the telegram chat that specifically frustrated me, and the screenshots are included below
- [ ] Investigate + fix cases where the bot claims it is "doing tasks" without actually performing them. *Needs investigation of `handleSessionComplete` false positives.*
  Evidence: attached screenshots below.

### Attached screenshots
![alt text](image-4.png)
![alt text](image-3.png)
![alt text](image-2.png)
![alt text](image-1.png)


---

## 3) Topic management not working — **~90% done**

- [x] **Topic routing / management**
  ~~In Telegram, **itachi** responds to *my session responses* (topic/thread confusion).~~
  **DONE**: `spawningTopics` Set prevents message leaks during browse→session transition. All spawn paths use `spawningTopics.add/delete` with try/finally. All validators check spawningTopics. 72-test suite covers all routing + picker fixes. Container restart orphaning partially addressed via `itachi_topic_registry` persistent tracking.
- [ ] **Container restart topic recovery**: Topics registered on creation, marked 'deleted' after confirmed API deletion. Still needs full recovery flow on startup to reconcile orphaned topics.

---

## 4) Model switching mid-session — **Complete**

- [x] **Switch between models on the go (mid-session)**
  **DONE**: `/switch <engine>` command in topic-input-relay.ts. `handleEngineHandoff()` kills current session, builds handoff prompt from transcript, respawns with next engine.
- [x] **Auto handoff when nearing usage limits**
  **DONE**: `auto-fallback.ps1` hook on usage limit → `generate-handoff.ps1` → launches next engine. Engine priority from Supabase `machine_registry.engine_priority` (cached locally). `ITACHI_FALLBACK_ACTIVE=1` prevents infinite loops. Rate limit events (`rate_limit_event` in stream-json) trigger proactive handoff after threshold.
- [x] **Use the Itachi MCP for handoffs** *(if applicable)*
  **DONE**: Handoff files written to `~/.claude/handoffs/` with auto-cleanup (keep 20). Session flow shows 6-button engine+mode picker: {itachi, itachic, itachig} × {--ds, --cds}.

<!-- ---

## 5) Telegram hook: add item to todo list

- [ ] Add a Telegram command/hook (e.g. `/todo add ...`) that appends an item to this todo list (or a canonical todo store).

---

## 6) Gemini-specific: auto switch models

- [ ] Auto switch models when out of usage  
  Example: switch to **Gemini 3** when **3.1 Pro** runs out of usage.

--- -->

## 7) Mid-session commands (Telegram) — **Complete**

- [x] Add mid-session controls in Telegram (e.g., an **ESC/stop** equivalent) to interrupt/cancel the current task cleanly.
  **DONE**: Full control command set in topic-input-relay.ts: `/ctrl+c`, `/ctrl+d`, `/ctrl+z`, `/ctrl+\`, `/esc`, `/enter`, `/tab`, `/yes`, `/no`, `/interrupt`, `/kill`, `/exit`, `/stop`. Each sends the raw byte to SSH stdin. `/close` kills session + closes topic.

---

## 8) Link skills to subagents

- [ ] Link skills to subagents (agent teams)  
  Note: could increase usage; consider lightweight routing, shared skill registry, or caching.
