# Itachi Memory — Changelog

All notable changes to the Itachi system, organized by feature area.

---

## Features Added

### 1. Multi-Agent System (`itachi-agents` plugin)

A complete agent management layer that transforms Itachi from a single-agent system into a multi-specialist architecture.

- **Agent Profiles** — Persistent specialist personalities (`code-reviewer`, `researcher`, `devops`) stored in Supabase. Each has its own model, system prompt, tool access policy, and scoped memory namespace. Success rate is tracked via exponential moving average.
- **Subagent Spawning** — Spawn isolated agent sessions in two modes: *local* (single-turn LLM call) for analysis/review, or *SSH* (dispatched to a registered machine) for file-system tasks. Includes concurrency limits, automatic timeouts, and lifecycle tracking (`pending → running → completed/error/timeout`).
- **Inter-Agent Messaging** — Supabase-backed message queue. Subagent completion results auto-post to the parent. Unread messages injected into every conversation turn via the `AGENT_MAIL` provider.
- **Self-Scheduled Cron Jobs** — Itachi can schedule its own recurring tasks with standard cron expressions. Natural language like "every 30 minutes" is converted to cron via LLM. The lifecycle worker picks up due jobs and spawns subagent runs.
- **Pre-Compaction Memory Flush** — Evaluator that monitors conversation length and saves undocumented insights to permanent memory before ElizaOS compacts the context window (triggers at ~80K chars).
- **Subagent Lesson Extraction** — Evaluator that extracts transferable 1-2 sentence lessons from completed subagent runs and stores them under the profile's memory namespace for future spawns.
- **Context Providers** — `SUBAGENT_STATUS` (active/pending runs) and `AGENT_MAIL` (unread messages) inject agent state into every conversation turn. Zero LLM cost.
- **Lifecycle Worker** — 30-second interval worker that executes pending local runs, enforces timeouts via `cleanup_expired_subagents()` RPC, and processes due cron jobs.

**Database:** 4 new tables (`itachi_agent_profiles`, `itachi_subagent_runs`, `itachi_agent_messages`, `itachi_agent_cron`), 6 indexes, 1 RPC, 3 seed profiles.

---

### 2. Interactive CLI Sessions & Task Lifecycle

Unlimited back-and-forth conversations with CLI sessions on remote machines, replacing the old single-shot human-in-the-loop model.

- **`waiting_input` status** — New task state that signals Itachi is waiting for user input mid-session. Integrated across task-service, topic-reply, topic-input-relay, topic-context, and active-tasks provider.
- **Unlimited conversation loop** — Task-runner now supports continuous back-and-forth with Claude sessions using `--continue` (CWD-based, no session ID needed).
- **`detectUserPrompt()`** — Expanded pattern matching to recognize when a CLI session is asking a question (Y/n prompts, "Press enter", etc.).
- **`splitMessage()`** — Long Telegram messages are split into chunks instead of being truncated.

---

### 3. RL (Reinforcement Learning) Pipeline

Automatic learning from task outcomes and user corrections.

- **`extractLessonFromCompletion()`** — Task-poller automatically extracts lessons from completed tasks and stores them for future reference.
- **Correction detection** — Topic-input-relay detects when a user corrects Itachi mid-task and calls `extractCorrectionLesson()` to learn from the correction.
- **`enrichWithLessons()`** — New tasks are enriched with relevant past lessons at creation time.
- **`/feedback` command** — Explicit user task ratings via Telegram. Accepts task ID/prefix + rating + optional comment.

---

### 4. Descriptive Task Naming

Replaced UUID-based naming with human-readable descriptive slugs throughout the system.

- Branch names, worktrees, Telegram topics, commits, and PRs now use 1-3 word summaries from the task description (via `generateTaskTitle()`).
- Case-insensitive repo matching using `ilike()` in Supabase and canonical name resolution.
- NL task parsing handles conversation confirmations ("yes, go ahead") by extracting task details from prior assistant messages.

---

### 5. Natural Language SSH Control

- **`COOLIFY_CONTROL` action** — Understands natural language requests like "check why the mac is failing" or "restart the server" without slash commands.
- **Machine aliases & intent detection** — Maps informal names to registered machines and detects diagnostic vs. control intent.
- **`SSH_CAPABILITIES` provider** — Tells the LLM about available SSH targets so it routes requests correctly.
- **`/ssh-test` command** — Connectivity testing for registered machines.

---

### 6. Proactive Monitor Worker

Background worker that periodically checks system health and sends alerts to the Telegram group.

- Detects failed/stale tasks, offline machines, and queued tasks with no online workers.
- Sends alerts proactively without user prompting.

---

### 7. Conversation Memory

Two experimental approaches for persisting Telegram conversations to long-term memory:

- **LLM Smart Filtering** — An evaluator that uses an LLM to decide if a conversation exchange is worth remembering. Filters out greetings, thanks, and small talk.
- **Store All** — Every Telegram exchange gets stored with a simple summary. No filtering or scoring.

---

### 8. Topic Management Improvements

- Topics are now **deleted** (not just closed) on task completion/failure, clearing `telegram_topic_id` from the task record.
- Poller-detected completions now get descriptive topic names (previously kept their UUID slugs).
- `/close_finished` added as alias for `/close_done`.

---

## Bug Fixes

| Fix | Description |
|-----|-------------|
| **Embedding crash** | `getEmbedding()` passed `{ input: text }` but OpenAI expects `{ text }`. Every embedding was a zero-fill fallback, causing `embedding.map()` TypeError + 2-3 min retry delays. Fixed the parameter, added null guard patch, and purged stale zero-fill cache entries. |
| **Duplicate Telegram messages** | Removed `callback()` from read-only commands (`/status`, `/repos`, `/machines`) — providers already feed the LLM, so the callback was causing duplicates. |
| **@BotName command parsing** | Telegram group chats append `@BotUsername` to commands, breaking all validators. Added `stripBotMention()` utility applied to all 9 action validate/handler functions. |
| **Command suppressor** | Added `commandSuppressorProvider` to prevent the LLM from generating a second response when a bot command was already handled. |
| **SSH env vars** | `SSHService` was using `getSetting()` (character secrets only) instead of `process.env`, causing 0 SSH targets despite env vars being set. |
| **NL task creation** | Added `extractTaskFromUserMessage()` (Strategy 0) for direct regex extraction. Fixed JSON fence stripping and case-insensitive project validation in LLM fallback. |
| **`/feedback` bare command** | Bare `/feedback` (no trailing space) wasn't matching `validate()`, causing LLM to handle it as conversation. |
| **`/remind` parser** | Now accepts bare shorthand like `5m`, `2h` without requiring the "in" prefix. |
| **Reminder chat ID** | `extractTelegramIds` falls back to `TELEGRAM_GROUP_CHAT_ID` env var when `telegram_chat_id` isn't populated by ElizaOS. |
| **SQL wildcard injection** | `getTaskByPrefix` now rejects SQL wildcards (`%`, `_`) in prefix input. |
| **NaN/Infinity budgets** | `createTask` rejects NaN/Infinity budget values. |
| **Channel ID validation** | `getTopicThreadId` validates channel ID prefix format. |
| **Lesson extractor** | String-casts `content.text` to handle numeric values. |
| **Task type safety** | Refactored task routes and services for improved type assertions and error messages. |

---

## Testing

| Suite | Tests | Coverage |
|-------|-------|----------|
| Agent System (unit) | 156 tests, 251 assertions | Cron parser, profile service, subagent service, message service, cron service, providers, actions, evaluators, lifecycle worker, plugin index |
| Agent System (E2E) | 9 scenario definitions + 7 validation tests | Browser-based Telegram verification for spawn, list, message, cron, error handling |
| RL Pipeline | 52 tests | Lesson extractor, lessons provider, reflection worker, task-poller RL extraction, correction detection |
| Telegram Workflow | 60 tests | `stripBotMention`, `getTopicThreadId`, topic-input-relay, topic-reply, topic-context, pendingInputs queue |
| Task Dispatcher | 8 tests | Auto dispatch with no machine available |
| Utility Functions | Unit tests | `generateTaskTitle`, `splitMessage`, `detectUserPrompt`, feedback parsing |

**Total: 432 tests passing across 15 files.**

---

## Other Changes

- **`/update` command** — Triggers Coolify API rebuild from latest GitHub code.
- **`formatDuration` helper** — Converts `duration_ms` to human-readable strings ("34s", "2m 15s", "1h 5m") in result-reporter.
- **`SHOULD_RESPOND_BYPASS_SOURCES=telegram`** — Added to character settings so Telegram messages always get processed.
- **`STORE_MEMORY` validate fix** — Removed `text.length > 20` catch-all that was triggering on generic messages; now uses explicit keyword matching only.

---

## Pending (Unmerged Branches)

These changes exist on separate branches and are not yet on master:

- **Topic manager race guard** — Delete requires close first, proactive topic creation, race condition guard.
- **TypeScript strict-mode cleanup** — Resolves all TS strict-mode errors in `itachi-agents` plugin.
- **Dead code removal** — Removes unused exports, dead code, and obsolete files.
