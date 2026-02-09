# Eliza OS + Claude Code integration notes

  This document covers key details about how ElizaOS integrates with Claude Code for your
  Itachi project management bot. It explains the model choices, ElizaOS's role, cost estimates,
  setup scripts, and handling context compaction.

---
  1. Model for Telegram agent

  Yes, Sonnet. ElizaOS's plugin-anthropic maps:
  - ModelType.TEXT_SMALL → Haiku (used by lesson extractor, ~$0.05/month)
  - ModelType.TEXT_LARGE → Sonnet (used by main chat + reflection worker)

  The character.ts doesn't override the model — it inherits whatever plugin-anthropic defaults
   to. Sonnet handles all your Telegram conversations.

  ---
  2. How deep does ElizaOS go?

  ElizaOS handles:
  - Telegram connection, message routing, conversation state
  - LLM calls via runtime.useModel() (provider abstraction over Anthropic/OpenAI)
  - Built-in memory/embedding storage (its own memories table via Drizzle)
  - Task scheduler (repeat workers, background jobs)
  - Express HTTP server (your routes plug into)
  - Entity/room/world data model for multi-user conversations
  - Plugin lifecycle (init, start, stop)

  Your custom code handles (the 4 plugins, ~28 files):
  - itachi_memories / itachi_tasks tables (your own Supabase tables, separate from ElizaOS's)
  - REST API routes for backward compatibility with hooks + orchestrator
  - Task orchestration (creating task rows for the local orchestrator to claim)
  - Encrypted file sync (AES-256-GCM push/pull)
  - Self-improvement loop (evaluator extracts lessons, provider injects them, worker
  synthesizes weekly)
  - Project/repo registry
  - Telegram notifications on task completion

  ElizaOS is the chassis (handles Telegram, LLM, HTTP, memory). Your plugins are the brain
  (project management, task dispatch, learning).

  ---
  3. Estimated monthly costs

  Under subscription (Claude Code sessions = $0 extra):
  ┌──────────────────────────────┬────────────────────────┬───────────────────┐
  │          Component           │         Model          │ Est. Monthly Cost │
  ├──────────────────────────────┼────────────────────────┼───────────────────┤
  │ Telegram chat (~30 msgs/day) │ Sonnet                 │ ~$8-10            │
  ├──────────────────────────────┼────────────────────────┼───────────────────┤
  │ Lesson extractor (~50/month) │ Haiku                  │ ~$0.05            │
  ├──────────────────────────────┼────────────────────────┼───────────────────┤
  │ Reflection worker (4x/month) │ Sonnet                 │ ~$0.05            │
  ├──────────────────────────────┼────────────────────────┼───────────────────┤
  │ OpenAI embeddings            │ text-embedding-3-small │ ~$0.01            │
  ├──────────────────────────────┼────────────────────────┼───────────────────┤
  │ Claude Code sessions         │ Subscription           │ $0                │
  ├──────────────────────────────┼────────────────────────┼───────────────────┤
  │ Total                        │                        │ ~$8-10/month      │
  └──────────────────────────────┴────────────────────────┴───────────────────┘
  ElizaOS adds context overhead per message (~2K input tokens: character bio, providers
  injecting memories/tasks/lessons, conversation history) which drives most of the cost.

  If you switch Telegram to Opus:
  ┌──────────────────────────────┬────────────────────────┬───────────────────┐
  │          Component           │         Model          │ Est. Monthly Cost │
  ├──────────────────────────────┼────────────────────────┼───────────────────┤
  │ Telegram chat (~30 msgs/day) │ Opus                   │ ~$35-40           │
  ├──────────────────────────────┼────────────────────────┼───────────────────┤
  │ Lesson extractor             │ Haiku                  │ ~$0.05            │
  ├──────────────────────────────┼────────────────────────┼───────────────────┤
  │ Reflection worker            │ Opus                   │ ~$0.30            │
  ├──────────────────────────────┼────────────────────────┼───────────────────┤
  │ OpenAI embeddings            │ text-embedding-3-small │ ~$0.01            │
  ├──────────────────────────────┼────────────────────────┼───────────────────┤
  │ Total                        │                        │ ~$35-40/month     │
  └──────────────────────────────┴────────────────────────┴───────────────────┘
  Roughly 4-5x increase going Sonnet → Opus. For a personal project manager bot, Sonnet is the
   right call — Opus's extra reasoning ability doesn't add much value for "create a task row
  and notify me."

  ---
  4. Setup script + new dependencies

  The installer (`install.mjs`) is client-side only — it installs hooks,
  skills, and MCP onto machines running Claude Code. It doesn't install the ElizaOS
  server (that's Coolify/Hetzner).

  `install.mjs` prompts for all credentials including ITACHI_API_KEY (required for auth).
  Second machine pulls all keys from encrypted sync automatically — enter passphrase only.

  ---
  5. Hook on context compaction

  Good thinking, but Claude Code doesn't expose a hook event for context compaction. The
  available hook events are:

  - SessionStart — once at session start
  - PostToolUse / PreToolUse — on tool calls
  - SessionEnd — once at session end
  - Notification — on notification events

  Context compaction is an internal operation with no hook point. However, your current setup
  already mitigates this well:

  1. MEMORY.md (always in system prompt, survives compaction) — this is your primary defense
  2. /recall command — user can manually pull memories when context feels thin
  3. Session-start hook already injects recent memories at the beginning

  The most practical improvement would be a PreToolUse hook that detects large context and
  injects a reminder, but that would fire on every tool call and add latency. Not worth it.

  The real answer is: keep MEMORY.md concise and high-signal (which is why it has the 200-line
   cap). That file is your compaction-proof memory. Everything important should be there.