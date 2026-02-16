# Things OpenClaw Has That We Don't

> Comparative analysis: OpenClaw vs Itachi Memory system
> Date: 2026-02-16

---

## 1. Gateway Architecture (Single Control Plane)

OpenClaw runs a **persistent WebSocket gateway daemon** (`openclaw gateway`) that is the single source of truth for all sessions, routing, and channel connections. Everything connects to it: CLI, web UI, mobile apps, channels, and nodes.

**What they have:**
- Long-lived daemon process with typed WS API (JSON Schema-validated frames)
- Hot config reload (no restart for most changes)
- Health checks, heartbeat events, graceful shutdown protocol
- Device pairing and local trust model for WS clients
- Idempotency keys for safe retries on side-effecting methods

**What we have:**
- ElizaOS runtime with REST API routes via `itachi-sync`
- No persistent daemon model; our bot runs as a Docker container
- No WebSocket control plane; communication is REST + Telegram webhook

**Gap:** We lack a unified control plane that multiple clients can connect to simultaneously. Our system is request/response only.

---

## 2. Multi-Agent Routing and Isolation

OpenClaw supports **multiple fully-isolated agents** running in a single gateway, each with:

- Own workspace (`~/.openclaw/workspace-<agent>`)
- Own state directory and auth profiles
- Own session store (`~/.openclaw/agents/<agentId>/sessions`)
- Own skills folder
- Per-agent model selection (e.g., Sonnet for everyday, Opus for deep work)
- Per-agent sandbox and tool restrictions
- Per-agent mention patterns for group chats

**Routing system:**
- Deterministic binding rules: route by channel, accountId, peer ID, guild/team, roles
- Most-specific match wins
- Multiple accounts per channel (e.g., two WhatsApp numbers to two agents)
- Per-sender DM routing (same channel, different agents per person)

**What we have:**
- Single agent instance with one personality
- No concept of isolated agent workspaces
- No routing layer; all messages go to the same agent
- No per-agent model switching

**Gap:** No multi-agent isolation, no routing rules, no per-agent configuration.

---

## 3. `sessions_spawn` - Persistent Subagent Spawning

This is their most relevant feature for our comparison. OpenClaw has a **first-class subagent system**:

**`sessions_spawn` tool:**
- Agent can spawn a sub-agent run with a specific `task`, optional `label`, `agentId`, `model`, `runTimeoutSeconds`, and `cleanup` policy
- Non-blocking: returns `status: "accepted"` immediately
- Spawned session gets its own isolated session key
- Posts an announce reply back to the requester when done
- Hierarchical: supports nested spawns with descendant tracking

**`SubagentRegistry` (src/agents/subagent-registry.ts):**
- Full lifecycle management: register, monitor, complete, cleanup, resume
- Persistent to disk for cross-process recovery
- Sweep timer (60s interval) for expired records
- Archive retention configurable per-agent
- Supports "steer restart" (transition between run IDs)
- Completion announcements with retry logic
- Active run counting and hierarchical descendant queries

**Session-to-session communication:**
- `sessions_list`: discover active sessions
- `sessions_history`: fetch transcript from another session
- `sessions_send`: message another session with reply-back ping-pong (up to 5 turns)
- `session_status`: check/change model for current session
- `agents_list`: discover which agents are available to spawn into
- Visibility scoping: `tree` (current + spawned), `self`, or custom

**What we have:**
- `spawnSessionAction` in itachi-tasks: launches interactive coding sessions on orchestrator machines via SSH
- Task queue with polling, but tasks are dispatched to external orchestrators, not internal sub-agents
- No session-to-session communication
- No subagent registry or lifecycle management
- No spawn-and-wait-for-result pattern

**Gap:** We dispatch work to external machines. They spawn isolated agent sessions internally with full lifecycle tracking, inter-session messaging, and hierarchical coordination.

---

## 4. Multi-Channel Inbox

OpenClaw supports **12+ messaging channels** simultaneously from one gateway:

| Channel | Protocol |
|---------|----------|
| WhatsApp | Baileys (Web) |
| Telegram | grammY |
| Discord | discord.js |
| Slack | Bolt |
| Signal | signal-cli |
| iMessage | BlueBubbles |
| Google Chat | native |
| MS Teams | native |
| Matrix | native |
| Mattermost | plugin |
| Zalo | native |
| WebChat | built-in |

Each channel supports:
- DM policies (pairing, allowlist, open, disabled)
- Group chat with mention-gating
- Media in/out (images, audio, documents)
- Per-channel account management

**What we have:**
- Telegram only (via ElizaOS Telegram client)
- No multi-channel routing
- No DM pairing/approval flow
- No mention-gating for groups

**Gap:** Single-channel vs 12+ channels with unified routing.

---

## 5. Vector Memory Search with Hybrid BM25

OpenClaw has a **sophisticated memory search** system:

- Plain Markdown as source of truth (`MEMORY.md` + `memory/YYYY-MM-DD.md`)
- Hybrid search: vector similarity + BM25 keyword relevance
- Multiple embedding providers: OpenAI, Gemini, Voyage, local GGUF
- Automatic embedding cache in SQLite
- sqlite-vec acceleration for vector queries
- Automatic reindex on provider/model change
- Memory flush before context compaction (pre-compaction ping)
- QMD experimental backend: BM25 + vectors + reranking sidecar
- Session transcript indexing (experimental)
- Citations with source path + line numbers
- Batch embedding for large corpus indexing
- Extra paths support for indexing files outside workspace

**What we have:**
- Supabase pgvector for embeddings + `match_memories` RPC
- Embedding cache with SHA256 hashing
- Category-based filtering
- Significance scoring and reinforcement tracking
- No BM25/hybrid search
- No local embedding option
- No automatic pre-compaction memory flush
- No session transcript indexing

**Gap:** They have hybrid search (vector + keyword), local embeddings, automatic memory flush, and session transcript indexing. We have simpler vector-only search.

---

## 6. Browser Automation (Built-in)

OpenClaw has a **first-class browser tool** with full CDP control:

- Managed Chrome/Chromium instances
- Multi-profile support (up to ~100 profiles)
- Actions: snapshot, screenshot, click, type, hover, drag, fill, evaluate
- AI-powered snapshot mode (returns semantic refs)
- Upload support with ref-based targeting
- PDF generation
- Console log access
- Sandboxable browser instances
- Remote browser via node targeting

**What we have:**
- No built-in browser control
- We rely on Claude Code's MCP tools (playwright, chrome-devtools) which are development-time only

**Gap:** No production browser automation capability in our agent.

---

## 7. Sandboxing (Docker Isolation)

OpenClaw runs tool execution in **Docker containers**:

- Modes: off, non-main (sandbox non-primary sessions), all
- Scope: per-session, per-agent, or shared
- Workspace access: none, read-only, read-write
- Custom bind mounts per agent
- Setup commands (run once on container creation)
- Sandbox browser instances
- Per-agent sandbox overrides
- Elevated exec escape hatch for host access

**What we have:**
- Our bot runs inside a single Docker container on Coolify
- No per-session or per-agent sandboxing
- No tool-level isolation
- SSH-based remote execution is our only isolation mechanism

**Gap:** No granular sandboxing for agent tool execution.

---

## 8. Cron Jobs and Scheduled Automation

OpenClaw has **built-in cron**:

- `cron` tool for the agent to schedule its own recurring tasks
- Actions: add, update, remove, list, run
- `wake` action for system event + heartbeat
- Session retention for cron-spawned sessions
- Max concurrent run limits
- Heartbeat system (configurable interval, target channel)

**What we have:**
- `ReminderService` with basic scheduling
- Workers that poll on intervals (task dispatcher, repo sync, reminder poller)
- No agent-self-scheduled cron
- No heartbeat/wake system

**Gap:** Agent can't schedule its own recurring work. Our reminders are simpler than their cron system.

---

## 9. Mobile Nodes (iOS/Android)

OpenClaw supports **device nodes** that expose hardware capabilities:

- Camera snap/clip
- Screen recording
- Location retrieval
- System notifications
- Canvas surface for visual output (A2UI)
- Device pairing with approval flow

**What we have:**
- No mobile node support
- No device capability exposure

**Gap:** No mobile/device integration.

---

## 10. Skill Marketplace (ClawHub)

OpenClaw has a **public skill registry**:

- `SKILL.md` format with frontmatter metadata
- Vector search for skill discovery (OpenAI embeddings)
- Version management with changelogs and tags
- Security analysis of declared requirements
- CLI: `clawhub search`, `clawhub install`, `clawhub publish`
- Three tiers: bundled, managed, workspace-specific
- Per-agent skill isolation

**What we have:**
- Plugins are TypeScript modules registered at startup
- No marketplace or registry
- No skill discovery mechanism
- No versioning or publishing flow

**Gap:** No skill marketplace, no dynamic skill installation, no community sharing.

---

## 11. Tool Profiles and Granular Tool Policy

OpenClaw has **layered tool access control**:

- Tool profiles: `minimal`, `coding`, `messaging`, `full`
- Global allow/deny lists with wildcard support
- Per-agent tool overrides
- Per-provider tool restrictions (`tools.byProvider`)
- Tool groups (`group:fs`, `group:runtime`, `group:sessions`, etc.)
- Sandbox-specific tool policy

**What we have:**
- All tools available to the agent at all times
- No tool restriction mechanism
- No per-context tool filtering

**Gap:** No tool access control or profiling.

---

## 12. Workflow Engine (Lobster)

OpenClaw has **Lobster**, a typed workflow shell:

- YAML/JSON workflow definitions with typed pipelines (objects/arrays, not text)
- Step-based execution with `$stepId.stdout` data flow
- Approval gates (human-in-the-loop)
- Data shaping: `where`, `pick`, `head`
- Composable pipelines that save tokens and enable determinism
- Resumable execution

**What we have:**
- Task queue with sequential dispatch
- No workflow definition language
- No typed pipeline system
- No approval gates

**Gap:** No composable, deterministic workflow engine.

---

## 13. Voice Capabilities

OpenClaw supports:
- Voice Wake: always-on speech trigger with ElevenLabs
- Talk Mode: continuous conversation overlay
- Voice note transcription hook

**What we have:**
- No voice support

---

## 14. Web Control UI / Dashboard

OpenClaw ships a **browser-based dashboard**:
- Chat interface
- Config editor (form + raw JSON)
- Session management
- Node pairing
- Health monitoring

**What we have:**
- No web dashboard
- Management via Telegram commands only

---

## Summary: Priority Gaps

| Priority | Feature | Impact |
|----------|---------|--------|
| **Critical** | Subagent spawning with lifecycle management | Core agent capability |
| **Critical** | Session-to-session communication | Agent coordination |
| **High** | Multi-agent routing/isolation | Personality & workspace separation |
| **High** | Hybrid memory search (vector + BM25) | Better recall accuracy |
| **High** | Tool profiles and access control | Security & scope management |
| **Medium** | Gateway/control plane architecture | Multi-client access |
| **Medium** | Built-in cron/scheduling | Agent autonomy |
| **Medium** | Workflow engine | Deterministic task pipelines |
| **Low** | Multi-channel support | We're Telegram-focused by design |
| **Low** | Browser automation | Dev-time only need |
| **Low** | Mobile nodes | Not our use case currently |
