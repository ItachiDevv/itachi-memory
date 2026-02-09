# Telegram Integration

Complete guide to Itachi's Telegram integration — commands, forum topics, task streaming, and personality.

## Overview

Itachi runs as a Telegram bot inside a **supergroup** with forum topics enabled. The general topic is for conversation, and each task automatically gets its own forum topic for progress streaming and interaction.

**Architecture flow:**

```
User (Telegram) → ElizaOS (plugin-telegram) → Itachi Actions/Evaluators
                                              → TelegramTopicsService → Forum Topics
Orchestrator → POST /api/tasks/:id/stream → TelegramTopicsService → Forum Topic
```

## Configuration

### Required Environment Variables

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_GROUP_CHAT_ID` | Supergroup chat ID for forum topics |

### Optional

| Variable | Description |
|----------|-------------|
| `ITACHI_ALLOWED_USERS` | Comma-separated Telegram user IDs allowed to create tasks |

### Bot Setup

1. Create bot via @BotFather
2. Enable "Allow Groups" and disable "Group Privacy" (so the bot sees all messages)
3. Create a supergroup with forum topics enabled
4. Add the bot as an admin
5. Get the chat ID (send a message, check `https://api.telegram.org/bot<TOKEN>/getUpdates`)

## Commands

### Built-in Slash Commands

| Command | Handler | Description |
|---------|---------|-------------|
| `/task <desc>` | create-task action | Queue a new task |
| `/task <project>: <desc>` | create-task action | Queue task for a specific project |
| `/queue` | list-tasks action | Show queued/running tasks |
| `/status` | list-tasks action | Same as /queue |
| `/cancel <id>` | cancel-task action | Cancel a queued/running task |
| `/recall <query>` | telegram-commands action | Search project memories |
| `/recall <project>:<query>` | telegram-commands action | Search memories in a specific project |
| `/repos` | telegram-commands action | List registered repositories |
| `/machines` | telegram-commands action | Show orchestrator machines and status |

### Examples

```
/task lotus-manager: fix the login redirect bug
/recall auth middleware changes
/recall lotus-manager:database migration
/queue
/cancel abc12345
/repos
/machines
```

## Forum Topics

Each task gets its own Telegram forum topic for streaming output and user interaction.

### Topic Lifecycle

1. **Creation**: Topic created on first stream event (or when task is claimed)
   - Name format: `{shortId} | {project}: {description}` (max 128 chars)
   - Initial message shows task details (project, model, priority)

2. **Streaming**: Orchestrator streams events to the topic in real-time
   - Text output from Claude/Codex appears as it's generated
   - Tool use events show as `🔧 tool_name: file_path`
   - Buffered at 1.5s intervals, max 3500 chars per message (below Telegram's 4096 limit)

3. **Completion**: Topic is closed with final status
   - Success: `✅ Completed (cost) | files changed | summary`
   - Failure: `❌ Failed: error message`

### Replying in Topics

Users can reply directly in task forum topics:

| Task Status | Behavior |
|-------------|----------|
| **Running/Claimed** | Message queued as input for the orchestrator session |
| **Queued** | Message queued for when the task starts |
| **Completed/Failed** | Type `follow up: <description>` to create a new task with context |

The orchestrator polls for user input via `GET /api/tasks/:id/input` and injects it into the Claude/Codex session.

## Streaming Architecture

### Orchestrator → ElizaOS → Telegram

```
Claude/Codex Session
  ↓ stdout events
session-manager.ts (streamToEliza)
  ↓ POST /api/tasks/:id/stream
task-stream.ts route handler
  ↓ format event → receiveChunk()
TelegramTopicsService (streaming buffer)
  ↓ flush every 1.5s or at 3500 chars
Telegram API (sendMessage / editMessageText)
  ↓
Forum Topic in Supergroup
```

### Stream Event Types

| Type | Content | Display |
|------|---------|---------|
| `text` | Assistant message text | Raw text in topic |
| `tool_use` | Tool name + input | `🔧 name: file_path` |
| `result` | Status, cost, files, summary | Final status message |

### Pending Inputs

User replies in topics are stored in an in-memory map (`pendingInputs`) and cleaned up after 30 minutes. The orchestrator polls `GET /api/tasks/:id/input` to retrieve them.

## Supergroup Response Behavior

By default, ElizaOS only auto-responds in DMs and requires bot mentions in groups. Itachi overrides this:

```typescript
// character.ts settings
SHOULD_RESPOND_BYPASS_SOURCES: 'telegram'
```

This makes Itachi respond to **all** Telegram messages in the configured group — required for forum topic replies to work without explicitly mentioning the bot.

Actions filter messages via their `validate()` functions to prevent responding to irrelevant messages.

## Conversation Memory

Telegram conversations are automatically bridged into `itachi_memories` for long-term recall via `/recall` and MCP tools. This uses the **scored** strategy (Branch 2).

### Timing

| Component | Frequency | Description |
|-----------|-----------|-------------|
| Chat responses | Real-time | ElizaOS plugin-telegram uses long polling; responses within seconds |
| Memory storage | Every response | `conversationMemoryEvaluator` fires after each Telegram response > 30 chars |
| Significance scoring | Every response | Haiku scores 0.0–1.0, adds ~1-2s background processing (non-blocking) |
| Task streaming | Every 1.5s | `TelegramTopicsService` flushes buffer to forum topic (or at 3500 chars) |
| Context injection | Every response | `conversationContextProvider` (position 11) queries last-24h memories |

### How It Works

1. **Evaluator** (`evaluators/conversation-memory.ts`, `alwaysRun: true`):
   - Triggers on every Telegram response from Itachi (text > 30 chars)
   - Sends last 6 messages + current response to haiku for scoring
   - Scores: 0.0–0.2 (greetings), 0.3–0.5 (general), 0.6–0.8 (decisions), 0.9–1.0 (critical)
   - Stores to `itachi_memories` with `category: "conversation"` and `metadata: { significance }`
   - Cost: ~$0.001 per message

2. **Provider** (`providers/conversation-context.ts`, position 11):
   - Queries last 24h of conversation memories from Supabase
   - Filters out significance < 0.3 (hides small talk)
   - Injects "## Recent Conversations" section into every LLM call
   - Gives Itachi awareness of what was discussed recently

3. **Weighted Search** (`services/memory-service.ts`):
   - `searchMemoriesWeighted()` multiplies similarity score by significance
   - `/recall` and MCP `memory_search` surface decisions over small talk
   - Formula: `weighted = similarity * (0.5 + 0.5 * significance)`

### Storage Volume

- ~30-100 conversation memories per day (depending on chat activity)
- Low-significance entries still stored and searchable, just ranked lower
- Adjust the 0.3 threshold in `conversation-context.ts` to tune provider output

### Alternative Strategies

See `docs/conversation-memory-comparison.md` for the two alternative branches:
- `feature/conv-memory-smart-filter` — LLM yes/no filter (~5-15 memories/day)
- `feature/conv-memory-store-all` — store everything equally (~50-150 memories/day)

## Personality

Itachi's Telegram personality is configured in `character.ts`:

- **Concise responses** optimized for Telegram's chat format
- **Plain text formatting** (no markdown that Telegram doesn't render)
- **Proactive suggestions** — offers to search memories or create tasks
- **Task ID references** — always mentions first 8 chars of task IDs
- **Project-aware** — cites project name and category when recalling memories

## Database Schema

### Telegram Fields on `itachi_tasks`

| Column | Type | Description |
|--------|------|-------------|
| `telegram_chat_id` | bigint | Chat ID of the requesting user |
| `telegram_user_id` | bigint | User ID of the requester |
| `telegram_topic_id` | bigint | Forum topic ID for streaming (added in migration v5) |

Index on `telegram_topic_id` for efficient topic-reply lookups.

## Key Files

| File | Purpose |
|------|---------|
| `eliza/src/character.ts` | Bot personality, style, shouldRespond bypass |
| `eliza/src/plugins/itachi-tasks/actions/telegram-commands.ts` | /recall and /repos commands |
| `eliza/src/plugins/itachi-tasks/actions/topic-reply.ts` | Forum topic reply handling |
| `eliza/src/plugins/itachi-tasks/services/telegram-topics.ts` | Topic CRUD + streaming buffer |
| `eliza/src/plugins/itachi-tasks/routes/task-stream.ts` | Stream endpoint + pending inputs |
| `orchestrator/src/session-manager.ts` | Streams events to ElizaOS |
| `eliza/src/plugins/itachi-memory/evaluators/conversation-memory.ts` | Scores + stores conversation memories |
| `eliza/src/plugins/itachi-memory/providers/conversation-context.ts` | Injects recent conversations into LLM context |
| `eliza/src/plugins/itachi-memory/services/memory-service.ts` | `searchMemoriesWeighted()` for significance ranking |
