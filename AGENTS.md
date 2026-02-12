# Repository Guidelines

## Project Structure & Module Organization
Core services are split by runtime:
- `eliza/`: ElizaOS agent and plugins (`src/plugins/itachi-*`), plus tests in `eliza/src/__tests__/`.
- `orchestrator/`: task runner that claims/executes queued work (`src/task-*.ts`, `session-manager.ts`).
- `mcp/`: local MCP server (`index.js`) exposing memory/task tools to Claude Code.
- `hooks/windows` and `hooks/unix`: session lifecycle hook scripts.
- `supabase/migrations/`: canonical schema migrations. `schema/` contains legacy SQL snapshots.
- `docs/`, `config/`, `skills/`, `dashboard/`: architecture notes, templates, skill bundles, and UI assets.

## Build, Test, and Development Commands
Run from the repository root unless noted:
- `node install.mjs`: standard setup.
- `node install.mjs --full`: full multi-machine/orchestrator setup.
- `npm run update` (or `npm run build`): executes `update.mjs` (git pull, rebuild Eliza + orchestrator, restart PM2).
- `cd eliza && bun run dev`: run Eliza in dev mode.
- `cd eliza && bun run build`: compile Eliza plugins.
- `cd eliza && bun test`: run Bun test suite.
- `cd orchestrator && npm run build && npm start`: build and run orchestrator.
- `cd mcp && npm install --omit=dev && npm start`: run MCP server.

## Coding Style & Naming Conventions
TypeScript is strict across `eliza/` and `orchestrator/`; keep types explicit and avoid `any`.
Follow existing local style per file (indentation and quotes are not fully standardized across modules).
Use descriptive suffixes by role (`*-service.ts`, `*-provider.ts`, `*-worker.ts`, `*-routes.ts`).
Prefer kebab-case file names for plugin/action modules (for example, `store-memory.ts`, `task-dispatcher.ts`).

## Testing Guidelines
Primary automated tests live in `eliza/src/__tests__` and run with Bun.
Name tests `*.test.ts`; keep integration-heavy cases in dedicated integration files.
No enforced coverage threshold is configured; add/extend tests for behavior changes in plugins, routes, and task actions.

## Commit & Pull Request Guidelines
Recent history follows Conventional Commit prefixes (`feat:`, `fix:`, `docs:`), with concise imperative subjects.
PRs should include:
- what changed and why,
- affected modules (for example `eliza/plugins/itachi-sync`),
- verification steps/commands run,
- migration or environment variable changes,
- screenshots for `dashboard/` UI updates.

## Security & Configuration Tips
Do not commit secrets or machine-specific credentials. Use templates in `config/` and environment variables (`ITACHI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, etc.). Put new schema changes in `supabase/migrations/`.
