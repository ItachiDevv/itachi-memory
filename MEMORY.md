# Itachi Memory Index

## Redesign State
- [project_redesign_state.md](project_redesign_state.md) — Phase 1 verification in progress, Phase 2 deployed
- [pending.md](pending.md) — Current open work and next steps

## Architecture & Config
- [core_architecture.md](core_architecture.md) — Supabase, server, plugins, model setup, critical config
- [machine_state.md](machine_state.md) — Per-machine state, SSH targets, OS limitations

## User Identity
- **User is Itachisan, bot is Itachi.** NEVER call user "Newman."

## Feedback (MUST follow)
- [feedback_thoroughness.md](feedback_thoroughness.md) — test thoroughly, fix bugs don't just report them
- [feedback_architecture.md](feedback_architecture.md) — stop overcomplicating, core value is clone+brain+telegram
- [feedback_bare_metal.md](feedback_bare_metal.md) — NEVER use Docker for Itachi bot, run bare metal systemd as itachi user
- [feedback_env_files.md](feedback_env_files.md) — NEVER modify/remove API keys from project .env files

## Patterns & Guardrails
- [patterns.md](patterns.md) — Recurring gotchas, debugging insights
- [debugging.md](debugging.md) — Debugging notes


## Itachi Session Context
<!-- auto-updated by itachi session-start hook -->

**Hot files**: /Users/itachisan/itachi/itachi-memory/eliza/src/plugins/itachi-tasks/services/task-executor-service.ts (31 edits), /Users/itachisan/itachi/itachi-memory/eliza/src/index.ts (30 edits), /Users/itachisan/itachi/itachi-memory/hooks/unix/session-end.sh (19 edits), /Users/itachisan/itachi/itachi-memory/eliza/src/plugins/itachi-tasks/actions/interactive-session.ts (13 edits), /Users/itachisan/itachi/itachi-memory/eliza/src/character.ts (10 edits)
**Active patterns**: Pattern: Work is concentrated in the `itachi-memory` plugin’s code-intel path (`routes`, new `middleware`, ne, Pattern: Most activity is concentrated in `eliza/src/index.ts` plus Telegram/task and code-intel plugin paths, Pattern: Work is concentrated in the documentation layer, specifically `docs/superpowers/plans` and `docs/sup, Pattern: Most activity is concentrated in two plugin areas under `eliza/src/plugins`: `itachi-self-improve` (, Pattern: Work is concentrated in two areas: cross-platform session lifecycle hooks (`hooks/unix/*`, `hooks/wi
**Style**: naming=unknown (insufficient observable edits; no naming patterns available), testing=unknown (no test files, assertions, or framework usage observed), imports=unknown (no import statements observed), formatting=unknown (no code diffs to infer spacing, semicolon, quote, or linting preferences), architecture=unknown (no module structure or design patterns observable from empty sessions), error_handling=unknown (no try/catch, result types, or error strategy usage observed), libraries=unknown (languages and tool counts are provided, but no concrete dependency usage is shown), commit_style=unknown (no commit messages or VCS metadata provided)
**Recent decisions**: Let me check what the Windows session fixed and the current hook state.; Let me check what the Windows session fixed and the current hook state.; Let me check what the Windows session fixed and the current hook state.

## Project Rules
<!-- auto-updated by itachi session-start hook -->

- Claude Code session directory constraint (reinforced 2x)
- For this environment, remote infrastructure tasks must not proceed without explicit auth material (SSH private key or Coolify API token).
- For verification-only prompts in this project, sessions can complete successfully without touching files or creating commits when explicitly instructed (`Nothing to commit`).
- SSH Start Directory Configuration
- Unified SessionStart Hook Architecture
- API routing and environment configuration constraints.
- Project structure and plugin location
- Core logic for task execution is centralized in the itachi-tasks plugin.
- The project uses a specific documentation-driven memory structure.
- Persistent documentation is maintained in a /memory directory and synced at the start of tasks.
- Pushing code to GitHub in the 'itachi-memory' repo triggers an automatic redeploy on infrastructure.
- The repository is the single source of truth for behavior to prevent hallucination-driven drift.
- Preferred testing environment involves Telegram and Chrome MCP.
- Maintain repository as the single source of truth to prevent hallucination-driven drift.
- The project maintains persistent documentation files in a /memory directory that are synced at the start of tasks.
