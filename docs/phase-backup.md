  | # | Phase | New/Modified Files |
  |---|-------|--------------------|
  | 1 | Scaffold + Character | `eliza/package.json`, `tsconfig.json`, `tsup.config.ts`,
  `src/index.ts`, `src/character.ts`, `.env.example` |
  | 2 | itachi-memory plugin | `src/plugins/itachi-memory/index.ts`,
  `actions/store-memory.ts`, `providers/recent-memories.ts`, `providers/memory-stats.ts`,
  `services/memory-service.ts` |
  | 3 | itachi-tasks plugin | `src/plugins/itachi-tasks/index.ts`,
  `actions/spawn-session.ts`, `actions/create-task.ts`, `actions/list-tasks.ts`,
  `actions/cancel-task.ts`, `providers/active-tasks.ts`, `providers/repos.ts`,
  `services/task-service.ts`, `services/task-poller.ts` |
  | 4 | itachi-sync plugin (routes) | `src/plugins/itachi-sync/index.ts`,
  `routes/sync-routes.ts`, `routes/memory-routes.ts`, `routes/task-routes.ts`,
  `routes/repo-routes.ts`, `routes/bootstrap-routes.ts`, `services/sync-service.ts` |
  | 5 | itachi-self-improve plugin | `src/plugins/itachi-self-improve/index.ts`,
  `evaluators/lesson-extractor.ts`, `providers/lessons.ts`,
  `workers/reflection-worker.ts` |
  | 6 | Database migration | `schema/supabase-migration-elizaos.sql` |
  | 7 | Hook migration | Verify existing hooks — no file changes needed |
  | 8 | Deployment | `eliza/Dockerfile`, `eliza/railway.toml` |
  | 9 | Parallel run + cutover | Testing only — no new files |

  **Total new files: ~30 TypeScript files + 4 config files + 1 SQL migration + 1
  Dockerfile + 1 railway.toml**


  If you need specific details from before exiting plan mode (like exact code snippets,
  error messages, or content you generated), read the full transcript at:
  C:\Users\newma\.claude\projects\C--Users-newma-documents-crypto-skills-plugins\72edb505
  -2e35-4096-ace5-8cdcec0f84a8.jsonl