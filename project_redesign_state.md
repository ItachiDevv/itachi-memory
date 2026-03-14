---
name: project_redesign_state
description: Current state of the Itachi architecture redesign — what's done, what's next, critical details for continuation
type: project
---

## Redesign Status (as of 2026-03-11)

### Documents
- **Spec:** `docs/superpowers/specs/2026-03-11-itachi-redesign-design.md` — APPROVED by Itachisan
- **Phase 1 Plan:** `docs/superpowers/plans/2026-03-11-itachi-redesign-phase1.md` — 12 tasks, 4 chunks
- **Memory Improvement Plan:** `docs/memory-improvement-plan.md` — Phases 1-2 merged into redesign, Phase 3 saved for later

### What's DONE (Chunk 1 — committed as `9cec321`)
- Task 1: Removed itachi-agents plugin (15 files)
- Task 2: Removed itachi-sync plugin (9 files)
- Task 3: Removed itachi-tester plugin (9 files)
- Task 4: Merged itachi-code-intel into itachi-memory (routes, service, provider, utils)
- index.ts cleaned: 3 plugins + 2 model plugins, 9 workers instead of 17
- TS errors: 22 (all pre-existing, none from our changes)
- **56 files changed, 7199 lines deleted**

### What's NEXT

#### Chunk 2: Simplify Telegram (Tasks 5-6)
- **Task 5: Build intent router** — `eliza/src/plugins/itachi-tasks/services/intent-router.ts`
  - LLM classifies every message as: conversation | task | question | feedback
  - Uses TEXT_SMALL model, temperature 0.1
  - Returns structured Intent object with type + parsed fields
  - Falls back to 'conversation' on parse failure

- **Task 6: Replace telegram-commands.ts** — THE BIG ONE
  - Create `eliza/src/plugins/itachi-tasks/actions/natural-language.ts`
  - This action validates ALL messages that aren't session controls or /brain /status /help
  - Strips /command prefixes so old habits still work
  - Routes: conversation → let ElizaOS handle, task → create task (Phase 2: SessionOperator), question → memory search, feedback → store lesson
  - **GUT telegram-commands.ts from 2100 lines to ~200**
  - Keep ONLY: /brain (handleBrain), /status (handleTaskStatus), /help, session controls (/stop /exit /esc /yes /no /close)
  - Delete ALL other handlers: /task, /session, /remote, /recall, /teach, /unteach, /machines, /repos, /engines, /sync-repos, /cancel, /feedback, /delete_topics, /close_all_topics, /health, /gh, /ssh, /ops, /remind, /schedule, /spawn, /agents, /msg
  - Update setMyCommands to only register: brain, status, help
  - Register naturalLanguageAction in itachi-tasks/index.ts AFTER session controls

#### Chunk 3: Structure Memory (Tasks 7-9)
- **Task 7: Structured memory blocks**
  - Replace flat MEMORY.md with: core.md, machine-state.md, patterns.md, preferences.md, pending.md, session-log.md
  - Max line limits per block (200, 100, 150, 100, 50, 50 entries)
  - session-start.sh injects relevant blocks, not everything
  - One-time migration script to split current MEMORY.md
  - Apply to both Unix and Windows hooks

- **Task 8: Automatic session summaries**
  - session-end.sh extracts structured summary: request, files_changed, decisions, completed, timestamp, duration
  - Writes to session-log.md as compact markdown entries
  - Caps at 50 entries (trim oldest)
  - Sends structured JSON to brain server via /api/session/complete

- **Task 9: Signal keyword filtering**
  - Filter transcript turns before sending to brain
  - SIGNAL_KEYWORDS: remember, important, bug, fix, solution, decision, pattern, convention, gotcha, workaround, todo, fixme, never, always, critical, root cause, discovered, error, failed, broken, wrong, correct, should, learned, realized, turns out, actually
  - Keep signal turns + 2 turns surrounding context
  - ~70% volume reduction

#### Chunk 4: Cleanup (Tasks 10-12)
- **Task 10: Fix identity** — Update "Newman" → "Itachisan" in Supabase itachi_memories table (identity category)
- **Task 11: Clean up index.ts** — Already mostly done in Chunk 1, verify final state
- **Task 12: Deploy and test** — Push, verify Coolify rebuild, test 6 scenarios on Telegram

### Critical Implementation Notes

#### telegram-commands.ts gutting (Task 6)
- File is at: `eliza/src/plugins/itachi-tasks/actions/telegram-commands.ts` (~2100 lines)
- The telegramCommandsAction has validate() that checks for /command prefixes
- handler() is a massive switch/if-else chain for each command
- Keep the action structure but strip handlers
- The topic-input-relay evaluator (`eliza/src/plugins/itachi-tasks/evaluators/topic-input-relay.ts`) handles session controls — DO NOT DELETE IT
- slash-interceptor.ts in services/ may also need cleanup (it dispatches to handlers that no longer exist)
- callback-handler.ts handles Telegram button callbacks — needs review, some callbacks were for deleted features

#### Memory block injection (Task 7)
- Current session-start.sh injects MEMORY.md via the briefing section
- The encodeCwd function was FIXED this session (uses `-` not `--`)
- Memory dir: `~/.claude/projects/-Users-itachisan-itachi-itachi-memory/memory/`
- The auto-memory system (MEMORY.md + frontmatter .md files) is SEPARATE from the structured blocks
- Structured blocks are for session injection, auto-memory is for cross-session persistence
- Don't break the auto-memory system (feedback_thoroughness.md, feedback_architecture.md, etc.)

#### Supabase connection for Task 10
- Key env var: `SUPABASE_KEY` (not SUPABASE_SERVICE_KEY)
- Project: `zhbchbslvwrgjbzakeap`
- Use: `source ~/.itachi-api-keys && curl with printf '%s' "$SUPABASE_KEY"`
- Node -e scripts need to use /tmp/script.mjs pattern (bash escaping breaks node -e on this Mac)

### Earlier Fixes (also committed this session)
- encodeCwd: `--` → `-` (9 instances across 4 hook files)
- entry.type: `'human'` → `'user'` (8 instances across 5 files)
- Significance threshold: 0.7 → 0.4 for task_lesson/RLM promotion
- Lesson extractor: added every-5th-message sampling
- Effectiveness worker: thresholds 5 → 2
- Telegram notify: TELEGRAM_CHAT_ID → TELEGRAM_GROUP_CHAT_ID
- Hook auto-update: hardcoded repo path, detect symlinks
- Session-end decisions.md: fixed escaped newlines
- itachi-tester: all bugs fixed before deletion
- SSH service: inline keys to ~/.ssh/, ensureDeployKey returns undefined on failure
- Mac IP: 100.103.124.46 → 100.80.217.87 in character.ts
- hoodie added to MACHINE_ALIASES
